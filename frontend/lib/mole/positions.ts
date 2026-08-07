/**
 * positions.ts — pure display-derivation helpers for MolePositions positions.
 *
 * Nothing in here touches the network: every function maps raw on-chain values
 * (as decoded by viem from the ABIs in abi.ts) plus a caller-supplied current
 * tick into display values.
 *
 * PRICE CONVENTION. All prices here are "token1 per token0 in WHOLE tokens"
 * (for the live pool: USDG per WETH, i.e. the familiar ETH-in-dollars number).
 * Raw pool price is 1.0001^tick in RAW units; the human price applies the
 * decimal adjustment 10^(decimals0 - decimals1). For WETH(18)/USDG(6) that is
 * 10^12 — skipping it is a 12-order-of-magnitude display error. Both decimals
 * are therefore explicit parameters on every price function; there are no
 * defaults and 18 is never assumed.
 *
 * These price numbers are IEEE-754 doubles, fine for display and range pickers.
 * Never derive a transaction amount from them — raw amounts stay bigint and go
 * through format.ts.
 */

/** Uniswap v4 global tick bounds (TickMath.MIN_TICK / MAX_TICK). */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Shape of `getPosition(id)` as viem decodes it (int24 -> number, uint64/uint128 -> bigint).
 * `liquidity` can shrink on partial withdraw and is REWRITTEN by every rebalance
 * (token amounts are conserved, not the liquidity number) — never cache it across
 * blocks; `withdrawAll` exists precisely so callers do not have to echo it back.
 */
export interface RawPosition {
  readonly owner: `0x${string}`;
  readonly poolId: `0x${string}`;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
  readonly openedAtL1Block: bigint;
  readonly lastRebalancedAt: bigint;
}

/** Position ids are 1-based; a never-opened id decodes with owner == zero address. */
export function positionExists(p: RawPosition): boolean {
  return p.owner.toLowerCase() !== ZERO_ADDRESS;
}

/** Fully withdrawn (or zap mid-flight, which a UI never observes): exists but holds nothing. */
export function isEmptyPosition(p: RawPosition): boolean {
  return p.liquidity === BigInt(0);
}

/* ------------------------------------------------------------ range status */

export type RangeStatus = "in-range" | "below-range" | "above-range";

/**
 * Uniswap convention: a position earns fees while tickLower <= currentTick < tickUpper.
 * `currentTick` is passed in by the caller (from slot0 or the TWAP) — this module
 * does not read chains.
 */
export function isInRange(currentTick: number, tickLower: number, tickUpper: number): boolean {
  return tickLower <= currentTick && currentTick < tickUpper;
}

/**
 * Where the pool price sits relative to the range.
 *   below-range: price under the range — the position is entirely token0 (WETH), earning nothing.
 *   above-range: price over the range — entirely token1 (USDG), earning nothing.
 */
export function rangeStatus(currentTick: number, p: RawPosition): RangeStatus {
  if (isInRange(currentTick, p.tickLower, p.tickUpper)) return "in-range";
  return currentTick < p.tickLower ? "below-range" : "above-range";
}

export function rangeWidthTicks(p: RawPosition): number {
  return p.tickUpper - p.tickLower;
}

/** Midpoint of the range — the same number the vault's recenter/TWAP bounds are measured on. */
export function midTick(p: RawPosition): number {
  return Math.trunc((p.tickLower + p.tickUpper) / 2);
}

/* ------------------------------------------------------------ tick <-> price */

/**
 * Tick -> human price (token1 per token0, whole tokens): 1.0001^tick * 10^(decimals0 - decimals1).
 * Live pool sanity anchor: tick -201118 with (18, 6) ≈ 1836 USDG per WETH.
 */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new RangeError(`Tick out of bounds: ${String(tick)}`);
  }
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

/**
 * Human price -> nearest tick (rounded to nearest integer, NOT yet snapped to spacing —
 * feed through nearestUsableTick before building a range).
 */
export function priceToTick(price: number, decimals0: number, decimals1: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new RangeError(`Price must be finite and positive: ${String(price)}`);
  }
  const raw = price * Math.pow(10, decimals1 - decimals0);
  const tick = Math.round(Math.log(raw) / Math.log(1.0001));
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new RangeError(`Price ${String(price)} maps outside tick bounds`);
  }
  return tick;
}

/**
 * Snap a tick to the pool's tick spacing (nearest multiple, clamped inside the global
 * bounds). The vault reverts TickNotOnSpacing otherwise. Live pool spacing is 60.
 */
export function nearestUsableTick(tick: number, tickSpacing: number): number {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new RangeError(`Invalid tickSpacing: ${String(tickSpacing)}`);
  }
  const snapped = Math.round(tick / tickSpacing) * tickSpacing;
  const maxUsable = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  const minUsable = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  return Math.min(maxUsable, Math.max(minUsable, snapped));
}

/* --------------------------------------------------------- derived display */

export interface PositionDisplay {
  readonly exists: boolean;
  readonly empty: boolean;
  readonly status: RangeStatus;
  readonly inRange: boolean;
  /** Human prices (token1 per token0): lower tick maps to the LOWER price. */
  readonly lowerPrice: number;
  readonly upperPrice: number;
  readonly currentPrice: number;
  readonly midPrice: number;
  readonly widthTicks: number;
}

/**
 * One-call derivation of everything a position card renders.
 * `currentTick` comes from the caller (slot0 or TWAP); decimals come from
 * chain.ts token metadata (for the live pool: decimals0=18 WETH, decimals1=6 USDG).
 */
export function derivePositionDisplay(
  p: RawPosition,
  currentTick: number,
  decimals0: number,
  decimals1: number
): PositionDisplay {
  const status = rangeStatus(currentTick, p);
  return {
    exists: positionExists(p),
    empty: isEmptyPosition(p),
    status,
    inRange: status === "in-range",
    lowerPrice: tickToPrice(p.tickLower, decimals0, decimals1),
    upperPrice: tickToPrice(p.tickUpper, decimals0, decimals1),
    currentPrice: tickToPrice(currentTick, decimals0, decimals1),
    midPrice: tickToPrice(midTick(p), decimals0, decimals1),
    widthTicks: rangeWidthTicks(p),
  };
}
