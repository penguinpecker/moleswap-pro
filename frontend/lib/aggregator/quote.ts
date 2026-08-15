/**
 * quote.ts — the aggregator's front door. One call: "I have X of A and want B" → the best route, the
 * guaranteed minimum, and the executable plan.
 *
 * Everything underneath this has been proven exact against the live chain (the swap math to the wei, the
 * routing optimal for a concave curve). This layer only composes them and applies the one policy decision
 * a quote needs that the math cannot make for you: how much slippage to tolerate. It is pure — no network,
 * no clock — so a UI can call it on every keystroke, and a caller supplies the current pool state and the
 * current time explicitly rather than the quoter reaching for either.
 */

import { PoolGraph, bestSplitRoute, describeRoute, type SplitRoute } from "./route";
import type { PoolState } from "./venues/v3Pool";
import { planFromSplit, applyAggFee, type SwapPlan } from "./plan";

/** The sentinel a plan uses for native ETH, matching MoleRouter's NATIVE constant exactly. A request may
 *  set tokenIn or tokenOut to this; routing then happens over WETH and the executor wraps/unwraps. */
export const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export interface QuoteRequest {
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly recipient: string;
  /** Unix seconds now. The quoter adds `ttlSeconds` to get the on-chain deadline. */
  readonly nowSeconds: bigint;
  /** How long the resulting plan stays valid on-chain. */
  readonly ttlSeconds: bigint;
  /** Tolerated shortfall from the quoted output, in basis points. */
  readonly slippageBps: number;
  /** Aggregator fee the router skims from the output, in bps (read live from the fee dial; 0 = feeless). */
  readonly feeBps?: number;
  /** Search depth. Defaults are tuned to the live chain's WETH-star graph. */
  readonly maxHops?: number;
  readonly maxPaths?: number;
  readonly splitParts?: number;
  /** The WETH address, REQUIRED when tokenIn or tokenOut is NATIVE: routing happens over WETH, and the
   *  resulting plan carries the NATIVE sentinel so the executor wraps/unwraps at the edges. */
  readonly weth?: string;
}

export interface Quote {
  /** GROSS input — what the payer is debited. The fee comes out of this, not on top of it. */
  readonly amountIn: bigint;
  /** amountIn − feeAmount: what actually reaches the pools and what the route was priced on. */
  readonly netAmountIn: bigint;
  /** The route's full output against current pool state. Since the fee is taken on the INPUT, all of
   *  this goes to the recipient — this is the number to show as "you receive". */
  readonly amountOut: bigint;
  /** Identical to amountOut. Retained so existing consumers of "the number to show" keep working; it no
   *  longer differs, because nothing is skimmed from the output any more. */
  readonly netAmountOut: bigint;
  /** The aggregator fee applied, in bps, and its amount in the **INPUT** token.
   *  ⚠ Denominated in tokenIn, not tokenOut — format it with tokenIn's decimals. */
  readonly feeBps: number;
  readonly feeAmount: bigint;
  /** The floor the transaction enforces on-chain (computed on the full output). */
  readonly minAmountOut: bigint;
  /** How much of the trade nets against opposing pool liquidity vs. price impact — for display. */
  readonly split: SplitRoute;
  /** Human-readable "via A → WETH → B [0.05%]" lines, one per path. */
  readonly routeDescriptions: string[];
  /** The exact object to ABI-encode and send to MoleRouter.swap. */
  readonly plan: SwapPlan;
}

export class NoRouteError extends Error {
  constructor(tokenIn: string, tokenOut: string) {
    super(`no route from ${tokenIn} to ${tokenOut} in the current pool set`);
    this.name = "NoRouteError";
  }
}

/**
 * Produce a quote and an executable plan from a snapshot of pool state.
 *
 * @param pools the current routable set — already fetched by the indexer. Passed in rather than fetched
 *        here so the quoter stays pure and testable, and so a UI can quote many sizes against one snapshot.
 */
export function getQuote(pools: readonly PoolState[], req: QuoteRequest): Quote {
  if (req.amountIn <= 0n) throw new Error("amountIn must be positive");

  // Native ETH is a WETH wrapper at the edges: route over WETH, but keep NATIVE on the plan's outer
  // tokenIn/tokenOut so the executor knows to wrap the input and unwrap the output.
  const nativeIn = req.tokenIn.toLowerCase() === NATIVE.toLowerCase();
  const nativeOut = req.tokenOut.toLowerCase() === NATIVE.toLowerCase();
  if ((nativeIn || nativeOut) && !req.weth) {
    throw new Error("a native-ETH quote requires the weth address in the request");
  }
  const routeIn = nativeIn ? req.weth! : req.tokenIn;
  const routeOut = nativeOut ? req.weth! : req.tokenOut;
  if (routeIn.toLowerCase() === routeOut.toLowerCase()) throw new Error("effective tokenIn equals tokenOut");

  // THE FEE COMES OFF THE INPUT, so the route is computed on what will actually be swapped. The router
  // takes its cut in the source currency immediately after pulling the input and routes the remainder,
  // scaling each path pro-rata — so quoting the GROSS here would over-promise by exactly the fee.
  const feeBps = req.feeBps ?? 0;
  const clampedBps = feeBps > 100 ? 100 : feeBps < 0 ? 0 : feeBps; // mirror the router's MAX_FEE_BPS clamp
  const feeAmount = (req.amountIn * BigInt(clampedBps)) / 10_000n; // floor, like the contract
  const netAmountIn = req.amountIn - feeAmount;
  if (netAmountIn <= 0n) throw new Error("aggregator fee consumes the entire input");

  const graph = new PoolGraph(pools);
  const split = bestSplitRoute(graph, routeIn, routeOut, netAmountIn, {
    parts: req.splitParts ?? 10,
    maxHops: req.maxHops ?? 3,
    // 12 (was 8): with pool-disjoint split selection, more ranked candidates just give the selector more
    // non-overlapping pools to draw from — the cost is parts x paths pure-arithmetic quotes (120 vs 80),
    // microseconds. Covers tokens with many fee-tier pools without dropping a useful one at the margin.
    maxPaths: req.maxPaths ?? 12,
  });

  if (!split || split.amountOut <= 0n) throw new NoRouteError(req.tokenIn, req.tokenOut);

  // Build the plan with the ORIGINAL (possibly NATIVE) tokenIn/tokenOut on the outer fields; the hops
  // already reference WETH because the route was computed over it.
  const plan = planFromSplit(split, req.tokenIn, req.tokenOut, {
    recipient: req.recipient,
    deadline: req.nowSeconds + req.ttlSeconds,
    slippageBps: req.slippageBps,
    feeBps,
    // The plan's paths must sum to the GROSS input: the router checks that sum against plan.amountIn and
    // then scales each path down by (amountIn − fee)/amountIn itself. Scaling on-chain rather than here
    // is what lets the fee dial move between quote and execution without invalidating the plan.
    grossAmountIn: req.amountIn,
  });

  return {
    // What the payer is debited (gross) versus what actually reaches the pools (net).
    amountIn: req.amountIn,
    netAmountIn,
    // The route's FULL output — all of it goes to the recipient now that the fee is taken on the input.
    amountOut: split.amountOut,
    netAmountOut: split.amountOut,
    feeBps,
    // NOTE: denominated in the INPUT token, not the output. Consumers formatting this must use tokenIn's
    // decimals — using tokenOut's is a silent 10^12 error on a 6-vs-18 pair.
    feeAmount,
    minAmountOut: plan.minAmountOut,
    split,
    routeDescriptions: split.parts.map((r) => describeRoute(r)),
    plan,
  };
}
