/**
 * hookClass.test.ts — the rule that decides a v4 pool's quote mode. Written as attacks on the boundary:
 * a hook one bit off the delta mask, a native leg hiding behind a delta hook, checksum-cased addresses,
 * MoleSwap's OWN hook (which carries a delta bit but is the DEX's own, tick-path pool — never a third-party
 * simulate candidate), a mole_v4 row wearing a foreign hook, and a malformed hook field that must fail
 * closed instead of throwing out of the filter.
 */
import { describe, it, expect } from "vitest";
import {
  classifyV4Pool,
  classifyV4Row,
  isSimulateEligible,
  hasNativeCurrency,
  isMoleHook,
} from "../../lib/aggregator/hookClass";
import { MOLE_ADDRESSES } from "../../lib/mole/chain";

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const TOKEN = "0x1cf19a265363e743c767b7962ebedaafe86edba3";
const ZERO = "0x0000000000000000000000000000000000000000";

// Hooks whose LOW 14 bits encode exactly one property, so the mask test is exercised at its edges.
const HOOK_AFTER_DELTA = "0x0000000000000000000000000000000000000004"; // afterSwapReturnDelta (0x04)
const HOOK_BEFORE_DELTA = "0x0000000000000000000000000000000000000008"; // beforeSwapReturnDelta (0x08)
const HOOK_BOTH_DELTA = "0x000000000000000000000000000000000000000c"; // both (0x0c)
const HOOK_AFTER_SWAP_ONLY = "0x0000000000000000000000000000000000000040"; // afterSwap, NO delta (0x40)
const HOOK_NONE = "0x0000000000000000000000000000000000000000";
const HOOK_REAL_AFTER = "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544"; // live RH hook, low bits 0x2544 (0x04 set)
const MOLE_HOOK = "0xb2c9A0af48dF8858F3765385E733Cd8776a138C4"; // MoleHook proxy, low bits 0x38C4 (0x04 set) — the DEX's own

describe("classifyV4Pool", () => {
  it("hookless ERC-20 pool → ticks", () => {
    expect(classifyV4Pool(WETH, USDG, HOOK_NONE)).toBe("ticks");
    expect(classifyV4Pool(WETH, USDG, null)).toBe("ticks");
  });

  it("a hook that only OBSERVES swaps (afterSwap without the delta bit) → ticks", () => {
    // The discriminator is the return-delta bits, not "has a swap callback". 0x40 sets afterSwap but not
    // afterSwapReturnDelta, so tick math is still exact.
    expect(classifyV4Pool(WETH, TOKEN, HOOK_AFTER_SWAP_ONLY)).toBe("ticks");
  });

  it("either return-delta bit → simulate", () => {
    expect(classifyV4Pool(WETH, TOKEN, HOOK_AFTER_DELTA)).toBe("simulate");
    expect(classifyV4Pool(WETH, TOKEN, HOOK_BEFORE_DELTA)).toBe("simulate");
    expect(classifyV4Pool(WETH, TOKEN, HOOK_BOTH_DELTA)).toBe("simulate");
    expect(classifyV4Pool(WETH, TOKEN, HOOK_REAL_AFTER)).toBe("simulate");
  });

  it("a native leg is unroutable even with a delta hook — native wins over the hook test", () => {
    expect(classifyV4Pool(ZERO, TOKEN, HOOK_BOTH_DELTA)).toBe("unroutable");
    expect(classifyV4Pool(TOKEN, ZERO, HOOK_NONE)).toBe("unroutable");
  });

  it("is case-insensitive on the native check", () => {
    expect(hasNativeCurrency(ZERO.toUpperCase().replace("0X", "0x"), TOKEN)).toBe(true);
  });

  it("MoleSwap's OWN hook is tick-path-owned — never 'simulate' — in any address case, though it carries 0x04", () => {
    // The attack this pins: MoleHook's address has afterSwapReturnDelta set (it CAN charge hookFeePips), so
    // the bare bit test would call the DEX's own WETH/USDG and CASHCAT/WETH pools third-party hooked
    // candidates and push them through the external quoter on every quote and live tick.
    expect(MOLE_HOOK.toLowerCase()).toBe(MOLE_ADDRESSES.moleHook.toLowerCase()); // the pinned live address
    expect(BigInt(MOLE_HOOK) & 0x04n).toBe(0x04n); // non-vacuity: the bit IS set, the exception is doing the work
    expect(classifyV4Pool(WETH, USDG, MOLE_HOOK)).toBe("ticks"); // checksum case
    expect(classifyV4Pool(WETH, USDG, MOLE_HOOK.toLowerCase())).toBe("ticks");
    expect(classifyV4Pool(USDG, WETH, MOLE_HOOK.toUpperCase().replace("0X", "0x"))).toBe("ticks");
    expect(isMoleHook(MOLE_HOOK)).toBe(true);
    expect(isMoleHook(MOLE_HOOK.toLowerCase())).toBe(true);
    expect(isMoleHook(HOOK_REAL_AFTER)).toBe(false);
    // Native still wins over the Mole exception (the block is the router, not the hook).
    expect(classifyV4Pool(ZERO, USDG, MOLE_HOOK)).toBe("unroutable");
  });

  it("a MALFORMED hook field fails CLOSED (unroutable) instead of throwing — '0x', '0xzz', a short hex", () => {
    // Before this guard BigInt('0x') threw SyntaxError out of classifyV4Pool → hookedCandidateRows →
    // LivePairSession.init, taking a whole pair's card down on one bad registry row.
    expect(() => classifyV4Pool(WETH, TOKEN, "0x")).not.toThrow();
    expect(classifyV4Pool(WETH, TOKEN, "0x")).toBe("unroutable");
    expect(classifyV4Pool(WETH, TOKEN, "0xzz")).toBe("unroutable");
    expect(classifyV4Pool(WETH, TOKEN, "0x04")).toBe("unroutable"); // parses as a delta bit, but is no address
    expect(classifyV4Pool(WETH, TOKEN, "not-an-address")).toBe("unroutable");
    expect(isSimulateEligible({ token0: WETH, token1: TOKEN, hooks: "0x" })).toBe(false);
    expect(isSimulateEligible({ token0: WETH, token1: TOKEN, hooks: "0xzz" })).toBe(false);
    // Null / empty stay what they were: no hook → ticks.
    expect(classifyV4Pool(WETH, TOKEN, null)).toBe("ticks");
    expect(classifyV4Pool(WETH, TOKEN, "")).toBe("ticks");
  });
});

describe("classifyV4Row / isSimulateEligible", () => {
  const row = (token0: string, token1: string, hooks: string | null) => ({ token0, token1, hooks });

  it("only a delta-hook, non-native row is simulate-eligible", () => {
    expect(isSimulateEligible(row(WETH, TOKEN, HOOK_AFTER_DELTA))).toBe(true);
    expect(isSimulateEligible(row(WETH, USDG, HOOK_NONE))).toBe(false); // ticks
    expect(isSimulateEligible(row(ZERO, TOKEN, HOOK_AFTER_DELTA))).toBe(false); // native → unroutable
  });

  it("classifyV4Row agrees with classifyV4Pool", () => {
    expect(classifyV4Row(row(WETH, TOKEN, HOOK_BEFORE_DELTA))).toBe("simulate");
    expect(classifyV4Row(row(WETH, USDG, null))).toBe("ticks");
  });

  it("MoleSwap's own registry rows are NEVER simulate-eligible — by hook, and by venue independently", () => {
    // Real-shaped live rows: venue mole_v4, WETH/USDG, dynamic-fee sentinel, MoleHook, active=true.
    const moleRow = { venue: "mole_v4", token0: WETH, token1: USDG, hooks: MOLE_HOOK, active: true, fee: 8388608, tick_spacing: 60 };
    expect(isSimulateEligible(moleRow)).toBe(false);
    expect(classifyV4Row(moleRow)).toBe("ticks");
    // The HOOK alone excludes it, whatever venue the row claims (a uniswap_v4 row wearing MoleHook).
    expect(isSimulateEligible({ venue: "uniswap_v4", token0: WETH, token1: USDG, hooks: MOLE_HOOK })).toBe(false);
    expect(isSimulateEligible({ token0: WETH, token1: USDG, hooks: MOLE_HOOK.toLowerCase() })).toBe(false);
    // The VENUE alone excludes it, whatever hook the row claims: mole_v4 is owned by the tick path, so a
    // mole_v4 row whose hook field named some other delta hook must still not reach the external quoter.
    expect(isSimulateEligible({ venue: "mole_v4", token0: WETH, token1: TOKEN, hooks: HOOK_AFTER_DELTA })).toBe(false);
    expect(isSimulateEligible({ venue: "mole_v4", token0: WETH, token1: TOKEN, hooks: HOOK_REAL_AFTER })).toBe(false);
    // Non-vacuity: the same foreign hooks under the third-party venue ARE eligible.
    expect(isSimulateEligible({ venue: "uniswap_v4", token0: WETH, token1: TOKEN, hooks: HOOK_AFTER_DELTA })).toBe(true);
    expect(isSimulateEligible({ venue: "uniswap_v4", token0: WETH, token1: TOKEN, hooks: HOOK_REAL_AFTER })).toBe(true);
  });
});
