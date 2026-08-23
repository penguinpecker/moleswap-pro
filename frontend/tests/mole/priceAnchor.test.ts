/**
 * priceAnchor.test.ts — the deposit path, driven AS THE ATTACK.
 *
 * THE DEFECT THESE TESTS WERE WRITTEN AGAINST. `buildZap` computed the zap's only real slippage bound
 * from `slot0`:
 *
 *     const slot0 = await pub.readContract({ ...getSlot0 });
 *     const expectedOut = swapAmount * priceX192 / Q192;
 *     const amountOutMin = expectedOut * (10000 - slippageBps) / 10000n;
 *     minLiquidity: 1n,
 *
 * so the bound was anchored to the one number an attacker moves for free, and then enforced against a
 * swap executing at that same number. Skew the pool, hold it a block, and the user's `amountOutMin`
 * compares the bad price against ITSELF and passes; `minLiquidity` of 1 wei catches nothing on the way
 * out. On Arc the deepest pool on the whole chain is ~$74k, so holding the skew is cheap. Same class as
 * the Arrakis V1 drain of 2026-08-23.
 *
 * Every test below therefore drives the manipulation and asserts on the NUMBERS THAT REACH THE CHAIN —
 * the bound, the range, the floor, the refusal — not merely that something threw. The old spot-anchored
 * code passes the manipulated swap in `test_theOldSpotAnchoredBound_clearedTheManipulatedSwapAtTheManipulatedPrice`
 * and fails every other assertion in this file.
 *
 * Fixtures are the LIVE pool as read on 2026-08-23: WETH/USDG on Robinhood Chain 4663, MoleHook
 * consult(1800) = -200461, slot0 tick = -200461, vault maxTwapDeviationTicks = 600, twapWindow = 1800.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getSqrtRatioAtTick } from "@/lib/aggregator/math/tickMath";
import { applySlippageFloor } from "@/lib/mole/format";
import { getLiquidityForAmounts } from "@/lib/mole/seedLiquidity";
import { QUEUE_CONFIG } from "@/lib/mole/chain";
import {
  BoundTooSmallError,
  FALLBACK_MAX_TWAP_DEVIATION_TICKS,
  FALLBACK_TWAP_WINDOW_SECONDS,
  NoHonestAnchorError,
  PoolLooksManipulatedError,
  expectedOutAtSqrtPrice,
  judgeAnchor,
  readPriceAnchor,
  tickDeviation,
  type AnchorReads,
  type PriceAnchor,
} from "@/lib/mole/priceAnchor";
import { ZAP_MIN_LIQUIDITY_MARGIN_BPS, buildZapPlan } from "@/lib/mole/zapPlan";

/* ------------------------------------------------------------------------ fixtures */

const TWAP_TICK = -200_461; // MoleHook consult(1800) on the live WETH/USDG pool
const SPACING = 60;
const ONE_WETH = 10n ** 18n;
const SLIPPAGE_BPS = 100;

/** An anchor exactly as `readPriceAnchor` would return it, with spot placed wherever the test wants. */
function anchorAt(spotTick: number, opts: { twapTick?: number; max?: number } = {}): PriceAnchor {
  const twapTick = opts.twapTick ?? TWAP_TICK;
  const max = opts.max ?? FALLBACK_MAX_TWAP_DEVIATION_TICKS;
  const deviationTicks = Math.abs(spotTick - twapTick);
  return {
    deviationTicks,
    maxDeviationTicks: max,
    manipulated: deviationTicks > max,
    twapTick,
    twapSqrtPriceX96: getSqrtRatioAtTick(twapTick),
    spotTick,
    spotSqrtPriceX96: getSqrtRatioAtTick(spotTick),
    twapWindowSeconds: FALLBACK_TWAP_WINDOW_SECONDS,
  };
}

/** The bound the SHIPPED-BEFORE code produced: spot in, spot out, nothing else. */
function oldSpotAnchoredBound(spotTick: number, swapAmount: bigint, zeroForOne: boolean): bigint {
  const sqrtPriceX96 = getSqrtRatioAtTick(spotTick);
  const Q192 = 1n << 192n;
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  const expectedOut = zeroForOne ? (swapAmount * priceX192) / Q192 : (swapAmount * Q192) / priceX192;
  return (expectedOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
}

/* -------------------------------------------------------------- the bound is the TWAP */

describe("the zap's slippage bound is anchored to the TWAP, not to the price an attacker just set", () => {
  // A 500-tick skew is INSIDE the vault's 600-tick band, so the pool is not refused — this is the
  // narrow, cheap manipulation that the refusal alone would miss and only the anchor catches.
  const SPOT = TWAP_TICK - 500; // ~4.88% below the time-averaged price
  const plan = buildZapPlan({
    anchor: anchorAt(SPOT),
    zeroForOne: true, // depositing WETH: the zap sells half of it into USDG
    amountIn: ONE_WETH,
    tickSpacing: SPACING,
    slippageBps: SLIPPAGE_BPS,
  });
  const outAtManipulatedSpot = expectedOutAtSqrtPrice(getSqrtRatioAtTick(SPOT), plan.swapAmount, true);

  it("the manipulated swap CANNOT clear the bound — the deposit reverts on chain and the user keeps their WETH", () => {
    expect(outAtManipulatedSpot).toBeLessThan(plan.amountOutMin);
  });

  it("test_theOldSpotAnchoredBound_clearedTheManipulatedSwapAtTheManipulatedPrice", () => {
    // The exact number the shipped code would have sent. It is BELOW what the skewed pool returns, so
    // the swap settles at the attacker's price and every check on chain passes.
    const oldBound = oldSpotAnchoredBound(SPOT, plan.swapAmount, true);
    expect(outAtManipulatedSpot).toBeGreaterThanOrEqual(oldBound);
    // And the new bound refuses precisely that trade.
    expect(plan.amountOutMin).toBeGreaterThan(oldBound);
  });

  it("prices the gap in USDG: the old bound let ~5.8% of the swapped leg be taken, on 0.5 WETH", () => {
    const oldBound = oldSpotAnchoredBound(SPOT, plan.swapAmount, true);
    const takeable = plan.expectedOut - oldBound; // USDG raw, 6 decimals
    const takeableBps = Number((takeable * 10_000n) / plan.expectedOut);
    expect(takeableBps).toBeGreaterThan(500); // >5% of the swapped half, per deposit, per skew
    expect(Number(takeable) / 1e6).toBeGreaterThan(50); // >50 USDG on a single 1-WETH deposit
    // The TWAP-anchored bound gives away only the slippage the user actually chose.
    const allowed = plan.expectedOut - plan.amountOutMin;
    expect(Number((allowed * 10_000n) / plan.expectedOut)).toBe(SLIPPAGE_BPS);
  });

  it("amountOutMin is exactly the TWAP-priced expectation less the caller's slippage — no other input", () => {
    const twapOut = expectedOutAtSqrtPrice(getSqrtRatioAtTick(TWAP_TICK), plan.swapAmount, true);
    expect(plan.expectedOut).toBe(twapOut);
    expect(plan.amountOutMin).toBe(applySlippageFloor(twapOut, SLIPPAGE_BPS));
  });

  it("the USDG leg is anchored too — a skew the other way is caught on the reverse direction", () => {
    // Depositing USDG sells half of it for WETH, so the attacker skews spot UP to hand over less WETH.
    const spotUp = TWAP_TICK + 500;
    const usdgPlan = buildZapPlan({
      anchor: anchorAt(spotUp),
      zeroForOne: false,
      amountIn: 2_000_000_000n, // 2,000 USDG (6 decimals)
      tickSpacing: SPACING,
      slippageBps: SLIPPAGE_BPS,
    });
    const outAtSkew = expectedOutAtSqrtPrice(getSqrtRatioAtTick(spotUp), usdgPlan.swapAmount, false);
    expect(outAtSkew).toBeLessThan(usdgPlan.amountOutMin);
    expect(outAtSkew).toBeGreaterThanOrEqual(oldSpotAnchoredBound(spotUp, usdgPlan.swapAmount, false));
  });
});

/* ------------------------------------------------------------------- the range itself */

describe("the deposit range is placed by the TWAP, so a walked spot cannot choose which side of the market you land on", () => {
  it("test_theRangeIsCentredOnTheTwapEvenWhenSpotSitsAtTheEdgeOfTheBand", () => {
    const spot = TWAP_TICK - 600; // the furthest skew the vault's own band still allows
    const plan = buildZapPlan({ anchor: anchorAt(spot), zeroForOne: true, amountIn: ONE_WETH, tickSpacing: SPACING });
    const center = (plan.tickLower + plan.tickUpper) / 2;
    expect(center).toBe(Math.round(TWAP_TICK / SPACING) * SPACING);
    expect(center).not.toBe(Math.round(spot / SPACING) * SPACING);
    // and the range is still legal for the vault: on spacing, inside [120, 60000]
    expect(Math.abs(plan.tickLower % SPACING)).toBe(0);
    expect(Math.abs(plan.tickUpper % SPACING)).toBe(0);
    expect(plan.tickUpper - plan.tickLower).toBe(30_000);
  });
});

/* ------------------------------------------------------------------ minLiquidity floor */

describe("minLiquidity is a floor that was derived, not the placeholder 1 that read like one", () => {
  const plan = buildZapPlan({
    anchor: anchorAt(TWAP_TICK),
    zeroForOne: true,
    amountIn: ONE_WETH,
    tickSpacing: SPACING,
    slippageBps: SLIPPAGE_BPS,
  });

  it("test_minLiquidityIsTheTwapPricedWorstCase_notOneWei", () => {
    expect(plan.minLiquidity).toBeGreaterThan(1n);
    const worst = getLiquidityForAmounts(
      getSqrtRatioAtTick(TWAP_TICK),
      getSqrtRatioAtTick(plan.tickLower),
      getSqrtRatioAtTick(plan.tickUpper),
      plan.amountIn - plan.swapAmount,
      plan.amountOutMin,
    );
    expect(plan.minLiquidity).toBe(applySlippageFloor(worst, ZAP_MIN_LIQUIDITY_MARGIN_BPS));
    // It is a real number, not dust: the old floor was 1 wei of liquidity.
    expect(plan.minLiquidity).toBeGreaterThan(10n ** 12n);
  });

  it("a zap whose swap returned almost nothing mints FAR below the floor, so the mint reverts", () => {
    // The attack that `minLiquidity: 1n` could never see: the swap leg is taken, the mint proceeds from
    // whatever is left, and the position is opened anyway.
    const robbed = getLiquidityForAmounts(
      getSqrtRatioAtTick(TWAP_TICK),
      getSqrtRatioAtTick(plan.tickLower),
      getSqrtRatioAtTick(plan.tickUpper),
      plan.amountIn - plan.swapAmount,
      1n, // the swap returned one wei of USDG
    );
    expect(robbed).toBeLessThan(plan.minLiquidity);
    expect(robbed).toBeGreaterThan(1n); // ...and yet it would have cleared a floor of 1
  });

  it("an honest deposit still clears it — the floor bounds theft, it does not block the product", () => {
    const honest = getLiquidityForAmounts(
      getSqrtRatioAtTick(TWAP_TICK),
      getSqrtRatioAtTick(plan.tickLower),
      getSqrtRatioAtTick(plan.tickUpper),
      plan.amountIn - plan.swapAmount,
      plan.expectedOut,
    );
    expect(honest).toBeGreaterThan(plan.minLiquidity);
  });

  it("test_aDepositTooSmallToFloorIsRefused_ratherThanShippedWithAFloorOfZero", () => {
    // 3 wei of WETH: the swapped half is worth zero raw USDG, so the worst-case mint is zero liquidity —
    // which is exactly as much of a bound as the `1` that used to sit here. Refused, not shipped.
    let threw: unknown;
    try {
      buildZapPlan({ anchor: anchorAt(TWAP_TICK), zeroForOne: true, amountIn: 3n, tickSpacing: SPACING });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(BoundTooSmallError);
    expect((threw as Error).message).toMatch(/Nothing was submitted/);
  });

  it("a deposit with no swap half at all lands on the same floor, not on a silent zero", () => {
    // 1 wei: swapAmount floors to 0, so one leg of min(L0, L1) is derived from nothing. The floor
    // catches it — which is why there is no separate guard upstream for this case.
    expect(() =>
      buildZapPlan({ anchor: anchorAt(TWAP_TICK), zeroForOne: true, amountIn: 1n, tickSpacing: SPACING }),
    ).toThrow(BoundTooSmallError);
    expect(() =>
      buildZapPlan({ anchor: anchorAt(TWAP_TICK), zeroForOne: false, amountIn: 1n, tickSpacing: SPACING }),
    ).toThrow(BoundTooSmallError);
  });
});

/* ---------------------------------------------------------------------- the refusal */

describe("a pool whose spot has walked outside the vault's own band is refused, not bounded", () => {
  it("test_aSkewBeyondTheVaultsOwnBandIsRefused_andNoCalldataIsProduced", () => {
    const spot = TWAP_TICK - 3_000; // ~26% below the time-averaged price
    let threw: unknown;
    try {
      buildZapPlan({ anchor: anchorAt(spot), zeroForOne: true, amountIn: ONE_WETH, tickSpacing: SPACING });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(PoolLooksManipulatedError);
    const err = threw as PoolLooksManipulatedError;
    expect(err.verdict.deviationTicks).toBe(3_000);
    expect(err.verdict.maxDeviationTicks).toBe(600);
    // The user is TOLD, in the one piece of copy, that nothing was sent.
    expect(err.message).toMatch(/looks manipulated/i);
    expect(err.message).toMatch(/3000 ticks/);
    expect(err.message).toMatch(/600-tick limit/);
    expect(err.message).toMatch(/Nothing was submitted/);
  });

  it("catches a skew in EITHER direction — the band is on |spot − TWAP|", () => {
    for (const spot of [TWAP_TICK - 3_000, TWAP_TICK + 3_000]) {
      expect(() =>
        buildZapPlan({ anchor: anchorAt(spot), zeroForOne: true, amountIn: ONE_WETH, tickSpacing: SPACING }),
      ).toThrow(PoolLooksManipulatedError);
    }
    expect(tickDeviation(TWAP_TICK + 3_000, TWAP_TICK)).toBe(tickDeviation(TWAP_TICK - 3_000, TWAP_TICK));
  });

  it("test_theBandIsInclusiveAtTheVaultsNumberAndRefusesOneTickPast", () => {
    expect(judgeAnchor(TWAP_TICK - 600, TWAP_TICK, 600).manipulated).toBe(false);
    expect(judgeAnchor(TWAP_TICK - 601, TWAP_TICK, 600).manipulated).toBe(true);
  });

  it("uses the band the VAULT reports, not a hard-coded one — a tighter vault refuses a smaller skew", () => {
    // At the vault's live 600 a 300-tick skew is fine; under a 120-tick vault it is not.
    expect(judgeAnchor(TWAP_TICK - 300, TWAP_TICK, 600).manipulated).toBe(false);
    expect(judgeAnchor(TWAP_TICK - 300, TWAP_TICK, 120).manipulated).toBe(true);
  });

  it("test_aVaultBandOfZeroIsNotReadAsUnlimited", async () => {
    // On chain, maxTwapDeviationTicks == 0 disables the gate. In a client that would restore the whole
    // defect, so zero falls back to the live band instead — a disabled on-chain gate is exactly when
    // this one has to bind.
    expect(judgeAnchor(TWAP_TICK - 3_000, TWAP_TICK, 0).manipulated).toBe(true);
    const anchor = await readPriceAnchor(
      reads({ twap: TWAP_TICK, spotTick: TWAP_TICK - 3_000, bounds: { maxTwapDeviationTicks: 0, twapWindowSeconds: 0 } }),
    );
    expect(anchor.maxDeviationTicks).toBe(FALLBACK_MAX_TWAP_DEVIATION_TICKS);
    expect(anchor.twapWindowSeconds).toBe(FALLBACK_TWAP_WINDOW_SECONDS);
    expect(anchor.manipulated).toBe(true);
  });

  it("the fallback band is the live vault's own number, and the queue's", () => {
    expect(FALLBACK_MAX_TWAP_DEVIATION_TICKS).toBe(600);
    expect(FALLBACK_MAX_TWAP_DEVIATION_TICKS).toBe(QUEUE_CONFIG.maxTwapDeviationTicks);
    expect(FALLBACK_TWAP_WINDOW_SECONDS).toBe(QUEUE_CONFIG.twapWindow);
  });
});

/* ------------------------------------------------------------------------- the read */

function reads(opts: {
  twap: number | Error;
  spotTick: number;
  bounds?: { maxTwapDeviationTicks: number; twapWindowSeconds: number } | Error;
  seen?: string[];
}): AnchorReads {
  const seen = opts.seen ?? [];
  return {
    twapTick: async (w: number) => {
      seen.push(`consult:${w}`);
      if (opts.twap instanceof Error) throw opts.twap;
      return opts.twap;
    },
    spot: async () => {
      seen.push("slot0");
      return { tick: opts.spotTick, sqrtPriceX96: getSqrtRatioAtTick(opts.spotTick) };
    },
    bounds: opts.bounds
      ? async () => {
          seen.push("bounds");
          if (opts.bounds instanceof Error) throw opts.bounds;
          return opts.bounds as { maxTwapDeviationTicks: number; twapWindowSeconds: number };
        }
      : undefined,
  };
}

describe("reading the anchor", () => {
  it("test_noOracleAnswerIsRefused_ratherThanFallingBackToSpot", async () => {
    const seen: string[] = [];
    await expect(
      readPriceAnchor(reads({ twap: new Error("InsufficientObservations"), spotTick: TWAP_TICK - 9_000, seen })),
    ).rejects.toBeInstanceOf(NoHonestAnchorError);
    // slot0 was never even consulted as a stand-in — that fallback is the defect, not the mitigation.
    expect(seen).not.toContain("slot0");
  });

  it("prices from the TWAP and merely records spot, however far apart they are", async () => {
    const anchor = await readPriceAnchor(reads({ twap: TWAP_TICK, spotTick: TWAP_TICK - 400 }));
    expect(anchor.twapSqrtPriceX96).toBe(getSqrtRatioAtTick(TWAP_TICK));
    expect(anchor.spotSqrtPriceX96).toBe(getSqrtRatioAtTick(TWAP_TICK - 400));
    expect(anchor.twapSqrtPriceX96).not.toBe(anchor.spotSqrtPriceX96);
    expect(anchor.deviationTicks).toBe(400);
    expect(anchor.manipulated).toBe(false);
  });

  it("consults over the window the VAULT reports, so client and chain average the same series", async () => {
    const seen: string[] = [];
    await readPriceAnchor(
      reads({ twap: TWAP_TICK, spotTick: TWAP_TICK, bounds: { maxTwapDeviationTicks: 600, twapWindowSeconds: 900 }, seen }),
    );
    expect(seen).toContain("consult:900");
  });

  it("an unreadable vault falls back to the live band rather than to no band at all", async () => {
    const anchor = await readPriceAnchor(
      reads({ twap: TWAP_TICK, spotTick: TWAP_TICK - 3_000, bounds: new Error("rpc down") }),
    );
    expect(anchor.maxDeviationTicks).toBe(FALLBACK_MAX_TWAP_DEVIATION_TICKS);
    expect(anchor.manipulated).toBe(true);
  });
});

/* ------------------------------------------------------------- nothing left on spot */

describe("no transaction bound in the deposit paths is still built from slot0", () => {
  const root = path.resolve(__dirname, "../..");
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

  it("the vault client no longer prices anything itself and no longer ships a placeholder floor", () => {
    const src = read("lib/mole/vault.ts");
    expect(src).not.toMatch(/minLiquidity:\s*1n/);
    // the spot price math that used to live here is gone, anchor and all
    expect(src).not.toMatch(/priceX192/);
    expect(src).toMatch(/readPriceAnchor\(/);
    expect(src).toMatch(/buildZapPlan\(/);
  });

  it("the native path refuses BEFORE it wraps, so a refused deposit never leaves the user holding WETH", () => {
    const src = read("lib/mole/vault.ts");
    const check = src.indexOf("assertAnchorUsable(a)"); // the CALL, not the import line
    const wrap = src.indexOf('onStep?.("Wrapping ETH');
    expect(check).toBeGreaterThan(-1);
    expect(wrap).toBeGreaterThan(-1);
    expect(check).toBeLessThan(wrap);
  });

  it("the ERC-20 path builds its bounds BEFORE it asks for an approval, so a refusal leaves nothing behind", () => {
    const src = read("lib/mole/vault.ts");
    const build = src.indexOf("const z = await buildZap(pub");
    const approve = src.indexOf('functionName: "approve"');
    expect(build).toBeGreaterThan(-1);
    expect(approve).toBeGreaterThan(-1);
    expect(build).toBeLessThan(approve);
  });

  it("the browser's one-sided add-liquidity refuses a walked pool BEFORE it asks for an approval", () => {
    const src = read("lib/chain/amm.ts");
    const fn = src.indexOf("export async function addLiquidityOneSided");
    expect(fn).toBeGreaterThan(-1);
    const check = src.indexOf("assertAnchorUsable(a)", fn);
    const approve = src.indexOf('functionName: "approve"', fn);
    expect(check).toBeGreaterThan(-1);
    expect(approve).toBeGreaterThan(-1);
    expect(check).toBeLessThan(approve);
    // ...and the RANGE is still placed relative to spot, because "one-sided" is a v4 fact about the
    // current tick, not an opinion about value. The gate is what protects it.
    expect(src.slice(fn)).toMatch(/computeOneSidedRange\(\{\s*side,\s*currentTick,/);
  });

  it("the zap plan takes the SAFER of the two prices for its bound, and the TWAP alone for its range", () => {
    // This assertion used to be "never mentions spot at all", which was too crude and hid a real bug:
    // a TWAP-ONLY bound is loose by the whole permitted drift whenever spot sits ABOVE the TWAP, and a
    // sandwicher keeps the difference. The safe property is not "ignore spot", it is "never let either
    // price make the bound LOOSER" — so the bound consults both and takes the max, which is the same
    // shape the add-liquidity route below already uses in its own direction (there, the min). The range
    // is a separate question and is still centred on the TWAP alone, because a range centred on a
    // walked spot hands the choice of side to whoever walked it.
    const src = read("lib/mole/zapPlan.ts");
    expect(src).toMatch(/assertAnchorUsable\(anchor\)/);
    expect(src).toMatch(/expectedOutAtSqrtPrice\(anchor\.twapSqrtPriceX96/);
    expect(src).toMatch(/expectedOutAtSqrtPrice\(anchor\.spotSqrtPriceX96/);
    expect(src).toMatch(/twapPriced > spotPriced \? twapPriced : spotPriced/);
    // the RANGE still never reads spot
    expect(src).toMatch(/Math\.round\(anchor\.twapTick \/ tickSpacing\)/);
    expect(src).not.toMatch(/Math\.round\(anchor\.spotTick \/ tickSpacing\)/);
  });

  it("the add-liquidity route refuses a manipulated pool and centres its default range on the TWAP", () => {
    const src = read("app/api/v1/tx/add-liquidity/route.ts");
    expect(src).toMatch(/judgeAnchor\(currentTick, twapTick, maxDevTicks\)/);
    expect(src).toMatch(/if \(anchorVerdict\.manipulated\)/);
    expect(src).toMatch(/manipulatedMessage\(anchorVerdict\)/);
    expect(src).toMatch(/const center = snapToSpacing\(twapTick\)/);
    expect(src).not.toMatch(/const center = snapToSpacing\(currentTick\)/);
    // and the declared liquidity can never be inflated by the price we distrust
    expect(src).toMatch(/liquidityAtSpot < liquidityAtTwap \? liquidityAtSpot : liquidityAtTwap/);
  });
});

/* ------------------------------------------------- the mirror direction, which had no test at all */

describe("a spot walked UP cannot loosen the bound either — the direction the TWAP-only fix leaked", () => {
  // The first fix anchored amountOutMin to the TWAP alone. That is correct when spot has been walked
  // DOWN, and wrong by the whole permitted drift when it has been walked UP: the honest output at a
  // spot 600 ticks above the TWAP is ~6.2% richer than the TWAP claims, so a TWAP-priced floor lets a
  // sandwicher keep the difference. It is the same defect as the original, mirrored — and cheaper,
  // because it needs one atomic sandwich instead of a skew held across blocks. Nothing exercised this
  // direction, so nothing caught it.
  const SPOT_UP = TWAP_TICK + 600; // exactly at the vault's deviation limit, so the pool is NOT refused
  const plan = buildZapPlan({
    anchor: anchorAt(SPOT_UP),
    zeroForOne: true,
    amountIn: ONE_WETH,
    tickSpacing: SPACING,
    slippageBps: SLIPPAGE_BPS,
  });

  /** What the TWAP-only bound would have demanded — the regression, computed exactly. */
  function twapOnlyBound(swapAmount: bigint): bigint {
    const out = expectedOutAtSqrtPrice(getSqrtRatioAtTick(TWAP_TICK), swapAmount, true);
    return (out * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
  }

  it("demands the richer price the pool is actually offering, not the poorer time-averaged one", () => {
    const honestOut = expectedOutAtSqrtPrice(getSqrtRatioAtTick(SPOT_UP), plan.swapAmount, true);
    // The floor tracks the real price to within the user's own slippage tolerance...
    expect(plan.amountOutMin).toBeGreaterThan((honestOut * BigInt(10_000 - SLIPPAGE_BPS * 2)) / 10_000n);
    // ...and is strictly tighter than the TWAP-only bound this replaced.
    expect(plan.amountOutMin).toBeGreaterThan(twapOnlyBound(plan.swapAmount));
  });

  it("closes the gap a sandwicher could have taken under the TWAP-only bound", () => {
    const honestOut = expectedOutAtSqrtPrice(getSqrtRatioAtTick(SPOT_UP), plan.swapAmount, true);
    const leakedUnderTwapOnly = honestOut - twapOnlyBound(plan.swapAmount);
    const leakedNow = honestOut - plan.amountOutMin;
    // The old gap was worth more than half a percent of the swap; the new one is just the user's own
    // stated tolerance. Asserting the RATIO, so this keeps meaning the same thing if the fixture moves.
    expect(leakedUnderTwapOnly).toBeGreaterThan((honestOut * 500n) / 10_000n);
    expect(leakedNow).toBeLessThan(leakedUnderTwapOnly);
    expect(leakedNow).toBeLessThanOrEqual((honestOut * BigInt(SLIPPAGE_BPS)) / 10_000n + 1n);
  });

  it("still refuses a spot walked DOWN — max() must not have undone the original fix", () => {
    const downPlan = buildZapPlan({
      anchor: anchorAt(TWAP_TICK - 500),
      zeroForOne: true,
      amountIn: ONE_WETH,
      tickSpacing: SPACING,
      slippageBps: SLIPPAGE_BPS,
    });
    const outAtWalkedSpot = expectedOutAtSqrtPrice(getSqrtRatioAtTick(TWAP_TICK - 500), downPlan.swapAmount, true);
    expect(outAtWalkedSpot).toBeLessThan(downPlan.amountOutMin);
  });
});
