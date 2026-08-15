/**
 * singleSided.ts — one-sided ("launch-style") liquidity math for MolePositions.open.
 *
 * WHAT THIS IS
 * The pool-creation / add-liquidity flow offers a Meteora/Uniswap-style OPTION: deposit only ONE
 * token by placing the whole range strictly beyond the current price. Uniswap v4 semantics
 * (verified against the live chain this session):
 *
 *   - range entirely ABOVE the current tick  → funded by token0 ONLY
 *   - range entirely BELOW (currentTick >= tickUpper) → funded by token1 ONLY
 *
 * `side` in this module means "the token the user deposits": side 'token0' builds an above-spot
 * range, side 'token1' a below-spot range.
 *
 * THE SNAP RULE (the edge case that breaks the guarantee)
 * For an above-spot range, tickLower must be STRICTLY greater than the current tick after
 * snapping to spacing — snap UP, and if the snapped value <= currentTick, add one spacing.
 * Mirror rule below spot (tickUpper = the largest spacing multiple <= currentTick; equality is
 * fine there because currentTick >= tickUpper already means "all token1"). If spot ends up
 * INSIDE the range, the PoolManager pulls BOTH tokens and the deposit is no longer
 * single-sided — `computeOneSidedRange` makes that impossible by construction and
 * `assertStrictlyOneSided` re-checks it right before a send.
 *
 * MONEY RULES
 * - All price math is BigInt Q96. No floating point ever reaches anything that goes on chain.
 * - Liquidity is rounded DOWN (full-precision single floor) so the pool can never pull more
 *   than the user's stated amount; the OFF side's amountMax is 0n, which makes a two-sided pull
 *   revert instead of silently draining the other token.
 * - Live MolePositions bounds: width in [minRangeWidth=120, maxRangeWidth=120000] ticks, both
 *   ticks % tickSpacing == 0, lower < upper. There is NO constraint tying the range to spot —
 *   an entirely off-spot range is legal, minPositionLiquidity = 0.
 */
import {
  getSqrtRatioAtTick,
  MIN_TICK,
  MAX_TICK,
} from "@/lib/aggregator/math/tickMath";
import { createPublicClient, http } from "viem";
import {
  ROBINHOOD_RPC_URL,
  robinhoodChain,
  type Address,
  type Hex,
} from "./chain";

/* ------------------------------------------------------------- constants */

/** Live MolePositions.minRangeWidth (ticks), read from the chain this session. */
export const MIN_RANGE_WIDTH = 120;
/** Live MolePositions.maxRangeWidth (ticks), read from the chain this session. */
export const MAX_RANGE_WIDTH = 120000;
/**
 * Nominal width of the 'tight' preset — a few hundred ticks starting just beyond spot
 * (rounded to a spacing multiple, clamped into the live band).
 */
export const TIGHT_WIDTH_TICKS = 300;

const Q96 = 1n << 96n;
const MAX_UINT128 = (1n << 128n) - 1n;

/* ----------------------------------------------------------------- types */

/** Which token the user deposits. token0 ⇒ range above spot; token1 ⇒ range below spot. */
export type OneSidedSide = "token0" | "token1";

/**
 * 'launch': the WIDEST width the live vault accepts (120000 ticks) — full launchpad parity
 * pattern in the wild (Meteora-style single-sided launches) uses ranges ~120,000 ticks wide,
 * (the band was raised from 60000 by the 2026-08-15 setRangeWidthBand upgrade), so 'launch'
 * here is capped at the legal maximum, not the folklore number.
 * 'tight': ~TIGHT_WIDTH_TICKS starting just beyond spot.
 * Custom: an explicit width in ticks (snapped to spacing, clamped into the live band).
 */
export type OneSidedPreset = "launch" | "tight" | { widthTicks: number };

export interface OneSidedRange {
  tickLower: number;
  tickUpper: number;
}

/** Minimal PoolKey shape, matching the tuple in lib/mole/abi.ts / LIVE_POOL_KEY. */
export interface PoolKeyLike {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/* ------------------------------------------------------------- utilities */

/** Largest multiple of `spacing` that is <= tick (floor division, correct for negatives). */
function floorToSpacing(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function assertTick(name: string, tick: number): void {
  if (!Number.isInteger(tick)) throw new Error(`${name} must be an integer, got ${tick}`);
  if (tick < MIN_TICK || tick > MAX_TICK) throw new Error(`${name} ${tick} out of tick range`);
}

/**
 * Resolve a preset to a concrete width: a multiple of `spacing` inside
 * [MIN_RANGE_WIDTH, MAX_RANGE_WIDTH]. Throws if the spacing makes that impossible.
 */
function resolveWidth(preset: OneSidedPreset, spacing: number): number {
  const nominal =
    preset === "launch"
      ? MAX_RANGE_WIDTH // widest LEGAL width — see OneSidedPreset doc re the 120k folklore width
      : preset === "tight"
        ? TIGHT_WIDTH_TICKS
        : preset.widthTicks;
  if (!Number.isFinite(nominal) || !Number.isInteger(nominal) || nominal <= 0) {
    throw new Error(`invalid width ${String(nominal)}`);
  }
  let w = Math.round(nominal / spacing) * spacing;
  if (w < MIN_RANGE_WIDTH) w = Math.ceil(MIN_RANGE_WIDTH / spacing) * spacing;
  if (w > MAX_RANGE_WIDTH) w = Math.floor(MAX_RANGE_WIDTH / spacing) * spacing;
  if (w < MIN_RANGE_WIDTH || w > MAX_RANGE_WIDTH) {
    throw new Error(
      `tickSpacing ${spacing} cannot produce a width inside [${MIN_RANGE_WIDTH}, ${MAX_RANGE_WIDTH}]`,
    );
  }
  return w;
}

/* ------------------------------------------------------ range construction */

/**
 * Throw unless the range is strictly one-sided for `side` at `currentTick`:
 *   token0 (above spot): tickLower  >  currentTick  — STRICT. currentTick == tickLower means the
 *     live sqrtPrice can sit at/above sqrtRatio(tickLower), i.e. IN range, pulling both tokens.
 *   token1 (below spot): tickUpper  <= currentTick  — equality is safe: currentTick >= tickUpper
 *     implies sqrtPrice >= sqrtRatio(tickUpper), i.e. the position is entirely token1.
 * Call this right before sending, with a FRESH currentTick, so a price move between quote and
 * send cannot silently turn the deposit two-sided.
 */
export function assertStrictlyOneSided(
  side: OneSidedSide,
  currentTick: number,
  range: OneSidedRange,
): void {
  if (side === "token0") {
    if (!(range.tickLower > currentTick)) {
      throw new Error(
        `not one-sided: tickLower ${range.tickLower} must be STRICTLY above currentTick ${currentTick}`,
      );
    }
  } else {
    if (!(range.tickUpper <= currentTick)) {
      throw new Error(
        `not one-sided: tickUpper ${range.tickUpper} must be <= currentTick ${currentTick}`,
      );
    }
  }
}

/**
 * Build a one-sided range: snapped to spacing, strictly beyond spot per the snap rule,
 * width a spacing multiple clamped into the live [120, 120000] band, and clamped to the
 * usable tick bounds (throws if spot is so close to a bound that no legal width fits).
 */
export function computeOneSidedRange(params: {
  side: OneSidedSide;
  currentTick: number;
  tickSpacing: number;
  preset: OneSidedPreset;
}): OneSidedRange {
  const { side, currentTick, tickSpacing, preset } = params;
  assertTick("currentTick", currentTick);
  if (!Number.isInteger(tickSpacing) || tickSpacing < 1) {
    throw new Error(`invalid tickSpacing ${tickSpacing}`);
  }
  const width = resolveWidth(preset, tickSpacing);
  const maxUsable = floorToSpacing(MAX_TICK, tickSpacing); // largest legal spacing multiple
  const minUsable = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing; // smallest legal spacing multiple

  let tickLower: number;
  let tickUpper: number;
  if (side === "token0") {
    // Smallest spacing multiple STRICTLY greater than currentTick. This is exactly
    // "snap up, and if snapped <= currentTick add one spacing": when currentTick is itself
    // a multiple, floor(currentTick) == currentTick and we land one full spacing above.
    tickLower = floorToSpacing(currentTick, tickSpacing) + tickSpacing;
    if (tickLower > maxUsable - MIN_RANGE_WIDTH) {
      throw new Error(`spot too close to MAX_TICK for a one-sided token0 range`);
    }
    tickUpper = Math.min(tickLower + width, maxUsable);
  } else {
    // Largest spacing multiple <= currentTick (equality is one-sided below spot, see above).
    tickUpper = floorToSpacing(currentTick, tickSpacing);
    if (tickUpper < minUsable + MIN_RANGE_WIDTH) {
      throw new Error(`spot too close to MIN_TICK for a one-sided token1 range`);
    }
    tickLower = Math.max(tickUpper - width, minUsable);
  }

  const range = { tickLower, tickUpper };
  // Defense in depth: the constructions above guarantee these; if a future edit breaks the
  // snap rule this throws instead of shipping a two-sided "one-sided" deposit.
  assertStrictlyOneSided(side, currentTick, range);
  if (tickUpper - tickLower < MIN_RANGE_WIDTH || tickUpper - tickLower > MAX_RANGE_WIDTH) {
    throw new Error(`internal: width ${tickUpper - tickLower} outside live band`);
  }
  return range;
}

/* --------------------------------------------------------- liquidity math */

/**
 * Liquidity mintable from `amount` of the deposit token over [tickLower, tickUpper] —
 * the standard Uniswap one-sided formulas, full-precision BigInt with a SINGLE final floor:
 *
 *   above spot (token0): L = amount0 * sqrtA * sqrtB / ((sqrtB - sqrtA) * 2^96)
 *   below spot (token1): L = amount1 * 2^96 / (sqrtB - sqrtA)
 *
 * Rounded DOWN so the pool's pull can never exceed the user's stated amount (see
 * buildOneSidedOpenArgs for the 1-wei ceil-rounding caveat). Throws if the amount is too
 * small to mint any liquidity (the vault requires liquidity > 0) or if L overflows uint128.
 */
export function liquidityForOneSidedAmount(params: {
  side: OneSidedSide;
  tickLower: number;
  tickUpper: number;
  amount: bigint;
}): bigint {
  const { side, tickLower, tickUpper, amount } = params;
  assertTick("tickLower", tickLower);
  assertTick("tickUpper", tickUpper);
  if (tickLower >= tickUpper) throw new Error(`tickLower ${tickLower} must be < tickUpper ${tickUpper}`);
  if (typeof amount !== "bigint" || amount <= 0n) throw new Error(`amount must be a positive bigint`);

  const sa = getSqrtRatioAtTick(tickLower);
  const sb = getSqrtRatioAtTick(tickUpper);
  const liquidity =
    side === "token0"
      ? (amount * sa * sb) / ((sb - sa) * Q96)
      : (amount * Q96) / (sb - sa);

  if (liquidity <= 0n) throw new Error(`amount too small to mint any liquidity over this range`);
  if (liquidity > MAX_UINT128) throw new Error(`liquidity overflows uint128`);
  return liquidity;
}

/**
 * WORST-CASE amount the PoolManager can pull for `liquidity` over the range — the forward
 * formulas with v4's own round-UP behaviour (SqrtPriceMath.getAmount0Delta does a double
 * ceil: ceil(ceil(L·2^96·(sb−sa)/sb)/sa); getAmount1Delta a single ceil). Use this for UI
 * previews and to size amountMax; it is ≤ the user's stated amount + 1 wei when `liquidity`
 * came from `liquidityForOneSidedAmount`.
 */
export function maxPullForLiquidity(params: {
  side: OneSidedSide;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}): bigint {
  const { side, tickLower, tickUpper, liquidity } = params;
  assertTick("tickLower", tickLower);
  assertTick("tickUpper", tickUpper);
  if (tickLower >= tickUpper) throw new Error(`tickLower ${tickLower} must be < tickUpper ${tickUpper}`);
  if (typeof liquidity !== "bigint" || liquidity <= 0n) throw new Error(`liquidity must be a positive bigint`);

  const sa = getSqrtRatioAtTick(tickLower);
  const sb = getSqrtRatioAtTick(tickUpper);
  return side === "token0"
    ? ceilDiv(ceilDiv(liquidity * Q96 * (sb - sa), sb), sa)
    : ceilDiv(liquidity * (sb - sa), Q96);
}

/* ------------------------------------------------------------- open args */

/** The exact argument tuple for MolePositions.open (see molePositionsAbi in ./abi.ts). */
export type OpenArgs = readonly [
  PoolKeyLike,
  number, // tickLower
  number, // tickUpper
  bigint, // liquidity (uint128)
  bigint, // amount0Max
  bigint, // amount1Max
  bigint, // deadline
];

/**
 * Build the argument tuple for MolePositions.open for a one-sided deposit.
 *
 * The OFF side's amountMax is 0n — if the range somehow straddled spot, the pull of the other
 * token would exceed 0 and the whole open REVERTS instead of quietly taking both tokens.
 * The ON side's max is amount + 1 wei: liquidity was floored from `amount`, but v4 rounds the
 * pulled amount UP (double-ceil on the token0 delta), which can land exactly 1 wei above the
 * floored ideal. The documented +1 wei headroom absorbs that; it can never pull more than
 * stated+1 because liquidityForOneSidedAmount floors at full precision.
 */
export function buildOneSidedOpenArgs(params: {
  key: PoolKeyLike;
  side: OneSidedSide;
  range: OneSidedRange;
  liquidity: bigint;
  amount: bigint;
  deadline: bigint;
}): OpenArgs {
  const { key, side, range, liquidity, amount, deadline } = params;
  if (typeof liquidity !== "bigint" || liquidity <= 0n) throw new Error(`liquidity must be positive`);
  if (liquidity > MAX_UINT128) throw new Error(`liquidity overflows uint128`);
  if (typeof amount !== "bigint" || amount <= 0n) throw new Error(`amount must be positive`);
  if (range.tickLower >= range.tickUpper) throw new Error(`invalid range`);

  const onSideMax = amount + 1n; // documented headroom, see above
  const amount0Max = side === "token0" ? onSideMax : 0n;
  const amount1Max = side === "token1" ? onSideMax : 0n;
  return [key, range.tickLower, range.tickUpper, liquidity, amount0Max, amount1Max, deadline] as const;
}

/* ----------------------------------------------------------- thin loader */

/** v4 StateView (same address vault.ts reads slot0 from). */
const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as Address;
const stateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }],
  },
] as const;

/**
 * Read a pool's live tick (view-only eth_call). The math above stays pure; this is the only
 * function in the module that touches the network. Re-read this immediately before sending
 * and re-run assertStrictlyOneSided with the fresh tick.
 */
export async function loadPoolTickState(
  poolId: Hex,
): Promise<{ currentTick: number; sqrtPriceX96: bigint }> {
  const pub = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });
  const slot0 = (await pub.readContract({
    address: STATE_VIEW,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: [poolId],
  })) as readonly [bigint, number, number, number];
  return { sqrtPriceX96: slot0[0], currentTick: Number(slot0[1]) };
}
