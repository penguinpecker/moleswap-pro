/**
 * inputSideFee.test.ts — the quote half of the fee-on-INPUT change.
 *
 * WHY THIS FILE EXISTS. When the router moved its fee from the output to the input, the entire frontend
 * suite (391 tests) stayed green — because exactly one test anywhere passed a nonzero feeBps, and it was
 * testing slippage. The quote path's fee arithmetic had no coverage at all, so "all tests pass" was a true
 * sentence that proved nothing about the change. These tests are the coverage that was missing.
 *
 * The contract the router and the quoter must agree on, or users get quoted a number the chain will not
 * honour:
 *   - the route is priced on (amountIn − fee), because that is what the router actually swaps;
 *   - the plan still DECLARES the gross, because the contract checks the slices against plan.amountIn and
 *     scales them down itself (which is what lets the fee dial move between quote and execution);
 *   - minAmountOut is computed on the FULL output, because nothing is skimmed from the output any more;
 *   - feeAmount is denominated in the INPUT token.
 */

import { describe, it, expect } from "vitest";
import { getSqrtRatioAtTick } from "../../lib/aggregator/math/tickMath";
import type { PoolState, TickData } from "../../lib/aggregator/venues/v3Pool";
import { getQuote } from "../../lib/aggregator/quote";

const A = "0x" + "a".repeat(40);
const WETH = "0x" + "e".repeat(40);
const B = "0x" + "b".repeat(40);

function pool(address: string, token0: string, token1: string, liquidity: bigint, fee = 3000): PoolState {
  // NOTE: the field is `index`, not `tick`. Passing `tick` type-checks nowhere but silently produces a
  // pool with NO usable tick data, which would make these assertions pass against a degenerate fixture.
  const ticks: TickData[] = [
    { index: -6000, liquidityNet: liquidity },
    { index: 6000, liquidityNet: -liquidity },
  ];
  const [t0, t1] = token0.toLowerCase() < token1.toLowerCase() ? [token0, token1] : [token1, token0];
  return {
    address,
    token0: t0,
    token1: t1,
    fee,
    tickSpacing: 60,
    sqrtPriceX96: getSqrtRatioAtTick(0),
    tick: 0,
    liquidity,
    ticks,
  };
}

const L = 10_000_000_000_000_000_000n;
const POOLS = [pool("0xP1".padEnd(42, "0"), A, WETH, L), pool("0xP2".padEnd(42, "0"), WETH, B, L)];
const ONE = 1_000_000_000_000_000_000n;

function quote(amountIn: bigint, feeBps: number) {
  return getQuote(POOLS, {
    tokenIn: A,
    tokenOut: B,
    amountIn,
    recipient: "0x" + "1".repeat(40),
    slippageBps: 50,
    nowSeconds: 1_000_000n,
    ttlSeconds: 60n,
    feeBps,
  });
}

describe("the fee is taken from the INPUT", () => {
  it("feeAmount is bps of the GROSS input, floored, and netAmountIn is the remainder", () => {
    const q = quote(ONE, 69);
    expect(q.feeAmount).toBe((ONE * 69n) / 10_000n);
    expect(q.netAmountIn).toBe(ONE - q.feeAmount);
    expect(q.amountIn).toBe(ONE); // the payer is debited the gross
  });

  it("clamps to the router's compiled 1% ceiling", () => {
    // A dial value above the cap must be clamped HERE too, or the quote would price a fee the contract
    // refuses to take — under-promising the user's output by the difference.
    expect(quote(ONE, 5000).feeAmount).toBe((ONE * 100n) / 10_000n);
  });

  it("prices the route on the NET input, not the gross", () => {
    // The decisive check: a charged quote must equal a feeless quote of the net amount. If the quoter
    // priced the gross it would promise ~0.69% more than the router can deliver.
    const charged = quote(ONE, 69);
    const feelessOnNet = quote(charged.netAmountIn, 0);
    expect(charged.amountOut).toBe(feelessOnNet.amountOut);

    // And it must be strictly LESS than a feeless quote of the gross — the over-promise being avoided.
    expect(charged.amountOut).toBeLessThan(quote(ONE, 0).amountOut);
  });

  it("gives the recipient the whole output — nothing is skimmed from it", () => {
    const q = quote(ONE, 69);
    expect(q.netAmountOut).toBe(q.amountOut);
  });
});

describe("the plan the contract receives", () => {
  it("declares the GROSS and its slices sum to it EXACTLY", () => {
    // MoleRouter reverts PathSumMismatch unless the slices sum to plan.amountIn to the wei, and it scales
    // them down by (amountIn − fee)/amountIn itself. A plan summing to the net would revert every swap.
    for (const bps of [0, 1, 69, 100]) {
      const q = quote(ONE, bps);
      expect(q.plan.amountIn).toBe(ONE);
      const summed = q.plan.paths.reduce((a, p) => a + p.amountIn, 0n);
      expect(summed, `slices must sum to gross at ${bps} bps`).toBe(ONE);
    }
  });

  it("computes minAmountOut on the FULL output, not a fee-reduced one", () => {
    const q = quote(ONE, 69);
    // 50 bps slippage on the whole output. If the old post-fee subtraction survived anywhere, this floor
    // would sit a further 0.69% lower — quietly widening every user's slippage tolerance.
    expect(q.minAmountOut).toBe((q.amountOut * 9950n) / 10_000n);
  });

  it("keeps the split's proportions when scaling the slices back up", () => {
    const q = quote(ONE, 69);
    if (q.plan.paths.length < 2) return; // single-path route: nothing to compare
    // Each slice, scaled back down the way the router will, must match what the split allocated.
    const totalNet = q.netAmountIn;
    for (let i = 0; i < q.plan.paths.length; i++) {
      const routed = (q.plan.paths[i].amountIn * totalNet) / ONE;
      const allocated = q.split.parts[i].amountIn;
      const drift = routed > allocated ? routed - allocated : allocated - routed;
      expect(drift).toBeLessThanOrEqual(q.plan.paths.length ? BigInt(q.plan.paths.length) : 1n);
    }
  });
});

describe("zero fee is unchanged behaviour", () => {
  it("routes the gross and leaves the plan untouched", () => {
    const q = quote(ONE, 0);
    expect(q.feeAmount).toBe(0n);
    expect(q.netAmountIn).toBe(ONE);
    expect(q.plan.amountIn).toBe(ONE);
    expect(q.netAmountOut).toBe(q.amountOut);
  });
});
