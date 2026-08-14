/**
 * client.ts — the frontend's one call to price and build a swap.
 *
 * It threads the pieces that are each verified in isolation into a single flow: the pool registry (from
 * Supabase) says which pools exist, the indexer reads their live state over RPC, the quoter (exact against
 * the chain to the wei) picks the best route, and the plan encoder turns it into the exact `MoleRouter.swap`
 * argument. Nothing here re-implements math — it composes verified parts and applies one policy: slippage.
 */

import { getQuote, NATIVE, NoRouteError, type Quote } from "./quote";
import type { PoolState } from "./venues/v3Pool";
import { fetchV3StatesMulticall } from "./multicall";
import { fetchV4MolePool, fetchV4Pool, fetchV4PoolByKey } from "./venues/v4Reader";
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
  } catch (err) {
    /* discovery best-effort — fall back to the indexed set, but say so: a quote built from fewer venues
       than the chain actually has is a worse price, and silently swallowing this hid that. */
    console.warn(
      `[aggregator] pool discovery failed for ${tokenIn} -> ${tokenOut}; quoting on the indexed set only:`,
      err instanceof Error ? `${err.name}: ${err.message}` : err,
    );
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
  } catch (err) {
    /* multicall read failed — fall through to the v4 venues below rather than failing the whole quote */
    console.error(
      `[aggregator] v3 state multicall failed for ${v3Rows.length} pool(s) on ${tokenIn} -> ${tokenOut}; those venues are missing from this quote:`,
      err instanceof Error ? `${err.name}: ${err.message}` : err,
    );
  }

  // Always add the live MoleSwap v4 (MoleHook) WETH/USDG pool. It is the deepest WETH<->USDG venue and,
  // crucially, the WETH<->USDG BRIDGE edge: without it an arbitrary A->B where A routes via WETH and B via
  // USDG (or vice-versa) has no connecting hop and is falsely reported "no route". One StateView read that
  // only ever helps — so it is unconditional, not gated on WETH/USDG being an endpoint.
  try {
    const v4 = await fetchV4MolePool();
    if (v4 && (v4.liquidity > 0n || v4.ticks.length > 0)) v3States.push(v4);
  } catch (err) {
    /* v4 read failed — quote on the V3 venues alone */
    console.error(
      "[aggregator] the live MoleSwap v4 WETH/USDG pool could not be read; the WETH<->USDG bridge edge is missing from this quote:",
      err instanceof Error ? `${err.name}: ${err.message}` : err,
    );
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
    } catch (err) {
      /* skip an unreadable v4 pool */
      console.warn(
        `[aggregator] MoleHook v4 pool ${p.id} (fee ${p.fee}, spacing ${p.tick_spacing}) could not be read; excluded from this quote:`,
        err instanceof Error ? `${err.name}: ${err.message}` : err,
      );
    }
  }

  // ── External Uniswap-v4 pools, from the registry ──────────────────────────────────────────────
  // A v4 pool has no address, so it can never be found by asking a factory for one; the indexer
  // discovers them from the PoolManager's Initialize event and records the key. Only EXISTENCE comes
  // from the registry — state is read live from the chain here, exactly like the v3 multicall path.
  // Rows the router cannot execute (native-ETH currencies) or cannot honestly price (hooks carrying a
  // return-delta permission, which move tokens the tick math never sees) are marked inactive by the
  // indexer and therefore never reach this loop.
  const externalV4 = pools.filter(
    (p) =>
      (p as any).venue === "uniswap_v4" &&
      p.active &&
      (isPair(p, inT, outT) || isPair(p, inT, w) || isPair(p, outT, w)),
  );
  for (const p of externalV4.slice(0, 4)) {
    try {
      const st = await fetchV4PoolByKey({
        currency0: p.token0 as `0x${string}`,
        currency1: p.token1 as `0x${string}`,
        fee: p.fee,
        tickSpacing: p.tick_spacing,
        hooks: (p.hooks || "0x0000000000000000000000000000000000000000") as `0x${string}`,
      });
      if (st && (st.liquidity > 0n || st.ticks.length > 0)) v3States.push(st);
    } catch (err) {
      /* skip an unreadable pool rather than failing the quote */
      console.warn(
        `[aggregator] external v4 pool ${p.id} (fee ${p.fee}, spacing ${p.tick_spacing}) could not be read; excluded from this quote:`,
        err instanceof Error ? `${err.name}: ${err.message}` : err,
      );
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
 * The quoter itself failed — this is NOT "this pair has no liquidity".
 *
 * `quoteSwap` returns `null` for the one honest no-route case (`NoRouteError`: pools were read, no path
 * clears). EVERY other throw out of `getQuote` means something is wrong with US, not with the market:
 * a bad argument, the deliberate "incomplete route — re-fetch pool state and re-quote" signal from
 * plan.ts, or a plain programming error in the routing/tick math. Those used to be flattened into the
 * same `null`, so a live quoter regression was indistinguishable from an illiquid pair and every
 * consumer reported "No liquidity route found for this pair". They are now logged and thrown as this
 * type, so a caller can tell the two apart (`err instanceof QuoteFailedError`) and a bug shows up as a
 * 500 / an error log instead of hiding inside normal-looking 404 copy.
 *
 * Every existing caller already wraps `quoteSwap` in try/catch (the API routes turn it into a 500 with
 * the real message; `lib/chain/amm.ts` logs it and returns null; the swap card keeps its last price),
 * so nothing crashes — the failure just stops lying about its cause.
 */
export class QuoteFailedError extends Error {
  /** The original throw from the quoter, kept for logging/inspection. */
  readonly detail: unknown;
  constructor(detail: unknown) {
    super(
      detail instanceof Error
        ? `quote failed: ${detail.message}`
        : `quote failed: ${String(detail)}`,
    );
    this.name = "QuoteFailedError";
    this.detail = detail;
  }
}

/**
 * Price a swap and produce the exact `MoleRouter.swap` argument.
 *
 * Returns `null` ONLY when the pair genuinely has no route (no pool state at all, or the router found
 * no path that clears). Any unexpected failure inside the quoter is logged and rethrown as
 * {@link QuoteFailedError} rather than being disguised as "no liquidity".
 *
 * @param pools the registry rows (loaded from Supabase by the caller/hook).
 */
export async function quoteSwap(pools: PoolRow[], req: SwapQuoteRequest): Promise<SwapQuote | null> {
  const now = req.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  const ttl = req.ttlSeconds ?? 60n; // ~60s deadline; on a 0.1s-block chain 300s let stale intent fill

  const states = await fetchRelevantPoolStates(pools, req.tokenIn, req.tokenOut, req.weth);
  if (states.length === 0) {
    // Genuinely nothing to quote against. Still worth a line: it is also what an RPC outage looks like,
    // because every read inside fetchRelevantPoolStates is best-effort.
    console.warn(
      `[aggregator] quoteSwap: no pool state for ${req.tokenIn} -> ${req.tokenOut} (registry rows: ${pools.length}) — reporting no route`,
    );
    return null;
  }

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
  } catch (err) {
    // The ONE honest no-route case: pools were read and priced, no path clears. Callers keep showing
    // "no liquidity route" for this, exactly as before.
    if (err instanceof NoRouteError) return null;
    // Everything else is a defect on our side, not an empty market. Log it with the actual error (and
    // enough context to reproduce), then rethrow it as a distinct type so no caller can mistake it for
    // an illiquid pair.
    console.error(
      "[aggregator] quoteSwap: the quoter threw — this is a QUOTER FAILURE, not 'no liquidity'",
      {
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn.toString(),
        slippageBps: req.slippageBps,
        feeBps: req.feeBps ?? 0,
        poolStates: states.length,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
    );
    throw new QuoteFailedError(err);
  }

  const { arg, value } = encodePlan(quote.plan);
  return { quote, encoded: arg, value };
}

export { NATIVE };
