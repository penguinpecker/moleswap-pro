/**
 * withdrawFloor.test.ts — the EXIT, driven as the attack, and driven as the trap.
 *
 * TWO FAILURES ARE POSSIBLE ON THIS PATH AND THEY POINT IN OPPOSITE DIRECTIONS, which is why this file
 * tests both halves rather than only the obvious one:
 *
 *   1. A floor that agrees with a manipulated price is not a floor. `MolePositions.withdrawWithMinimums`
 *      has been live on both chains since the 2026-08-23 audit and the client passed (0, 0) on every
 *      exit — so a withdrawal took whatever composition the pool held at that block. Wiring the floor to
 *      `slot0` instead of the TWAP would have reproduced the deposit-side defect exactly: a bound built
 *      from the price the burn settles at clears by construction.
 *   2. A floor that is too HIGH traps funds, and trapped funds are worse than slippage. So every test
 *      below that pushes the floor up is matched by one that pins it loose: floors never exceed what the
 *      anchor itself pays, a leg the band can empty floors at ZERO rather than refusing, a manipulated
 *      pool still gets a plan (refusing to BUILD an exit is the client inventing the censorship lever
 *      `MolePositions.withdraw` documents itself as refusing to be), and the unfloored `withdrawAll`
 *      stays wired and reachable.
 *
 * Fixtures are the live chain as read on 2026-08-24: MoleHook consult(1800) = -200461 and slot0 tick
 * = -200461 on the WETH/USDG pool, vault maxTwapDeviationTicks = 600, and MolePositions position #3 —
 * liquidity 4976312705240 over [-201060, -200460], which sits one tick under its own upper edge and is
 * therefore the real-world case where one leg's floor MUST be allowed to be zero.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { toFunctionSelector } from "viem";
import { getSqrtRatioAtTick } from "@/lib/aggregator/math/tickMath";
import { getLiquidityForAmounts } from "@/lib/mole/seedLiquidity";
import { molePositionsAbi } from "@/lib/mole/abi";
import {
  FALLBACK_MAX_TWAP_DEVIATION_TICKS,
  FALLBACK_TWAP_WINDOW_SECONDS,
  type PriceAnchor,
} from "@/lib/mole/priceAnchor";
import {
  FLOOR_ROUNDING_SLACK_UNITS,
  amountsForLiquidity,
  buildWithdrawFloor,
  floorNotMetMessage,
  slippageToleranceTicks,
} from "@/lib/mole/withdrawPlan";
import { DEFAULT_SLIPPAGE_BPS, slippageBpsFor } from "@/lib/settings/swapSettings";

/* ------------------------------------------------------------------------ fixtures */

const TWAP_TICK = -200_461; // MoleHook consult(1800) on the live WETH/USDG pool
const SPACING = 60;

/** Live MolePositions #3, read from Robinhood 4663 on 2026-08-24. */
const LIVE_POSITION = { tickLower: -201_060, tickUpper: -200_460, liquidity: 4_976_312_705_240n };

/** A zap-shaped position: the ±15 000-tick range `zapPlan` builds around the same TWAP. */
const WIDE_POSITION = { tickLower: -215_460, tickUpper: -185_460, liquidity: 10n ** 15n };

/** An anchor exactly as `readPriceAnchor` returns it, with spot placed wherever the test wants. */
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

/** What the burn actually pays if it settles at `tick` — the number the contract compares the floor to. */
function paidAt(tick: number, position: { tickLower: number; tickUpper: number; liquidity: bigint }) {
  return amountsForLiquidity(
    getSqrtRatioAtTick(tick),
    getSqrtRatioAtTick(position.tickLower),
    getSqrtRatioAtTick(position.tickUpper),
    position.liquidity,
  );
}

/** `_withdraw`'s check, transcribed: `if (amount0 < amount0Min || amount1 < amount1Min) revert`. */
function contractAccepts(
  paid: { amount0: bigint; amount1: bigint },
  floor: { amount0Min: bigint; amount1Min: bigint },
): boolean {
  return paid.amount0 >= floor.amount0Min && paid.amount1 >= floor.amount1Min;
}

const root = path.resolve(__dirname, "../..");
const readSource = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/* ============================================================ the floor IS the TWAP's */

describe("the exit floor is derived from the TWAP, and spot cannot move it", () => {
  const honest = buildWithdrawFloor({
    anchor: anchorAt(TWAP_TICK),
    ...WIDE_POSITION,
    liquidityToRemove: WIDE_POSITION.liquidity,
    slippageBps: DEFAULT_SLIPPAGE_BPS,
  });

  it("a spot walked to the far edge of the vault's own band produces the IDENTICAL floor", () => {
    for (const spot of [TWAP_TICK - 600, TWAP_TICK - 500, TWAP_TICK + 500, TWAP_TICK + 600]) {
      const walked = buildWithdrawFloor({
        anchor: anchorAt(spot),
        ...WIDE_POSITION,
        liquidityToRemove: WIDE_POSITION.liquidity,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      });
      expect(walked.amount0Min).toBe(honest.amount0Min);
      expect(walked.amount1Min).toBe(honest.amount1Min);
    }
  });

  it("a spot walked PAST the band — a pool the deposit path refuses outright — still cannot move it", () => {
    const anchor = anchorAt(TWAP_TICK - 5_000);
    expect(anchor.manipulated).toBe(true);
    const walked = buildWithdrawFloor({
      anchor,
      ...WIDE_POSITION,
      liquidityToRemove: WIDE_POSITION.liquidity,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
    });
    expect(walked.amount0Min).toBe(honest.amount0Min);
    expect(walked.amount1Min).toBe(honest.amount1Min);
  });

  it("moving the TWAP DOES move the floor — otherwise the anchor is decoration, not an input", () => {
    const moved = buildWithdrawFloor({
      anchor: anchorAt(TWAP_TICK - 300, { twapTick: TWAP_TICK - 300 }),
      ...WIDE_POSITION,
      liquidityToRemove: WIDE_POSITION.liquidity,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
    });
    // Price down: the position holds MORE token0 and LESS token1, and both floors follow.
    expect(moved.amount0Min).toBeGreaterThan(honest.amount0Min);
    expect(moved.amount1Min).toBeLessThan(honest.amount1Min);
  });

  it("ATTACK: a burn settling at a walked spot FAILS the floor — which is the whole point of having one", () => {
    // 500 ticks is INSIDE the vault's 600-tick band, so nothing on chain refuses this pool. Only the
    // floor stands between the exiting user and a composition someone else chose.
    const walkedDown = paidAt(TWAP_TICK - 500, WIDE_POSITION);
    expect(contractAccepts(walkedDown, honest)).toBe(false); // starved of token1
    const walkedUp = paidAt(TWAP_TICK + 500, WIDE_POSITION);
    expect(contractAccepts(walkedUp, honest)).toBe(false); // starved of token0
    // ...while the honest price clears both legs.
    expect(contractAccepts(paidAt(TWAP_TICK, WIDE_POSITION), honest)).toBe(true);
  });

  it("ATTACK: the spot-anchored floor we did NOT build would have waved the manipulation through", () => {
    const spot = TWAP_TICK - 500;
    // The shape of the old deposit-side defect, transcribed onto the exit: price the minimums at slot0,
    // then let the burn settle at slot0. It agrees with itself, every time.
    const spotAnchored = buildWithdrawFloor({
      anchor: anchorAt(spot, { twapTick: spot }),
      ...WIDE_POSITION,
      liquidityToRemove: WIDE_POSITION.liquidity,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
    });
    expect(contractAccepts(paidAt(spot, WIDE_POSITION), spotAnchored)).toBe(true);
    expect(spotAnchored.amount1Min).toBeLessThan(honest.amount1Min);
  });

  it("the vault client reads the anchor for the exit and never prices it from slot0", () => {
    const src = readSource("lib/mole/vault.ts");
    const fn = src.indexOf("export async function almWithdrawWithFloor");
    expect(fn).toBeGreaterThan(-1);
    const body = src.slice(fn);
    expect(body).toMatch(/readPriceAnchor\(/);
    expect(body).toMatch(/buildWithdrawFloor\(/);
    expect(body).not.toMatch(/getSlot0/);
    expect(body).not.toMatch(/spotSqrtPriceX96/);
  });
});

/* ================================================== the user's setting, not a literal */

describe("the floor spends the user's own slippage setting", () => {
  const floorAt = (slippageBps: number) =>
    buildWithdrawFloor({
      anchor: anchorAt(TWAP_TICK),
      ...WIDE_POSITION,
      liquidityToRemove: WIDE_POSITION.liquidity,
      slippageBps,
    });

  it("the tolerance band IS the slippage setting, converted to ticks", () => {
    expect(floorAt(50).toleranceTicks).toBe(slippageToleranceTicks(50));
    expect(floorAt(50).toleranceTicks).toBe(50); // 1.0001^50 ≈ 1.005
    expect(floorAt(500).toleranceTicks).toBe(488); // 1.0001^488 ≈ 1.05
  });

  it("the Settings panel's own value reaches it — 'AUTO' and '0.5' are the same 50 bps", () => {
    expect(slippageBpsFor("AUTO")).toBe(DEFAULT_SLIPPAGE_BPS);
    expect(floorAt(slippageBpsFor("0.5")).toleranceTicks).toBe(floorAt(DEFAULT_SLIPPAGE_BPS).toleranceTicks);
    expect(floorAt(slippageBpsFor("5")).toleranceTicks).toBeGreaterThan(floorAt(slippageBpsFor("0.5")).toleranceTicks);
  });

  it("more tolerance is a LOWER floor, monotonically — the setting can only ever loosen the exit", () => {
    let previous = floorAt(0);
    for (const bps of [1, 10, 50, 100, 500, 2_000, 10_000]) {
      const next = floorAt(bps);
      expect(next.amount0Min).toBeLessThanOrEqual(previous.amount0Min);
      expect(next.amount1Min).toBeLessThanOrEqual(previous.amount1Min);
      previous = next;
    }
  });

  it("MUTATION: the exit reads the live panel value, not zapPlan's deposit-side default", () => {
    const src = readSource("lib/mole/vault.ts");
    const fn = src.indexOf("export async function almWithdrawWithFloor");
    const body = src.slice(fn);
    expect(body).toMatch(/slippageBps:\s*opts\.slippageBps\s*\?\?\s*getSlippageBps\(\)/);
    expect(body).not.toMatch(/DEFAULT_SLIPPAGE_BPS/);
  });

  it("there is no default slippage to forget to pass — the argument is required", () => {
    const src = readSource("lib/mole/withdrawPlan.ts");
    expect(src).not.toMatch(/slippageBps\?:/);
    expect(src).not.toMatch(/slippageBps\s*=\s*\d/);
  });
});

/* ============================================================== it fails LOOSE, always */

describe("the floor errs low, because a floor that is too high traps funds", () => {
  const floor = buildWithdrawFloor({
    anchor: anchorAt(TWAP_TICK),
    ...WIDE_POSITION,
    liquidityToRemove: WIDE_POSITION.liquidity,
    slippageBps: DEFAULT_SLIPPAGE_BPS,
  });

  it("EVERY price inside the band clears BOTH legs — the two floors are one joint bound", () => {
    // Each leg is priced at the opposite end of the band, so this is the property that says the pair is
    // coherent: pricing both legs at one tick would over-floor one of them and block exits in here.
    for (let tick = floor.amount1FloorTick; tick <= floor.amount0FloorTick; tick += 5) {
      expect(contractAccepts(paidAt(tick, WIDE_POSITION), floor)).toBe(true);
    }
    expect(contractAccepts(paidAt(floor.amount0FloorTick, WIDE_POSITION), floor)).toBe(true);
    expect(contractAccepts(paidAt(floor.amount1FloorTick, WIDE_POSITION), floor)).toBe(true);
  });

  it("a price outside the band fails exactly one leg, and it is the starved one", () => {
    const above = paidAt(floor.amount0FloorTick + SPACING, WIDE_POSITION);
    expect(above.amount0).toBeLessThan(floor.amount0Min);
    expect(above.amount1).toBeGreaterThan(floor.amount1Min);
    const below = paidAt(floor.amount1FloorTick - SPACING, WIDE_POSITION);
    expect(below.amount1).toBeLessThan(floor.amount1Min);
    expect(below.amount0).toBeGreaterThan(floor.amount0Min);
  });

  it("neither floor ever exceeds what the anchor itself pays", () => {
    expect(floor.amount0Min).toBeLessThan(floor.expected0);
    expect(floor.amount1Min).toBeLessThan(floor.expected1);
  });

  it("the rounding slack is shaved OFF, never added — v4 floors what it pays and so do we", () => {
    const tight = buildWithdrawFloor({
      anchor: anchorAt(TWAP_TICK),
      ...WIDE_POSITION,
      liquidityToRemove: WIDE_POSITION.liquidity,
      slippageBps: 0,
    });
    expect(tight.toleranceTicks).toBe(0);
    expect(tight.amount0Min).toBe(tight.expected0 - FLOOR_ROUNDING_SLACK_UNITS);
    expect(tight.amount1Min).toBe(tight.expected1 - FLOOR_ROUNDING_SLACK_UNITS);
  });

  it("LIVE POSITION #3: a leg the band can empty floors at zero instead of refusing to build", () => {
    // The position sits one tick below its own upper edge, so a 50-tick band reaches past it and the
    // burn can legitimately pay no token0 at all. Flooring that leg at anything above zero would block
    // the exit of a real, live position — and throwing instead would leave it with no floored exit.
    const floor3 = buildWithdrawFloor({
      anchor: anchorAt(TWAP_TICK),
      ...LIVE_POSITION,
      liquidityToRemove: LIVE_POSITION.liquidity,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
    });
    expect(floor3.amount0FloorTick).toBeGreaterThan(LIVE_POSITION.tickUpper);
    expect(floor3.amount0Min).toBe(0n);
    expect(floor3.amount1Min).toBeGreaterThan(0n);
    expect(contractAccepts(paidAt(TWAP_TICK, LIVE_POSITION), floor3)).toBe(true);
  });

  it("a manipulated pool still gets a plan — the client never censors an exit", () => {
    // The deposit builder throws PoolLooksManipulatedError here on purpose. The exit must not: refusing
    // to BUILD a withdrawal is the client becoming the thing MolePositions.withdraw refuses to be.
    const anchor = anchorAt(TWAP_TICK - 5_000);
    expect(anchor.manipulated).toBe(true);
    expect(() =>
      buildWithdrawFloor({
        anchor,
        ...WIDE_POSITION,
        liquidityToRemove: WIDE_POSITION.liquidity,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      }),
    ).not.toThrow();
    expect(readSource("lib/mole/withdrawPlan.ts")).not.toMatch(/assertAnchorUsable/);
  });

  it("a partial exit floors the slice, not the position — the floor is this burn's own", () => {
    const half = buildWithdrawFloor({
      anchor: anchorAt(TWAP_TICK),
      ...WIDE_POSITION,
      liquidityToRemove: WIDE_POSITION.liquidity / 2n,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
    });
    expect(half.amount1Min * 2n).toBeLessThanOrEqual(floor.amount1Min + 4n);
    expect(half.amount1Min * 2n).toBeGreaterThan((floor.amount1Min * 99n) / 100n);
  });
});

/* ====================================================== the unfloored escape hatch */

describe("the exit with no floor at all stays reachable, and nothing silently replaces it", () => {
  it("withdrawAll(id) is still in the ABI and still takes only the id", () => {
    const all = (molePositionsAbi as readonly any[]).find((e) => e.name === "withdrawAll");
    expect(all).toBeDefined();
    expect(all.inputs.map((i: any) => [i.name, i.type])).toEqual([["id", "uint256"]]);
  });

  it("almWithdraw still sends withdrawAll — the one-call exit at any price", () => {
    const src = readSource("lib/mole/vault.ts");
    const fn = src.indexOf("export async function almWithdraw(");
    expect(fn).toBeGreaterThan(-1);
    const body = src.slice(fn, src.indexOf("export ", fn + 10));
    expect(body).toMatch(/functionName:\s*"withdrawAll"/);
    // and it stays free of every price read, so nothing about it can fail closed
    expect(body).not.toMatch(/readPriceAnchor|buildWithdrawFloor|amount0Min/);
  });

  it("the floored exit NEVER falls back to the unfloored one — a droppable floor is not a floor", () => {
    const src = readSource("lib/mole/vault.ts");
    const body = src.slice(src.indexOf("export async function almWithdrawWithFloor"));
    expect(body).toMatch(/functionName:\s*"withdrawWithMinimums"/);
    expect(body).not.toMatch(/functionName:\s*"withdrawAll"/);
    expect(body).not.toMatch(/functionName:\s*"withdraw"/);
  });

  it("the refusal message says nothing was submitted AND names the way out", () => {
    const msg = floorNotMetMessage({ toleranceTicks: 50 });
    expect(msg).toMatch(/50-tick/);
    expect(msg).toMatch(/[Nn]othing was submitted/);
    expect(msg).toMatch(/untouched/);
    expect(msg).toMatch(/withdraw all/i);
  });

  it("only WithdrawBelowMinimum is translated into a price message — other reverts stay themselves", () => {
    const src = readSource("lib/mole/vault.ts");
    // The live selector, checked against the deployed implementation on both chains.
    expect(src).toMatch(/"0x0fdbcf37"/);
    expect(toFunctionSelector("WithdrawBelowMinimum()")).toBe("0x0fdbcf37");
  });
});

/* ================================================================== the ABI itself */

describe("withdrawWithMinimums is encoded exactly as the deployed vault expects", () => {
  const fn = (molePositionsAbi as readonly any[]).find((e) => e.name === "withdrawWithMinimums");

  it("takes (uint256 id, uint128 liquidityToRemove, uint256 amount0Min, uint256 amount1Min)", () => {
    expect(fn).toBeDefined();
    expect(fn.stateMutability).toBe("nonpayable");
    expect(fn.inputs.map((i: any) => [i.name, i.type])).toEqual([
      ["id", "uint256"],
      ["liquidityToRemove", "uint128"],
      ["amount0Min", "uint256"],
      ["amount1Min", "uint256"],
    ]);
    expect(fn.outputs).toEqual([]);
  });

  it("hashes to 0xaaff5bcc — the selector present in BOTH live implementations", () => {
    // RH 4663 impl 0xd231a291…55a1 and Arc 5042 impl 0x9aca6745…950e both carry this selector; a
    // liquidityToRemove typed uint256 instead of uint128 would hash elsewhere and hit no function.
    expect(toFunctionSelector("withdrawWithMinimums(uint256,uint128,uint256,uint256)")).toBe("0xaaff5bcc");
    const built = toFunctionSelector(
      `withdrawWithMinimums(${fn.inputs.map((i: any) => i.type).join(",")})`,
    );
    expect(built).toBe("0xaaff5bcc");
  });

  it("is NOT an overload of withdraw — the exit's own selector must stay unambiguous", () => {
    const named = (molePositionsAbi as readonly any[]).filter((e) => e.name === "withdraw");
    expect(named).toHaveLength(1);
  });
});

/* ========================================================== the amounts arithmetic */

describe("amountsForLiquidity is the inverse of the liquidity math the deposit path uses", () => {
  const { tickLower, tickUpper, liquidity } = WIDE_POSITION;
  const sa = getSqrtRatioAtTick(tickLower);
  const sb = getSqrtRatioAtTick(tickUpper);

  it("round-trips through getLiquidityForAmounts to within rounding", () => {
    const p = getSqrtRatioAtTick(TWAP_TICK);
    const { amount0, amount1 } = amountsForLiquidity(p, sa, sb, liquidity);
    const back = getLiquidityForAmounts(p, sa, sb, amount0, amount1);
    // Both directions floor, so `back` may land a hair under; it must never land over.
    expect(back).toBeLessThanOrEqual(liquidity);
    expect(back).toBeGreaterThan((liquidity * 99_999n) / 100_000n);
  });

  it("below the range it is all token0, above it all token1 — the clamp IS the case split", () => {
    const below = amountsForLiquidity(getSqrtRatioAtTick(tickLower - 1_000), sa, sb, liquidity);
    expect(below.amount1).toBe(0n);
    expect(below.amount0).toBeGreaterThan(0n);
    // clamped, so going further out changes nothing
    expect(amountsForLiquidity(getSqrtRatioAtTick(tickLower - 50_000), sa, sb, liquidity)).toEqual(below);

    const above = amountsForLiquidity(getSqrtRatioAtTick(tickUpper + 1_000), sa, sb, liquidity);
    expect(above.amount0).toBe(0n);
    expect(above.amount1).toBeGreaterThan(0n);
  });

  it("token0 falls as the price rises and token1 rises with it — the reason each leg has its own tick", () => {
    let prior = amountsForLiquidity(getSqrtRatioAtTick(tickLower), sa, sb, liquidity);
    for (let tick = tickLower + 600; tick <= tickUpper; tick += 600) {
      const now = amountsForLiquidity(getSqrtRatioAtTick(tick), sa, sb, liquidity);
      expect(now.amount0).toBeLessThan(prior.amount0);
      expect(now.amount1).toBeGreaterThan(prior.amount1);
      prior = now;
    }
  });

  it("takes the range bounds in either order and rejects a nonsense price", () => {
    expect(amountsForLiquidity(getSqrtRatioAtTick(TWAP_TICK), sb, sa, liquidity)).toEqual(
      amountsForLiquidity(getSqrtRatioAtTick(TWAP_TICK), sa, sb, liquidity),
    );
    expect(() => amountsForLiquidity(0n, sa, sb, liquidity)).toThrow();
  });

  it("refuses the arguments that would silently produce a meaningless floor", () => {
    const base = { anchor: anchorAt(TWAP_TICK), slippageBps: DEFAULT_SLIPPAGE_BPS, ...WIDE_POSITION };
    expect(() => buildWithdrawFloor({ ...base, liquidityToRemove: 0n })).toThrow(/positive/);
    expect(() => buildWithdrawFloor({ ...base, liquidityToRemove: 1n << 130n })).toThrow(/uint128/);
    expect(() =>
      buildWithdrawFloor({ ...base, tickLower: 0, tickUpper: 0, liquidityToRemove: 1_000n }),
    ).toThrow(/tickLower/);
    expect(() => slippageToleranceTicks(10_001)).toThrow(RangeError);
    expect(() => slippageToleranceTicks(1.5)).toThrow(RangeError);
  });
});
