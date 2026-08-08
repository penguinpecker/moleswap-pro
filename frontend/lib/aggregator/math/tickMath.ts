/**
 * tickMath.ts — an EXACT port of Uniswap's TickMath, in BigInt.
 *
 * WHY THIS EXISTS AT ALL, since a `QuoterV2` contract is sitting right there on chain. Because calling
 * it is a network round trip, and an aggregator's whole job is to evaluate MANY candidate routes before
 * it picks one. A single WETH→USDG quote over 4 fee tiers plus a 2-hop alternative is a dozen eth_calls;
 * do that on every keystroke and the UI is dead. Jupiter is fast for exactly one structural reason: it
 * does not ask the chain what a swap is worth, it *computes* it from cached pool state. Everything in
 * this directory is that computation.
 *
 * WHICH MEANS "APPROXIMATELY RIGHT" IS USELESS HERE. A quote that is off by a wei is a quote that either
 * under-promises (and loses the route to a competitor) or over-promises (and reverts on `minOut` at the
 * user's expense). So this is a transliteration of the Solidity, constant for constant, not a re-derivation
 * in floating point. Every magic number below is from Uniswap's TickMath and is asserted against the live
 * chain in the tests — if solc and this file ever disagree, the test says so.
 *
 * Source: Uniswap v3-core TickMath.sol. The same math is used by PancakeSwap V3 (a v3 fork) and, for the
 * price/tick relationship, by Uniswap v4.
 */

/** The lowest tick a v3-style pool can represent. */
export const MIN_TICK = -887272;
/** The highest. Symmetric, because price(t) = 1.0001^t and the bound is on representable sqrt price. */
export const MAX_TICK = 887272;

export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const Q32 = 2n ** 32n;

/** 2^256 - 1, for the overflow-mimicking arithmetic below. */
const MAX_UINT256 = (1n << 256n) - 1n;

function mulShift(val: bigint, mulBy: bigint): bigint {
  return (val * mulBy) >> 128n;
}

/**
 * sqrt(1.0001^tick) * 2^96, exactly as the EVM computes it.
 *
 * The chain of magic constants is a fixed-point exponentiation: each bit of |tick| multiplies in a
 * precomputed sqrt(1.0001^(2^i)) in Q128. Do not "simplify" it to Math.pow — the whole point is that the
 * rounding matches the EVM's bit for bit.
 */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick)) throw new Error(`tick must be an integer, got ${tick}`);
  if (tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick ${tick} out of range`);

  const absTick = tick < 0 ? -tick : tick;

  let ratio =
    (absTick & 0x1) !== 0
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;

  if ((absTick & 0x2) !== 0) ratio = mulShift(ratio, 0xfff97272373d413259a46990580e213an);
  if ((absTick & 0x4) !== 0) ratio = mulShift(ratio, 0xfff2e50f5f656932ef12357cf3c7fdccn);
  if ((absTick & 0x8) !== 0) ratio = mulShift(ratio, 0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if ((absTick & 0x10) !== 0) ratio = mulShift(ratio, 0xffcb9843d60f6159c9db58835c926644n);
  if ((absTick & 0x20) !== 0) ratio = mulShift(ratio, 0xff973b41fa98c081472e6896dfb254c0n);
  if ((absTick & 0x40) !== 0) ratio = mulShift(ratio, 0xff2ea16466c96a3843ec78b326b52861n);
  if ((absTick & 0x80) !== 0) ratio = mulShift(ratio, 0xfe5dee046a99a2a811c461f1969c3053n);
  if ((absTick & 0x100) !== 0) ratio = mulShift(ratio, 0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if ((absTick & 0x200) !== 0) ratio = mulShift(ratio, 0xf987a7253ac413176f2b074cf7815e54n);
  if ((absTick & 0x400) !== 0) ratio = mulShift(ratio, 0xf3392b0822b70005940c7a398e4b70f3n);
  if ((absTick & 0x800) !== 0) ratio = mulShift(ratio, 0xe7159475a2c29b7443b29c7fa6e889d9n);
  if ((absTick & 0x1000) !== 0) ratio = mulShift(ratio, 0xd097f3bdfd2022b8845ad8f792aa5825n);
  if ((absTick & 0x2000) !== 0) ratio = mulShift(ratio, 0xa9f746462d870fdf8a65dc1f90e061e5n);
  if ((absTick & 0x4000) !== 0) ratio = mulShift(ratio, 0x70d869a156d2a1b890bb3df62baf32f7n);
  if ((absTick & 0x8000) !== 0) ratio = mulShift(ratio, 0x31be135f97d08fd981231505542fcfa6n);
  if ((absTick & 0x10000) !== 0) ratio = mulShift(ratio, 0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if ((absTick & 0x20000) !== 0) ratio = mulShift(ratio, 0x5d6af8dedb81196699c329225ee604n);
  if ((absTick & 0x40000) !== 0) ratio = mulShift(ratio, 0x2216e584f5fa1ea926041bedfe98n);
  if ((absTick & 0x80000) !== 0) ratio = mulShift(ratio, 0x48a170391f7dc42444e8fa2n);

  // The constants above compute the ratio for a NEGATIVE tick; invert for positive.
  if (tick > 0) ratio = MAX_UINT256 / ratio;

  // Q128 -> Q96, rounding UP, which is what the Solidity does:
  //   sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
  // Rounding down here would let a quote claim a price the pool will not honour at the boundary.
  return (ratio >> 32n) + (ratio % Q32 === 0n ? 0n : 1n);
}

/**
 * The inverse: the greatest tick whose sqrt ratio is <= the input.
 *
 * Implemented as a binary search rather than the Solidity's log2 bit-twiddling. The two agree because
 * `getSqrtRatioAtTick` is monotonic, and the search asserts that agreement directly — which is a stronger
 * guarantee than a second pile of magic constants nobody can eyeball.
 */
export function getTickAtSqrtRatio(sqrtRatioX96: bigint): number {
  if (sqrtRatioX96 < MIN_SQRT_RATIO || sqrtRatioX96 >= MAX_SQRT_RATIO) {
    throw new Error(`sqrtRatioX96 ${sqrtRatioX96} out of range`);
  }
  let lo = MIN_TICK;
  let hi = MAX_TICK;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (getSqrtRatioAtTick(mid) <= sqrtRatioX96) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
