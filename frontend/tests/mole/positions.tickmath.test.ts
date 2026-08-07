/**
 * positions.tickmath.test.ts — adversarial tests for lib/mole/positions.ts
 *
 * The live WETH(18)/USDG(6) pool sits at tick ~ -201118, where the human price
 * is ~1845 USDG per WETH. A tick<->price helper that works at tick 0 but breaks
 * at -201118 (or silently drops the 10^12 decimal adjustment) is useless here,
 * so THAT tick is the anchor for everything below.
 *
 * Independent reference: price(tick) = e^(tick * ln 1.0001) * 10^(dec0-dec1),
 * computed here with exp/log rather than the module's own code path.
 */

import { describe, it, expect } from "vitest";
import {
  MIN_TICK,
  MAX_TICK,
  tickToPrice,
  priceToTick,
  nearestUsableTick,
  isInRange,
  rangeStatus,
  rangeWidthTicks,
  midTick,
  positionExists,
  isEmptyPosition,
  derivePositionDisplay,
  type RawPosition,
} from "../../lib/mole/positions";

const LIVE_TICK = -201118;
const D0 = 18; // WETH
const D1 = 6; // USDG

/** Independent reference implementation (exp/log, not Math.pow). */
function refPrice(tick: number, d0: number, d1: number): number {
  return Math.exp(tick * Math.log(1.0001)) * Math.pow(10, d0 - d1);
}

function relDiff(a: number, b: number): number {
  return Math.abs(a - b) / Math.abs(b);
}

describe("ATTACK: tick->price at the LIVE pool magnitude (tick -201118, 18/6 pair)", () => {
  it("returns ~1845 USDG per WETH — the number a human recognises as the ETH price", () => {
    const p = tickToPrice(LIVE_TICK, D0, D1);
    // Hard sanity window: kills raw-price bugs (1.845e-9), inverted-adjustment
    // bugs (1.845e-21), and inverted-price bugs (5.42e-4) in one assertion.
    expect(p).toBeGreaterThan(1830);
    expect(p).toBeLessThan(1860);
    expect(relDiff(p, refPrice(LIVE_TICK, D0, D1))).toBeLessThan(1e-9);
  });

  it("applies the decimal adjustment as exactly 10^(dec0-dec1)", () => {
    const adjusted = tickToPrice(LIVE_TICK, 18, 6);
    const unadjusted = tickToPrice(LIVE_TICK, 6, 6); // same decimals -> raw 1.0001^tick
    expect(relDiff(adjusted / unadjusted, 1e12)).toBeLessThan(1e-12);
  });

  it("tick 0 with the 18/6 pair prices at exactly 1e12 — the adjustment alone", () => {
    expect(tickToPrice(0, D0, D1)).toBe(1e12);
  });

  it("tick 0 with equal decimals prices at exactly 1", () => {
    expect(tickToPrice(0, 6, 6)).toBe(1);
  });
});

describe("ATTACK: price->tick inverse at live magnitude", () => {
  it("priceToTick(1845, 18, 6) lands on -201118 exactly", () => {
    expect(priceToTick(1845, D0, D1)).toBe(LIVE_TICK);
  });

  it("round-trips priceToTick(tickToPrice(t)) === t across sign, zero and both int24 extremes", () => {
    const ticks = [
      MIN_TICK,
      MIN_TICK + 1,
      -201720,
      LIVE_TICK,
      -200640,
      -60,
      -1,
      0,
      1,
      60,
      201118,
      MAX_TICK - 1,
      MAX_TICK,
    ];
    for (const t of ticks) {
      expect(priceToTick(tickToPrice(t, D0, D1), D0, D1)).toBe(t);
    }
  });

  it("round-trips with the decimals flipped (6/18) and equal (18/18)", () => {
    for (const t of [MIN_TICK, LIVE_TICK, -1, 0, 1, MAX_TICK]) {
      expect(priceToTick(tickToPrice(t, D1, D0), D1, D0)).toBe(t);
      expect(priceToTick(tickToPrice(t, 18, 18), 18, 18)).toBe(t);
    }
  });
});

describe("int24 bounds", () => {
  it("MIN_TICK/MAX_TICK are the Uniswap v4 global bounds", () => {
    expect(MIN_TICK).toBe(-887272);
    expect(MAX_TICK).toBe(887272);
  });

  it("prices at both extremes are finite and positive (no overflow/underflow to 0 or Infinity)", () => {
    const pMin = tickToPrice(MIN_TICK, D0, D1);
    const pMax = tickToPrice(MAX_TICK, D0, D1);
    expect(pMin).toBeGreaterThan(0);
    expect(pMin).toBeLessThan(1e-20); // ~2.94e-27
    expect(Number.isFinite(pMax)).toBe(true);
    expect(pMax).toBeGreaterThan(1e40); // ~3.4e50
  });

  it("ATTACK: ticks beyond the int24 bounds are rejected, not extrapolated", () => {
    expect(() => tickToPrice(MIN_TICK - 1, D0, D1)).toThrow(RangeError);
    expect(() => tickToPrice(MAX_TICK + 1, D0, D1)).toThrow(RangeError);
  });

  it("ATTACK: non-integer and NaN ticks are rejected", () => {
    expect(() => tickToPrice(0.5, D0, D1)).toThrow(RangeError);
    expect(() => tickToPrice(Number.NaN, D0, D1)).toThrow(RangeError);
  });

  it("ATTACK: prices that map outside the tick range are rejected", () => {
    expect(() => priceToTick(1e300, D0, D1)).toThrow(RangeError); // tick ~ +6.6e6
    expect(() => priceToTick(1e-300, D0, D1)).toThrow(RangeError); // tick ~ -7.2e6
  });

  it("ATTACK: zero, negative and non-finite prices are rejected", () => {
    expect(() => priceToTick(0, D0, D1)).toThrow(RangeError);
    expect(() => priceToTick(-1845, D0, D1)).toThrow(RangeError);
    expect(() => priceToTick(Number.POSITIVE_INFINITY, D0, D1)).toThrow(RangeError);
    expect(() => priceToTick(Number.NaN, D0, D1)).toThrow(RangeError);
  });
});

describe("monotonicity: higher tick must always mean higher price, including through negatives", () => {
  it("holds tick-by-tick around the live tick, zero, and both extremes", () => {
    const probes = [
      [MIN_TICK, MIN_TICK + 1, MIN_TICK + 2],
      [-201120, -201119, -201118, -201117],
      [-1, 0, 1],
      [MAX_TICK - 2, MAX_TICK - 1, MAX_TICK],
    ];
    for (const run of probes) {
      for (let i = 1; i < run.length; i++) {
        expect(tickToPrice(run[i]!, D0, D1)).toBeGreaterThan(tickToPrice(run[i - 1]!, D0, D1));
      }
    }
  });
});

describe("ATTACK: in/out-of-range boundary convention — fees accrue on [tickLower, tickUpper)", () => {
  // A realistic live range around the current price, on the pool's 60 spacing.
  const L = -201720; // ~1737 USDG/WETH
  const U = -200640; // ~1935 USDG/WETH

  it("current tick inside the range is in-range", () => {
    expect(isInRange(LIVE_TICK, L, U)).toBe(true);
  });

  it("current tick EXACTLY at tickLower is IN range (inclusive lower)", () => {
    expect(isInRange(L, L, U)).toBe(true);
  });

  it("current tick EXACTLY at tickUpper is OUT of range (exclusive upper — 100% USDG, earning nothing)", () => {
    expect(isInRange(U, L, U)).toBe(false);
  });

  it("one tick inside the upper bound is still in range", () => {
    expect(isInRange(U - 1, L, U)).toBe(true);
  });

  it("one tick below the lower bound is out of range", () => {
    expect(isInRange(L - 1, L, U)).toBe(false);
  });

  it("a range crossing zero keeps the same convention", () => {
    expect(isInRange(0, -60, 60)).toBe(true);
    expect(isInRange(-60, -60, 60)).toBe(true);
    expect(isInRange(60, -60, 60)).toBe(false);
  });

  it("rangeStatus maps below/in/above correctly at the boundaries", () => {
    const p = makePosition(L, U);
    expect(rangeStatus(LIVE_TICK, p)).toBe("in-range");
    expect(rangeStatus(L, p)).toBe("in-range");
    expect(rangeStatus(L - 1, p)).toBe("below-range");
    expect(rangeStatus(U, p)).toBe("above-range"); // exclusive upper counts as above
    expect(rangeStatus(U + 600, p)).toBe("above-range");
  });
});

describe("nearestUsableTick (live pool spacing = 60)", () => {
  it("snaps the live tick to the nearest multiple of 60", () => {
    expect(nearestUsableTick(-201118, 60)).toBe(-201120);
    expect(nearestUsableTick(-201100, 60)).toBe(-201120);
    expect(nearestUsableTick(201100, 60)).toBe(201120);
  });

  it("is the identity on already-snapped ticks", () => {
    expect(nearestUsableTick(-201120, 60)).toBe(-201120);
    expect(nearestUsableTick(0, 60)).toBe(0);
  });

  it("ATTACK: clamps inside the global bounds instead of snapping past them", () => {
    expect(nearestUsableTick(MAX_TICK, 60)).toBe(887220); // NOT 887280
    expect(nearestUsableTick(MIN_TICK, 60)).toBe(-887220); // NOT -887280
  });

  it("rejects nonsense spacings", () => {
    expect(() => nearestUsableTick(0, 0)).toThrow(RangeError);
    expect(() => nearestUsableTick(0, -60)).toThrow(RangeError);
    expect(() => nearestUsableTick(0, 1.5)).toThrow(RangeError);
  });
});

/* ------------------------------------------------------------------ helpers */

function makePosition(tickLower: number, tickUpper: number, liquidity?: bigint): RawPosition {
  return {
    owner: "0x47D1000000000000000000000000000000000001" as `0x${string}`,
    poolId: "0x9aca9d2f4bb68ef41e6928bbe080a4b076b167e2d4b7fdebf4b4fd5d6dadd029" as `0x${string}`,
    tickLower,
    tickUpper,
    liquidity: liquidity ?? BigInt(123456789),
    openedAtL1Block: BigInt(1000),
    lastRebalancedAt: BigInt(0),
  };
}

describe("position predicates", () => {
  it("a decoded never-opened id (zero owner) does not exist", () => {
    const ghost = { ...makePosition(-201720, -200640), owner: ("0x" + "0".repeat(40)) as `0x${string}` };
    expect(positionExists(ghost)).toBe(false);
    expect(positionExists(makePosition(-201720, -200640))).toBe(true);
  });

  it("zero liquidity marks a position empty", () => {
    expect(isEmptyPosition(makePosition(-201720, -200640, BigInt(0)))).toBe(true);
    expect(isEmptyPosition(makePosition(-201720, -200640, BigInt(1)))).toBe(false);
  });

  it("width and midpoint", () => {
    const p = makePosition(-201720, -200640);
    expect(rangeWidthTicks(p)).toBe(1080);
    expect(midTick(p)).toBe(-201180);
  });
});

describe("derivePositionDisplay at live magnitudes", () => {
  const p = makePosition(-201720, -200640);
  const d = derivePositionDisplay(p, LIVE_TICK, D0, D1);

  it("ATTACK: the LOWER tick maps to the LOWER price — no min/max flip on negative ticks", () => {
    expect(d.lowerPrice).toBeLessThan(d.upperPrice);
  });

  it("prices land where the live pool actually trades (~1737 / ~1845 / ~1935)", () => {
    expect(d.lowerPrice).toBeGreaterThan(1730);
    expect(d.lowerPrice).toBeLessThan(1745);
    expect(d.currentPrice).toBeGreaterThan(1830);
    expect(d.currentPrice).toBeLessThan(1860);
    expect(d.upperPrice).toBeGreaterThan(1928);
    expect(d.upperPrice).toBeLessThan(1943);
    expect(relDiff(d.lowerPrice, refPrice(-201720, D0, D1))).toBeLessThan(1e-9);
    expect(relDiff(d.upperPrice, refPrice(-200640, D0, D1))).toBeLessThan(1e-9);
  });

  it("midPrice sits strictly between the bounds", () => {
    expect(d.midPrice).toBeGreaterThan(d.lowerPrice);
    expect(d.midPrice).toBeLessThan(d.upperPrice);
  });

  it("status flags are coherent", () => {
    expect(d.exists).toBe(true);
    expect(d.empty).toBe(false);
    expect(d.inRange).toBe(true);
    expect(d.status).toBe("in-range");
    expect(d.widthTicks).toBe(1080);
  });

  it("a current tick at the upper bound flips the card to above-range/out", () => {
    const out = derivePositionDisplay(p, -200640, D0, D1);
    expect(out.inRange).toBe(false);
    expect(out.status).toBe("above-range");
  });
});
