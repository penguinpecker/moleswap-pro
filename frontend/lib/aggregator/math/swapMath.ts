/**
 * swapMath.ts — exact ports of Uniswap v3's SqrtPriceMath and SwapMath.
 *
 * ROUNDING IS THE ENTIRE SUBJECT OF THIS FILE. Every function below rounds in a specific direction, and
 * the direction is always "in the pool's favour". That is not a detail to tidy up later: an aggregator
 * that rounds the other way produces quotes the pool will not honour, which surface to the user as a
 * revert on `minOut` after they have already paid gas — the worst possible place to discover an
 * off-by-one. Where the Solidity uses mulDivRoundingUp, so does this.
 *
 * Ported from Uniswap v3-core SqrtPriceMath.sol and SwapMath.sol. PancakeSwap V3 is a v3 fork and uses
 * the identical math, so one implementation serves both venues on Robinhood Chain.
 */

const Q96 = 2n ** 96n;
const MAX_UINT160 = (1n << 160n) - 1n;

function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  const product = a * b;
  const result = product / denominator;
  return product % denominator === 0n ? result : result + 1n;
}

/**
 * The next sqrt price when `amount` of token0 is added to (or removed from) the pool.
 *
 * `add` true  -> token0 comes IN, price goes DOWN (selling token0).
 * `add` false -> token0 goes OUT, price goes UP.
 */
export function getNextSqrtPriceFromAmount0RoundingUp(
  sqrtPX96: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean,
): bigint {
  if (amount === 0n) return sqrtPX96;
  const numerator1 = liquidity << 96n;

  if (add) {
    const product = amount * sqrtPX96;
    // The cheap path is only valid when the product did not overflow uint256 in the Solidity; here it
    // cannot overflow, but the BRANCH must be preserved because the two formulas round differently.
    if (product / amount === sqrtPX96) {
      const denominator = numerator1 + product;
      if (denominator >= numerator1) {
        return mulDivRoundingUp(numerator1, sqrtPX96, denominator);
      }
    }
    return mulDivRoundingUp(numerator1, 1n, numerator1 / sqrtPX96 + amount);
  }

  const product = amount * sqrtPX96;
  if (!(product / amount === sqrtPX96 && numerator1 > product)) {
    throw new Error("getNextSqrtPriceFromAmount0RoundingUp: price overflow");
  }
  const denominator = numerator1 - product;
  return mulDivRoundingUp(numerator1, sqrtPX96, denominator);
}

/**
 * The next sqrt price when `amount` of token1 is added to (or removed from) the pool.
 *
 * `add` true  -> token1 comes IN, price goes UP (selling token1).
 */
export function getNextSqrtPriceFromAmount1RoundingDown(
  sqrtPX96: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean,
): bigint {
  if (add) {
    const quotient = amount <= MAX_UINT160 ? (amount << 96n) / liquidity : (amount * Q96) / liquidity;
    return sqrtPX96 + quotient;
  }
  const quotient =
    amount <= MAX_UINT160
      ? mulDivRoundingUp(amount << 96n, 1n, liquidity)
      : mulDivRoundingUp(amount, Q96, liquidity);
  if (sqrtPX96 <= quotient) throw new Error("getNextSqrtPriceFromAmount1RoundingDown: price underflow");
  return sqrtPX96 - quotient;
}

/** Amount of token0 between two prices. `roundUp` when the pool is owed it. */
export function getAmount0Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtRatioBX96 - sqrtRatioAX96;
  if (sqrtRatioAX96 <= 0n) throw new Error("getAmount0Delta: sqrtRatioAX96 must be > 0");

  return roundUp
    ? mulDivRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtRatioBX96), 1n, sqrtRatioAX96)
    : (numerator1 * numerator2) / sqrtRatioBX96 / sqrtRatioAX96;
}

/** Amount of token1 between two prices. */
export function getAmount1Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  return roundUp
    ? mulDivRoundingUp(liquidity, sqrtRatioBX96 - sqrtRatioAX96, Q96)
    : (liquidity * (sqrtRatioBX96 - sqrtRatioAX96)) / Q96;
}

export interface SwapStepResult {
  readonly sqrtRatioNextX96: bigint;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly feeAmount: bigint;
}

/**
 * One swap step within a single tick range — the innermost loop of a v3 swap.
 *
 * @param sqrtRatioCurrentX96 where the pool is now
 * @param sqrtRatioTargetX96  the price this step may not pass (the next initialised tick, or the limit)
 * @param liquidity           in-range liquidity for this step
 * @param amountRemaining     positive for exactIn, negative for exactOut
 * @param feePips             the pool's fee in hundredths of a bip (500 = 0.05%)
 */
export function computeSwapStep(
  sqrtRatioCurrentX96: bigint,
  sqrtRatioTargetX96: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  feePips: number,
): SwapStepResult {
  const zeroForOne = sqrtRatioCurrentX96 >= sqrtRatioTargetX96;
  const exactIn = amountRemaining >= 0n;
  const FEE_DENOM = 1_000_000n;
  const fee = BigInt(feePips);

  let sqrtRatioNextX96: bigint;
  let amountIn = 0n;
  let amountOut = 0n;

  if (exactIn) {
    // The fee is taken off the INPUT before it is swapped, rounding up, so the pool keeps the dust.
    const amountRemainingLessFee = (amountRemaining * (FEE_DENOM - fee)) / FEE_DENOM;
    amountIn = zeroForOne
      ? getAmount0Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, true)
      : getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, true);

    if (amountRemainingLessFee >= amountIn) {
      // This step consumes the whole range: we reach the target price exactly.
      sqrtRatioNextX96 = sqrtRatioTargetX96;
    } else {
      sqrtRatioNextX96 = getNextSqrtPriceFromInput(
        sqrtRatioCurrentX96,
        liquidity,
        amountRemainingLessFee,
        zeroForOne,
      );
    }
  } else {
    amountOut = zeroForOne
      ? getAmount1Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, false)
      : getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, false);
    const wanted = -amountRemaining;
    if (wanted >= amountOut) {
      sqrtRatioNextX96 = sqrtRatioTargetX96;
    } else {
      sqrtRatioNextX96 = getNextSqrtPriceFromOutput(sqrtRatioCurrentX96, liquidity, wanted, zeroForOne);
    }
  }

  const max = sqrtRatioTargetX96 === sqrtRatioNextX96;

  if (zeroForOne) {
    amountIn = max && exactIn ? amountIn : getAmount0Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, true);
    amountOut =
      max && !exactIn ? amountOut : getAmount1Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, false);
  } else {
    amountIn = max && exactIn ? amountIn : getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, true);
    amountOut =
      max && !exactIn ? amountOut : getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, false);
  }

  // An exactOut swap must never hand out more than was asked for.
  if (!exactIn && amountOut > -amountRemaining) {
    amountOut = -amountRemaining;
  }

  let feeAmount: bigint;
  if (exactIn && sqrtRatioNextX96 !== sqrtRatioTargetX96) {
    // Did not reach the target: the remainder of the input IS the fee. Not recomputed from a
    // percentage — that would leave a wei behind and desynchronise the running total.
    feeAmount = amountRemaining - amountIn;
  } else {
    feeAmount = mulDivRoundingUp(amountIn, fee, FEE_DENOM - fee);
  }

  return { sqrtRatioNextX96, amountIn, amountOut, feeAmount };
}

export function getNextSqrtPriceFromInput(
  sqrtPX96: bigint,
  liquidity: bigint,
  amountIn: bigint,
  zeroForOne: boolean,
): bigint {
  if (sqrtPX96 <= 0n) throw new Error("sqrtPX96 must be > 0");
  if (liquidity <= 0n) throw new Error("liquidity must be > 0");
  return zeroForOne
    ? getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountIn, true)
    : getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountIn, true);
}

export function getNextSqrtPriceFromOutput(
  sqrtPX96: bigint,
  liquidity: bigint,
  amountOut: bigint,
  zeroForOne: boolean,
): bigint {
  if (sqrtPX96 <= 0n) throw new Error("sqrtPX96 must be > 0");
  if (liquidity <= 0n) throw new Error("liquidity must be > 0");
  return zeroForOne
    ? getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountOut, false)
    : getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountOut, false);
}
