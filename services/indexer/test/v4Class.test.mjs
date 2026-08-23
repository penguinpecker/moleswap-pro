/**
 * v4Class.test.mjs — the indexer's v4 quote-mode rule, as attacks on its boundary.
 *
 * Run: `npm test` in services/indexer (node --test, no dependencies). The frontend's
 * tests/aggregator/hookClassAgreement.test.ts imports the same module and proves the browser mirror agrees.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyV4Pool, hookAltersSwapAmounts, isTickRoutable, isMoleHook, MOLE_HOOK } from "../src/v4Class.mjs";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const TOKEN = "0x1cf19a265363e743c767b7962ebedaafe86edba3";
const ZERO = "0x0000000000000000000000000000000000000000";

// Hooks whose LOW 14 bits encode exactly one property, so the mask is exercised at its edges.
const HOOK_AFTER_DELTA = "0x0000000000000000000000000000000000000004"; // afterSwapReturnDelta
const HOOK_BEFORE_DELTA = "0x0000000000000000000000000000000000000008"; // beforeSwapReturnDelta
const HOOK_AFTER_SWAP_ONLY = "0x0000000000000000000000000000000000000040"; // afterSwap, NO delta
const HOOK_ADD_LIQ_DELTA = "0x0000000000000000000000000000000000000002"; // afterAddLiquidityReturnDelta — NOT a swap delta
const HOOK_LIVE_LAUNCHPAD = "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544"; // live RH hook, low bits 0x2544 (0x04 set)
const HOOK_LIVE_BEFORE = "0x8be50bbf71297cd1f328149510f9bbba61e44888"; // live RH hook, low bits 0x0888 (0x08 set)
const MOLE_HOOK_CHECKSUM = "0xb2c9A0af48dF8858F3765385E733Cd8776a138C4"; // the live MoleHook proxy, low bits 0x38C4 (0x04 set)

test("hookless / null hook → ticks", () => {
  assert.equal(classifyV4Pool(WETH, TOKEN, ZERO), "ticks");
  assert.equal(classifyV4Pool(WETH, TOKEN, null), "ticks");
  assert.equal(classifyV4Pool(WETH, TOKEN, undefined), "ticks");
});

test("a hook that only OBSERVES swaps → ticks (the discriminator is the delta bits, not 'has a swap callback')", () => {
  assert.equal(classifyV4Pool(WETH, TOKEN, HOOK_AFTER_SWAP_ONLY), "ticks");
  assert.equal(hookAltersSwapAmounts(HOOK_AFTER_SWAP_ONLY), false);
});

test("a liquidity return-delta bit is NOT a swap delta → ticks", () => {
  assert.equal(classifyV4Pool(WETH, TOKEN, HOOK_ADD_LIQ_DELTA), "ticks");
});

test("either swap return-delta bit → simulate", () => {
  assert.equal(classifyV4Pool(WETH, TOKEN, HOOK_AFTER_DELTA), "simulate");
  assert.equal(classifyV4Pool(WETH, TOKEN, HOOK_BEFORE_DELTA), "simulate");
  assert.equal(classifyV4Pool(WETH, TOKEN, HOOK_LIVE_LAUNCHPAD), "simulate");
  assert.equal(classifyV4Pool(WETH, TOKEN, HOOK_LIVE_BEFORE), "simulate");
});

test("a native leg is 'native' even under a delta hook — native wins, in either column, any case", () => {
  assert.equal(classifyV4Pool(ZERO, TOKEN, HOOK_AFTER_DELTA), "native");
  assert.equal(classifyV4Pool(TOKEN, ZERO, ZERO), "native");
  assert.equal(classifyV4Pool("0x0000000000000000000000000000000000000000".toUpperCase().replace("0X", "0x"), TOKEN, null), "native");
});

test("MoleSwap's OWN hook → ticks, never simulate, in any address case — although its address carries 0x04", () => {
  assert.equal(MOLE_HOOK, MOLE_HOOK_CHECKSUM.toLowerCase());
  assert.equal(hookAltersSwapAmounts(MOLE_HOOK), true); // non-vacuity: the bare bit test WOULD say simulate
  for (const hook of [MOLE_HOOK, MOLE_HOOK_CHECKSUM, MOLE_HOOK.toUpperCase().replace("0X", "0x")]) {
    assert.equal(isMoleHook(hook), true, hook);
    assert.equal(classifyV4Pool(WETH, TOKEN, hook), "ticks", hook);
    assert.equal(classifyV4Pool(TOKEN, WETH, hook), "ticks", hook);
  }
  assert.equal(isMoleHook(HOOK_LIVE_LAUNCHPAD), false);
  assert.equal(isMoleHook(null), false);
  assert.equal(classifyV4Pool(ZERO, TOKEN, MOLE_HOOK), "native"); // native still wins
  // A third-party hook with the same low bits is NOT excused — the exception is the address.
  assert.equal(classifyV4Pool(WETH, TOKEN, "0x00000000000000000000000000000000000038c4"), "simulate");
});

test("only 'ticks' is tick-routable (→ mp_pools.active)", () => {
  assert.equal(isTickRoutable("ticks"), true);
  assert.equal(isTickRoutable("simulate"), false);
  assert.equal(isTickRoutable("native"), false);
});
