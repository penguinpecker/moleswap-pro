/**
 * liveQuoteFailure.test.ts — the live session must answer "no route" and "I broke" DIFFERENTLY.
 *
 * `LivePairSession.quote()` had `catch { return null }` around both the quoter and the plan encoder, and the
 * exchange card renders null as "No route with live liquidity for this pair" — so a quoter crash and an
 * illiquid pair were indistinguishable to the card and to the user (learnings.txt 2026-08-14 #2; the server
 * twin `quoteSwap` was fixed that day, the session was not). Now: null is ONLY the honest no-route; every other
 * failure is thrown as QuoteFailedError, and the card renders it as an error, not a market fact.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { PoolState } from "../../lib/aggregator/venues/v3Pool";

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const OTHER = "0x00000000000000000000000000000000000000bb";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const SQRT_1_1 = 79228162514264337593543950336n;

function v3(token0: string, token1: string): PoolState {
  return {
    address: `0x${token0.slice(2, 22)}${token1.slice(2, 22)}`.slice(0, 42).padEnd(42, "0"),
    token0,
    token1,
    fee: 500,
    tickSpacing: 10,
    sqrtPriceX96: SQRT_1_1,
    tick: 0,
    liquidity: 10n ** 21n,
    ticks: [
      { index: -887270, liquidityNet: 10n ** 21n },
      { index: 887270, liquidityNet: -(10n ** 21n) },
    ],
    venue: "PancakeV3",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("../../lib/aggregator/client");
  vi.doUnmock("../../lib/aggregator/discover");
  vi.doUnmock("../../lib/aggregator/venues/v4Reader");
  vi.doUnmock("../../lib/mole/aggFee");
});

async function sessionWith(states: PoolState[], tokenIn: string, tokenOut: string, weth: string) {
  vi.resetModules();
  vi.doMock("../../lib/aggregator/client", async (orig) => {
    const real = (await orig()) as any;
    return { ...real, fetchRelevantPoolStates: async () => states };
  });
  vi.doMock("../../lib/aggregator/discover", () => ({ discoverForPair: async () => [] }));
  vi.doMock("../../lib/aggregator/venues/v4Reader", () => ({ fetchV4Pool: vi.fn(), fetchV4PoolByKey: vi.fn() }));
  vi.doMock("../../lib/mole/aggFee", () => ({ getAggFeeBps: async () => 0, cachedAggFeeBps: () => 0 }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ result: "0x1" }) })) as any);
  const { LivePairSession } = await import("../../lib/aggregator/live");
  const { QuoteFailedError } = await import("../../lib/aggregator/client");
  const s = new LivePairSession(tokenIn, tokenOut, weth);
  await s.init([]);
  return { s, QuoteFailedError };
}

const params = { amountIn: 10n ** 18n, recipient: "0x000000000000000000000000000000000000dEaD", slippageBps: 50, decimalsIn: 18, decimalsOut: 6 };

describe("LivePairSession.quote(): null is only the honest no-route", () => {
  it("returns null when the pool set has no path for the pair", async () => {
    const { s } = await sessionWith([v3(USDG, OTHER)], WETH, USDG, WETH); // only a USDG/OTHER pool: no WETH leg
    expect(s.quote(params)).toBeNull();
  });

  it("returns a quote when a path exists (positive control)", async () => {
    const { s } = await sessionWith([v3(WETH, USDG)], WETH, USDG, WETH);
    const q = s.quote(params);
    expect(q).not.toBeNull();
    expect(q!.amountOut).toBeGreaterThan(0n);
  });

  it("THROWS QuoteFailedError — does not return null — when the quoter itself fails", async () => {
    // A native-in quote with no WETH address is a configuration defect inside the quoter, not a market fact.
    const { s, QuoteFailedError } = await sessionWith([v3(WETH, USDG)], NATIVE, USDG, "");
    let thrown: unknown = null;
    let returned: unknown = "not-called";
    try {
      returned = s.quote(params);
    } catch (e) {
      thrown = e;
    }
    expect(returned).toBe("not-called");
    expect(thrown).toBeInstanceOf(QuoteFailedError);
    expect(String((thrown as Error).message)).toMatch(/quote failed/);
  });

  it("THROWS QuoteFailedError when the route is found but the plan cannot be built (v4 hop without its key)", async () => {
    const broken: PoolState = { ...v3(WETH, USDG), venue: "UniswapV4" }; // no poolKey → hopToPlan refuses
    const { s, QuoteFailedError } = await sessionWith([broken], WETH, USDG, WETH);
    expect(() => s.quote(params)).toThrow(QuoteFailedError);
  });

  it("a failure and a no-route are distinguishable by the caller", async () => {
    const noRoute = await sessionWith([v3(USDG, OTHER)], WETH, USDG, WETH);
    const crash = await sessionWith([v3(WETH, USDG)], NATIVE, USDG, "");
    const outcome = (s: any) => {
      try {
        return s.quote(params) === null ? "no-route" : "quote";
      } catch {
        return "failure";
      }
    };
    expect(outcome(noRoute.s)).toBe("no-route");
    expect(outcome(crash.s)).toBe("failure");
  });
});
