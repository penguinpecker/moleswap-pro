/**
 * poolActivity.test.ts — the pool page's numbers must come from the chain, and must be honest when
 * there is nothing to report.
 *
 * This module replaced a "liquidity distribution" chart whose 24 bars were `100 - distance from a
 * hard-coded 0.55 peak`, over a price axis invented as `price * (0.5 + ratio)`, with a tooltip that
 * reported the bar's own height back as "LIQ: n%". It sat under a cryptographic provenance panel.
 * So the bar this code has to clear is not "looks plausible" — it is "every number traces to an event
 * the chain emitted".
 */
import { describe, it, expect } from "vitest";
import {
  decodeV3Swap, decodeV4Swap, priceFromSqrt, toCandles, priceAgo, pctChange,
  readPoolActivity, blocksForSeconds, V4_SWAP_TOPIC, type PoolTrade,
} from "../../lib/mole/poolActivity";

const w = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
/** Two's complement of a negative bigint in 32 bytes — what the chain actually puts in the log. */
const negWord = (v: bigint) => ((1n << 256n) + v).toString(16).padStart(64, "0");

const SQRT_1_1 = 1n << 96n; // price 1.0 at equal decimals

describe("decoding what the chain emitted", () => {
  it("reads a v4 Swap: signed amounts, the sender from topic 2, the post-trade sqrt price", () => {
    const log = {
      blockNumber: "0x64",
      transactionHash: "0xdead",
      topics: ["0x" + "0".repeat(64), "0x" + "11".repeat(32), "0x" + "0".repeat(24) + "ab".repeat(20)],
      data: "0x" + negWord(-5n) + w("7") + w(SQRT_1_1.toString(16)) + w("0") + w("0") + w("bb8"),
    };
    const d = decodeV4Swap(log);
    expect(d.blockNumber).toBe(100);
    expect(d.amount0).toBe(-5n); // the pool PAID OUT token0
    expect(d.amount1).toBe(7n);
    expect(d.sqrtPriceX96).toBe(SQRT_1_1);
    expect(d.sender.toLowerCase()).toBe("0x" + "ab".repeat(20));
  });

  it("reads a v3 Swap with its different word layout", () => {
    const log = {
      blockNumber: "0xa",
      transactionHash: "0xbeef",
      topics: ["0x" + "0".repeat(64), "0x" + "0".repeat(24) + "11".repeat(20), "0x" + "0".repeat(24) + "cd".repeat(20)],
      data: "0x" + w("3") + negWord(-9n) + w(SQRT_1_1.toString(16)) + w("0") + w("0"),
    };
    const d = decodeV3Swap(log);
    expect(d.amount0).toBe(3n);
    expect(d.amount1).toBe(-9n);
    expect(d.sqrtPriceX96).toBe(SQRT_1_1);
  });
});

describe("price from the pool's own sqrt price", () => {
  it("is 1.0 for sqrtPriceX96 = 2^96 at equal decimals", () => {
    expect(priceFromSqrt(SQRT_1_1, 18, 18)).toBeCloseTo(1, 9);
  });

  it("adjusts for a 18/6 pair — the WETH/USDG shape, where getting this wrong is a 1e12 error", () => {
    // sqrt(2080 / 1e12) * 2^96 — the encoding a WETH/USDG pool really carries at ~$2,080 per ETH.
    // Read with equal decimals the same value would answer 2.08e-9, which is the 1e12 mistake.
    const sqrtAt2080 = 3613360154980996901502976n;
    expect(priceFromSqrt(sqrtAt2080, 18, 6)).toBeCloseTo(2080, 0);
    expect(priceFromSqrt(sqrtAt2080, 18, 18)).toBeLessThan(1e-6);
  });

  it("refuses to invent a price from a zero sqrt price", () => {
    expect(priceFromSqrt(0n, 18, 6)).toBe(0);
  });
});

const trade = (ts: number, price: number, amount0 = 10n ** 18n): PoolTrade => ({
  blockNumber: ts, timestamp: ts, timestampExact: true, txHash: "0x" + ts.toString(16),
  sender: "0x" + "1".repeat(40), amount0, amount1: 1n, buysToken0: false,
  size0: Number(amount0) / 1e18, price,
});

describe("candles", () => {
  it("buckets by time and reports true open/high/low/close", () => {
    const c = toCandles([trade(0, 10), trade(100, 14), trade(200, 8), trade(299, 12)], 300);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ o: 10, h: 14, l: 8, c: 12 });
  });

  it("FILLS a gap flat instead of leaving a hole", () => {
    // A hole renders as a straight line between two distant points, which reads as a trend that never
    // happened. This pool traded, went quiet for an hour, then traded again.
    const c = toCandles([trade(0, 10), trade(3600, 20)], 600);
    expect(c.length).toBe(7);
    expect(c[1]!.o).toBe(10);
    expect(c[1]!.c).toBe(10); // flat at the last close, not interpolated toward 20
    expect(c[1]!.v).toBe(0);
    expect(c[c.length - 1]!.c).toBe(20);
  });

  it("says nothing when nothing traded", () => {
    expect(toCandles([], 300)).toEqual([]);
  });

  it("keeps the chart drawable by capping buckets to the most recent window", () => {
    const c = toCandles([trade(0, 1), trade(600_000, 2)], 60, 50);
    expect(c).toHaveLength(50);
    expect(c[c.length - 1]!.c).toBe(2); // the RECENT end survives, not the ancient one
  });
});

describe("change over a window", () => {
  it("takes the last price at or before the cutoff — nothing moved it in between", () => {
    const ts = [trade(0, 100), trade(1_000, 110), trade(5_000, 130)];
    expect(priceAgo(ts, 4_000)).toBe(110); // 5000-4000 = 1000
    expect(pctChange(priceAgo(ts, 4_000), 130)).toBeCloseTo(18.1818, 3);
  });

  it("returns null rather than 0 when the window predates every trade", () => {
    expect(priceAgo([trade(9_000, 5)], 86_400)).toBeNull();
    expect(pctChange(null, 5)).toBeNull();
    expect(pctChange(0, 5)).toBeNull(); // no division by zero dressed up as Infinity%
  });
});

describe("reading a pool", () => {
  const BASE_TS = 1_700_000_000;
  /** Block timestamps derived from the block NUMBER, so trades in different blocks are different times.
   *  A stub that answers one fixed timestamp puts every trade in the same bucket and quietly makes any
   *  time-window assertion vacuous. */
  const stubRpc = (logs: any[], latest = 1_000_000) => async (method: string, params: any[]) => {
    if (method === "eth_blockNumber") return "0x" + latest.toString(16);
    if (method === "eth_getLogs") return logs;
    if (method === "eth_getBlockByNumber") {
      const b = parseInt(String(params[0]), 16);
      return { timestamp: "0x" + Math.round(BASE_TS - (latest - b) / 9.7).toString(16) };
    }
    throw new Error("unexpected " + method);
  };

  const v4Log = (block: number, amount0: bigint, sqrt: bigint) => ({
    blockNumber: "0x" + block.toString(16),
    transactionHash: "0x" + block.toString(16),
    topics: [V4_SWAP_TOPIC, "0x" + "22".repeat(32), "0x" + "0".repeat(24) + "ab".repeat(20)],
    data: "0x" + (amount0 < 0n ? negWord(amount0) : w(amount0.toString(16))) + w("1") + w(sqrt.toString(16)) + w("0") + w("0") + w("bb8"),
  });

  it("an empty pool is an ANSWER, not an error", async () => {
    const a = await readPoolActivity({
      rpc: stubRpc([]), poolManager: "0x" + "1".repeat(40), poolId: "0x" + "2".repeat(64),
      decimals0: 18, decimals1: 6,
    });
    expect(a.trades).toEqual([]);
    expect(a.candles).toEqual([]);
    expect(a.lastPrice).toBeNull();      // null, not 0 — "nothing to measure", not "measured zero"
    expect(a.changePct.h24).toBeNull();
    expect(a.complete).toBe(true);       // we really did see the whole window
    expect(a.venue).toBe("v4");
  });

  it("a node that refuses the range is NOT reported as an empty pool", async () => {
    const rpc = async (method: string) => {
      if (method === "eth_blockNumber") return "0xf4240";
      throw new Error("logs matched by query exceeds limit of 10000");
    };
    const a = await readPoolActivity({
      rpc, poolManager: "0x" + "1".repeat(40), poolId: "0x" + "2".repeat(64), decimals0: 18, decimals1: 6,
    });
    expect(a.trades).toEqual([]);
    expect(a.complete).toBe(false); // the caller must be able to say "at least", not "none"
  });

  it("marks the side from the sign the pool reported, not from the amount's size", async () => {
    const a = await readPoolActivity({
      rpc: stubRpc([v4Log(999_000, -3n, SQRT_1_1), v4Log(999_500, 4n, SQRT_1_1)]),
      poolManager: "0x" + "1".repeat(40), poolId: "0x" + "2".repeat(64), decimals0: 18, decimals1: 18,
    });
    expect(a.trades).toHaveLength(2);
    expect(a.trades[0]!.buysToken0).toBe(true);  // pool paid token0 out
    expect(a.trades[1]!.buysToken0).toBe(false);
    expect(a.trades[0]!.timestampExact).toBe(true);
  });

  it("reports candle volume in WHOLE tokens, not raw integer units", async () => {
    // An 18-decimal pool that traded 0.0004 WETH once put "9,860.34B" on the volume axis, because the
    // histogram summed wei. A volume axis in wei is not a large number — it is a wrong one.
    const a = await readPoolActivity({
      rpc: stubRpc([v4Log(999_000, -(10n ** 18n) / 2n, SQRT_1_1)]),
      poolManager: "0x" + "1".repeat(40), poolId: "0x" + "2".repeat(64),
      decimals0: 18, decimals1: 18,
    });
    expect(a.trades[0]!.size0).toBeCloseTo(0.5, 9);
    expect(a.candles[0]!.v).toBeCloseTo(0.5, 9);
    expect(a.volumeToken0.h24).toBeCloseTo(0.5, 9);
  });

  it("totals the WHOLE scanned window, not just its last 24 hours", async () => {
    // A "Volume 30d" tile fed from the fixed 24h bucket prints a 24-hour number under a 30-day label.
    // These two trades are 8 days apart, so any 24h-scoped total would see at most one of them.
    const eightDaysOfBlocks = Math.round(8 * 86_400 * 9.7);
    const latest = 30_000_000;
    const a = await readPoolActivity({
      rpc: stubRpc(
        [v4Log(latest - eightDaysOfBlocks, -(10n ** 18n), SQRT_1_1), v4Log(latest - 100, -(10n ** 18n), SQRT_1_1)],
        latest,
      ),
      poolManager: "0x" + "1".repeat(40), poolId: "0x" + "2".repeat(64),
      decimals0: 18, decimals1: 18, lookbackSeconds: 2_592_000,
    });
    // Sanity: the fixture really does straddle 24h, or the assertion below proves nothing.
    expect(a.tradeCount.h24).toBe(1);
    expect(a.windowTotals.trades).toBe(2);
    expect(a.windowTotals.volumeToken0).toBeCloseTo(2, 9);
  });

  it("scans a window sized from the chain's real block rate", () => {
    // ~9.7 blocks/sec measured on Robinhood Chain: 24h is ~836k blocks, not ~7k as a 12s chain would be.
    expect(blocksForSeconds(86_400)).toBeGreaterThan(700_000);
    expect(blocksForSeconds(86_400)).toBeLessThan(900_000);
  });
});
