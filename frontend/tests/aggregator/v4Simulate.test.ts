/**
 * v4Simulate.test.ts
 *
 * (1) DIFFERENTIAL vs chain — the whole encode → eth_call → decode pipeline reproduces the canonical V4
 *     Quoter's answer for a REAL return-delta pool on Robinhood Chain. The fixture (v4QuoterFixture.json)
 *     is a pinned live capture: the exact calldata sent and the exact bytes the chain returned for
 *     WETH→RISK through hook 0x4e34…a544 (afterSwapReturnDelta) at block 0x2925daf. `cast call` returned
 *     the identical amountOut independently, and the same call re-run on 2026-08-22 (public + configured
 *     RPC, 6 samples) returned the identical bytes. So this locks our ABI codec against the chain's wire
 *     format; if either drifts, the assertion fails. The live re-run itself is tests/live/ (opt-in).
 * (2) The screen and helpers as attacks: a reverting quoter must yield null (never 0), a hook skimming
 *     past the policy must fail the skim screen, an unscreenable direction must abstain not reject, an
 *     input that does not fit uint128 must not be silently truncated.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fixture from "./v4QuoterFixture.json";
import {
  encodeQuoteCalldata,
  decodeQuoteResult,
  simulateV4ExactInputSingle,
  screenSkim,
  tickReferenceOutput,
  MAX_HOOK_SKIM_BPS,
  QUOTE_EXACT_INPUT_SINGLE_SELECTOR,
  V4_QUOTER,
} from "../../lib/aggregator/venues/v4Simulate";
import type { V4PoolKey } from "../../lib/mole/poolId";
import type { PoolState } from "../../lib/aggregator/venues/v3Pool";

const KEY: V4PoolKey = {
  currency0: fixture.key.currency0 as `0x${string}`,
  currency1: fixture.key.currency1 as `0x${string}`,
  fee: fixture.key.fee,
  tickSpacing: fixture.key.tickSpacing,
  hooks: fixture.key.hooks as `0x${string}`,
};

afterEach(() => vi.unstubAllGlobals());

/**
 * A fetch stub that answers the ONE-call JSON-RPC batch the simulator sends: ids mirrored from the request
 * (the batch is re-paired by id), `ok:true`, and the scripted per-call body (a result, an error, or both).
 */
function stubRpc(perCall: { result?: string; error?: { code: number; message: string } } | ((i: number) => { result?: string; error?: { code: number; message: string } })) {
  const spy = vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const batch: { id: number }[] = Array.isArray(body) ? body : [body];
    const out = batch.map((b, i) => ({ jsonrpc: "2.0", id: b.id, ...(typeof perCall === "function" ? perCall(i) : perCall) }));
    return { ok: true, status: 200, json: async () => (Array.isArray(body) ? out : out[0]) };
  });
  vi.stubGlobal("fetch", spy as any);
  return spy;
}

describe("differential vs the live V4 Quoter (real return-delta pool)", () => {
  it("encodes the exact calldata the chain accepted, under the pinned selector", () => {
    const data = encodeQuoteCalldata(KEY, fixture.zeroForOne, BigInt(fixture.exactAmount));
    expect(data.toLowerCase()).toBe(fixture.calldata.toLowerCase());
    expect(data.slice(0, 10)).toBe(QUOTE_EXACT_INPUT_SINGLE_SELECTOR);
    expect(fixture.calldata.slice(0, 10)).toBe(QUOTE_EXACT_INPUT_SINGLE_SELECTOR);
  });

  it("decodes the chain's real return bytes to the amount cast returned", () => {
    const { amountOut, gasEstimate } = decodeQuoteResult(fixture.rawResult as `0x${string}`);
    expect(amountOut.toString()).toBe(fixture.amountOut);
    expect(gasEstimate.toString()).toBe(fixture.gasEstimate);
  });

  it("the full pipeline (fetch → decode) reproduces the chain's amountOut and gasEstimate, against the quoter", async () => {
    const spy = stubRpc({ result: fixture.rawResult });
    const out = await simulateV4ExactInputSingle(KEY, fixture.zeroForOne, BigInt(fixture.exactAmount));
    expect(out).not.toBeNull();
    expect(out!.amountOut.toString()).toBe(fixture.amountOut);
    expect(out!.gasEstimate.toString()).toBe(fixture.gasEstimate);
    const body = JSON.parse((spy.mock.calls[0] as any)[1].body);
    const call = Array.isArray(body) ? body[0] : body;
    expect(call.method).toBe("eth_call");
    expect(call.params[0].to.toLowerCase()).toBe(V4_QUOTER.toLowerCase());
    expect(call.params[0].data.toLowerCase()).toBe(fixture.calldata.toLowerCase());
    expect(call.params[1]).toBe("latest");
  });
});

describe("simulateV4ExactInputSingle fails closed", () => {
  it("a quoter REVERT (json error) returns null, not zero", async () => {
    stubRpc({ error: { code: 3, message: "execution reverted" } });
    expect(await simulateV4ExactInputSingle(KEY, true, 1000n)).toBeNull();
  });

  it("a json error WINS even if a result field is also present (never trust a flagged error)", async () => {
    // A decodable tuple with a NONZERO amountOut, so that a swallowed error would wrongly succeed.
    const anyBytes = "0x" + "0".repeat(63) + "5" + "0".repeat(64);
    stubRpc({ error: { code: 3, message: "reverted" }, result: anyBytes });
    expect(await simulateV4ExactInputSingle(KEY, true, 1000n)).toBeNull();
  });

  it("a network throw returns null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }) as any);
    expect(await simulateV4ExactInputSingle(KEY, true, 1000n)).toBeNull();
  });

  it("an HTTP error status returns null (the body is not even read)", async () => {
    const json = vi.fn(async () => ({ jsonrpc: "2.0", id: 0, result: fixture.rawResult }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json })) as any);
    expect(await simulateV4ExactInputSingle(KEY, true, 1000n)).toBeNull();
    expect(json).not.toHaveBeenCalled();
  });

  it("a mis-paired batch answer (wrong id) returns null rather than reading someone else's result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ jsonrpc: "2.0", id: 7, result: fixture.rawResult }] })) as any);
    expect(await simulateV4ExactInputSingle(KEY, true, 1000n)).toBeNull();
  });

  it("a zero output returns null (nothing to route)", async () => {
    stubRpc({ result: "0x" + "0".repeat(128) });
    expect(await simulateV4ExactInputSingle(KEY, true, 1000n)).toBeNull();
  });

  it("an undecodable / empty result returns null", async () => {
    stubRpc({ result: "0x" });
    expect(await simulateV4ExactInputSingle(KEY, true, 1000n)).toBeNull();
    stubRpc({ result: "0x1234" });
    expect(await simulateV4ExactInputSingle(KEY, true, 1000n)).toBeNull();
  });

  it("a non-positive amountIn is rejected before any network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy as any);
    expect(await simulateV4ExactInputSingle(KEY, true, 0n)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an amount above uint128 is refused, not truncated into a smaller quote", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy as any);
    expect(await simulateV4ExactInputSingle(KEY, true, 1n << 128n)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(() => encodeQuoteCalldata(KEY, true, 1n << 128n)).toThrow(/uint128/);
  });

  it("a slow RPC times out and fails closed", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn((_u: string, init: any) => new Promise((_res, rej) => {
          init.signal.addEventListener("abort", () => rej(new Error("aborted")));
        })) as any,
      );
      const p = simulateV4ExactInputSingle(KEY, true, 1000n, undefined, 50);
      await vi.advanceTimersByTimeAsync(60);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("screenSkim — exclude a hook that skims more than the policy in its favour", () => {
  it("passes when the simulated output is within the skim ceiling below tick math", () => {
    // 5% below reference, ceiling is 10% → allowed.
    const ref = 1_000_000n;
    const sim = 950_000n;
    const s = screenSkim(sim, ref);
    expect(s.ok).toBe(true);
    expect(s.skimBps).toBe(500);
  });

  it("excludes when the hook skims MORE than the ceiling", () => {
    const ref = 1_000_000n;
    const sim = 800_000n; // 20% below → 2000 bps > 1000 ceiling
    const s = screenSkim(sim, ref);
    expect(s.ok).toBe(false);
    expect(s.skimBps).toBe(2000);
  });

  it("is exact at the boundary: exactly MAX_HOOK_SKIM_BPS passes, one bp past fails", () => {
    const ref = 10_000n;
    const atLimit = ref - (ref * BigInt(MAX_HOOK_SKIM_BPS)) / 10_000n; // 9000 → 1000 bps skim
    expect(screenSkim(atLimit, ref).ok).toBe(true);
    expect(screenSkim(atLimit - 1n, ref).ok).toBe(false);
  });

  it("a simulated output AT OR ABOVE the reference is not the hook's favour → allowed", () => {
    expect(screenSkim(1_000_000n, 1_000_000n)).toEqual({ ok: true, skimBps: 0 });
    expect(screenSkim(1_200_000n, 1_000_000n)).toEqual({ ok: true, skimBps: 0 });
  });

  it("no reference → abstains (allowed, skimBps null); zero simulated → rejected", () => {
    expect(screenSkim(500_000n, null)).toEqual({ ok: true, skimBps: null });
    expect(screenSkim(500_000n, 0n)).toEqual({ ok: true, skimBps: null });
    expect(screenSkim(0n, 1_000_000n)).toEqual({ ok: false, skimBps: null });
  });
});

describe("tickReferenceOutput", () => {
  const refState: PoolState = {
    address: "ref",
    token0: fixture.key.currency0,
    token1: fixture.key.currency1,
    fee: 3000,
    tickSpacing: 60,
    sqrtPriceX96: 79228162514264337593543950336n, // 1:1
    tick: 0,
    liquidity: 1_000_000_000_000n,
    ticks: [
      { index: -600, liquidityNet: 1_000_000_000_000n },
      { index: 600, liquidityNet: -1_000_000_000_000n },
    ],
    venue: "UniswapV4",
    poolKey: KEY,
  };

  it("prices a healthy reference pool", () => {
    const out = tickReferenceOutput(refState, true, 1_000_000n);
    expect(out).not.toBeNull();
    expect(out!).toBeGreaterThan(0n);
  });

  it("returns null for a null reference or non-positive amount", () => {
    expect(tickReferenceOutput(null, true, 1000n)).toBeNull();
    expect(tickReferenceOutput(undefined, true, 1000n)).toBeNull();
    expect(tickReferenceOutput(refState, true, 0n)).toBeNull();
  });

  it("abstains (null) when the reference cannot absorb the size — a partial fill is not a reference", () => {
    // Way more than the visible liquidity can fill: the simulator exhausts tick data → no reference.
    expect(tickReferenceOutput(refState, true, 10n ** 30n)).toBeNull();
  });
});
