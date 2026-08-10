import { describe, it, expect } from "vitest";
import { applyAggFee, minOutFor } from "@/lib/aggregator/plan";

describe("aggregator fee plumbing", () => {
  it("applyAggFee floors the fee like the contract", () => {
    // 1e18 output at 69 bps -> fee 6.9e15 -> net 9.931e17
    expect(applyAggFee(10n ** 18n, 69)).toBe(10n ** 18n - (10n ** 18n * 69n) / 10_000n);
    expect(applyAggFee(10n ** 18n, 0)).toBe(10n ** 18n);
  });

  it("clamps an over-cap fee to 1% (mirrors the router MAX_FEE_BPS)", () => {
    expect(applyAggFee(10n ** 18n, 5000)).toBe(applyAggFee(10n ** 18n, 100));
  });

  it("minAmountOut built on the post-fee output stays below what the router delivers", () => {
    const gross = 1_000_000_000n;
    const feeBps = 69;
    const slippageBps = 50;
    const net = applyAggFee(gross, feeBps); // what the router pays the user
    const minOut = minOutFor(net, slippageBps); // what the plan demands
    // The router checks: userOut (== net at execution) >= minOut. With any slippage, net > minOut.
    expect(net).toBeGreaterThan(minOut);
    // And critically, minOut computed on GROSS (the bug) would be ABOVE net -> revert. Prove the gap:
    const buggyMinOut = minOutFor(gross, slippageBps);
    expect(buggyMinOut).toBeGreaterThan(net); // 0.50% slippage < 0.69% fee, so the buggy floor exceeds net
  });
});
