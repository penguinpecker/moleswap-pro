/**
 * quoteSwapHooked.test.ts — quoteSwap folds the hooked-pool simulate fallback into the executable quote.
 *
 * Attacks: a pair whose ONLY route is a return-delta hook must now quote (it used to return null); when
 * both a tick route and a hooked route exist, the better OUTPUT must win; a real quoter defect must still
 * surface as QuoteFailedError and not be masked by a hooked candidate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolRow, SwapQuote } from "../../lib/aggregator/client";
import type { PoolState } from "../../lib/aggregator/venues/v3Pool";

vi.mock("../../lib/aggregator/multicall", () => ({ fetchV3StatesMulticall: vi.fn(async () => []) }));
vi.mock("../../lib/aggregator/discover", () => ({ discoverForPair: vi.fn(async () => []) }));
vi.mock("../../lib/aggregator/venues/v4Reader", () => ({
  fetchV4MolePool: vi.fn(async () => null),
  fetchV4Pool: vi.fn(async () => null),
  fetchV4PoolByKey: vi.fn(async () => null),
}));
vi.mock("../../lib/aggregator/hookedQuote", () => ({ bestHookedSimulateQuote: vi.fn(async () => null) }));

import { quoteSwap } from "../../lib/aggregator/client";
import { fetchV3StatesMulticall } from "../../lib/aggregator/multicall";
import { bestHookedSimulateQuote } from "../../lib/aggregator/hookedQuote";

const v3Mock = fetchV3StatesMulticall as unknown as ReturnType<typeof vi.fn>;
const hookedMock = bestHookedSimulateQuote as unknown as ReturnType<typeof vi.fn>;

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const TOKEN = "0x1cf19a265363e743c767b7962ebedaafe86edba3";

const v3Row: PoolRow = {
  id: "0xpool", venue: "uniswap_v3", token0: WETH, token1: TOKEN, fee: 3000, tick_spacing: 60,
  hooks: null, address: "0x00000000000000000000000000000000000000a1", active: true,
};

/** A healthy 1:1 v3 pool the router can price. */
const v3State: PoolState = {
  address: v3Row.address!,
  token0: WETH,
  token1: TOKEN,
  fee: 3000,
  tickSpacing: 60,
  sqrtPriceX96: 79228162514264337593543950336n,
  tick: 0,
  liquidity: 1_000_000_000_000_000n,
  ticks: [
    { index: -60000, liquidityNet: 1_000_000_000_000_000n },
    { index: 60000, liquidityNet: -1_000_000_000_000_000n },
  ],
  venue: "PancakeV3",
};

/** A fake hooked SwapQuote with a chosen output and the 'hooked' tag on its route breakdown. */
function hookedCandidate(amountOut: bigint) {
  const swapQuote = {
    quote: {
      amountIn: 100_000_000_000_000n,
      netAmountIn: 99_310_000_000_000n,
      amountOut,
      netAmountOut: amountOut,
      feeBps: 69,
      feeAmount: 690_000_000_000n,
      minAmountOut: (amountOut * 9950n) / 10_000n,
      split: { parts: [], amountIn: 99_310_000_000_000n, amountOut, incomplete: false },
      routeDescriptions: ["0x0bd7.. → 0x1cf1.. [hooked]"],
      plan: {} as any,
    },
    encoded: {} as any,
    value: 0n,
  } as unknown as SwapQuote;
  return { swapQuote, hookRisk: { hook: "0x", isContract: true, codeHash: "0x", isProxy: false, ok: true, tag: "hooked" }, skimBps: null };
}

const req = {
  tokenIn: WETH,
  tokenOut: TOKEN,
  amountIn: 100_000_000_000_000n,
  recipient: "0x000000000000000000000000000000000000dEaD",
  slippageBps: 50,
  feeBps: 69,
  weth: WETH,
};

beforeEach(() => {
  vi.clearAllMocks();
  v3Mock.mockResolvedValue([]);
  hookedMock.mockResolvedValue(null);
});

describe("quoteSwap + hooked fallback", () => {
  it("quotes a pair whose ONLY route is a return-delta hook (used to be null)", async () => {
    v3Mock.mockResolvedValue([]); // no tick route at all
    hookedMock.mockResolvedValue(hookedCandidate(2_000_000n));
    const q = await quoteSwap([], req);
    expect(q).not.toBeNull();
    expect(q!.quote.amountOut).toBe(2_000_000n);
    expect(q!.quote.routeDescriptions[0]).toContain("[hooked]");
  });

  it("returns null when neither a tick route nor a hooked route exists", async () => {
    v3Mock.mockResolvedValue([]);
    hookedMock.mockResolvedValue(null);
    expect(await quoteSwap([], req)).toBeNull();
  });

  it("prefers the HOOKED route when it delivers more output", async () => {
    v3Mock.mockResolvedValue([v3State]);
    const tick = await quoteSwap([v3Row], { ...req }); // measure the tick output first
    expect(tick).not.toBeNull();
    hookedMock.mockResolvedValue(hookedCandidate(tick!.quote.amountOut + 1_000_000_000_000n));
    const q = await quoteSwap([v3Row], req);
    expect(q!.quote.routeDescriptions[0]).toContain("[hooked]");
  });

  it("prefers the TICK route when the hooked route delivers less", async () => {
    v3Mock.mockResolvedValue([v3State]);
    hookedMock.mockResolvedValue(hookedCandidate(1n)); // hooked barely delivers anything
    const q = await quoteSwap([v3Row], req);
    expect(q).not.toBeNull();
    expect(q!.quote.routeDescriptions.join(" ")).not.toContain("[hooked]");
    expect(q!.quote.amountOut).toBeGreaterThan(1n);
  });
});

describe("a real quoter defect is not masked by a hooked candidate", () => {
  it("still throws QuoteFailedError when the tick quoter throws a non-NoRoute error", async () => {
    vi.resetModules();
    vi.doMock("../../lib/aggregator/multicall", () => ({ fetchV3StatesMulticall: vi.fn(async () => [v3State]) }));
    vi.doMock("../../lib/aggregator/discover", () => ({ discoverForPair: vi.fn(async () => []) }));
    vi.doMock("../../lib/aggregator/venues/v4Reader", () => ({
      fetchV4MolePool: async () => null, fetchV4Pool: async () => null, fetchV4PoolByKey: async () => null,
    }));
    vi.doMock("../../lib/aggregator/hookedQuote", () => ({
      bestHookedSimulateQuote: vi.fn(async () => hookedCandidate(9_999_999n)),
    }));
    vi.doMock("../../lib/aggregator/quote", async (orig) => {
      const real = (await orig()) as any;
      return { ...real, getQuote: () => { throw new Error("routing invariant broken"); } };
    });
    const { quoteSwap: fresh, QuoteFailedError } = await import("../../lib/aggregator/client");
    await expect(fresh([v3Row], req)).rejects.toBeInstanceOf(QuoteFailedError);
    vi.doUnmock("../../lib/aggregator/quote");
    vi.resetModules();
  });
});
