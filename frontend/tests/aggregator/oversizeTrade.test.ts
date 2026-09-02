/**
 * oversizeTrade.test.ts — a trade bigger than the visible depth is a MARKET answer, not an engine error.
 *
 * Measured live before this fix: selling 1 NVDA into its thin pool returned HTTP 500 "cannot build a plan
 * from an incomplete split; re-fetch pool state and re-quote". The advice is unfollowable — re-quoting the
 * same size produces the same over-large amount — and an integrator could not tell an engine bug from
 * "not enough depth". The chain of cause: bestSplitRoute admitted a path whose full-size probe had already
 * run out of the tick data we hold, priced the slice against liquidity it cannot see, and planFromSplit
 * then refused to build the plan at all.
 *
 * Two properties are pinned here, and they pull against each other:
 *   1. an oversize trade refuses in liquidity terms (InsufficientLiquidityError), never a bare throw;
 *   2. a path that is incomplete at FULL size but fine at a SLICE is still used — dropping such paths
 *      outright would turn fillable trades into "no route", which is the regression the verifier of this
 *      finding warned about.
 */
import { describe, it, expect } from "vitest";
import { getSqrtRatioAtTick } from "../../lib/aggregator/math/tickMath";
import type { PoolState, TickData } from "../../lib/aggregator/venues/v3Pool";
import { PoolGraph, bestSplitRoute, quotePath } from "../../lib/aggregator/route";
import { getQuote, InsufficientLiquidityError, NoRouteError } from "../../lib/aggregator/quote";

const A = "0x" + "a".repeat(40);
const WETH = "0x" + "e".repeat(40);

/** A pool whose initialised ticks span [lo, hi] only: a big enough swap walks off the end of what we hold,
 *  which is exactly what `exhaustedTickData` reports. */
function pool(address: string, token0: string, token1: string, liquidity: bigint, lo: number, hi: number): PoolState {
  // NB: TickData keys on `index`, not `tick`. Building these as `{tick}` makes every tick INVISIBLE to
  // the simulator, which then prices the pool as constant-liquidity and never exhausts — the same field
  // mix-up that once made every v4 tick invisible in v4Reader.
  const ticks: TickData[] = [
    { index: lo, liquidityNet: liquidity },
    { index: hi, liquidityNet: -liquidity },
  ];
  const [t0, t1] = token0.toLowerCase() < token1.toLowerCase() ? [token0, token1] : [token1, token0];
  return {
    address, token0: t0, token1: t1, fee: 3000, tickSpacing: 60,
    sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, liquidity, ticks,
  };
}

const THIN = 10_000_000_000_000n;   // runs out quickly
const DEEP = 10_000_000_000_000_000_000n;

describe("a trade larger than the visible depth", () => {
  it("the fixtures really do differ in depth — the premise of the rest of this file", () => {
    const SIZE = 10n ** 18n;
    const thinPath = new PoolGraph([pool("0x" + "1".repeat(40), A, WETH, THIN, -600, 600)]).findPaths(A, WETH, 2)[0]!;
    const deepPath = new PoolGraph([pool("0x" + "2".repeat(40), A, WETH, DEEP, -60000, 60000)]).findPaths(A, WETH, 2)[0]!;
    // Same size, two pools: the thin one walks off the end of the tick data we hold, the deep one does not.
    expect(quotePath(thinPath, SIZE).incomplete).toBe(true);
    expect(quotePath(deepPath, SIZE).incomplete).toBe(false);
  });

  it("never allocates a slice against liquidity it cannot see the end of", () => {
    const p = pool("0x" + "1".repeat(40), A, WETH, THIN, -600, 600);
    const graph = new PoolGraph([p]);
    const split = bestSplitRoute(graph, A, WETH, 10n ** 21n, { parts: 10 });
    // Either it declines outright, or every part it DID place is complete and it spent less than asked.
    if (split) {
      for (const part of split.parts) expect(part.incomplete).toBe(false);
      expect(split.incomplete).toBe(false);
      expect(split.amountIn).toBeLessThan(10n ** 21n);
    }
  });

  it("getQuote refuses in liquidity terms instead of throwing a plan-build error", () => {
    const p = pool("0x" + "1".repeat(40), A, WETH, THIN, -600, 600);
    let thrown: unknown;
    try {
      getQuote([p], {
        tokenIn: A, tokenOut: WETH, amountIn: 10n ** 21n,
        recipient: "0x" + "9".repeat(40), nowSeconds: 1_700_000_000n, ttlSeconds: 60n,
        slippageBps: 50, feeBps: 0, weth: WETH,
      });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(InsufficientLiquidityError);
    expect(thrown).not.toBeInstanceOf(NoRouteError);
    // and it says something a user can act on, not "re-fetch pool state and re-quote"
    expect((thrown as Error).message).toMatch(/liquidity/i);
    expect((thrown as Error).message).not.toMatch(/re-quote|re-fetch/i);
  });

  it("still fills a size the pool CAN carry, through the same pool", () => {
    const p = pool("0x" + "1".repeat(40), A, WETH, THIN, -600, 600);
    const q = getQuote([p], {
      tokenIn: A, tokenOut: WETH, amountIn: 10n ** 11n,
      recipient: "0x" + "9".repeat(40), nowSeconds: 1_700_000_000n, ttlSeconds: 60n,
      slippageBps: 50, feeBps: 0, weth: WETH,
    });
    expect(q.amountOut).toBeGreaterThan(0n);
  });

  it("a PARTIAL fill reports how much the depth could actually take", () => {
    // Self-calibrating: find a size the allocator can only partly place, so the assertion does not depend
    // on a magic number that a future tick-math change would silently invalidate.
    const p = pool("0x" + "1".repeat(40), A, WETH, THIN, -600, 600);
    const graph = new PoolGraph([p]);
    let partial: bigint | undefined;
    for (let e = 6n; e <= 24n; e++) {
      const size = 10n ** e;
      const split = bestSplitRoute(graph, A, WETH, size, { parts: 10 });
      if (split && split.amountIn > 0n && split.amountIn < size) { partial = size; break; }
    }
    expect(partial, "a size that fills only partly").toBeDefined();

    let thrown: unknown;
    try {
      getQuote([p], {
        tokenIn: A, tokenOut: WETH, amountIn: partial!,
        recipient: "0x" + "9".repeat(40), nowSeconds: 1_700_000_000n, ttlSeconds: 60n,
        slippageBps: 50, feeBps: 0, weth: WETH,
      });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(InsufficientLiquidityError);
    // and it names a real, usable size rather than just refusing
    expect((thrown as InsufficientLiquidityError).maxFillableIn).toBeGreaterThan(0n);
    expect((thrown as InsufficientLiquidityError).maxFillableIn).toBeLessThan(partial!);
  });

  /**
   * NOT TESTED, AND SAID SO RATHER THAN LEFT LOOKING COVERED: `rankedAll` also sorts complete paths ahead
   * of incomplete ones, which matters only when an incomplete path's quote OUT-RANKS a fillable one and
   * takes its slot at the `maxPaths` cut. In this simulator an exhausted walk BREAKS out and returns a
   * partial output, so it always ranks lower by output anyway and no fixture here can tell the sort from
   * its absence — deleting it leaves every test in this file green. It earns its place against the
   * over-quoting hole documented in v3Pool/multicall (a walk that continues at constant liquidity through
   * un-read words), which needs a windowed-tick fixture this file does not build.
   */

  it("REGRESSION GUARD: a deep path still wins the whole trade when a thin one exists beside it", () => {
    // The thin pool's full-size probe is incomplete; it must be ranked behind, not deleted, and the deep
    // pool must carry the trade rather than the pair reading as "no route".
    const thin = pool("0x" + "1".repeat(40), A, WETH, THIN, -600, 600);
    const deep = pool("0x" + "2".repeat(40), A, WETH, DEEP, -60000, 60000);
    const graph = new PoolGraph([thin, deep]);
    const split = bestSplitRoute(graph, A, WETH, 10n ** 18n, { parts: 10 });
    expect(split).toBeDefined();
    expect(split!.amountIn).toBe(10n ** 18n); // the whole amount was placed
    expect(split!.incomplete).toBe(false);
    expect(split!.amountOut).toBeGreaterThan(0n);
  });
});
