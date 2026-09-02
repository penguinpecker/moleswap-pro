/**
 * txSwapImpactGuard.test.ts — the endpoint that emits SIGNABLE CALLDATA must not emit a trade the
 * oracle says is catastrophic.
 *
 * Measured 2026-08-25: USDe — which this same API publishes as `swappable: false` — produced signable
 * calldata at a ~99.95% loss, and `minReceived` was derived from that same quote, so the slippage floor
 * could not save the caller either. The transaction does not revert; it executes. /api/v1/quote already
 * judged routes against Chainlink; the route whose whole job is to build a transaction did not.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const ref = { priceImpactBps: 0 as number | null, valueInUsd: 100 as number | null, valueOutUsd: 100 as number | null, reason: null as string | null };

vi.mock("@/lib/aggregator/referencePrice", () => ({ checkAgainstReference: async () => ({ ...ref }) }));
vi.mock("@/lib/aggregator/serverPools", () => ({ loadPoolRowsServer: async () => [{ id: "0x1" }] }));
vi.mock("@/lib/mole/aggFee", () => ({ getAggFeeBps: async () => 69 }));
vi.mock("@/lib/aggregator/client", () => ({
  quoteSwap: async () => ({
    quote: {
      netAmountOut: 1000n, amountOut: 1000n, minAmountOut: 990n, feeBps: 69,
      feeAmount: 69n, netAmountIn: 931n, routeDescriptions: ["WETH -> USDG [0.05%]"],
      plan: {},
    },
    // A structurally valid SwapPlan: encodeFunctionData rejects placeholder addresses, and this test is
    // about the guard, not about plan encoding.
    encoded: {
      tokenIn: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      tokenOut: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      amountIn: 1n,
      minAmountOut: 1n,
      recipient: "0x0000000000000000000000000000000000000001",
      deadline: 1n,
      paths: [],
    },
    value: 0n,
  }),
}));

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const RECIP = "0x0000000000000000000000000000000000000001";

async function post(body: Record<string, unknown>) {
  const { POST } = await import("../../app/api/v1/tx/swap/route");
  const res = await POST(
    new NextRequest("http://localhost/api/v1/tx/swap", {
      method: "POST",
      body: JSON.stringify({ chainId: 4663, tokenIn: WETH, tokenOut: USDG, amountIn: "1000000000000000", recipient: RECIP, ...body }),
      headers: { "content-type": "application/json" },
    }),
  );
  return { status: res.status, json: (await res.json()) as any };
}

describe("/api/v1/tx/swap price-impact guard", () => {
  beforeEach(() => {
    ref.priceImpactBps = 0;
    ref.valueInUsd = 100;
    ref.valueOutUsd = 100;
    ref.reason = null;
  });

  it("builds the transaction on a normal route, and publishes the reference numbers", async () => {
    ref.priceImpactBps = 40;
    const { status, json } = await post({});
    expect(status).toBe(200);
    expect(json.data.transactions.length).toBeGreaterThan(0);
    // the fields the quote route always had and this one did not
    expect(json.data.priceImpactBps).toBe(40);
    expect(json.data.referenceValueInUsd).toBe(100);
  });

  it("REFUSES to emit calldata for a catastrophic route", async () => {
    ref.priceImpactBps = 9995; // the measured USDe case
    ref.valueOutUsd = 0.05;
    const { status, json } = await post({});
    expect(status).toBe(422);
    expect(json.success).toBe(false);
    expect(json.error).toMatch(/99\.95%/);
    expect(json.error).toMatch(/No transaction was built/);
    // and it names the way through, rather than being a dead end
    expect(json.error).toMatch(/acknowledgeImpact/);
    expect(json.data).toBeUndefined();
  });

  it("lets a caller who acknowledges it through, and says so in the response", async () => {
    ref.priceImpactBps = 9995;
    const { status, json } = await post({ acknowledgeImpact: true });
    expect(status).toBe(200);
    expect(json.data.transactions.length).toBeGreaterThan(0);
    expect(json.data.impactAcknowledged).toBe(true);
    expect(json.data.priceImpactBps).toBe(9995);
  });

  it("does not refuse when there is no reference feed — absent is not zero", async () => {
    ref.priceImpactBps = null;
    ref.valueInUsd = null;
    ref.valueOutUsd = null;
    ref.reason = "no fresh reference feed for the output token";
    const { status, json } = await post({});
    expect(status).toBe(200);
    expect(json.data.priceImpactBps).toBeNull();
    expect(json.data.priceImpactReason).toMatch(/no fresh reference feed/);
    expect(json.data.impactAcknowledged).toBe(false);
  });

  it("a route just under the bar still builds", async () => {
    ref.priceImpactBps = 2999;
    const { status } = await post({});
    expect(status).toBe(200);
  });
});
