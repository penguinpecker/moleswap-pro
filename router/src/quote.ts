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

import { PoolGraph, bestSplitRoute, describeRoute, type SplitRoute } from "./route.js";
import type { PoolState } from "./venues/v3Pool.js";
import { planFromSplit, type SwapPlan } from "./plan.js";

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
  /** Search depth. Defaults are tuned to the live chain's WETH-star graph. */
  readonly maxHops?: number;
  readonly maxPaths?: number;
  readonly splitParts?: number;
}

export interface Quote {
  readonly amountIn: bigint;
  /** The quoted output, exact against current pool state. */
  readonly amountOut: bigint;
  /** The floor the transaction enforces on-chain. The user cannot receive less and have the tx succeed. */
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
  if (req.tokenIn.toLowerCase() === req.tokenOut.toLowerCase()) throw new Error("tokenIn equals tokenOut");

  const graph = new PoolGraph(pools);
  const split = bestSplitRoute(graph, req.tokenIn, req.tokenOut, req.amountIn, {
    parts: req.splitParts ?? 10,
    maxHops: req.maxHops ?? 3,
    maxPaths: req.maxPaths ?? 8,
  });

  if (!split || split.amountOut <= 0n) throw new NoRouteError(req.tokenIn, req.tokenOut);

  const plan = planFromSplit(split, req.tokenIn, req.tokenOut, {
    recipient: req.recipient,
    deadline: req.nowSeconds + req.ttlSeconds,
    slippageBps: req.slippageBps,
  });

  return {
    amountIn: split.amountIn,
    amountOut: split.amountOut,
    minAmountOut: plan.minAmountOut,
    split,
    routeDescriptions: split.parts.map((r) => describeRoute(r)),
    plan,
  };
}
