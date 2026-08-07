import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { quoteExactInput, type PoolState, type TickData } from "../src/venues/v3Pool.js";
import { getSqrtRatioAtTick, getTickAtSqrtRatio, MAX_TICK, MIN_TICK } from "../src/math/tickMath.js";

/**
 * THE ACCEPTANCE TEST FOR THE WHOLE ROUTER.
 *
 * The fixtures in `fixtures.live.json` are not hand-written and are not a model. They were produced by
 * `test/fork/RouterFixtures.t.sol`, which forks Robinhood Chain, reads the real PancakeSwap V3
 * WETH/USDG pool, and executes REAL swaps against it — the pool's own arithmetic, at a pinned block.
 *
 * If a single number below disagrees, the off-chain quoter is lying to users about what they will
 * receive, and the failure mode is a transaction that reverts on `minOut` after they have paid gas.
 * There is no tolerance here on purpose: exact, or broken.
 */

const fx = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "test/fixtures.live.json"), "utf8"),
) as {
  pool: string;
  token0: string;
  token1: string;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  tickSpacing: number;
  fee: number;
  block: number;
  ticks: { index: number; liquidityNet: string }[];
  exactInZeroForOne: { amountIn: string; amount0: string; amount1: string }[];
  exactInOneForZero: { amountIn: string; amount0: string; amount1: string }[];
};

const pool: PoolState = {
  address: fx.pool,
  token0: fx.token0,
  token1: fx.token1,
  fee: fx.fee,
  tickSpacing: fx.tickSpacing,
  sqrtPriceX96: BigInt(fx.sqrtPriceX96),
  tick: fx.tick,
  liquidity: BigInt(fx.liquidity),
  ticks: fx.ticks.map<TickData>((t) => ({ index: t.index, liquidityNet: BigInt(t.liquidityNet) })),
};

describe("fixture sanity — the ground truth must actually be ground truth", () => {
  it("came from a real pool at a real block", () => {
    expect(fx.block).toBeGreaterThan(30_000_000);
    expect(fx.fee).toBe(500);
    expect(fx.tickSpacing).toBe(10);
    expect(BigInt(fx.liquidity)).toBeGreaterThan(0n);
  });

  it("has ticks on BOTH sides of spot, or the crossing cases prove nothing", () => {
    const below = pool.ticks.filter((t) => t.index < fx.tick).length;
    const above = pool.ticks.filter((t) => t.index > fx.tick).length;
    expect(below).toBeGreaterThan(3);
    expect(above).toBeGreaterThan(3);
  });

  it("has ticks in ascending order, which the simulator assumes", () => {
    for (let i = 1; i < pool.ticks.length; i++) {
      expect(pool.ticks[i]!.index).toBeGreaterThan(pool.ticks[i - 1]!.index);
    }
  });
});

describe("tickMath agrees with the chain", () => {
  it("reproduces the pool's own sqrtPriceX96 bracket from its tick", () => {
    // The pool's live sqrtPrice must sit in [ratio(tick), ratio(tick+1)) — the defining relationship.
    const lo = getSqrtRatioAtTick(fx.tick);
    const hi = getSqrtRatioAtTick(fx.tick + 1);
    expect(BigInt(fx.sqrtPriceX96)).toBeGreaterThanOrEqual(lo);
    expect(BigInt(fx.sqrtPriceX96)).toBeLessThan(hi);
  });

  it("round-trips tick -> sqrtRatio -> tick across the usable range", () => {
    for (const t of [MIN_TICK, -887000, -200743, -60000, -1, 0, 1, 60000, 200743, MAX_TICK - 1]) {
      expect(getTickAtSqrtRatio(getSqrtRatioAtTick(t))).toBe(t);
    }
  });

  it("is monotonic — a non-monotonic tick math silently corrupts every route search", () => {
    let prev = getSqrtRatioAtTick(-1000);
    for (let t = -999; t <= 1000; t += 7) {
      const cur = getSqrtRatioAtTick(t);
      expect(cur).toBeGreaterThan(prev);
      prev = cur;
    }
  });

  it("pins the documented boundary constants", () => {
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(4295128739n);
    expect(getSqrtRatioAtTick(0)).toBe(79228162514264337593543950336n); // exactly 2^96
  });
});

describe("EXACT parity with real on-chain swaps: WETH -> USDG", () => {
  for (const p of fx.exactInZeroForOne) {
    const amountIn = BigInt(p.amountIn);
    // The pool reports deltas from ITS side: amount0 positive (it received), amount1 negative (it paid).
    const expectedOut = -BigInt(p.amount1);

    it(`amountIn ${amountIn} -> ${expectedOut} USDG`, () => {
      const q = quoteExactInput(pool, true, amountIn);
      if (q.exhaustedTickData) {
        // The honest outcome for a swap that walks past the cached window — and for a probe this large
        // NO finite window suffices, because draining a pool sends the price to the edge of the range.
        // What must hold is that refusing to guess is CONSERVATIVE: an exhausted quote may under-report
        // what the pool would pay, and must never over-report it. Under-quoting costs a route; the other
        // direction costs the user a reverted transaction.
        expect(q.amountOut).toBeLessThanOrEqual(expectedOut);
        return;
      }
      expect(q.amountIn).toBe(amountIn);
      expect(q.amountOut).toBe(expectedOut);
    });
  }

  it("prices larger trades strictly worse per unit — price impact must be real, not linear", () => {
    const small = quoteExactInput(pool, true, 10n ** 15n);
    const large = quoteExactInput(pool, true, 2n * 10n ** 18n);
    const rateSmall = (small.amountOut * 10n ** 18n) / small.amountIn;
    const rateLarge = (large.amountOut * 10n ** 18n) / large.amountIn;
    expect(rateLarge).toBeLessThan(rateSmall);
  });
});

describe("EXACT parity with real on-chain swaps: USDG -> WETH", () => {
  for (const p of fx.exactInOneForZero) {
    const amountIn = BigInt(p.amountIn);
    const expectedOut = -BigInt(p.amount0);

    it(`amountIn ${amountIn} -> ${expectedOut} wei WETH`, () => {
      const q = quoteExactInput(pool, false, amountIn);
      if (q.exhaustedTickData) {
        expect(q.amountOut).toBeLessThanOrEqual(expectedOut);
        return;
      }
      expect(q.amountIn).toBe(amountIn);
      expect(q.amountOut).toBe(expectedOut);
    });
  }
});

describe("coverage of the two outcomes", () => {
  it("the fixture set exercises BOTH exact quotes and honest refusals", () => {
    let exact = 0;
    let refused = 0;
    for (const p of fx.exactInZeroForOne) {
      const q = quoteExactInput(pool, true, BigInt(p.amountIn));
      q.exhaustedTickData ? refused++ : exact++;
    }
    for (const p of fx.exactInOneForZero) {
      const q = quoteExactInput(pool, false, BigInt(p.amountIn));
      q.exhaustedTickData ? refused++ : exact++;
    }
    // If everything were exact the conservative-refusal branch would never run and its assertion would
    // be decoration; if everything refused, the parity claim would be vacuous. Both must be real.
    expect(exact).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(0);
    console.log(`live probes: ${exact} exact to the wei, ${refused} honestly refused`);
  });
});

describe("the simulator refuses to guess", () => {
  it("flags exhaustion rather than inventing liquidity past the cached window", () => {
    // A tiny tick window plus a swap far too large for it. The honest answer is "I do not know",
    // and the ONLY safe way to say that is a flag the caller must check — a partial number that
    // looks like a quote is how an aggregator quietly under-fills people.
    const narrow: PoolState = { ...pool, ticks: pool.ticks.slice(0, 2) };
    const q = quoteExactInput(narrow, true, 10n ** 24n);
    expect(q.exhaustedTickData).toBe(true);
  });

  it("rejects a non-positive amount instead of returning zero", () => {
    expect(() => quoteExactInput(pool, true, 0n)).toThrow();
    expect(() => quoteExactInput(pool, true, -1n)).toThrow();
  });
});
