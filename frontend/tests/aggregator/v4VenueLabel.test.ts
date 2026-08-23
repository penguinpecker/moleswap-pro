/**
 * v4VenueLabel.test.ts — a foreign v4 pool must never be labelled as MoleSwap's in the route list.
 *
 * THE DEFECT THIS LOCKS OUT. The live session labelled EVERY UniswapV4 hop "MoleSwap v4": external v4
 * pools (foreign hook or hookless) and lookalikes with MoleHook's exact bitmap at another address all
 * read as ours in the swap route rows. The label now comes from the hop's key: only the pinned MoleHook
 * address is "MoleSwap v4"; every other v4 pool is "Uniswap v4". Driven through LivePairSession.quote()
 * with the same harness as liveV4Refresh.test.ts, so the test exercises the real label path.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { PoolState } from "../../lib/aggregator/venues/v3Pool";

const MOLE_HOOK = "0xb2c9A0af48dF8858F3765385E733Cd8776a138C4";
const LOOKALIKE = "0xdeadbeefdeadbeefdeadbeefdeadbeefdead38c4"; // MoleHook's bitmap, not MoleHook
const ZERO = "0x0000000000000000000000000000000000000000";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const BENK = "0x00077886eE27db5F74a8E867c47Ccb28d99f1E66";

function v4State(currency0: string, currency1: string, hooks: string, fee: number, liquidity: bigint): PoolState {
  return {
    address: `v4:${currency0}:${currency1}:${fee}:60:${hooks}`,
    token0: currency0,
    token1: currency1,
    fee: 3000,
    tickSpacing: 60,
    sqrtPriceX96: 79228162514264337593543950336n,
    tick: 0,
    liquidity,
    ticks: [
      { index: -600, liquidityNet: liquidity },
      { index: 600, liquidityNet: -liquidity },
    ],
    venue: "UniswapV4",
    poolKey: { currency0, currency1, fee, tickSpacing: 60, hooks },
  };
}

const MOLE_POOL = v4State(WETH, USDG, MOLE_HOOK, 0x800000, 10_000_000_000n);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("../../lib/aggregator/client");
  vi.doUnmock("../../lib/aggregator/discover");
  vi.doUnmock("../../lib/aggregator/venues/v4Reader");
  vi.doUnmock("../../lib/mole/aggFee");
});

async function quoteThrough(foreignHook: string) {
  vi.resetModules();
  const foreign = v4State(BENK, WETH, foreignHook, 3000, 10_000_000_000n);
  vi.doMock("../../lib/aggregator/client", () => ({ fetchRelevantPoolStates: async () => [MOLE_POOL, foreign] }));
  vi.doMock("../../lib/aggregator/discover", () => ({ discoverForPair: async () => [] }));
  vi.doMock("../../lib/aggregator/venues/v4Reader", () => ({
    fetchV4Pool: async () => MOLE_POOL,
    fetchV4PoolByKey: async () => foreign,
  }));
  vi.doMock("../../lib/mole/aggFee", () => ({ getAggFeeBps: async () => 0, cachedAggFeeBps: () => 0 }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ result: "0x1" }) })) as any);

  const { LivePairSession } = await import("../../lib/aggregator/live");
  const s = new LivePairSession(BENK, USDG, WETH);
  await s.init([]);
  const q = s.quote({ amountIn: 1_000_000n, recipient: "0x000000000000000000000000000000000000dEaD", slippageBps: 50, decimalsIn: 18, decimalsOut: 6 });
  if (!q) throw new Error("no quote");
  return q;
}

describe("ATTACK — a foreign v4 pool is not MoleSwap's", () => {
  it("a hookless v4 hop is labelled 'Uniswap v4', the MoleHook hop 'MoleSwap v4' — in one route", async () => {
    const q = await quoteThrough(ZERO);
    const hops = q.routes.flatMap((r) => r.hops);
    const benkHop = hops.find((h) => h.tokenIn.toLowerCase() === BENK.toLowerCase());
    const usdgHop = hops.find((h) => h.tokenOut.toLowerCase() === USDG.toLowerCase());
    expect(benkHop?.venue).toBe("Uniswap v4");
    expect(usdgHop?.venue).toBe("MoleSwap v4");
    // and NOWHERE is a foreign pool called ours
    for (const h of hops) if (h.tokenIn.toLowerCase() === BENK.toLowerCase()) expect(h.venue).not.toBe("MoleSwap v4");
  });

  it("a LOOKALIKE hook (MoleHook's bitmap at another address) is still 'Uniswap v4'", async () => {
    const q = await quoteThrough(LOOKALIKE);
    const hops = q.routes.flatMap((r) => r.hops);
    const benkHop = hops.find((h) => h.tokenIn.toLowerCase() === BENK.toLowerCase());
    expect(benkHop?.venue).toBe("Uniswap v4");
  });
});
