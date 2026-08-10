/**
 * client.ts — the frontend's one call to price and build a swap.
 *
 * It threads the pieces that are each verified in isolation into a single flow: the pool registry (from
 * Supabase) says which pools exist, the indexer reads their live state over RPC, the quoter (exact against
 * the chain to the wei) picks the best route, and the plan encoder turns it into the exact `MoleRouter.swap`
 * argument. Nothing here re-implements math — it composes verified parts and applies one policy: slippage.
 */

import { getQuote, NATIVE, type Quote } from "./quote";
import { fetchV3Pool } from "./indexer";
import { v4PoolState } from "./venues/v4Pool";
import type { PoolState } from "./venues/v3Pool";
import { FetchTransport } from "./transport";
import { fetchV4MolePool, fetchV4Pool } from "./venues/v4Reader";
import { discoverForPair } from "./discover";
import { encodePlan, type EncodedPlan } from "./router";
import { PANCAKE_V3, LIVE_POOL_ID, MOLE_ADDRESSES } from "../mole/chain";

const USDG_LC = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

/** A pool row as stored in Supabase `mp_pools`. */
export interface PoolRow {
  id: string;
  venue: "pancake_v3" | "uniswap_v3" | "mole_v4";
  token0: string;
  token1: string;
  fee: number;
  tick_spacing: number;
  hooks: string | null;
  address: string | null;
  active: boolean;
}

/** A token row from Supabase `mp_tokens`. */
export interface TokenRow {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  is_native: boolean;
  is_stable: boolean;
  sort_rank: number;
}

const lc = (a: string) => a.toLowerCase();

const NATIVE_LC = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/** Both tokens of a pool equal the unordered pair {a, b}. */
function isPair(p: PoolRow, a: string, b: string): boolean {
  const t0 = lc(p.token0);
  const t1 = lc(p.token1);
  return (t0 === a && t1 === b) || (t0 === b && t1 === a);
}

/**
 * Fetch the live state of only the pools that can actually sit on a route between `tokenIn` and
 * `tokenOut` — NOT every pool that merely touches WETH.
 *
 * THIS BOUND IS LOAD-BEARING, not an optimisation. Robinhood Chain's graph is a WETH star with ~200 live
 * pools, and an earlier version fetched state for every WETH-touching pool: ~200 pools times ~15 RPC
 * calls each rate-limited the public endpoint (HTTP 429), most fetches failed, and the quoter saw no
 * pools — so the most common swap (ETH -> USDG) returned "no route". The fix is to fetch only:
 *   - the DIRECT pools for the pair, and
 *   - when neither side is WETH, the two hub legs (tokenIn/WETH and WETH/tokenOut) for a 2-hop route,
 * capped and fetched with bounded concurrency so the endpoint is never bursted.
 */
export async function fetchRelevantPoolStates(
  pools: PoolRow[],
  tokenIn: string,
  tokenOut: string,
  weth: string,
  transport = new FetchTransport(),
): Promise<PoolState[]> {
  const w = lc(weth);
  const inT = lc(tokenIn) === NATIVE_LC ? w : lc(tokenIn);
  const outT = lc(tokenOut) === NATIVE_LC ? w : lc(tokenOut);

  const relevant = pools.filter(
    (p) =>
      p.active &&
      (isPair(p, inT, outT) || // direct
        (inT !== w && outT !== w && (isPair(p, inT, w) || isPair(p, outT, w)))), // 2-hop via the WETH hub
  );

  // On-demand, on-chain discovery: find EVERY live pool for this pair (direct + WETH/USDG hub legs) across
  // all executable factories, so the router quotes/splits across venues the indexer hasn't cached yet.
  // This is what lets any token with liquidity be traded immediately, Jupiter-style.
  let discovered: PoolRow[] = [];
  try {
    discovered = await discoverForPair(tokenIn, tokenOut, weth);
  } catch {
    /* discovery best-effort — fall back to the indexed set */
  }

  // Merge indexed + discovered, deduped by pool address.
  const byAddr = new Map<string, PoolRow>();
  for (const p of [...relevant, ...discovered]) {
    if (p.address) byAddr.set(p.address.toLowerCase(), p);
  }
  // Cap generously — Multicall discovery is bounded and the Alchemy RPC handles the fan-out — but keep a
  // ceiling so a pathological pair can't fetch hundreds of pool states.
  const capped = [...byAddr.values()].slice(0, 48);

  const states: (PoolState | null)[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < capped.length; i += CONCURRENCY) {
    const chunk = capped.slice(i, i + CONCURRENCY);
    const batch = await Promise.all(
      chunk.map(async (p) => {
        try {
          // Any Uniswap-V3-style pool (Pancake or Uniswap V3 forks) is read the same way and executed
          // by MoleRouter's shared V3 callback — the TickLens reads any V3 pool's ticks by address.
          if ((p.venue === "pancake_v3" || p.venue === "uniswap_v3") && p.address) {
            return await fetchV3Pool(transport, p.address, PANCAKE_V3.tickLens);
          }
          // v4 pools are read via StateView (handled separately); skip here.
          return null;
        } catch {
          // Drop a pool that fails to read rather than failing the whole quote.
          return null;
        }
      }),
    );
    states.push(...batch);
  }

  const v3States = states.filter(
    (s): s is PoolState => s !== null && (s.liquidity > 0n || s.ticks.length > 0),
  );

  // Add the live MoleSwap v4 (MoleHook) WETH/USDG pool as a venue whenever WETH or USDG is on the path —
  // it competes on the direct pair and serves as a hub leg to USDG. Read via StateView.
  const touchesV4 = inT === w || outT === w || inT === USDG_LC || outT === USDG_LC;
  if (touchesV4) {
    try {
      const v4 = await fetchV4MolePool();
      if (v4 && (v4.liquidity > 0n || v4.ticks.length > 0)) v3States.push(v4);
    } catch {
      /* v4 read failed — quote on the V3 venues alone */
    }
  }

  // Any OTHER whitelisted MoleHook pool created via the operator flow and registered in mp_pools routes
  // automatically: its id is derived from the key, so no per-pool code. Fetch the ones on this path.
  const extraV4 = pools.filter(
    (p) =>
      p.venue === "mole_v4" &&
      p.active &&
      p.id?.toLowerCase() !== LIVE_POOL_ID.toLowerCase() && // live pool already handled above
      (isPair(p, inT, outT) ||
        isPair(p, inT, w) || isPair(p, outT, w) ||
        isPair(p, inT, USDG_LC) || isPair(p, outT, USDG_LC)),
  );
  for (const p of extraV4.slice(0, 8)) {
    try {
      const v4 = await fetchV4Pool({
        currency0: p.token0 as `0x${string}`,
        currency1: p.token1 as `0x${string}`,
        fee: p.fee,
        tickSpacing: p.tick_spacing,
        hooks: (p.hooks || MOLE_ADDRESSES.moleHook) as `0x${string}`,
      });
      if (v4 && (v4.liquidity > 0n || v4.ticks.length > 0)) v3States.push(v4);
    } catch {
      /* skip an unreadable v4 pool */
    }
  }

  return v3States;
}

export interface SwapQuoteRequest {
  tokenIn: string; // may be the NATIVE sentinel
  tokenOut: string; // may be the NATIVE sentinel
  amountIn: bigint;
  recipient: string;
  slippageBps: number;
  /** Aggregator fee the router skims from the output, in bps (read live from the fee dial). 0 = feeless. */
  feeBps?: number;
  weth: string;
  /** Unix seconds; defaults to Date.now()/1000 at call time. */
  nowSeconds?: bigint;
  ttlSeconds?: bigint;
}

export interface SwapQuote {
  quote: Quote;
  encoded: EncodedPlan;
  value: bigint;
}

/**
 * Price a swap and produce the exact `MoleRouter.swap` argument. Returns `null` if no route exists.
 *
 * @param pools the registry rows (loaded from Supabase by the caller/hook).
 */
export async function quoteSwap(pools: PoolRow[], req: SwapQuoteRequest): Promise<SwapQuote | null> {
  const now = req.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  const ttl = req.ttlSeconds ?? 300n;

  const states = await fetchRelevantPoolStates(pools, req.tokenIn, req.tokenOut, req.weth);
  if (states.length === 0) return null;

  let quote: Quote;
  try {
    quote = getQuote(states, {
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      amountIn: req.amountIn,
      recipient: req.recipient,
      nowSeconds: now,
      ttlSeconds: ttl,
      slippageBps: req.slippageBps,
      feeBps: req.feeBps ?? 0,
      weth: req.weth,
    });
  } catch {
    return null;
  }

  const { arg, value } = encodePlan(quote.plan);
  return { quote, encoded: arg, value };
}

export { NATIVE };
