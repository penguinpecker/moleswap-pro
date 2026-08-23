/**
 * hookBitmap.test.ts — the bitmap proof is arithmetic on the address; make sure it is the RIGHT arithmetic.
 *
 * Written as attacks first: hostile hooks that carry a remove-liquidity bit, a lookalike that copies
 * MoleHook's exact bitmap at a different address (mining is cheap — the bits never prove identity), a
 * deposit-tax bit, malformed inputs, and registry rows whose `venue` label disagrees with their hook.
 * Then the confirmations: the live MoleHook decodes to 0x38C4 with exactly the six mined flags, the
 * remove-path mask is 0x0301 and matches the Solidity constant byte-for-byte.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  HOOK_PERMISSION_MASK,
  REMOVE_LIQUIDITY_MASK,
  DEPOSIT_TAX_MASK,
  MOLE_HOOK_BITMAP,
  HOOK_FLAGS,
  hookBitmap,
  removeLiquidityBitsClear,
  depositTaxBitClear,
  hookBitmapProof,
  isMoleHookServed,
  poolServiceTag,
  engineActionsAllowed,
  v4VenueLabel,
  SERVICE_TAG_LABEL,
} from "../../lib/mole/hookBitmap";
import { MOLE_ADDRESSES } from "../../lib/mole/chain";

const MOLE_HOOK = "0xb2c9A0af48dF8858F3765385E733Cd8776a138C4";
const ZERO = "0x0000000000000000000000000000000000000000";

/** An address whose low 14 bits are exactly `bits`, with arbitrary (non-MoleHook) high bits. */
const withBits = (bits: number, high = "0xdeadbeefdeadbeefdeadbeefdeadbeefdead") =>
  (`${high}${(bits & 0x3fff).toString(16).padStart(4, "0")}`) as `0x${string}`;

describe("ATTACK — hostile bitmaps", () => {
  it("a hook carrying beforeRemoveLiquidity (0x0200) fails the withdrawal proof", () => {
    const h = withBits(MOLE_HOOK_BITMAP | 0x0200);
    expect(removeLiquidityBitsClear(h)).toBe(false);
    const p = hookBitmapProof(h);
    expect(p.removeBitsClear).toBe(false);
    expect(p.proofLine).toBe("uint160(hook) & 0x0301 == 0 ✗");
    expect(p.setFlags).toContain("beforeRemoveLiquidity");
    expect(p.bits.find((b) => b.bit === 9)!.set).toBe(true);
  });

  it("a hook carrying afterRemoveLiquidity (0x0100) fails the withdrawal proof", () => {
    const h = withBits(MOLE_HOOK_BITMAP | 0x0100);
    expect(removeLiquidityBitsClear(h)).toBe(false);
    expect(hookBitmapProof(h).setFlags).toContain("afterRemoveLiquidity");
  });

  it("a hook carrying afterRemoveLiquidityReturnDelta (0x0001) fails the withdrawal proof", () => {
    const h = withBits(MOLE_HOOK_BITMAP | 0x0001);
    expect(removeLiquidityBitsClear(h)).toBe(false);
    expect(hookBitmapProof(h).setFlags).toContain("afterRemoveLiquidityReturnDelta");
  });

  it("a hook with ONLY a remove bit and nothing else still fails — the mask is tested alone, not 'ours plus'", () => {
    for (const bit of [0x0200, 0x0100, 0x0001]) {
      expect(removeLiquidityBitsClear(withBits(bit))).toBe(false);
    }
    expect(removeLiquidityBitsClear(withBits(0x0301))).toBe(false);
  });

  it("every OTHER bit set (0x3FFF & ~0x0301) still passes the withdrawal proof — the mask is exactly the three remove bits", () => {
    const everythingButRemove = HOOK_PERMISSION_MASK & ~REMOVE_LIQUIDITY_MASK;
    expect(removeLiquidityBitsClear(withBits(everythingButRemove))).toBe(true);
    // and adding any one remove bit back breaks it
    expect(removeLiquidityBitsClear(withBits(everythingButRemove | 0x0200))).toBe(false);
    expect(removeLiquidityBitsClear(withBits(everythingButRemove | 0x0100))).toBe(false);
    expect(removeLiquidityBitsClear(withBits(everythingButRemove | 0x0001))).toBe(false);
  });

  it("a LOOKALIKE with MoleHook's exact bitmap at another address passes the bit proof but is NOT MoleHook", () => {
    const lookalike = withBits(MOLE_HOOK_BITMAP);
    const p = hookBitmapProof(lookalike);
    expect(p.bitmap).toBe(0x38c4);
    expect(p.matchesMoleBitmap).toBe(true);
    expect(p.removeBitsClear).toBe(true); // the bits genuinely prove the callbacks cannot fire…
    expect(isMoleHookServed(lookalike)).toBe(false); // …and prove nothing about who deployed it
    expect(poolServiceTag({ venue: "mole_v4", hooks: lookalike })).toBe("foreign-v4");
    expect(engineActionsAllowed(poolServiceTag({ venue: "mole_v4", hooks: lookalike }))).toBe(false);
    expect(v4VenueLabel(lookalike)).toBe("Uniswap v4");
  });

  it("matchesMoleBitmap is exact equality with 0x38C4 — a subset, a superset, and a hostile superset all read false", () => {
    expect(hookBitmapProof(withBits(0x00c4)).matchesMoleBitmap).toBe(false); // subset
    expect(hookBitmapProof(withBits(MOLE_HOOK_BITMAP | 0x0002)).matchesMoleBitmap).toBe(false); // superset
    expect(hookBitmapProof(withBits(MOLE_HOOK_BITMAP | 0x0200)).matchesMoleBitmap).toBe(false); // hostile superset
    expect(hookBitmapProof(withBits(0)).matchesMoleBitmap).toBe(false); // hookless-shaped
  });

  it("the deposit-tax bit (0x0002) is detected", () => {
    expect(depositTaxBitClear(withBits(MOLE_HOOK_BITMAP | 0x0002))).toBe(false);
    expect(hookBitmapProof(withBits(0x0002)).depositTaxClear).toBe(false);
  });

  it("malformed input fails closed: never 'served', and the decoder throws rather than guessing", () => {
    for (const bad of ["", "0x", "not an address", "0x38c4", ZERO, "0xb2c9A0af48dF8858F3765385E733Cd8776a138C", `${MOLE_HOOK}00`]) {
      expect(isMoleHookServed(bad)).toBe(false);
    }
    expect(isMoleHookServed(undefined)).toBe(false);
    expect(isMoleHookServed(null)).toBe(false);
    expect(() => hookBitmap("")).toThrow();
    expect(() => hookBitmap("0x38c4")).toThrow();
    expect(() => hookBitmap("0xb2c9A0af48dF8858F3765385E733Cd8776a138C")).toThrow(); // 39 hex chars
    expect(() => hookBitmapProof("0xzz" + "0".repeat(38))).toThrow();
  });
});

describe("ATTACK — registry labels do not decide service, the hook address does", () => {
  it("a row filed under venue 'mole_v4' with a foreign hook is foreign — no Provide / Queue", () => {
    const tag = poolServiceTag({ venue: "mole_v4", hooks: withBits(0x38c4 | 0x0200) });
    expect(tag).toBe("foreign-v4");
    expect(engineActionsAllowed(tag)).toBe(false);
  });

  it("a row filed under venue 'mole_v4' with NO hook on record is not guessed to be ours", () => {
    expect(poolServiceTag({ venue: "mole_v4", hooks: null })).toBe("foreign-v4");
    expect(poolServiceTag({ venue: "mole_v4" })).toBe("foreign-v4");
  });

  it("a hookless v4 pool (hooks = address(0)) is foreign", () => {
    expect(poolServiceTag({ venue: "uniswap_v4", hooks: ZERO })).toBe("foreign-v4");
    expect(poolServiceTag({ venue: "UniswapV4", poolKey: { hooks: ZERO } })).toBe("foreign-v4");
    expect(v4VenueLabel(ZERO)).toBe("Uniswap v4");
  });

  it("a simulator PoolState with a foreign poolKey.hooks is foreign, whatever its venue string", () => {
    const foreign = withBits(0x00c4);
    expect(poolServiceTag({ venue: "UniswapV4", poolKey: { hooks: foreign } })).toBe("foreign-v4");
    expect(v4VenueLabel(foreign)).toBe("Uniswap v4");
  });

  it("v3 rows are v3 and get no engine actions", () => {
    for (const venue of ["pancake_v3", "uniswap_v3", "PancakeV3"]) {
      const tag = poolServiceTag({ venue, hooks: null });
      expect(tag).toBe("v3");
      expect(engineActionsAllowed(tag)).toBe(false);
    }
    expect(poolServiceTag({})).toBe("v3");
  });

  it("a row filed under 'uniswap_v4' that actually carries MoleHook IS ours — the address wins both ways", () => {
    expect(poolServiceTag({ venue: "uniswap_v4", hooks: MOLE_HOOK.toLowerCase() })).toBe("molehook");
  });
});

describe("CONFIRM — the live MoleHook decodes to exactly the mined bitmap", () => {
  it("bitmap is 0x38C4, binary 11100011000100, and the pinned address decodes to the pinned constant", () => {
    expect(hookBitmap(MOLE_HOOK)).toBe(0x38c4);
    expect(hookBitmap(MOLE_ADDRESSES.moleHook)).toBe(MOLE_HOOK_BITMAP);
    const p = hookBitmapProof(MOLE_HOOK);
    expect(p.bitmapHex).toBe("0x38c4");
    expect(p.binary).toBe("11100011000100");
    expect(p.binary).toHaveLength(14);
    expect(p.matchesMoleBitmap).toBe(true);
  });

  it("exactly the six mined flags are set, in bit order, and nothing else", () => {
    expect(hookBitmapProof(MOLE_HOOK).setFlags).toEqual([
      "beforeInitialize",
      "afterInitialize",
      "beforeAddLiquidity",
      "beforeSwap",
      "afterSwap",
      "afterSwapReturnDelta",
    ]);
  });

  it("all three remove-liquidity bits (9, 8, 0) are clear and the proof line reads ✓", () => {
    const p = hookBitmapProof(MOLE_HOOK);
    expect(p.removeBitsClear).toBe(true);
    expect(p.depositTaxClear).toBe(true);
    expect(p.proofLine).toBe("uint160(hook) & 0x0301 == 0 ✓");
    for (const bit of [9, 8, 0]) {
      const b = p.bits.find((x) => x.bit === bit)!;
      expect(b.removePath).toBe(true);
      expect(b.set).toBe(false);
    }
    // and ONLY those three are flagged as the remove path
    expect(HOOK_FLAGS.filter((f) => f.removePath).map((f) => f.bit)).toEqual([9, 8, 0]);
    expect(HOOK_FLAGS.map((f) => f.bit)).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it("the masks are the v4-core values and match src/config/HookPermissions.sol byte-for-byte", () => {
    expect(REMOVE_LIQUIDITY_MASK).toBe((1 << 9) | (1 << 8) | (1 << 0));
    expect(REMOVE_LIQUIDITY_MASK).toBe(0x0301);
    expect(DEPOSIT_TAX_MASK).toBe(1 << 1);
    expect(HOOK_PERMISSION_MASK).toBe((1 << 14) - 1);
    const sol = readFileSync(path.resolve(__dirname, "../../../src/config/HookPermissions.sol"), "utf8");
    expect(sol).toMatch(/WITHDRAWAL_PATH_MASK\s*=\s*0x0301;/);
    expect(sol).toMatch(/\b0x38C4\b/);
  });

  it("the pinned MoleHook is served in any letter case; Provide / Queue are allowed only then", () => {
    expect(isMoleHookServed(MOLE_HOOK)).toBe(true);
    expect(isMoleHookServed(MOLE_HOOK.toLowerCase())).toBe(true);
    expect(isMoleHookServed(MOLE_HOOK.toUpperCase().replace("0X", "0x"))).toBe(true);
    const tag = poolServiceTag({ venue: "mole_v4", hooks: MOLE_HOOK });
    expect(tag).toBe("molehook");
    expect(engineActionsAllowed(tag)).toBe(true);
    expect(poolServiceTag({ venue: "UniswapV4", poolKey: { hooks: MOLE_HOOK.toLowerCase() } })).toBe("molehook");
    expect(v4VenueLabel(MOLE_HOOK)).toBe("MoleSwap v4");
    expect(SERVICE_TAG_LABEL.molehook).toBe("MoleHook");
    expect(SERVICE_TAG_LABEL["foreign-v4"]).toBe("Foreign hook");
  });
});
