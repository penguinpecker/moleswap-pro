/**
 * liveOracleDenominator.test.ts — the swap card's impact denominator on OUR venue is the hook's TWAP
 * mid, read through the one staleness helper; a stale or unread mid yields no impact figure and the
 * shared stale state instead.
 *
 * WHY. Impact against slot0 reads ~0% on a manipulated pool, because slot0 IS the manipulated number.
 * The TWAP is the only manipulation-resistant reference our pools have — and when it is stale it is the
 * last tick, extended, so there is no honest denominator at all. Written as attacks first: a stale mid
 * must not produce a number, an unread mid must not look fresh, and the fresh path must measurably use
 * the TWAP rather than slot0.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { PoolState } from "../../lib/aggregator/venues/v3Pool";
import { ORACLE_STALE_SECONDS } from "../../lib/mole/oracle";
import { poolIdOf } from "../../lib/mole/poolId";

const MOLE_HOOK = "0xb2c9A0af48dF8858F3765385E733Cd8776a138C4";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const Q96 = 79228162514264337593543950336n; // sqrtPriceX96 at tick 0 → price1per0 = 1
const L = 10n ** 15n; // deep enough that a 1e6-unit trade has negligible price impact of its own

/** The MoleHook WETH/USDG pool, spot at tick 0, as the aggregator's PoolState (fee 3000 dynamic). */
const MOLE_POOL: PoolState = {
  address: `v4:${WETH}:${USDG}:${0x800000}:60:${MOLE_HOOK}`,
  token0: WETH,
  token1: USDG,
  fee: 3000,
  tickSpacing: 60,
  sqrtPriceX96: Q96,
  tick: 0,
  liquidity: L,
  ticks: [
    { index: -887220, liquidityNet: L },
    { index: 887220, liquidityNet: -L },
  ],
  venue: "UniswapV4",
  poolKey: { currency0: WETH, currency1: USDG, fee: 0x800000, tickSpacing: 60, hooks: MOLE_HOOK },
};
const MOLE_ID = poolIdOf({ currency0: WETH, currency1: USDG, fee: 0x800000, tickSpacing: 60, hooks: MOLE_HOOK } as any).toLowerCase();

/**
 * A FOREIGN Uniswap-v4 pool at the same price: same venue tag, a hook that is not ours. client.ts feeds
 * external `uniswap_v4` registry rows into the same session (fetchV4PoolByKey), so the our-hook test must
 * be the HOOK ADDRESS, not the venue — otherwise every foreign v4 hop would read ORACLE STALE.
 */
const FOREIGN_HOOK = "0x0000000000000000000000000000000000000000";
const FOREIGN_V4_POOL: PoolState = {
  address: `v4:${WETH}:${USDG}:500:10:${FOREIGN_HOOK}`,
  token0: WETH,
  token1: USDG,
  fee: 500,
  tickSpacing: 10,
  sqrtPriceX96: Q96,
  tick: 0,
  liquidity: L,
  ticks: [
    { index: -887270, liquidityNet: L },
    { index: 887270, liquidityNet: -L },
  ],
  venue: "UniswapV4",
  poolKey: { currency0: WETH, currency1: USDG, fee: 500, tickSpacing: 10, hooks: FOREIGN_HOOK },
};
const FOREIGN_ID = poolIdOf({ currency0: WETH, currency1: USDG, fee: 500, tickSpacing: 10, hooks: FOREIGN_HOOK } as any).toLowerCase();

/** A plain v3 pool at the same price, for the control: no oracle involved. */
const V3_POOL: PoolState = {
  address: "0x88a8e96e7785d378825e8b5d7fc0e6f62487061e",
  token0: WETH,
  token1: USDG,
  fee: 500,
  tickSpacing: 10,
  sqrtPriceX96: Q96,
  tick: 0,
  liquidity: L,
  ticks: [
    { index: -887270, liquidityNet: L },
    { index: 887270, liquidityNet: -L },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("../../lib/aggregator/client");
  vi.doUnmock("../../lib/aggregator/discover");
  vi.doUnmock("../../lib/aggregator/venues/v4Reader");
  vi.doUnmock("../../lib/mole/aggFee");
  vi.doUnmock("../../lib/mole/oracle");
});

/**
 * A session over `states` whose oracle reads come from `health` (a function of the poolId, or a thrown
 * error). Everything else that would touch the network is stubbed; the quote is pure math off the states.
 */
async function sessionWith(states: PoolState[], health: (id: string) => Promise<any>) {
  vi.resetModules();
  const readOracleHealth = vi.fn(async (_c: any, id: string) => health(id));
  vi.doMock("../../lib/aggregator/client", () => ({ fetchRelevantPoolStates: async () => states }));
  vi.doMock("../../lib/aggregator/discover", () => ({ discoverForPair: async () => [] }));
  vi.doMock("../../lib/aggregator/venues/v4Reader", () => ({
    fetchV4Pool: async () => MOLE_POOL,
    fetchV4PoolByKey: async () => null,
  }));
  vi.doMock("../../lib/mole/aggFee", () => ({ getAggFeeBps: async () => 0, cachedAggFeeBps: () => 0 }));
  vi.doMock("../../lib/mole/oracle", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/mole/oracle")>()),
    oracleClient: () => ({ readContract: async () => { throw new Error("no network in tests"); } }),
    readOracleHealth,
  }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ result: "0x1" }) })) as any);

  const { LivePairSession } = await import("../../lib/aggregator/live");
  const s = new LivePairSession(WETH, USDG, WETH);
  await s.init([]);
  return { s, readOracleHealth };
}

const quoteOf = (s: any) =>
  s.quote({ amountIn: 1_000_000n, recipient: "0x000000000000000000000000000000000000dEaD", slippageBps: 50, decimalsIn: 18, decimalsOut: 6 });

const now = () => Math.floor(Date.now() / 1000);

describe("impact denominator on a MoleHook pool = the TWAP mid, through the staleness helper", () => {
  it("FRESH: measures impact against the TWAP, not slot0 (spot tick 0, TWAP tick +100 → ≈1.3%, not ≈0.3%)", async () => {
    // The oracle's mid sits 100 ticks ABOVE spot: TWAP price1per0 = 1.0001^100 ≈ 1.01005. Execution at
    // spot with a 0.30% fee ≈ 0.9970 USDG-raw per WETH-raw, so impact vs TWAP ≈ 1 − 0.9970/1.01005 ≈ 1.29%.
    // Against slot0 the same trade would read ≈ 0.30%. The gap between those two is the whole point.
    const { s, readOracleHealth } = await sessionWith([MOLE_POOL], async () => ({ mid: 100, observedAt: now() - 30, ageSec: 30, stale: false }));
    expect(readOracleHealth).toHaveBeenCalledTimes(1);
    expect(readOracleHealth.mock.calls[0]![1]).toBe(MOLE_ID); // keyed by the live-style pool id
    const q = quoteOf(s)!;
    expect(q).not.toBeNull();
    expect(q.oracleStale).toBe(false);
    expect(q.priceImpactPct).not.toBeNull();
    expect(q.priceImpactPct!).toBeGreaterThan(1.2);
    expect(q.priceImpactPct!).toBeLessThan(1.4);
    expect(q.oracleAgeSec).toBeGreaterThanOrEqual(30);
  });

  it("ATTACK: a STALE mid must not yield an impact number — oracleStale=true, priceImpactPct=null, age carried", async () => {
    const age = ORACLE_STALE_SECONDS + 1;
    const { s } = await sessionWith([MOLE_POOL], async () => ({ mid: 100, observedAt: now() - age, ageSec: age, stale: true }));
    const q = quoteOf(s)!;
    expect(q).not.toBeNull(); // the quote itself still stands — minAmountOut is the on-chain promise
    expect(q.oracleStale).toBe(true);
    expect(q.priceImpactPct).toBeNull();
    expect(q.oracleAgeSec).toBeGreaterThanOrEqual(age);
  });

  it("ATTACK: the boundary flips on the CLOCK, not on the next read — a mid read fresh goes stale as it ages", async () => {
    // Read at exactly the threshold (fresh); quote as if one more second has passed.
    const t0 = now();
    const { s } = await sessionWith([MOLE_POOL], async () => ({ mid: 100, observedAt: t0 - ORACLE_STALE_SECONDS, ageSec: ORACLE_STALE_SECONDS, stale: false }));
    expect(quoteOf(s)!.oracleStale).toBe(false);
    vi.useFakeTimers();
    try {
      vi.setSystemTime((t0 + 2) * 1000);
      expect(quoteOf(s)!.oracleStale).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ATTACK: an UNREAD oracle (read failed) must not look fresh — oracleStale=true, age Infinity", async () => {
    const { s } = await sessionWith([MOLE_POOL], async () => {
      throw new Error("http 429");
    });
    const q = quoteOf(s)!;
    expect(q.oracleStale).toBe(true);
    expect(q.priceImpactPct).toBeNull();
    expect(q.oracleAgeSec).toBe(Number.POSITIVE_INFINITY);
  });

  it("ATTACK: a mid the ring cannot answer (consult reverted → mid null) is not a denominator either", async () => {
    const { s } = await sessionWith([MOLE_POOL], async () => ({ mid: null, observedAt: now() - 5, ageSec: 5, stale: false }));
    const q = quoteOf(s)!;
    expect(q.oracleStale).toBe(true);
    expect(q.priceImpactPct).toBeNull();
  });

  it("CONTROL: a route that never touches a MoleHook pool is untouched — slot0 denominator, no oracle read", async () => {
    const { s, readOracleHealth } = await sessionWith([V3_POOL], async () => {
      throw new Error("must not be called");
    });
    expect(readOracleHealth).not.toHaveBeenCalled();
    const q = quoteOf(s)!;
    expect(q.oracleStale).toBe(false);
    expect(q.priceImpactPct).not.toBeNull();
    expect(q.priceImpactPct!).toBeLessThan(0.2); // fee is NOT impact against slot0 for a v3 pool: ≈ 0.05% + dust
  });

  it("CONTROL: a FOREIGN v4 pool (venue UniswapV4, hook ≠ MoleHook) is not ours — slot0 denominator, no oracle read, never stale", async () => {
    const { s, readOracleHealth } = await sessionWith([FOREIGN_V4_POOL], async () => {
      throw new Error("must not be called");
    });
    expect(readOracleHealth).not.toHaveBeenCalled();
    const q = quoteOf(s)!;
    expect(q).not.toBeNull();
    expect(q.oracleStale).toBe(false);
    expect(q.oracleAgeSec).toBe(0);
    expect(q.priceImpactPct).not.toBeNull();
    expect(q.priceImpactPct!).toBeLessThan(0.2); // slot0 reference: ≈ 0.05% fee + dust, exactly like the v3 control
  });

  it("CONTROL: in a mixed set only OUR pool's oracle is read — once, by our pool id, never the foreign one", async () => {
    const { s, readOracleHealth } = await sessionWith([MOLE_POOL, FOREIGN_V4_POOL], async (id) => {
      if (id !== MOLE_ID) throw new Error(`oracle read for a foreign pool ${id}`);
      return { mid: 0, observedAt: now() - 30, ageSec: 30, stale: false };
    });
    expect(readOracleHealth).toHaveBeenCalledTimes(1);
    expect(readOracleHealth.mock.calls[0]![1]).toBe(MOLE_ID);
    expect(readOracleHealth.mock.calls.map((c) => c[1])).not.toContain(FOREIGN_ID);
    const q = quoteOf(s)!;
    expect(q).not.toBeNull();
    expect(q.oracleStale).toBe(false); // whichever hop the splitter takes, the foreign one needs no oracle and ours is fresh
    expect(q.priceImpactPct).not.toBeNull();
  });

  it("the oracle is re-read at most every 15s across refresh ticks, by pool id", async () => {
    const { s, readOracleHealth } = await sessionWith([MOLE_POOL], async () => ({ mid: 100, observedAt: now() - 1, ageSec: 1, stale: false }));
    expect(readOracleHealth).toHaveBeenCalledTimes(1);
    await s.refresh();
    await s.refresh();
    expect(readOracleHealth).toHaveBeenCalledTimes(1); // throttled: the ring cannot move faster than the interval
    expect(s.oracleHealth.get(MOLE_ID)?.mid).toBe(100);
  });
});
