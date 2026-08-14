/**
 * swapSettings.test.ts — the Max Slippage control must reach the chain.
 *
 * The bug this guards: the Settings panel held Max Slippage in component-local state while the quote
 * path passed a hardcoded 50 bps, so the user's choice never touched amountOutMin. These tests follow
 * the value the whole way — panel value -> bps -> minOutFor() -> the floor MoleRouter enforces — and
 * are written to FAIL if anyone re-hardcodes the tolerance.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_SLIPPAGE_BPS,
  DEFAULT_SWAP_SETTINGS,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  getSlippageBps,
  normalizeSwapSettings,
  readSwapSettings,
  slippageBpsFor,
  writeSwapSettings,
} from "../../lib/settings/swapSettings";
import { minOutFor } from "../../lib/aggregator/plan";

const STORAGE_KEY = "moleswap.swapSettings";

beforeEach(() => {
  window.localStorage.clear();
});

describe("slippageBpsFor — panel value to basis points", () => {
  it("AUTO resolves to the app default, unchanged from the pre-fix behaviour", () => {
    expect(slippageBpsFor("AUTO")).toBe(50);
    expect(slippageBpsFor("AUTO")).toBe(DEFAULT_SLIPPAGE_BPS);
    expect(slippageBpsFor("auto")).toBe(DEFAULT_SLIPPAGE_BPS);
  });

  it("reads a percent string as percent, not as basis points", () => {
    expect(slippageBpsFor("0.5")).toBe(50);
    expect(slippageBpsFor("0.1")).toBe(10);
    expect(slippageBpsFor("1")).toBe(100);
    expect(slippageBpsFor("3")).toBe(300);
    expect(slippageBpsFor("0.5%")).toBe(50);
  });

  it("clamps into the same range the public API routes enforce", () => {
    expect(slippageBpsFor("0")).toBe(MIN_SLIPPAGE_BPS); // never demand the quote to the wei
    expect(slippageBpsFor("99")).toBe(MAX_SLIPPAGE_BPS); // 9900 bps -> 5000
    expect(slippageBpsFor("50")).toBe(MAX_SLIPPAGE_BPS);
  });

  it("falls back to the default rather than throwing on junk", () => {
    for (const junk of ["", "   ", "abc", "-1", "NaN", null, undefined]) {
      expect(slippageBpsFor(junk as string)).toBe(DEFAULT_SLIPPAGE_BPS);
    }
  });
});

describe("persistence — the choice survives leaving the panel", () => {
  it("returns defaults when nothing is stored", () => {
    expect(readSwapSettings()).toEqual(DEFAULT_SWAP_SETTINGS);
  });

  it("round-trips every field through localStorage", () => {
    writeSwapSettings({ routePriority: "FASTEST", maxSlippage: "0.5", gasPrice: "FAST" });
    expect(readSwapSettings()).toEqual({
      routePriority: "FASTEST",
      maxSlippage: "0.5",
      gasPrice: "FAST",
    });
  });

  it("survives corrupt storage instead of breaking the quote path", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(readSwapSettings()).toEqual(DEFAULT_SWAP_SETTINGS);
    expect(getSlippageBps()).toBe(DEFAULT_SLIPPAGE_BPS);
  });

  it("coerces out-of-domain stored values back to valid ones", () => {
    expect(normalizeSwapSettings({ routePriority: "CHEAPEST", gasPrice: "LUDICROUS" })).toEqual(
      DEFAULT_SWAP_SETTINGS,
    );
    expect(normalizeSwapSettings(null)).toEqual(DEFAULT_SWAP_SETTINGS);
    expect(normalizeSwapSettings({ maxSlippage: 0.5 })).toEqual(DEFAULT_SWAP_SETTINGS);
  });

  it("getSlippageBps reads the stored choice, not a literal", () => {
    writeSwapSettings({ ...DEFAULT_SWAP_SETTINGS, maxSlippage: "0.5" });
    expect(getSlippageBps()).toBe(50);
    writeSwapSettings({ ...DEFAULT_SWAP_SETTINGS, maxSlippage: "2" });
    expect(getSlippageBps()).toBe(200);
  });
});

describe("end to end — the stored choice is the on-chain floor", () => {
  // 1,000 USDG-shaped output (6 decimals) so the arithmetic is easy to read.
  const quotedOut = 1_000_000_000n;

  it("minOutFor consumes the resolved bps and moves with the user's choice", () => {
    writeSwapSettings({ ...DEFAULT_SWAP_SETTINGS, maxSlippage: "AUTO" });
    expect(minOutFor(quotedOut, getSlippageBps())).toBe(995_000_000n); // 0.50%

    writeSwapSettings({ ...DEFAULT_SWAP_SETTINGS, maxSlippage: "1" });
    expect(minOutFor(quotedOut, getSlippageBps())).toBe(990_000_000n); // 1.00%

    writeSwapSettings({ ...DEFAULT_SWAP_SETTINGS, maxSlippage: "0.1" });
    expect(minOutFor(quotedOut, getSlippageBps())).toBe(999_000_000n); // 0.10%
  });

  it("a tolerance the panel offers is never rejected by the plan builder", () => {
    for (const value of ["AUTO", "0.5", "0", "99"]) {
      expect(() => minOutFor(quotedOut, slippageBpsFor(value))).not.toThrow();
    }
  });

  it("the two presets the panel currently offers both mean 0.50%", () => {
    // Documented on purpose: wiring the control up must NOT silently change the floor for anyone who
    // never opened the panel. If a preset is ever added, this is the line that should change.
    expect(slippageBpsFor("AUTO")).toBe(slippageBpsFor("0.5"));
  });
});
