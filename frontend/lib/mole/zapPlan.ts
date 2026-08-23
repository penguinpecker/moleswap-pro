"use client";
/**
 * zapPlan.ts — the arithmetic of a one-token deposit into the ALM, with every bound anchored to the
 * TWAP and nothing anchored to spot.
 *
 * This is the half of `almDeposit` that decides what the user is promising. It is pure on purpose:
 * the numbers that reach `MolePositions.zapOpen` are the numbers this file computes, so they must be
 * testable against a manipulated pool without a chain, a wallet or a browser.
 *
 * WHAT ZAPOPEN ACTUALLY GUARANTEES, because the shape of the fix follows from it. `zapOpen` pulls
 * `amountIn`, swaps `swapAmount` of it inside the pool, mints from what is left plus the swap output,
 * and returns the remainder. `_validateRange` checks only WIDTH and SPACING — there is no price gate
 * on the deposit path at all. So the ONLY two things standing between a depositor and a walked price
 * are `amountOutMin` (checked against the swap's realised output in ZapLogic) and `minLiquidity`
 * (checked against what was actually minted). Both are caller-supplied. Both used to be built from
 * `slot0`, and `minLiquidity` was the literal 1 — which is not a bound, it is a placeholder that reads
 * like one. A skewed pool therefore cleared its own `amountOutMin` by construction and minted whatever
 * it liked past a floor of one wei of liquidity.
 *
 * SO: the range is centred on the TWAP tick, `amountOutMin` is the TWAP-priced expectation less the
 * user's slippage, and `minLiquidity` is the liquidity the WORST swap this bound still permits would
 * mint at the TWAP price, less a stated margin. Every one of those numbers moves only if the pool's
 * time-averaged price moves, and a same-transaction swap contributes exactly zero to that.
 */
import { getSqrtRatioAtTick } from "@/lib/aggregator/math/tickMath";
import { applySlippageFloor } from "./format";
import { getLiquidityForAmounts } from "./seedLiquidity";
import {
  BoundTooSmallError,
  assertAnchorUsable,
  expectedOutAtSqrtPrice,
  type PriceAnchor,
} from "./priceAnchor";

/** Half-width of the deposit range, in ticks. Full width 30 000 — inside the live [120, 60000] band. */
export const RANGE_HALF_WIDTH = 15_000;

/** Default slippage on the zap's swap leg, in bps. */
export const DEFAULT_SLIPPAGE_BPS = 100;

/**
 * How far below the TWAP-priced worst case `minLiquidity` is allowed to sit, in bps.
 *
 * It is NOT a second slippage allowance — the swap's slippage is already inside the amounts this floor
 * is computed from. It absorbs the two things that can still legitimately land the mint under a bound
 * computed at the time-averaged price: (a) the swap itself moves the pool, so the mint happens a little
 * off the TWAP and the BINDING leg of `min(L0, L1)` may not be the one the TWAP arithmetic picked, and
 * (b) v4 rounds the amounts it pulls UP while liquidity is floored. Over the 30 000-tick range above,
 * liquidity moves roughly one-for-one with price, so 300 bps covers a swap that lands the full 100 bps
 * of permitted slippage away and then some. Erring tight is the safe direction: too tight reverts the
 * deposit in the pre-send simulation, where the user sees it and keeps their tokens.
 */
export const ZAP_MIN_LIQUIDITY_MARGIN_BPS = 300;

const MAX_UINT128 = (1n << 128n) - 1n;

/** The `ZapParams` tuple, exactly as `molePositionsAbi.zapOpen` expects it. */
export interface ZapPlan {
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly zeroForOne: boolean;
  readonly amountIn: bigint;
  readonly swapAmount: bigint;
  readonly minLiquidity: bigint;
  readonly amountOutMin: bigint;
  /** What the bound was built from, carried so a caller can show its reasoning. */
  readonly anchor: PriceAnchor;
  /** The TWAP-priced expectation `amountOutMin` was shaved from — display only. */
  readonly expectedOut: bigint;
}

/**
 * Build the deposit's ticks and bounds from `anchor`, for `amountIn` raw units of the input leg.
 *
 * REFUSES, rather than bounding, when the anchor says the pool looks manipulated: the swap would
 * execute at the price we distrust, so a correct bound just means paying gas to revert. Refuses again
 * if the amount is too small for `minLiquidity` to be anything but zero — a floor of zero is the same
 * non-bound as a floor of one, and shipping it would put the placeholder straight back.
 *
 * @param zeroForOne true when the deposited token is the pool's currency0 (WETH on the live pool).
 */
export function buildZapPlan(params: {
  anchor: PriceAnchor;
  zeroForOne: boolean;
  amountIn: bigint;
  tickSpacing: number;
  slippageBps?: number;
  rangeHalfWidthTicks?: number;
}): ZapPlan {
  const { anchor, zeroForOne, amountIn, tickSpacing } = params;
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const halfWidth = params.rangeHalfWidthTicks ?? RANGE_HALF_WIDTH;

  // THE REFUSAL, first, before a single number is derived. Everything below prices against the TWAP,
  // so a manipulated pool would produce a CORRECT bound that the manipulated swap simply cannot meet —
  // an on-chain revert the user pays gas for. Saying so here is the honest answer.
  assertAnchorUsable(anchor);

  if (typeof amountIn !== "bigint" || amountIn <= 0n) throw new Error(`amountIn must be a positive bigint`);
  if (!Number.isInteger(tickSpacing) || tickSpacing < 1) throw new Error(`invalid tickSpacing ${tickSpacing}`);

  // CENTRED ON THE TWAP, NOT SPOT. The range decides which side of the market the deposit ends up on;
  // centring it on a walked spot hands that choice to whoever walked it. Spot is within
  // `maxTwapDeviationTicks` of the TWAP by the time we get here (the assert above), so the post-swap
  // price still sits comfortably inside a 30 000-tick range.
  const center = Math.round(anchor.twapTick / tickSpacing) * tickSpacing;
  const half = Math.round(halfWidth / tickSpacing) * tickSpacing;
  const tickLower = center - half;
  const tickUpper = center + half;

  const swapAmount = amountIn / 2n;

  // amountOutMin — the REAL slippage bound, priced at WHICHEVER OF THE TWAP AND SPOT IS BETTER FOR US.
  //
  // Pricing at the TWAP alone was the obvious fix and it is only half right. It does defeat a spot
  // walked DOWN: the bound stays at the time-averaged price, the swap cannot clear it, and the deposit
  // reverts instead of settling against a price the attacker chose. But the bound is symmetric, and in
  // the mirror direction it LOOSENS by the entire drift the gate permits — with spot 600 ticks ABOVE
  // the TWAP the honest output is about 6.8% richer than the TWAP says, so a TWAP-priced floor hands
  // that difference to a sandwicher. Measured on 1 WETH: 676 bps extractable at the gate's limit,
  // against 100 bps for the spot-priced bound this replaced. That is the same defect this fix exists to
  // close, mirrored — and cheaper to run, because it needs one atomic sandwich rather than a skew held
  // across blocks.
  //
  // `max` strictly dominates both. A spot walked DOWN loses to the TWAP, so the theft stays blocked. A
  // spot walked UP can only RAISE the floor, and a floor too high fails closed — `simulateContract`
  // refuses before the user is ever asked to sign. Both of the attacker's directions are dead ends.
  const twapPriced = expectedOutAtSqrtPrice(anchor.twapSqrtPriceX96, swapAmount, zeroForOne);
  const spotPriced = expectedOutAtSqrtPrice(anchor.spotSqrtPriceX96, swapAmount, zeroForOne);
  const expectedOut = twapPriced > spotPriced ? twapPriced : spotPriced;
  const amountOutMin = applySlippageFloor(expectedOut, slippageBps);

  // minLiquidity — a real floor, derived, not the literal 1 that used to stand in for one. Value the
  // WORST swap `amountOutMin` still permits at the TWAP price, alongside the half that was never
  // swapped, and ask what that mints over this range.
  const keptIn = amountIn - swapAmount;
  const worst0 = zeroForOne ? keptIn : amountOutMin;
  const worst1 = zeroForOne ? amountOutMin : keptIn;
  const worstLiquidity = getLiquidityForAmounts(
    anchor.twapSqrtPriceX96,
    getSqrtRatioAtTick(tickLower),
    getSqrtRatioAtTick(tickUpper),
    worst0,
    worst1,
  );
  const minLiquidity = applySlippageFloor(worstLiquidity, ZAP_MIN_LIQUIDITY_MARGIN_BPS);
  // ONE refusal, on the number furthest downstream, because it subsumes every earlier one. A deposit too
  // small to buy a single raw unit of the other leg floors `amountOutMin` to zero, and a deposit too
  // small to have a swap half at all floors `swapAmount` to zero — either way one side of
  // `min(L0, L1)` is derived from a zero amount and the whole floor collapses to zero, which lands here.
  // Guards for those two upstream cases were written first and then deleted: mutation testing killed
  // nothing with them gone, because nothing could reach them, and a guard no test can tell apart from
  // its neighbour is not a guard (the same transitive-enforcement argument MolePositions.zapOpen makes
  // about its own floor re-check). A floor of zero is exactly as much of a bound as the `1` that used to
  // sit here, so it is refused, not shipped.
  if (minLiquidity <= 0n) throw new BoundTooSmallError("This deposit");
  if (minLiquidity > MAX_UINT128) throw new Error(`minLiquidity overflows uint128`);

  return { tickLower, tickUpper, zeroForOne, amountIn, swapAmount, minLiquidity, amountOutMin, anchor, expectedOut };
}
