/**
 * singleSided.test.ts — adversarial tests for lib/mole/singleSided.ts (one-sided liquidity).
 *
 * THE GUARANTEE UNDER TEST: a "one-sided" deposit must be one-sided BY CONSTRUCTION.
 * If the range touches spot, the PoolManager pulls BOTH tokens — a fund-loss bug on a live
 * real-money DEX. So every guard here is written to turn RED if its specific protection is
 * mutated away:
 *
 *   - the strict-snap rule is exercised on ticks that are EXACT spacing multiples (where a
 *     non-strict "snap up" lands exactly ON spot and the > assertion fails);
 *   - forward amounts are recomputed with formulas written HERE, independently, and the
 *     cross-check fixture uses the pinned 2^96 constant plus float references — never the
 *     module's own arithmetic path.
 *
 * The live pool (WETH 18 / USDG 6) sits near tick -201118 with spacing 60; that magnitude
 * anchors the realistic cases.
 */
import { describe, it, expect } from "vitest";
import {
  MIN_RANGE_WIDTH,
  MAX_RANGE_WIDTH,
  computeOneSidedRange,
  liquidityForOneSidedAmount,
  maxPullForLiquidity,
  buildOneSidedOpenArgs,
  assertStrictlyOneSided,
  type OneSidedSide,
} from "../../lib/mole/singleSided";
import { getSqrtRatioAtTick } from "../../lib/aggregator/math/tickMath";

const LIVE_TICK = -201118;
const SPACING = 60;

/* ---------------- independent forward formulas (written here, not imported) -------------- */
const Q96 = 1n << 96n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** amount0 pulled for L over [sa,sb], floored (the ideal). */
const fwdFloor0 = (L: bigint, sa: bigint, sb: bigint) => (L * Q96 * (sb - sa)) / (sa * sb);
/** amount0 pulled with v4's double round-up (SqrtPriceMath.getAmount0Delta, roundUp). */
const fwdCeil0 = (L: bigint, sa: bigint, sb: bigint) => ceilDiv(ceilDiv(L * Q96 * (sb - sa), sb), sa);
const fwdFloor1 = (L: bigint, sa: bigint, sb: bigint) => (L * (sb - sa)) / Q96;
const fwdCeil1 = (L: bigint, sa: bigint, sb: bigint) => ceilDiv(L * (sb - sa), Q96);

const mod = (t: number, s: number) => ((t % s) + s) % s;

/* ========================================================================== snap rule */

describe("ATTACK: strict snap beyond spot — including spot EXACTLY on a spacing boundary", () => {
  // Exact multiples are the load-bearing cases: a lazy "snap up" (ceil without the strict
  // bump) returns the boundary itself there, tickLower === currentTick, and the range
  // straddles spot the moment price ticks up. These assertions go red for that mutation.
  const spacings = [1, 10, 60, 200];
  for (const s of spacings) {
    const ticks = [
      -3352 * s, // exact multiple (deep negative)
      -5 * s,
      -s,
      0,
      s,
      7 * s, // exact multiples
      -5 * s + 1,
      -1,
      1,
      s - 1,
      s + 1,
      7 * s - 1, // just off the boundaries
      LIVE_TICK, // the live pool's actual neighbourhood
    ];
    for (const t of ticks) {
      it(`spacing ${s}, currentTick ${t}: token0 range is STRICTLY above spot`, () => {
        const r = computeOneSidedRange({ side: "token0", currentTick: t, tickSpacing: s, preset: "tight" });
        expect(r.tickLower).toBeGreaterThan(t); // RED if snap is not strict
        expect(r.tickLower - t).toBeLessThanOrEqual(s); // and minimal — no over-snapping
        expect(mod(r.tickLower, s)).toBe(0);
        expect(mod(r.tickUpper, s)).toBe(0);
        expect(r.tickLower).toBeLessThan(r.tickUpper);
      });
      it(`spacing ${s}, currentTick ${t}: token1 range sits at/below spot`, () => {
        const r = computeOneSidedRange({ side: "token1", currentTick: t, tickSpacing: s, preset: "tight" });
        expect(r.tickUpper).toBeLessThanOrEqual(t); // currentTick >= tickUpper ⇒ all token1
        expect(t - r.tickUpper).toBeLessThan(s); // minimal
        expect(mod(r.tickLower, s)).toBe(0);
        expect(mod(r.tickUpper, s)).toBe(0);
        expect(r.tickLower).toBeLessThan(r.tickUpper);
      });
    }
  }

  it("pins the exact snap at a boundary: tick 1200 (a 60-multiple) → token0 starts at 1260, NOT 1200", () => {
    const above = computeOneSidedRange({ side: "token0", currentTick: 1200, tickSpacing: 60, preset: "tight" });
    expect(above.tickLower).toBe(1260); // 1200 here = both-token pull the moment price moves
    expect(above.tickUpper).toBe(1560);
    const below = computeOneSidedRange({ side: "token1", currentTick: 1200, tickSpacing: 60, preset: "tight" });
    expect(below.tickUpper).toBe(1200); // equality IS one-sided below spot
    expect(below.tickLower).toBe(900);
  });

  it("pins the snap at the live tick -201118 (not a multiple)", () => {
    const above = computeOneSidedRange({ side: "token0", currentTick: LIVE_TICK, tickSpacing: 60, preset: "tight" });
    expect(above.tickLower).toBe(-201060);
    expect(above.tickUpper).toBe(-200760);
    const below = computeOneSidedRange({ side: "token1", currentTick: LIVE_TICK, tickSpacing: 60, preset: "tight" });
    expect(below.tickUpper).toBe(-201120);
    expect(below.tickLower).toBe(-201420);
  });
});

describe("ATTACK: assertStrictlyOneSided is the last line before a send", () => {
  it("rejects tickLower === currentTick for token0 (the classic off-by-one that pulls both tokens)", () => {
    expect(() => assertStrictlyOneSided("token0", 1200, { tickLower: 1200, tickUpper: 1500 })).toThrow();
    expect(() => assertStrictlyOneSided("token0", 1200, { tickLower: 1201, tickUpper: 1500 })).not.toThrow();
  });
  it("accepts tickUpper === currentTick for token1, rejects one above", () => {
    expect(() => assertStrictlyOneSided("token1", 1200, { tickLower: 900, tickUpper: 1200 })).not.toThrow();
    expect(() => assertStrictlyOneSided("token1", 1200, { tickLower: 900, tickUpper: 1201 })).toThrow();
  });
});

/* ========================================================================== width band */

describe("ATTACK: width clamps to the LIVE band [120, 120000] and stays on the spacing grid", () => {
  it("'launch' is the widest LEGAL width: exactly 120000 — launchpad parity", () => {
    // The live band was raised to 120000 by the 2026-08-15 setRangeWidthBand upgrade (verified on
    // chain: maxRangeWidth()==120000), matching the launchpad's in-the-wild seed shape. If the
    // preset and this constant ever disagree with the chain again, deposits revert on-chain.
    for (const side of ["token0", "token1"] as OneSidedSide[]) {
      const r = computeOneSidedRange({ side, currentTick: LIVE_TICK, tickSpacing: 60, preset: "launch" });
      expect(r.tickUpper - r.tickLower).toBe(MAX_RANGE_WIDTH);
      expect(r.tickUpper - r.tickLower).toBe(120000);
    }
  });

  it("custom width below the minimum clamps UP to 120", () => {
    const r = computeOneSidedRange({ side: "token0", currentTick: LIVE_TICK, tickSpacing: 60, preset: { widthTicks: 50 } });
    expect(r.tickUpper - r.tickLower).toBe(120);
  });

  it("custom width above the maximum clamps DOWN to 120000", () => {
    const r = computeOneSidedRange({ side: "token1", currentTick: LIVE_TICK, tickSpacing: 60, preset: { widthTicks: 200000 } });
    expect(r.tickUpper - r.tickLower).toBe(120000);
  });

  it("custom widths land on the spacing grid inside the band", () => {
    for (const [w, expected] of [
      [130, 120],
      [150, 180],
      [1000, 1020],
      [59990, 60000],
      [119990, 120000],
    ] as const) {
      const r = computeOneSidedRange({ side: "token0", currentTick: LIVE_TICK, tickSpacing: 60, preset: { widthTicks: w } });
      expect(r.tickUpper - r.tickLower).toBe(expected);
      expect(mod(r.tickUpper - r.tickLower, 60)).toBe(0);
    }
  });

  it("every produced width is inside [120, 120000], a spacing multiple, lower < upper", () => {
    for (const s of [1, 10, 60, 200]) {
      for (const preset of ["launch", "tight", { widthTicks: 137 }, { widthTicks: 119999 }] as const) {
        for (const side of ["token0", "token1"] as OneSidedSide[]) {
          const r = computeOneSidedRange({ side, currentTick: LIVE_TICK, tickSpacing: s, preset });
          const w = r.tickUpper - r.tickLower;
          expect(w).toBeGreaterThanOrEqual(MIN_RANGE_WIDTH);
          expect(w).toBeLessThanOrEqual(MAX_RANGE_WIDTH);
          expect(mod(w, s)).toBe(0);
          expect(r.tickLower).toBeLessThan(r.tickUpper);
        }
      }
    }
  });

  it("a spacing that cannot produce any legal width throws instead of shipping garbage", () => {
    expect(() =>
      computeOneSidedRange({ side: "token0", currentTick: 0, tickSpacing: 121000, preset: "launch" }),
    ).toThrow();
  });
});

describe("tick-bound edges", () => {
  it("token0 'launch' near MAX_TICK clamps the upper end to the last usable tick", () => {
    const r = computeOneSidedRange({ side: "token0", currentTick: 880000, tickSpacing: 60, preset: "launch" });
    expect(r.tickLower).toBe(880020);
    expect(r.tickUpper).toBe(887220); // floor(887272/60)*60
    expect(r.tickUpper - r.tickLower).toBeGreaterThanOrEqual(MIN_RANGE_WIDTH);
  });
  it("token1 'launch' near MIN_TICK clamps the lower end", () => {
    const r = computeOneSidedRange({ side: "token1", currentTick: -880000, tickSpacing: 60, preset: "launch" });
    expect(r.tickUpper).toBe(-880020);
    expect(r.tickLower).toBe(-887220);
  });
  it("spot so close to a bound that no legal width fits throws", () => {
    expect(() =>
      computeOneSidedRange({ side: "token0", currentTick: 887200, tickSpacing: 60, preset: "launch" }),
    ).toThrow();
    expect(() =>
      computeOneSidedRange({ side: "token1", currentTick: -887200, tickSpacing: 60, preset: "launch" }),
    ).toThrow();
  });
});

/* ==================================================================== one-sidedness */

describe("ATTACK: open args pin the OFF side to 0n — the revert-not-drain guarantee", () => {
  const key = {
    currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as `0x${string}`,
    currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as `0x${string}`,
    fee: 0x800000,
    tickSpacing: 60,
    hooks: "0xb2c9A0af48dF8858F3765385E733Cd8776a138C4" as `0x${string}`,
  };
  const deadline = 1785500000n;

  it("token0 (above spot): amount1Max === 0n, amount0Max === amount + 1 wei headroom", () => {
    const amount = 5n * 10n ** 17n;
    const range = { tickLower: -201060, tickUpper: -200760 };
    const liquidity = liquidityForOneSidedAmount({ side: "token0", ...range, amount });
    const args = buildOneSidedOpenArgs({ key, side: "token0", range, liquidity, amount, deadline });
    expect(args[0]).toBe(key);
    expect(args[1]).toBe(range.tickLower);
    expect(args[2]).toBe(range.tickUpper);
    expect(args[3]).toBe(liquidity);
    expect(args[4]).toBe(amount + 1n); // ON side: documented +1 wei for v4's ceil rounding
    expect(args[5]).toBe(0n); // OFF side: any token1 pull ⇒ the whole open reverts
    expect(args[6]).toBe(deadline);
  });

  it("token1 (below spot): amount0Max === 0n, amount1Max === amount + 1 wei", () => {
    const amount = 250_000_000n; // 250 USDG (6 decimals)
    const range = { tickLower: -201420, tickUpper: -201120 };
    const liquidity = liquidityForOneSidedAmount({ side: "token1", ...range, amount });
    const args = buildOneSidedOpenArgs({ key, side: "token1", range, liquidity, amount, deadline });
    expect(args[4]).toBe(0n); // OFF side
    expect(args[5]).toBe(amount + 1n);
    expect(args[3]).toBe(liquidity);
  });
});

/* ====================================================================== round-trip */

describe("ATTACK: round-trip — the pull can never exceed the stated amount", () => {
  const cases: { name: string; side: OneSidedSide; tickLower: number; tickUpper: number; amount: bigint }[] = [
    { name: "token0 just above live spot, 0.5 WETH", side: "token0", tickLower: -201060, tickUpper: -200760, amount: 5n * 10n ** 17n },
    { name: "token0 above tick 0, 1 WETH", side: "token0", tickLower: 60, tickUpper: 6060, amount: 10n ** 18n },
    { name: "token0 launch-width, odd amount", side: "token0", tickLower: 1260, tickUpper: 61260, amount: 123456789012345678n },
    { name: "token1 just below live spot, 250 USDG", side: "token1", tickLower: -201420, tickUpper: -201120, amount: 250_000_000n },
    { name: "token1 below tick 1200", side: "token1", tickLower: 900, tickUpper: 1200, amount: 10n ** 18n },
    { name: "token1 tiny range at 0", side: "token1", tickLower: -60, tickUpper: 0, amount: 777_777_777n },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const L = liquidityForOneSidedAmount({ side: c.side, tickLower: c.tickLower, tickUpper: c.tickUpper, amount: c.amount });
      expect(L).toBeGreaterThan(0n);

      const sa = getSqrtRatioAtTick(c.tickLower);
      const sb = getSqrtRatioAtTick(c.tickUpper);
      const floorPull = c.side === "token0" ? fwdFloor0(L, sa, sb) : fwdFloor1(L, sa, sb);
      const ceilPull = c.side === "token0" ? fwdCeil0(L, sa, sb) : fwdCeil1(L, sa, sb);

      // 1) never exceeds the stated amount (ideal), and even v4's round-UP pull stays inside
      //    the documented amount+1 headroom that buildOneSidedOpenArgs grants.
      expect(floorPull <= c.amount).toBe(true);
      expect(ceilPull <= c.amount + 1n).toBe(true);

      // 2) MAXIMALITY — L was floored exactly once, not "rounded down extra for safety".
      //    One more unit of liquidity would demand MORE than the user offered. Any sloppier
      //    rounding (double floor, safety haircut) makes this RED.
      const onePlus = c.side === "token0" ? fwdCeil0(L + 1n, sa, sb) : fwdCeil1(L + 1n, sa, sb);
      expect(onePlus > c.amount).toBe(true);

      // 3) the module's own worst-case preview agrees with the independently written formula.
      expect(maxPullForLiquidity({ side: c.side, tickLower: c.tickLower, tickUpper: c.tickUpper, liquidity: L })).toBe(ceilPull);
    });
  }

  it("where liquidity quantisation is sub-wei, the round-trip is tight to 1 wei", () => {
    // token0 above tick 0: sa,sb >= 2^96 ⇒ one unit of L moves amount0 by < 1 wei.
    const a0 = 10n ** 18n;
    const L0 = liquidityForOneSidedAmount({ side: "token0", tickLower: 60, tickUpper: 6060, amount: a0 });
    const p0 = fwdFloor0(L0, getSqrtRatioAtTick(60), getSqrtRatioAtTick(6060));
    expect(a0 - p0 <= 1n).toBe(true);
    // token1 far below zero (live neighbourhood): (sb-sa)/2^96 ≪ 1 ⇒ same tightness.
    const a1 = 250_000_000n;
    const L1 = liquidityForOneSidedAmount({ side: "token1", tickLower: -201420, tickUpper: -201120, amount: a1 });
    const p1 = fwdFloor1(L1, getSqrtRatioAtTick(-201420), getSqrtRatioAtTick(-201120));
    expect(a1 - p1 <= 1n).toBe(true);
  });
});

/* ================================================================== cross-checks */

describe("cross-check against independently derived numbers (not the module's own path)", () => {
  // The one Q96 constant everyone can verify by hand: sqrt(1.0001^0) * 2^96 = 2^96.
  const TWO96 = 79228162514264337593543950336n;

  it("fixture sanity: getSqrtRatioAtTick(0) is exactly 2^96", () => {
    expect(getSqrtRatioAtTick(0)).toBe(TWO96);
  });

  it("token1 over [-60, 0]: L === amount·2^96/(2^96 − sqrtA), and matches the float model", () => {
    const amount = 10n ** 18n;
    const sa = getSqrtRatioAtTick(-60); // tickMath fixture — an EXACT EVM port, tested on-chain
    const expected = (amount * TWO96) / (TWO96 - sa); // derived here with the pinned constant
    const L = liquidityForOneSidedAmount({ side: "token1", tickLower: -60, tickUpper: 0, amount });
    expect(L).toBe(expected);
    // independent float reference: L ≈ amount / (1 − 1.0001^(−30))
    const ref = 1e18 / (1 - Math.exp(-30 * Math.log(1.0001)));
    const rel = Math.abs(Number(L) - ref) / ref;
    expect(rel).toBeLessThan(1e-9);
  });

  it("token0 over [0, 60]: hand-simplified L === amount·sqrtB/(sqrtB − 2^96), plus float model", () => {
    const amount = 10n ** 18n;
    const sb = getSqrtRatioAtTick(60);
    // With sqrtA = 2^96 the general formula amount·sa·sb/((sb−sa)·2^96) collapses ALGEBRAICALLY
    // to amount·sb/(sb−2^96) — a different arithmetic path than the module executes.
    const expected = (amount * sb) / (sb - TWO96);
    const L = liquidityForOneSidedAmount({ side: "token0", tickLower: 0, tickUpper: 60, amount });
    expect(L).toBe(expected);
    // independent float reference: L ≈ amount · r/(r−1), r = 1.0001^30
    const r = Math.exp(30 * Math.log(1.0001));
    const ref = 1e18 * (r / (r - 1));
    const rel = Math.abs(Number(L) - ref) / ref;
    expect(rel).toBeLessThan(1e-9);
  });
});

/* ================================================================== guard rails */

describe("guard rails", () => {
  it("liquidity overflowing uint128 throws (huge amount over a sliver at the tick floor)", () => {
    expect(() =>
      liquidityForOneSidedAmount({ side: "token1", tickLower: -887220, tickUpper: -887100, amount: 1n << 200n }),
    ).toThrow(/uint128/);
  });
  it("an amount too small to mint any liquidity throws — the vault requires liquidity > 0", () => {
    expect(() =>
      liquidityForOneSidedAmount({ side: "token0", tickLower: -201060, tickUpper: -141060, amount: 1n }),
    ).toThrow(/too small/);
  });
  it("inverted or degenerate ranges throw", () => {
    expect(() =>
      liquidityForOneSidedAmount({ side: "token0", tickLower: 120, tickUpper: 120, amount: 10n ** 18n }),
    ).toThrow();
    expect(() =>
      liquidityForOneSidedAmount({ side: "token0", tickLower: 180, tickUpper: 120, amount: 10n ** 18n }),
    ).toThrow();
  });
  it("non-positive amounts throw", () => {
    expect(() =>
      liquidityForOneSidedAmount({ side: "token1", tickLower: -60, tickUpper: 0, amount: 0n }),
    ).toThrow();
  });
  it("buildOneSidedOpenArgs refuses zero liquidity and inverted ranges", () => {
    const key = { currency0: "0x0", currency1: "0x1", fee: 0, tickSpacing: 60, hooks: "0x2" } as any;
    expect(() =>
      buildOneSidedOpenArgs({ key, side: "token0", range: { tickLower: 60, tickUpper: 120 }, liquidity: 0n, amount: 1n, deadline: 1n }),
    ).toThrow();
    expect(() =>
      buildOneSidedOpenArgs({ key, side: "token0", range: { tickLower: 120, tickUpper: 60 }, liquidity: 1n, amount: 1n, deadline: 1n }),
    ).toThrow();
  });
});
