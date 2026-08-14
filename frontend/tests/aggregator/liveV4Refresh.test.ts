/**
 * liveV4Refresh.test.ts — the 1-second refresh may not delete v4 venues it cannot re-read by hand.
 *
 * THE BUG THIS LOCKS OUT. `LivePairSession.refresh()` rebuilt its pool set from scratch every tick and
 * re-added exactly ONE v4 pool: the hard-coded MoleHook WETH/USDG pool, via `fetchV4MolePool()`. Every
 * other v4 pool `init()` had loaded — external Uniswap-v4 pools and any extra MoleHook pool — was thrown
 * away on the first tick. A v4 pool has no address, so nothing downstream could recover it.
 *
 * What the user saw: pasting a v4-only token (BENK, 0x00077886…1E66, fee 3000, spacing 60) priced
 * correctly for about one second and then read "No route with live liquidity for this pair" forever,
 * while /api/v1/quote quoted the same pair fine — the server path never runs this loop.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { PoolState } from "../../lib/aggregator/venues/v3Pool";

const MOLE_HOOK = "0xb2c9A0af48dF8858F3765385E733Cd8776a138C4";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const BENK = "0x00077886eE27db5F74a8E867c47Ccb28d99f1E66";

function v4State(
  currency0: string,
  currency1: string,
  hooks: string,
  fee: number,
  liquidity: bigint,
): PoolState {
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
      { index: -60, liquidityNet: liquidity },
      { index: 60, liquidityNet: -liquidity },
    ],
    venue: "UniswapV4",
    poolKey: { currency0, currency1, fee, tickSpacing: 60, hooks },
  };
}

const MOLE_POOL = v4State(WETH, USDG, MOLE_HOOK, 0x800000, 1_000_000n);
const EXTERNAL_POOL = v4State(BENK, WETH, "0x0000000000000000000000000000000000000000", 3000, 2_000_000n);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("../../lib/aggregator/client");
  vi.doUnmock("../../lib/aggregator/discover");
  vi.doUnmock("../../lib/aggregator/venues/v4Reader");
  vi.doUnmock("../../lib/mole/aggFee");
});

async function sessionWith(states: PoolState[]) {
  vi.resetModules();
  const fetchV4Pool = vi.fn(async () => ({ ...MOLE_POOL, liquidity: 1_111_111n }));
  const fetchV4PoolByKey = vi.fn(async () => ({ ...EXTERNAL_POOL, liquidity: 2_222_222n }));
  vi.doMock("../../lib/aggregator/client", () => ({ fetchRelevantPoolStates: async () => states }));
  vi.doMock("../../lib/aggregator/discover", () => ({ discoverForPair: async () => [] }));
  vi.doMock("../../lib/aggregator/venues/v4Reader", () => ({ fetchV4Pool, fetchV4PoolByKey }));
  vi.doMock("../../lib/mole/aggFee", () => ({ getAggFeeBps: async () => 0, cachedAggFeeBps: () => 0 }));
  // Only the gas-price read touches fetch here: with no v3 pools there is no aggregate3 round trip.
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ result: "0x1" }) })) as any);

  const { LivePairSession } = await import("../../lib/aggregator/live");
  const s = new LivePairSession(BENK, WETH, WETH);
  await s.init([]);
  return { s, fetchV4Pool, fetchV4PoolByKey };
}

describe("the live session refreshes every v4 pool, not just the MoleHook one", () => {
  it("keeps an EXTERNAL v4 pool across a refresh and re-reads it by its own key", async () => {
    const { s, fetchV4PoolByKey } = await sessionWith([MOLE_POOL, EXTERNAL_POOL]);
    expect(s.poolStates).toHaveLength(2);

    await s.refresh();

    const external = s.poolStates.find((p) => p.address === EXTERNAL_POOL.address);
    expect(external).toBeDefined(); // the whole bug: this used to be gone after one tick
    expect(external!.liquidity).toBe(2_222_222n); // and re-read live, not left stale
    // A foreign hook goes through the by-key reader (real key fee + protocol fee), never through the
    // MoleHook reader, whose ABI and dynamic-fee sentinel do not describe it.
    expect(fetchV4PoolByKey).toHaveBeenCalledTimes(1);
    expect(fetchV4PoolByKey.mock.calls[0]![0]).toMatchObject({ fee: 3000, tickSpacing: 60 });
  });

  it("still re-reads a MoleHook pool through the MoleHook reader (which checks hookFeePips)", async () => {
    const { s, fetchV4Pool, fetchV4PoolByKey } = await sessionWith([MOLE_POOL, EXTERNAL_POOL]);
    await s.refresh();

    const mole = s.poolStates.find((p) => p.address === MOLE_POOL.address);
    expect(mole!.liquidity).toBe(1_111_111n);
    expect(fetchV4Pool).toHaveBeenCalledTimes(1);
    expect(fetchV4Pool.mock.calls[0]![0]).toMatchObject({ hooks: MOLE_HOOK });
    expect(fetchV4PoolByKey).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good snapshot when a v4 re-read fails, rather than deleting the venue", async () => {
    vi.resetModules();
    vi.doMock("../../lib/aggregator/client", () => ({
      fetchRelevantPoolStates: async () => [EXTERNAL_POOL],
    }));
    vi.doMock("../../lib/aggregator/discover", () => ({ discoverForPair: async () => [] }));
    vi.doMock("../../lib/aggregator/venues/v4Reader", () => ({
      fetchV4Pool: async () => null,
      fetchV4PoolByKey: async () => {
        throw new Error("RPC down");
      },
    }));
    vi.doMock("../../lib/mole/aggFee", () => ({ getAggFeeBps: async () => 0, cachedAggFeeBps: () => 0 }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ result: "0x1" }) })) as any);

    const { LivePairSession } = await import("../../lib/aggregator/live");
    const s = new LivePairSession(BENK, WETH, WETH);
    await s.init([]);
    await s.refresh();

    expect(s.poolStates.map((p) => p.address)).toEqual([EXTERNAL_POOL.address]);
    expect(s.poolStates[0]!.liquidity).toBe(EXTERNAL_POOL.liquidity);
  });
});
