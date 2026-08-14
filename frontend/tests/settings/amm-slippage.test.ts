/**
 * amm-slippage.test.ts — the quote/execute path must forward the USER'S tolerance, not a literal.
 *
 * lib/chain/amm.ts used to pass `slippageBps: DEFAULT_SLIPPAGE_BPS` (a hardcoded 50) into quoteSwap on
 * both the quote path and the signing-time re-quote, which is the number plan.ts turns into the
 * router's amountOutMin. This test captures the argument actually handed to quoteSwap and asserts it
 * tracks the persisted Max Slippage. Re-hardcoding the literal turns this RED.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { writeSwapSettings, DEFAULT_SWAP_SETTINGS } from "../../lib/settings/swapSettings";

const quoteSwapCalls: any[] = [];

vi.mock("@/lib/aggregator/client", () => ({
  quoteSwap: vi.fn(async (_rows: any, req: any) => {
    quoteSwapCalls.push(req);
    return {
      quote: {
        amountOut: 1_000_000n,
        netAmountOut: 990_000n,
        minAmountOut: 985_000n,
        feeBps: 30,
      },
      encoded: {},
      value: 0n,
    };
  }),
}));

vi.mock("@/lib/mole/aggFee", () => ({ getAggFeeBps: vi.fn(async () => 30) }));

// Chainable + thenable stub: loadPoolRows now scopes the registry read to the traded pair
// (.select().eq().or().range()), so the stub answers at any point in the builder chain rather than
// pinning this test to one query shape.
vi.mock("@/lib/supabase/client", () => {
  const result = {
    data: [{ address: "0x0000000000000000000000000000000000000001", active: true }],
    error: null,
  };
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    or: () => builder,
    range: async () => result,
    then: (onFulfilled: any, onRejected: any) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return { createClient: () => ({ from: () => builder }) };
});

const TOKEN_IN = "0x0000000000000000000000000000000000000abc";
const TOKEN_OUT = "0x0000000000000000000000000000000000000def";

beforeEach(() => {
  window.localStorage.clear();
  quoteSwapCalls.length = 0;
});

describe("getSwapQuote forwards the persisted Max Slippage", () => {
  it("uses the app default when the user has never opened the panel", async () => {
    const { getSwapQuote } = await import("@/lib/chain/amm");
    await getSwapQuote({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1000000000000000000" });
    expect(quoteSwapCalls.at(-1)?.slippageBps).toBe(50);
  });

  it("uses the stored choice once the user picks one", async () => {
    const { getSwapQuote } = await import("@/lib/chain/amm");
    writeSwapSettings({ ...DEFAULT_SWAP_SETTINGS, maxSlippage: "1.25" });
    await getSwapQuote({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1000000000000000000" });
    expect(quoteSwapCalls.at(-1)?.slippageBps).toBe(125);
  });

  it("an explicit argument beats the stored choice", async () => {
    const { getSwapQuote } = await import("@/lib/chain/amm");
    writeSwapSettings({ ...DEFAULT_SWAP_SETTINGS, maxSlippage: "1" });
    await getSwapQuote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: "1000000000000000000",
      slippageBps: 300,
    });
    expect(quoteSwapCalls.at(-1)?.slippageBps).toBe(300);
  });
});
