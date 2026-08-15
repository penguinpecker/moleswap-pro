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
  /**
   * The GROSS input the payer supplies, when it differs from the split's amountIn. The split is priced on
   * the NET (gross − fee) because that is what the router swaps, but the plan must declare the gross and
   * let the router scale the slices down itself. Omit when there is no fee.
   */
  readonly grossAmountIn?: bigint;
  /**
   * The aggregator fee the router takes from the INPUT, in basis points (read live from the fee dial).
   * It no longer affects minAmountOut — the fee is removed before the swap, so the whole route output
   * reaches the recipient and the floor is computed on all of it. Retained because callers pass it and
   * it is reported back on the quote. Defaults to 0 (feeless router) when omitted.
   */
  readonly feeBps?: number;
}

/** The output the recipient actually receives after the router's aggregator-fee skim (floors, like the contract). */
export function applyAggFee(amountOut: bigint, feeBps: number): bigint {
  if (!feeBps || feeBps <= 0) return amountOut;
  const bps = feeBps > 100 ? 100 : feeBps; // mirror the router's MAX_FEE_BPS clamp
  const fee = (amountOut * BigInt(bps)) / 10_000n;
  return amountOut - fee;
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
    minAmountOut: minOutFor(applyAggFee(route.amountOut, opts.feeBps ?? 0), opts.slippageBps),
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
  // The split was computed on the NET input (gross − fee), because that is what the router actually
  // swaps. The plan, however, must declare the GROSS: the contract checks the path slices against
  // plan.amountIn and then scales each one down by (amountIn − fee)/amountIn itself. So scale the
  // slices back up here, in the same proportions.
  const gross = opts.grossAmountIn ?? split.amountIn;
  const amounts: bigint[] = split.parts.map((r) =>
    gross === split.amountIn ? r.amountIn : (r.amountIn * gross) / split.amountIn,
  );
  if (gross !== split.amountIn && amounts.length > 0) {
    // Per-slice rounding leaves the sum a few wei short of gross; the contract demands EXACT, so the
    // last slice absorbs the remainder. The router scales it straight back down, and its sweep returns
    // any wei that rounding leaves unrouted — so this cannot strand value either way.
    const summedScaled = amounts.reduce((a, b) => a + b, 0n);
    amounts[amounts.length - 1] += gross - summedScaled;
  }
  const paths: PlanPath[] = split.parts.map((r, i) => ({
    amountIn: amounts[i],
    hops: r.hops.map(hopToPlan),
  }));
  // The contract requires the path slices to sum to amountIn EXACTLY. The scaling above is built to
  // guarantee it, but a translation layer that silently disagreed with the contract's own check is
  // exactly the kind of seam bug worth an assertion, so verify it here too.
  const summed = paths.reduce((a, p) => a + p.amountIn, 0n);
  if (summed !== gross) {
    throw new Error(`path slices ${summed} do not sum to amountIn ${gross}`);
  }
  return {
    tokenIn,
    tokenOut,
    amountIn: gross,
    // NOT post-fee any more: the fee was already removed from the input, so the whole route output
    // belongs to the recipient and the floor is computed on all of it.
    minAmountOut: minOutFor(split.amountOut, opts.slippageBps),
    recipient: opts.recipient,
    deadline: opts.deadline,
    paths,
  };
}
