/**
 * seedLiquidity.oneSided.test.ts — adversarial tests for the one-sided SEED path
 * (customOneSidedRange + seedNewPoolOneSided plumbing) in lib/mole/seedLiquidity.ts.
 *
 * THE GUARANTEE UNDER TEST: whatever bounds the pool creator types — straddling spot, on the
 * wrong side of spot entirely, absurdly narrow or absurdly wide — the resulting range must be
 * strictly one-sided for the chosen side and inside the live [120, 60000] width band, with
 * both ticks exact spacing multiples. A clamp bug here is a fund-loss bug: a range touching
 * spot makes the PoolManager pull BOTH tokens.
 *
 * Checks are written INLINE (tickLower > spot, % spacing, width bounds) — not routed through
 * the module's own assert — so mutating the clamp AND the assert together still turns tests red.
 */
import { describe, it, expect } from "vitest";
import { customOneSidedRange, seedNewPoolOneSided } from "@/lib/mole/seedLiquidity";
import { MIN_RANGE_WIDTH, MAX_RANGE_WIDTH } from "@/lib/mole/singleSided";
import { MAX_TICK } from "@/lib/aggregator/math/tickMath";

const SPACING = 60;
const LIVE_TICK = -201118; // magnitude of the live WETH/USDG pool, not on a spacing multiple
const EXACT_TICK = -201120; // exactly on a spacing multiple — the load-bearing snap case

/** Non-negative modulo (JS % returns -0/negative for negative ticks). */
const mod = (t: number, s: number) => ((t % s) + s) % s;

const checkLegal = (side: "token0" | "token1", spot: number, r: { tickLower: number; tickUpper: number }, spacing = SPACING) => {
  expect(mod(r.tickLower, spacing)).toBe(0);
  expect(mod(r.tickUpper, spacing)).toBe(0);
  expect(r.tickLower).toBeLessThan(r.tickUpper);
  const width = r.tickUpper - r.tickLower;
  expect(width).toBeGreaterThanOrEqual(MIN_RANGE_WIDTH);
  expect(width).toBeLessThanOrEqual(MAX_RANGE_WIDTH);
  if (side === "token0") expect(r.tickLower).toBeGreaterThan(spot); // STRICT
  else expect(r.tickUpper).toBeLessThanOrEqual(spot); // equality legal below spot
};

describe("ATTACK: custom bounds that straddle or sit on the wrong side of spot", () => {
  it("token0: bounds straddling spot are clamped strictly ABOVE spot", () => {
    const r = customOneSidedRange({
      side: "token0", currentTick: LIVE_TICK, tickSpacing: SPACING,
      boundTickA: LIVE_TICK - 3000, boundTickB: LIVE_TICK + 3000,
    });
    checkLegal("token0", LIVE_TICK, r);
  });

  it("token0: spot EXACTLY on a spacing multiple — lower edge lands one full spacing above, never ON spot", () => {
    const r = customOneSidedRange({
      side: "token0", currentTick: EXACT_TICK, tickSpacing: SPACING,
      boundTickA: EXACT_TICK, boundTickB: EXACT_TICK + 6000,
    });
    expect(r.tickLower).toBe(EXACT_TICK + SPACING);
    checkLegal("token0", EXACT_TICK, r);
  });

  it("token0: bounds ENTIRELY below spot still produce a legal above-spot range", () => {
    const r = customOneSidedRange({
      side: "token0", currentTick: LIVE_TICK, tickSpacing: SPACING,
      boundTickA: LIVE_TICK - 9000, boundTickB: LIVE_TICK - 1200,
    });
    checkLegal("token0", LIVE_TICK, r);
  });

  it("token1: bounds straddling spot are clamped to AT MOST the floor multiple of spot", () => {
    const r = customOneSidedRange({
      side: "token1", currentTick: LIVE_TICK, tickSpacing: SPACING,
      boundTickA: LIVE_TICK - 3000, boundTickB: LIVE_TICK + 3000,
    });
    checkLegal("token1", LIVE_TICK, r);
    expect(r.tickUpper).toBe(Math.floor(LIVE_TICK / SPACING) * SPACING);
  });

  it("token1: spot exactly on a multiple — tickUpper == spot is legal (all-token1 by v4 semantics)", () => {
    const r = customOneSidedRange({
      side: "token1", currentTick: EXACT_TICK, tickSpacing: SPACING,
      boundTickA: EXACT_TICK - 6000, boundTickB: EXACT_TICK + 500,
    });
    expect(r.tickUpper).toBe(EXACT_TICK);
    checkLegal("token1", EXACT_TICK, r);
  });
});

describe("ATTACK: widths outside the live [120, 60000] band", () => {
  it("narrower than minRangeWidth is widened, not shipped", () => {
    const r = customOneSidedRange({
      side: "token0", currentTick: LIVE_TICK, tickSpacing: SPACING,
      boundTickA: LIVE_TICK + 100, boundTickB: LIVE_TICK + 130, // 30 ticks apart
    });
    checkLegal("token0", LIVE_TICK, r);
  });

  it("wider than maxRangeWidth is capped at the legal maximum", () => {
    const r = customOneSidedRange({
      side: "token0", currentTick: LIVE_TICK, tickSpacing: SPACING,
      boundTickA: LIVE_TICK + 60, boundTickB: LIVE_TICK + 200000, // folklore 120k+ launch width
    });
    checkLegal("token0", LIVE_TICK, r);
    expect(r.tickUpper - r.tickLower).toBe(Math.floor(MAX_RANGE_WIDTH / SPACING) * SPACING);
  });

  it("token1 mirror: huge below-spot range capped at the legal maximum", () => {
    const r = customOneSidedRange({
      side: "token1", currentTick: LIVE_TICK, tickSpacing: SPACING,
      boundTickA: LIVE_TICK - 200000, boundTickB: LIVE_TICK - 60,
    });
    checkLegal("token1", LIVE_TICK, r);
    expect(r.tickUpper - r.tickLower).toBe(Math.floor(MAX_RANGE_WIDTH / SPACING) * SPACING);
  });
});

describe("ATTACK: degenerate inputs", () => {
  it("non-integer bound ticks throw instead of silently rounding", () => {
    expect(() => customOneSidedRange({
      side: "token0", currentTick: LIVE_TICK, tickSpacing: SPACING,
      boundTickA: LIVE_TICK + 100.5, boundTickB: LIVE_TICK + 3000,
    })).toThrow();
    expect(() => customOneSidedRange({
      side: "token0", currentTick: LIVE_TICK, tickSpacing: SPACING,
      boundTickA: NaN, boundTickB: LIVE_TICK + 3000,
    })).toThrow();
  });

  it("spot too close to MAX_TICK for token0 throws (no clamped-into-illegality range)", () => {
    expect(() => customOneSidedRange({
      side: "token0", currentTick: MAX_TICK - 10, tickSpacing: SPACING,
      boundTickA: MAX_TICK - 6000, boundTickB: MAX_TICK,
    })).toThrow(/MAX_TICK/i);
  });

  it("sweep: many spot/bound/spacing combos never yield an illegal or two-sided range", () => {
    const spacings = [1, 10, 60, 200];
    const spots = [-201118, -201120, -50000, -1, 0, 1, 777, 123456];
    for (const spacing of spacings) {
      for (const spot of spots) {
        for (const [dA, dB] of [[-5000, 5000], [50, 90], [-100000, -200], [200, 100000], [0, 0]] as const) {
          for (const side of ["token0", "token1"] as const) {
            let r;
            try {
              r = customOneSidedRange({
                side, currentTick: spot, tickSpacing: spacing,
                boundTickA: spot + dA, boundTickB: spot + dB,
              });
            } catch {
              continue; // throwing is always a safe outcome
            }
            checkLegal(side, spot, r, spacing);
          }
        }
      }
    }
  });
});

describe("seedNewPoolOneSided plumbing", () => {
  it("fails soft (no throw) when no wallet is present", async () => {
    const saved = (globalThis as any).ethereum;
    (globalThis as any).ethereum = undefined; // stub is non-configurable but writable
    try {
      const res = await seedNewPoolOneSided({
        currency0: "0x0000000000000000000000000000000000000001",
        currency1: "0x0000000000000000000000000000000000000002",
        tickSpacing: SPACING,
        side: "token0",
        amount: 10n ** 18n,
        range: { tickLower: -201060, tickUpper: -195060 },
      });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/wallet/i);
    } finally {
      (globalThis as any).ethereum = saved;
    }
  });
});
