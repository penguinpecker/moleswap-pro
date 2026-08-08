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
import { encodePlan, type EncodedPlan } from "./router";
import { PANCAKE_V3 } from "../mole/chain";

/** A pool row as stored in Supabase `mp_pools`. */
export interface PoolRow {
  id: string;
  venue: "pancake_v3" | "mole_v4";
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

/**
 * Fetch the live state of every registry pool that could sit on a route between `tokenIn` and `tokenOut`.
 * For the WETH-star graph on this chain that is: any pool containing either token, plus (implicitly) the
 * WETH hub pools — so we simply fetch every active pool that touches either endpoint or WETH.
 */
export async function fetchRelevantPoolStates(
  pools: PoolRow[],
  tokenIn: string,
  tokenOut: string,
  weth: string,
  transport = new FetchTransport(),
): Promise<PoolState[]> {
  const endpoints = new Set([lc(tokenIn), lc(tokenOut), lc(weth)]);
  const relevant = pools.filter(
    (p) => p.active && (endpoints.has(lc(p.token0)) || endpoints.has(lc(p.token1))),
  );

  const states = await Promise.all(
    relevant.map(async (p) => {
      try {
        if (p.venue === "pancake_v3" && p.address) {
          return await fetchV3Pool(transport, p.address, PANCAKE_V3.tickLens);
        }
        // v4 pools are read differently and are inactive today; skip until the indexer service handles them.
        return null;
      } catch {
        // A pool that fails to read is dropped rather than failing the whole quote — the route search
        // simply has one fewer candidate.
        return null;
      }
    }),
  );
  return states.filter((s): s is PoolState => s !== null && (s.liquidity > 0n || s.ticks.length > 0));
}

export interface SwapQuoteRequest {
  tokenIn: string; // may be the NATIVE sentinel
  tokenOut: string; // may be the NATIVE sentinel
  amountIn: bigint;
  recipient: string;
  slippageBps: number;
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
      weth: req.weth,
    });
  } catch {
    return null;
  }

  const { arg, value } = encodePlan(quote.plan);
  return { quote, encoded: arg, value };
}

export { NATIVE };
