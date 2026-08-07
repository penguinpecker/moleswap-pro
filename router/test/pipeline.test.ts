import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getQuote, NoRouteError } from "../src/quote.js";
import { minOutFor, planFromRoute, PlanVenue } from "../src/plan.js";
import { bestSingleRoute, PoolGraph } from "../src/route.js";
import { v4PoolState, hookAltersSwapAmounts, assertQuotableHook } from "../src/venues/v4Pool.js";
import type { PoolState, TickData } from "../src/venues/v3Pool.js";

const fx = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "test/fixtures.live.json"), "utf8"),
) as {
  pool: string;
  token0: string;
  token1: string;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  tickSpacing: number;
  fee: number;
  ticks: { index: number; liquidityNet: string }[];
};

const WETH = fx.token0;
const USDG = fx.token1;
const ticks: TickData[] = fx.ticks.map((t) => ({ index: t.index, liquidityNet: BigInt(t.liquidityNet) }));

const livePool: PoolState = {
  address: fx.pool,
  token0: WETH,
  token1: USDG,
  fee: fx.fee,
  tickSpacing: fx.tickSpacing,
  sqrtPriceX96: BigInt(fx.sqrtPriceX96),
  tick: fx.tick,
  liquidity: BigInt(fx.liquidity),
  ticks,
};

function variant(over: Partial<PoolState> & { address: string }): PoolState {
  return { ...livePool, ...over };
}

const REQ = {
  tokenIn: WETH,
  tokenOut: USDG,
  amountIn: 5n * 10n ** 17n,
  recipient: "0x000000000000000000000000000000000000beef",
  nowSeconds: 1_700_000_000n,
  ttlSeconds: 120n,
  slippageBps: 50,
};

describe("getQuote — the front door", () => {
  it("quotes the live pool and produces an executable plan", () => {
    const q = getQuote([livePool], REQ);
    expect(q.amountOut).toBeGreaterThan(0n);
    expect(q.plan.tokenIn).toBe(WETH);
    expect(q.plan.tokenOut).toBe(USDG);
    expect(q.plan.amountIn).toBe(REQ.amountIn);
    expect(q.plan.recipient).toBe(REQ.recipient);
    expect(q.plan.deadline).toBe(REQ.nowSeconds + REQ.ttlSeconds);
  });

  it("the plan's output token matches a direct single-route quote to the wei", () => {
    const q = getQuote([livePool], REQ);
    const direct = bestSingleRoute(new PoolGraph([livePool]), WETH, USDG, REQ.amountIn)!;
    expect(q.amountOut).toBe(direct.amountOut);
  });

  it("minAmountOut is amountOut floored by the slippage tolerance, never above it", () => {
    const q = getQuote([livePool], REQ);
    expect(q.minAmountOut).toBe((q.amountOut * 9950n) / 10_000n);
    expect(q.minAmountOut).toBeLessThanOrEqual(q.amountOut);
  });

  it("the on-chain minAmountOut in the plan equals the quoted minAmountOut", () => {
    const q = getQuote([livePool], REQ);
    expect(q.plan.minAmountOut).toBe(q.minAmountOut);
  });

  it("path slices in the plan sum to exactly amountIn", () => {
    const q = getQuote([livePool, variant({ address: "0xsecond" })], { ...REQ, amountIn: 3n * 10n ** 18n });
    const summed = q.plan.paths.reduce((a, p) => a + p.amountIn, 0n);
    expect(summed).toBe(q.plan.amountIn);
  });

  it("splits across two comparable venues on a large trade", () => {
    const q = getQuote([livePool, variant({ address: "0xsecond" })], { ...REQ, amountIn: 3n * 10n ** 18n });
    expect(q.plan.paths.length).toBeGreaterThan(1);
    expect(q.routeDescriptions.length).toBe(q.plan.paths.length);
  });

  it("throws NoRouteError rather than returning a zero quote for an unreachable pair", () => {
    expect(() => getQuote([livePool], { ...REQ, tokenOut: "0x00000000000000000000000000000000deadbeef" })).toThrow(
      NoRouteError,
    );
  });

  it("rejects a nonsensical request instead of quoting it", () => {
    expect(() => getQuote([livePool], { ...REQ, amountIn: 0n })).toThrow();
    expect(() => getQuote([livePool], { ...REQ, tokenOut: WETH })).toThrow();
  });
});

describe("plan encoding fidelity", () => {
  it("emits a PancakeV3 hop with the pool address and a zeroed key", () => {
    const route = bestSingleRoute(new PoolGraph([livePool]), WETH, USDG, REQ.amountIn)!;
    const plan = planFromRoute(route, WETH, USDG, {
      recipient: REQ.recipient,
      deadline: 1n,
      slippageBps: 50,
    });
    const hop = plan.paths[0]!.hops[0]!;
    expect(hop.venue).toBe(PlanVenue.PancakeV3);
    expect(hop.pool).toBe(fx.pool.toLowerCase());
    expect(hop.key.currency0).toBe("0x0000000000000000000000000000000000000000");
    expect(hop.tokenIn).toBe(WETH.toLowerCase());
    expect(hop.tokenOut).toBe(USDG.toLowerCase());
    expect(hop.zeroForOne).toBe(true);
  });

  it("refuses to build a plan from an incomplete (guessed) route", () => {
    const narrow = variant({ address: "0xnarrow", ticks: ticks.slice(0, 2) });
    const route = bestSingleRoute(new PoolGraph([narrow]), WETH, USDG, 10n ** 24n);
    // A route that walked past the cached window is flagged incomplete; planning must refuse it.
    if (route?.incomplete) {
      expect(() => planFromRoute(route, WETH, USDG, { recipient: REQ.recipient, deadline: 1n, slippageBps: 50 })).toThrow(
        /incomplete/,
      );
    }
  });

  it("minOutFor floors and rejects out-of-range slippage", () => {
    expect(minOutFor(10_000n, 50)).toBe(9_950n);
    expect(minOutFor(3n, 50)).toBe(2n); // floor(3 * 9950 / 10000) = 2
    expect(minOutFor(1_000n, 0)).toBe(1_000n);
    expect(() => minOutFor(1_000n, 10_001)).toThrow();
    expect(() => minOutFor(1_000n, -1)).toThrow();
  });
});

describe("v4 pool adapter — same math, different plumbing", () => {
  const HOOKLESS_KEY = {
    currency0: WETH,
    currency1: USDG,
    fee: 500,
    tickSpacing: 10,
    hooks: "0x0000000000000000000000000000000000000000",
  };

  it("quotes a v4 pool identically to a v3 pool with the same curve", () => {
    // Same live state, presented as a v4 pool. The math must not branch on venue.
    const v4 = v4PoolState({
      poolKey: HOOKLESS_KEY,
      sqrtPriceX96: BigInt(fx.sqrtPriceX96),
      tick: fx.tick,
      liquidity: BigInt(fx.liquidity),
      ticks,
    });
    const v3out = bestSingleRoute(new PoolGraph([livePool]), WETH, USDG, REQ.amountIn)!.amountOut;
    const v4out = bestSingleRoute(new PoolGraph([v4]), WETH, USDG, REQ.amountIn)!.amountOut;
    expect(v4out).toBe(v3out);
  });

  it("emits a v4 hop carrying the pool key and address(0) for the pool", () => {
    const v4 = v4PoolState({
      poolKey: HOOKLESS_KEY,
      sqrtPriceX96: BigInt(fx.sqrtPriceX96),
      tick: fx.tick,
      liquidity: BigInt(fx.liquidity),
      ticks,
    });
    const q = getQuote([v4], REQ);
    const hop = q.plan.paths[0]!.hops[0]!;
    expect(hop.venue).toBe(PlanVenue.UniswapV4);
    expect(hop.pool).toBe("0x0000000000000000000000000000000000000000");
    expect(hop.key.hooks).toBe(HOOKLESS_KEY.hooks.toLowerCase());
    expect(hop.key.fee).toBe(500);
  });

  // MoleHook's live bitmap ends in 0x38C4, which CARRIES the afterSwapReturnDelta bit (0x04) because it
  // can charge a hook fee. Quotability therefore turns on the READ hookFeePips, not the bit alone.
  const MOLEHOOK_LIKE = "0x00000000000000000000000000000000000038C4";

  it("a delta-capable hook (MoleHook-style) is QUOTABLE when its read hookFeePips is 0", () => {
    expect(hookAltersSwapAmounts(MOLEHOOK_LIKE)).toBe(true); // the bit IS set
    expect(() => assertQuotableHook({ ...HOOKLESS_KEY, hooks: MOLEHOOK_LIKE }, 0)).not.toThrow();
  });

  it("the SAME hook is REFUSED once it charges a nonzero hook fee", () => {
    expect(() => assertQuotableHook({ ...HOOKLESS_KEY, hooks: MOLEHOOK_LIKE }, 5000)).toThrow(/not modelled/);
  });

  it("a delta-capable hook with NO fee reading is refused — capability without confirmation", () => {
    expect(() => assertQuotableHook({ ...HOOKLESS_KEY, hooks: MOLEHOOK_LIKE })).toThrow(/confirm it takes none/);
  });

  it("accepts an ordinary hook with no delta bits without needing a fee reading", () => {
    const plainHook = "0x0000000000000000000000000000000000000010"; // 0x10, no delta bits
    expect(hookAltersSwapAmounts(plainHook)).toBe(false);
    expect(() => assertQuotableHook({ ...HOOKLESS_KEY, hooks: plainHook })).not.toThrow();
  });

  it("builds a quotable v4 state for a MoleHook-style pool at hookFeePips 0", () => {
    const v4 = v4PoolState({
      poolKey: { ...HOOKLESS_KEY, hooks: MOLEHOOK_LIKE },
      sqrtPriceX96: BigInt(fx.sqrtPriceX96),
      tick: fx.tick,
      liquidity: BigInt(fx.liquidity),
      ticks,
      hookFeePips: 0,
    });
    const v3out = bestSingleRoute(new PoolGraph([livePool]), WETH, USDG, REQ.amountIn)!.amountOut;
    const v4out = bestSingleRoute(new PoolGraph([v4]), WETH, USDG, REQ.amountIn)!.amountOut;
    expect(v4out).toBe(v3out); // MoleHook at zero hook fee = plain v3 to the wei
  });

  it("refuses the raw dynamic-fee sentinel instead of pricing at a nonsense fee", () => {
    expect(() =>
      v4PoolState({
        poolKey: { ...HOOKLESS_KEY, fee: 0x800000 },
        sqrtPriceX96: BigInt(fx.sqrtPriceX96),
        tick: fx.tick,
        liquidity: BigInt(fx.liquidity),
        ticks,
      }),
    ).toThrow(/dynamic-fee/);
  });
});
