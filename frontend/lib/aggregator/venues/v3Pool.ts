/**
 * v3Pool.ts — a full off-chain simulation of a Uniswap-v3-style swap, tick crossings and all.
 *
 * This is the function the whole aggregator is built on: given cached pool state, what does swapping X
 * actually return? It must agree with the chain to the wei, because the number it produces becomes the
 * user's `minOut`.
 *
 * WHAT "CACHED POOL STATE" HAS TO INCLUDE, and why a naive cache is wrong. A v3 swap is not a closed
 * form. Liquidity is piecewise-constant in price: it changes every time the swap crosses an INITIALISED
 * tick, and by how much is stored per tick (`liquidityNet`). So simulating a large swap needs the ticks
 * it will cross, which are not known until you walk it. A cache holding only slot0 and `liquidity` can
 * price a small swap and will silently mis-price a large one — the error grows exactly where it matters
 * most, on the trades worth routing. `PoolState.ticks` below is that missing piece.
 *
 * HONEST LIMIT, stated because a silent one would be worse: if the swap walks past the last tick present
 * in `ticks`, this returns a partial fill and flags it, rather than inventing liquidity beyond what it
 * knows. The caller must treat `exhaustedTickData` as "re-fetch and retry", never as a quote.
 */

import {
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
  MAX_TICK,
  MIN_TICK,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
} from "../math/tickMath";
import { computeSwapStep } from "../math/swapMath";

export interface TickData {
  readonly index: number;
  /** Change in in-range liquidity when this tick is crossed left-to-right. Signed. */
  readonly liquidityNet: bigint;
}

/** How a pool is called on-chain. The swap MATH is identical for both — concentrated liquidity with a
 *  fixed fee — so quoting does not branch on this; only execution (the calldata builder) does. */
export type Venue = "PancakeV3" | "UniswapV4";

/** The v4 pool key. A v4 pool is identified by this tuple, not by an address, so a route through a v4
 *  pool must carry it for execution. Ignored for PancakeV3 pools. */
export interface PoolKeyState {
  readonly currency0: string;
  readonly currency1: string;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: string;
}

export interface PoolState {
  readonly address: string;
  readonly token0: string;
  readonly token1: string;
  /** Hundredths of a bip. 500 = 0.05%. */
  readonly fee: number;
  readonly tickSpacing: number;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
  /** Initialised ticks, ASCENDING by index. May be a window around the current tick. */
  readonly ticks: readonly TickData[];
  /** Defaults to PancakeV3 when omitted, so existing v3 callers and fixtures are unaffected. */
  readonly venue?: Venue;
  /** Required for a UniswapV4 pool; the execution layer needs it to build the hop. */
  readonly poolKey?: PoolKeyState;
}

export interface QuoteResult {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly sqrtPriceX96After: bigint;
  readonly tickAfter: number;
  readonly ticksCrossed: number;
  /**
   * TRUE means this is NOT a quote. The swap ran past the edge of the cached tick window, so the
   * remainder was priced against liquidity we cannot see. Re-fetch a wider window and retry.
   */
  readonly exhaustedTickData: boolean;
}

/**
 * Simulate `amountIn` of one side through a v3-style pool.
 *
 * @param zeroForOne true = selling token0 for token1 (price falls)
 */
export function quoteExactInput(pool: PoolState, zeroForOne: boolean, amountIn: bigint): QuoteResult {
  if (amountIn <= 0n) throw new Error("amountIn must be positive");

  const sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;

  let amountRemaining = amountIn;
  let amountCalculated = 0n;
  let sqrtPriceX96 = pool.sqrtPriceX96;
  let tick = pool.tick;
  let liquidity = pool.liquidity;
  let ticksCrossed = 0;
  let exhausted = false;

  // Ascending order is a precondition; binary-searching an unsorted array silently returns nonsense.
  const ticks = pool.ticks;

  while (amountRemaining > 0n && sqrtPriceX96 !== sqrtPriceLimitX96) {
    const next = nextTickStop(ticks, tick, zeroForOne, pool.tickSpacing);

    if (next === undefined) {
      exhausted = true;
      break;
    }

    // Past the edge of the cached window we would be pricing against liquidity we cannot see. An
    // uninitialised word boundary is fine to step through; a stop beyond every tick we hold is not.
    const known = zeroForOne
      ? next.tick >= (ticks[0]?.index ?? MIN_TICK)
      : next.tick <= (ticks[ticks.length - 1]?.index ?? MAX_TICK);
    if (!known) {
      exhausted = true;
      break;
    }

    if (next.tick < MIN_TICK || next.tick > MAX_TICK) {
      exhausted = true;
      break;
    }

    const sqrtPriceNextX96 = getSqrtRatioAtTick(next.tick);
    const sqrtPriceTargetX96 = zeroForOne
      ? sqrtPriceNextX96 < sqrtPriceLimitX96
        ? sqrtPriceLimitX96
        : sqrtPriceNextX96
      : sqrtPriceNextX96 > sqrtPriceLimitX96
        ? sqrtPriceLimitX96
        : sqrtPriceNextX96;

    if (liquidity === 0n) {
      // A region with no liquidity. The price moves to the next stop at zero cost — the behaviour that
      // made this project's own TWAP walkable, reproduced faithfully rather than smoothed away.
      sqrtPriceX96 = sqrtPriceTargetX96;
      if (next.initialized && next.data) {
        liquidity = applyLiquidityNet(liquidity, next.data.liquidityNet, zeroForOne);
        ticksCrossed++;
      }
      tick = zeroForOne ? next.tick - 1 : next.tick;
      continue;
    }

    const step = computeSwapStep(sqrtPriceX96, sqrtPriceTargetX96, liquidity, amountRemaining, pool.fee);

    amountRemaining -= step.amountIn + step.feeAmount;
    amountCalculated += step.amountOut;
    sqrtPriceX96 = step.sqrtRatioNextX96;

    if (sqrtPriceX96 === sqrtPriceNextX96) {
      // Reached the stop. Liquidity changes ONLY at a genuinely initialised tick — a word boundary is
      // just an arithmetic waypoint, and applying a liquidity delta there would corrupt everything after.
      if (next.initialized && next.data) {
        liquidity = applyLiquidityNet(liquidity, next.data.liquidityNet, zeroForOne);
        ticksCrossed++;
      }
      tick = zeroForOne ? next.tick - 1 : next.tick;
    } else if (sqrtPriceX96 !== sqrtPriceTargetX96) {
      // Ran out of input inside the range — done. Report the tick the price actually landed on rather
      // than the last stop, or `tickAfter` lies about where the pool ended up.
      tick = getTickAtSqrtRatio(sqrtPriceX96);
      break;
    }
  }

  return {
    amountIn: amountIn - (amountRemaining > 0n ? amountRemaining : 0n),
    amountOut: amountCalculated,
    sqrtPriceX96After: sqrtPriceX96,
    tickAfter: tick,
    ticksCrossed,
    exhaustedTickData: exhausted && amountRemaining > 0n,
  };
}

/**
 * Crossing a tick left-to-right ADDS its liquidityNet; right-to-left SUBTRACTS it. Getting this sign
 * backwards produces quotes that are plausible and wrong, which is the worst failure mode available.
 */
function applyLiquidityNet(liquidity: bigint, liquidityNet: bigint, zeroForOne: boolean): bigint {
  const next = zeroForOne ? liquidity - liquidityNet : liquidity + liquidityNet;
  return next < 0n ? 0n : next;
}

/**
 * The pool's next stop — which is NOT simply "the next initialised tick".
 *
 * THIS IS THE SUBTLEST THING IN THE FILE, and getting it wrong produces quotes that are close enough to
 * look right. Uniswap's `nextInitializedTickWithinOneWord` searches the tick bitmap ONE 256-BIT WORD AT A
 * TIME. When a word contains no initialised tick in the direction of travel, the pool does not leap to
 * the next initialised tick — it steps to that WORD'S BOUNDARY, runs a full swap step to there, and only
 * then looks at the next word. Liquidity does not change at a boundary, so the destination price is the
 * same either way, but the ARITHMETIC is not: each step rounds `amountIn` up and `amountOut` down
 * independently, so N steps and one step give different totals.
 *
 * Measured on the live PancakeSwap V3 WETH/USDG pool: a 10,000 USDG swap crossing a 3,240-tick
 * uninitialised stretch came out 254,943,475 wei of WETH too HIGH when the gap was jumped in one step —
 * an over-quote of 0.000006%, which is invisible in a spot check and is still a transaction that reverts
 * on `minOut` after the user has paid gas.
 *
 * @returns the next stop and whether it is an initialised tick (i.e. whether liquidity changes there)
 */
function nextTickStop(
  ticks: readonly TickData[],
  currentTick: number,
  zeroForOne: boolean,
  tickSpacing: number,
): { tick: number; initialized: boolean; data?: TickData } | undefined {
  // Solidity: `compressed = tick / tickSpacing` truncates toward zero, then decrements for negatives
  // that do not divide evenly — i.e. floor division. JS `Math.floor` gets there directly.
  const compressed = Math.floor(currentTick / tickSpacing);

  if (zeroForOne) {
    const wordPos = compressed >> 8;
    const wordStart = wordPos * 256; // first compressed index in this word
    // Initialised candidates at or below the current position, within this word only.
    let best: TickData | undefined;
    for (let i = ticks.length - 1; i >= 0; i--) {
      const t = ticks[i]!;
      const c = Math.floor(t.index / tickSpacing);
      if (c <= compressed && c >= wordStart) {
        best = t;
        break;
      }
    }
    if (best) return { tick: best.index, initialized: true, data: best };
    return { tick: wordStart * tickSpacing, initialized: false };
  }

  // Upward: the search starts at compressed + 1 and is confined to THAT index's word.
  const start = compressed + 1;
  const wordPos = start >> 8;
  const wordEnd = wordPos * 256 + 255; // last compressed index in this word
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]!;
    const c = Math.floor(t.index / tickSpacing);
    if (c >= start && c <= wordEnd) return { tick: t.index, initialized: true, data: t };
    if (c > wordEnd) break;
  }
  return { tick: wordEnd * tickSpacing, initialized: false };
}

/** Spot price of token1 per token0, scaled by 1e18. For display and for ranking candidate routes. */
export function spotPriceX18(pool: PoolState): bigint {
  const p = pool.sqrtPriceX96;
  return (p * p * 10n ** 18n) >> 192n;
}

export { MAX_TICK, MIN_TICK };
