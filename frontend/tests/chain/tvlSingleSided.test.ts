import { describe, it, expect } from "vitest";
import { tvlUsd, poolTvlUsd } from "@/lib/chain/livePools";

/**
 * TVL MUST NOT ASSUME A POSITION STRADDLES SPOT.
 *
 * `loadLivePools` used to value the hub leg and double it, on the reasoning that a two-sided position
 * holds matched value on each side. A position parked entirely above or below spot holds ONE token, so
 * that rule reported exactly twice the real TVL. Live proof, 2026-08-25: the NVDA/USDG display pool
 * held 0.999999 USDG and 0 NVDA, and /api/v1/pools reported tvlUsd 1.999998.
 *
 * These pin the arithmetic that replaced it — the non-hub leg valued at the pool's own spot price.
 */
describe("tvlUsd", () => {
  // USDG is token0, NVDA token1, price = NVDA per USDG. The pool holds $1 of USDG and no NVDA.
  const nvdaPerUsdg = 1 / 211.78;

  it("values a single-sided hub-only pool at exactly the hub it holds", () => {
    const v = tvlUsd({
      reserve0: 0.999999, reserve1: 0,
      price: nvdaPerUsdg, hubIsToken0: true, hubIsUsdg: true, ethUsd: 2478.63,
    });
    expect(v).toBeCloseTo(0.999999, 6);
  });

  it("values a single-sided pool holding ONLY the non-hub token at that token's spot value", () => {
    // 0.1 NVDA at $211.78 = $21.178, and no USDG at all. The doubling rule returned 0 here, because
    // the hub leg it wanted to double was empty — the same bug in the opposite direction.
    const v = tvlUsd({
      reserve0: 0, reserve1: 0.1,
      price: nvdaPerUsdg, hubIsToken0: true, hubIsUsdg: true, ethUsd: 2478.63,
    });
    expect(v).toBeCloseTo(21.178, 3);
  });

  it("still values a straddling two-sided pool as the sum of both legs", () => {
    const v = tvlUsd({
      reserve0: 5, reserve1: 5 * nvdaPerUsdg,
      price: nvdaPerUsdg, hubIsToken0: true, hubIsUsdg: true, ethUsd: 2478.63,
    });
    expect(v).toBeCloseTo(10, 6);
  });

  it("prices a pool whose hub leg is token1", () => {
    // SPY is token0, USDG token1, price = USDG per SPY = 766.70.
    const v = tvlUsd({
      reserve0: 0.01, reserve1: 3,
      price: 766.7, hubIsToken0: false, hubIsUsdg: true, ethUsd: 2478.63,
    });
    expect(v).toBeCloseTo(0.01 * 766.7 + 3, 6);
  });

  it("converts through ETH when the pool's only hub leg is the wrapped native", () => {
    // CASHCAT/WETH: WETH is token1, price = WETH per CASHCAT.
    const v = tvlUsd({
      reserve0: 100, reserve1: 0.002,
      price: 0.00001, hubIsToken0: false, hubIsUsdg: false, ethUsd: 2478.63,
    });
    expect(v).toBeCloseTo((100 * 0.00001 + 0.002) * 2478.63, 6);
  });

  it("refuses to invent a number when the pool has no usable price", () => {
    expect(tvlUsd({ reserve0: 1, reserve1: 1, price: 0, hubIsToken0: true, hubIsUsdg: true, ethUsd: 2478.63 })).toBe(0);
    expect(tvlUsd({ reserve0: 1, reserve1: 1, price: NaN, hubIsToken0: true, hubIsUsdg: true, ethUsd: 2478.63 })).toBe(0);
  });
});

/**
 * The block above proves the ARITHMETIC. This one proves the CALLER USES IT — which is where the bug
 * actually lived. `tvlUsd` was correct the whole time; `loadLivePools` simply did not call it, and a
 * suite that only exercised `tvlUsd` would have stayed green through the entire incident.
 */
describe("poolTvlUsd — the per-pool decision loadLivePools makes", () => {
  const NVDA_PER_USDG = 1 / 211.78;

  it("does not double a single-sided pool (the live NVDA/USDG case)", () => {
    const v = poolTvlUsd({
      reserve0: 0.999999, reserve1: 0, price: NVDA_PER_USDG,
      t0IsUsdg: true, t1IsUsdg: false, t0IsWeth: false, t1IsWeth: false, ethUsd: 2478.63,
    });
    expect(v).toBeCloseTo(0.999999, 6);
    expect(v).not.toBeCloseTo(1.999998, 4); // what the doubling rule published
  });

  it("values a pool holding only the non-hub token instead of returning zero", () => {
    const v = poolTvlUsd({
      reserve0: 0, reserve1: 0.1, price: NVDA_PER_USDG,
      t0IsUsdg: true, t1IsUsdg: false, t0IsWeth: false, t1IsWeth: false, ethUsd: 2478.63,
    });
    expect(v).toBeCloseTo(21.178, 3);
  });

  it("prices WETH/USDG in dollars directly rather than through the ETH price", () => {
    // price = USDG per WETH. Both legs are hubs; USDG must win as the denominator, so ethUsd being
    // wildly wrong must not move the answer at all.
    const args = {
      reserve0: 0.001, reserve1: 5, price: 2478.63,
      t0IsWeth: true, t1IsWeth: false, t0IsUsdg: false, t1IsUsdg: true,
    };
    const v = poolTvlUsd({ ...args, ethUsd: 2478.63 });
    expect(v).toBeCloseTo(0.001 * 2478.63 + 5, 6);
    expect(poolTvlUsd({ ...args, ethUsd: 1 })).toBeCloseTo(v, 6);
  });

  it("converts through ETH only when USDG is not a leg", () => {
    const v = poolTvlUsd({
      reserve0: 100, reserve1: 0.002, price: 0.00001,
      t0IsUsdg: false, t1IsUsdg: false, t0IsWeth: false, t1IsWeth: true, ethUsd: 2478.63,
    });
    expect(v).toBeCloseTo((100 * 0.00001 + 0.002) * 2478.63, 6);
  });

  it("reports an EMPTY pool as 0, not as a price-shaped number", () => {
    // The first-depositor case: initialised and whitelisted, no liquidity yet. It has a spot price
    // (set at initialize) but nothing in it, so any non-zero TVL here would be pure invention — and
    // these pools sit on the page for 30 minutes before they can be funded.
    expect(poolTvlUsd({
      reserve0: 0, reserve1: 0, price: NVDA_PER_USDG,
      t0IsUsdg: true, t1IsUsdg: false, t0IsWeth: false, t1IsWeth: false, ethUsd: 2478.63,
    })).toBe(0);
  });

  it("never returns a negative or non-finite figure, whatever the pool reports", () => {
    for (const price of [0, -1, NaN, Infinity]) {
      const v = poolTvlUsd({
        reserve0: 1, reserve1: 1, price,
        t0IsUsdg: true, t1IsUsdg: false, t0IsWeth: false, t1IsWeth: false, ethUsd: 2478.63,
      });
      expect(Number.isFinite(v), `price=${price}`).toBe(true);
      expect(v, `price=${price}`).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns 0 when neither leg is a hub — no dollar price exists for such a pool", () => {
    expect(poolTvlUsd({
      reserve0: 10, reserve1: 10, price: 1,
      t0IsUsdg: false, t1IsUsdg: false, t0IsWeth: false, t1IsWeth: false, ethUsd: 2478.63,
    })).toBe(0);
  });
});
