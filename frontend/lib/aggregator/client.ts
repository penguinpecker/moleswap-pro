/**
 * client.ts — the frontend's one call to price and build a swap.
 *
 * It threads the pieces that are each verified in isolation into a single flow: the pool registry (from
 * Supabase) says which pools exist, the indexer reads their live state over RPC, the quoter (exact against
 * the chain to the wei) picks the best route, and the plan encoder turns it into the exact `MoleRouter.swap`
 * argument. Nothing here re-implements math — it composes verified parts and applies one policy: slippage.
 */

import { getQuote, NATIVE, type Quote } from "./quote";
import type { PoolState } from "./venues/v3Pool";
import { fetchV3StatesMulticall } from "./multicall";
import { fetchV4MolePool, fetchV4Pool } from "./venues/v4Reader";
import { discoverForPair } from "./discover";
import { encodePlan, type EncodedPlan } from "./router";
import { LIVE_POOL_ID, MOLE_ADDRESSES } from "../mole/chain";

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
  rpcUrl?: string,
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
  // Cap generously — Multicall discovery is bounded and the RPC handles the fan-out — but keep a
  // ceiling so a pathological pair can't fetch hundreds of pool states.
  const capped = [...byAddr.values()].slice(0, 48);

  // Read every V3-style pool's live state in TWO aggregate3 round trips total (not one fetch per pool).
  // Any Uniswap-V3-style pool (Pancake or Uniswap V3 forks) is read the same way and executed by
  // MoleRouter's shared V3 callback. The immutables (tokens/fee/spacing) come from the registry/discovery
  // rows, so only slot0 + liquidity + the tick window are read here. This is the SAME multicall the live
  // session uses, so the route the card shows and the route that executes are built identically and fast.
  const v3Rows = capped.filter(
    (p) => (p.venue === "pancake_v3" || p.venue === "uniswap_v3") && p.address,
  );
  let v3States: PoolState[] = [];
  try {
    v3States = await fetchV3StatesMulticall(
      v3Rows.map((p) => ({
        address: p.address as string,
        token0: p.token0,
        token1: p.token1,
        fee: p.fee,
        tickSpacing: p.tick_spacing,
      })),
      rpcUrl,
    );
  } catch {
    /* multicall read failed — fall through to the v4 venues below rather than failing the whole quote */
  }

  // Always add the live MoleSwap v4 (MoleHook) WETH/USDG pool. It is the deepest WETH<->USDG venue and,
  // crucially, the WETH<->USDG BRIDGE edge: without it an arbitrary A->B where A routes via WETH and B via
  // USDG (or vice-versa) has no connecting hop and is falsely reported "no route". One StateView read that
  // only ever helps — so it is unconditional, not gated on WETH/USDG being an endpoint.
  try {
    const v4 = await fetchV4MolePool();
    if (v4 && (v4.liquidity > 0n || v4.ticks.length > 0)) v3States.push(v4);
  } catch {
    /* v4 read failed — quote on the V3 venues alone */
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
  const ttl = req.ttlSeconds ?? 60n; // ~60s deadline; on a 0.1s-block chain 300s let stale intent fill

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
