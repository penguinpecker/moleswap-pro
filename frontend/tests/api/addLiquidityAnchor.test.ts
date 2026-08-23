/**
 * addLiquidityAnchor.test.ts — /api/v1/tx/add-liquidity, driven against a MANIPULATED pool.
 *
 * The sibling file (tx-routes.test.ts) exercises this route against the live chain, where spot and the
 * TWAP agree and the gate is invisible. This one puts the pool where an attacker would: the chain reads
 * are stubbed, so the test can hold slot0 far away from MoleHook's time-averaged tick and assert what
 * the route does about it.
 *
 * THE DEFECT: every number this route produced came from `slot0` — the default range was centred on the
 * instantaneous tick and the declared liquidity was priced at it. A caller who hit the route while
 * someone held a skew received calldata that minted their funds at that skewed price, and every bound
 * in the response agreed with the manipulation because it had been computed from it.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  spotTick: -200_461,
  twapTick: -200_461,
  maxDevTicks: 600n,
  twapWindow: 1800n,
  consultThrows: false as boolean | string,
}));

/** sqrt(1.0001^tick)·2^96, computed by the real TickMath port so the stub answers like the chain. */
const sqrtAt = vi.hoisted(() => {
  return async (tick: number) => (await import("../../lib/aggregator/math/tickMath")).getSqrtRatioAtTick(tick);
});

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  const real: any = (actual as any).ethers;
  const tickMath = await import("../../lib/aggregator/math/tickMath");

  class FakeProvider {
    constructor(_url: string) {}
  }

  /** Answers the three contracts this route reads, dispatched by address. Encoding stays REAL. */
  class FakeContract {
    constructor(address: string, _abi: any, _provider: any) {
      const a = address.toLowerCase();
      if (a === "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b") {
        (this as any).getSlot0 = async () => [
          tickMath.getSqrtRatioAtTick(state.spotTick),
          BigInt(state.spotTick),
          0n,
          3000n,
        ];
      } else if (a === "0xb2c9a0af48df8858f3765385e733cd8776a138c4") {
        (this as any).consult = async () => {
          if (state.consultThrows) throw new Error(String(state.consultThrows));
          return BigInt(state.twapTick);
        };
      } else {
        (this as any).isWhitelisted = async () => true;
        (this as any).minRangeWidth = async () => 120n;
        (this as any).maxRangeWidth = async () => 60_000n;
        (this as any).minPositionLiquidity = async () => 0n;
        (this as any).maxPositionLiquidity = async () => 0n;
        (this as any).maxTwapDeviationTicks = async () => state.maxDevTicks;
        (this as any).twapWindow = async () => state.twapWindow;
      }
    }
  }

  return {
    ...actual,
    ethers: { ...real, JsonRpcProvider: FakeProvider, Contract: FakeContract },
  };
});

const { POST: addLiqPOST } = await import("@/app/api/v1/tx/add-liquidity/route");

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const REC = "0x47D1000000000000000000000000000000000814";

const BODY = {
  token0: WETH,
  token1: USDG,
  amount0Desired: "1000000000000000000", // 1 WETH
  amount1Desired: "2000000000", // 2,000 USDG
  recipient: REC,
  fee: 500,
};

function post(body: any = BODY) {
  return addLiqPOST(
    new NextRequest("http://t/api/v1/tx/add-liquidity", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

function reset() {
  state.spotTick = -200_461;
  state.twapTick = -200_461;
  state.maxDevTicks = 600n;
  state.twapWindow = 1800n;
  state.consultThrows = false;
}

describe("/api/v1/tx/add-liquidity refuses to build against a walked price", () => {
  it("test_aSkewBeyondTheVaultsBandReturns409AndNoTransactions", async () => {
    reset();
    state.spotTick = state.twapTick - 3_000; // ~26% below the time-averaged price
    const r = await post();
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error).toMatch(/looks manipulated/i);
    expect(j.error).toMatch(/3000 ticks/);
    expect(j.error).toMatch(/600-tick limit/);
    expect(j.error).toMatch(/Nothing was submitted/);
    // Not "a bounded transaction anyway": nothing executable comes back at all.
    expect(j.data).toBeUndefined();
  });

  it("refuses a skew in the other direction too", async () => {
    reset();
    state.spotTick = state.twapTick + 3_000;
    expect((await post()).status).toBe(409);
  });

  it("test_aVaultBandOfZeroDoesNotDisableTheRouteGate", async () => {
    reset();
    state.maxDevTicks = 0n; // the vault's own gate switched off
    state.spotTick = state.twapTick - 3_000;
    const r = await post();
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/600-tick limit/);
  });

  it("test_aPoolWithNoTwapIsRefused_notPricedFromSpot", async () => {
    reset();
    state.consultThrows = "InsufficientObservations";
    state.spotTick = state.twapTick - 9_000;
    const r = await post();
    expect(r.status).toBe(503);
    const j = await r.json();
    expect(j.error).toMatch(/time-averaged price/);
    expect(j.error).toMatch(/no\s+calldata was built/i);
    expect(j.data).toBeUndefined();
  });
});

describe("inside the band it builds, and it builds against the TWAP", () => {
  it("test_theDefaultRangeIsCentredOnTheTwapNotOnTheSkewedSpot", async () => {
    reset();
    state.spotTick = state.twapTick - 500; // legal skew: inside the 600-tick band
    const r = await post();
    expect(r.status).toBe(200);
    const d = (await r.json()).data;
    const center = (d.tickLower + d.tickUpper) / 2;
    expect(center).toBe(Math.round(state.twapTick / 60) * 60);
    expect(center).not.toBe(Math.round(state.spotTick / 60) * 60);
    expect(d.twapTick).toBe(state.twapTick);
    expect(d.currentTick).toBe(state.spotTick);
    expect(d.twapDeviationTicks).toBe(500);
    expect(d.maxTwapDeviationTicks).toBe(600);
    expect(d.twapWindowSeconds).toBe(1800);
    expect(d.transactions.length).toBeGreaterThan(0);
  });

  it("test_aSkewedSpotCanOnlyShrinkTheDeclaredLiquidity_neverInflateIt", async () => {
    reset();
    const honest = await post();
    const honestLiq = BigInt((await honest.json()).data.liquidity);

    // Same amounts, same range (the range follows the TWAP, which has not moved), spot walked to the
    // edge of the band in the direction that makes the position look bigger than it can be funded.
    reset();
    state.spotTick = state.twapTick + 600;
    const skewed = await post();
    const skewedLiq = BigInt((await skewed.json()).data.liquidity);
    expect(skewedLiq).toBeLessThanOrEqual(honestLiq);

    reset();
    state.spotTick = state.twapTick - 600;
    const skewedDown = await post();
    expect(BigInt((await skewedDown.json()).data.liquidity)).toBeLessThanOrEqual(honestLiq);
  });

  it("the one-sided path is gated by the same refusal, before its range is ever placed", async () => {
    reset();
    state.spotTick = state.twapTick - 3_000;
    const r = await post({ ...BODY, amount1Desired: "0", preset: "tight" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/looks manipulated/i);
  });

  it("and it still builds a one-sided deposit when the pool looks honest, echoing the anchor", async () => {
    reset();
    const r = await post({ ...BODY, amount1Desired: "0", preset: "tight" });
    expect(r.status).toBe(200);
    const d = (await r.json()).data;
    expect(d.depositMode).toBe("one-sided");
    expect(d.amount1Max).toBe("0");
    // A one-sided range is a v4 FACT about spot, so it stays spot-relative — the gate is its protection.
    expect(d.tickLower).toBeGreaterThan(d.currentTick);
    expect(d.twapTick).toBe(state.twapTick);
    expect(d.twapDeviationTicks).toBe(0);
  });

  it("consults over the window the vault reports", async () => {
    reset();
    state.twapWindow = 900n;
    const d = (await (await post()).json()).data;
    expect(d.twapWindowSeconds).toBe(900);
  });
});
