/**
 * plan.ts — turn a chosen route into the exact SwapPlan the on-chain MoleRouter executes.
 *
 * This is the seam between off-chain routing and on-chain execution, and it is deliberately dumb: it does
 * no math, it just translates. All the value judgement happened in `route.ts`; all the safety lives in
 * MoleRouter's minAmountOut. This file's only job is to not corrupt the translation — a hop pointed at the
 * wrong pool, a v4 key left off, or a slippage floor computed the wrong way would each turn a good route
 * into a failed or unsafe transaction.
 *
 * The struct field order and types mirror `MoleRouter.SwapPlan` exactly, so an ABI encoder can serialise
 * the object returned here with no reshaping. The Solidity is the source of truth; if it changes, this
 * changes with it, and the round-trip test in the contract repo is what keeps them honest.
 */

import type { Route, SplitRoute } from "./route";

/** Mirrors `MoleRouter.Venue`. */
export enum PlanVenue {
  PancakeV3 = 0,
  UniswapV4 = 1,
}

/** Mirrors `PoolKey`. Zeroed for a PancakeV3 hop. */
export interface PlanPoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

/** Mirrors `MoleRouter.Hop`. */
export interface PlanHop {
  venue: PlanVenue;
  pool: string;
  zeroForOne: boolean;
  tokenIn: string;
  tokenOut: string;
  key: PlanPoolKey;
}

/** Mirrors `MoleRouter.Path`. */
export interface PlanPath {
  amountIn: bigint;
  hops: PlanHop[];
}

/** Mirrors `MoleRouter.SwapPlan`. */
export interface SwapPlan {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut: bigint;
  recipient: string;
  deadline: bigint;
  paths: PlanPath[];
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_KEY: PlanPoolKey = {
  currency0: ZERO_ADDRESS,
  currency1: ZERO_ADDRESS,
  fee: 0,
  tickSpacing: 0,
  hooks: ZERO_ADDRESS,
};

export interface PlanOptions {
  readonly recipient: string;
  /** Unix seconds. The plan is rejected on-chain after this. */
  readonly deadline: bigint;
  /** Tolerated shortfall from the quoted output, in basis points. 50 = 0.5%. */
  readonly slippageBps: number;
}

function hopToPlan(hop: Route["hops"][number]): PlanHop {
  const pool = hop.pool;
  const isV4 = pool.venue === "UniswapV4";
  if (isV4 && !pool.poolKey) {
    // A v4 hop with no key would encode as address(0)/zeroed-key and the contract would swap the wrong
    // pool. Fail here, loudly, rather than build a plan that executes against nothing.
    throw new Error(`v4 hop through ${pool.address} is missing its poolKey`);
  }
  // Addresses are normalised to lowercase throughout the plan. On-chain an address is 20 bytes and
  // casing is meaningless (EIP-55 checksums live only in the string form), so a consistent lowercase
  // form avoids a hop whose `pool` and `tokenIn` disagree in casing purely because they came from
  // different layers — a cosmetic inconsistency that reads as a bug in a diff.
  const lc = (a: string) => a.toLowerCase();
  return {
    venue: isV4 ? PlanVenue.UniswapV4 : PlanVenue.PancakeV3,
    // The contract identifies a v4 pool by its key, not an address, so the address field is unused there.
    pool: isV4 ? ZERO_ADDRESS : lc(pool.address),
    zeroForOne: hop.zeroForOne,
    tokenIn: lc(hop.tokenIn),
    tokenOut: lc(hop.tokenOut),
    key: isV4
      ? {
          currency0: lc(pool.poolKey!.currency0),
          currency1: lc(pool.poolKey!.currency1),
          fee: pool.poolKey!.fee,
          tickSpacing: pool.poolKey!.tickSpacing,
          hooks: lc(pool.poolKey!.hooks),
        }
      : ZERO_KEY,
  };
}

/**
 * The minimum output to demand on-chain, given a quoted output and a slippage tolerance.
 *
 * Floors, always. Rounding the floor UP would occasionally set minOut ABOVE what the pool can deliver at
 * the quoted price and revert a swap that should have succeeded; rounding down only ever loosens the
 * bound by a wei, which the user already accepted by choosing a slippage tolerance at all.
 */
export function minOutFor(amountOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 10_000) throw new Error(`slippageBps ${slippageBps} out of range`);
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** Build the SwapPlan for a single-path route. */
export function planFromRoute(
  route: Route,
  tokenIn: string,
  tokenOut: string,
  opts: PlanOptions,
): SwapPlan {
  if (route.incomplete) {
    // An incomplete quote priced against liquidity we could not see. Executing it would set minOut off a
    // number the chain never promised. Refuse to build a plan from it.
    throw new Error("cannot build a plan from an incomplete route; re-fetch pool state and re-quote");
  }
  return {
    tokenIn,
    tokenOut,
    amountIn: route.amountIn,
    minAmountOut: minOutFor(route.amountOut, opts.slippageBps),
    recipient: opts.recipient,
    deadline: opts.deadline,
    paths: [{ amountIn: route.amountIn, hops: route.hops.map(hopToPlan) }],
  };
}

/** Build the SwapPlan for a split route across several paths. */
export function planFromSplit(
  split: SplitRoute,
  tokenIn: string,
  tokenOut: string,
  opts: PlanOptions,
): SwapPlan {
  if (split.incomplete) {
    throw new Error("cannot build a plan from an incomplete split; re-fetch pool state and re-quote");
  }
  const paths: PlanPath[] = split.parts.map((r) => ({
    amountIn: r.amountIn,
    hops: r.hops.map(hopToPlan),
  }));
  // The contract requires the path slices to sum to amountIn EXACTLY. route.ts already guarantees this,
  // but a translation layer that silently disagreed with the contract's own check is exactly the kind of
  // seam bug worth an assertion, so verify it here too.
  const summed = paths.reduce((a, p) => a + p.amountIn, 0n);
  if (summed !== split.amountIn) {
    throw new Error(`path slices ${summed} do not sum to amountIn ${split.amountIn}`);
  }
  return {
    tokenIn,
    tokenOut,
    amountIn: split.amountIn,
    minAmountOut: minOutFor(split.amountOut, opts.slippageBps),
    recipient: opts.recipient,
    deadline: opts.deadline,
    paths,
  };
}
