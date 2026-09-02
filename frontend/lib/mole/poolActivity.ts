/**
 * poolActivity.ts — a pool's real trading history, read from the chain itself.
 *
 * WHY THIS READS LOGS RATHER THAN THE REGISTRY. The pools page could only ever say TVL, a fee tier and
 * an APY that came from an indexer table; when that indexer stopped (its RPC key hit a monthly quota on
 * 2026-09-01) every one of those numbers froze and the page had no way to know. Swap events are on the
 * chain whether or not anything is indexing them, so this module has no dependency that can rot: point
 * it at an RPC and it answers.
 *
 * IT ALSO REPLACES A FABRICATED CHART. The pool detail drew a "liquidity distribution" whose bars were a
 * fixed triangular function around a hard-coded peak — decoration presented as data, on a page that also
 * shows a cryptographic provenance panel. Everything here is derived from events the chain emitted.
 *
 * HONESTY RULES, because a quiet pool must not look like a broken one:
 *  - `covered` states the block span actually scanned. A number computed over 6 hours is never labelled 24h.
 *  - `complete` is false when the RPC truncated the log set, so a caller can say "at least N" instead of N.
 *  - No trades is an ANSWER (`trades: []`), not an error. MoleSwap's own pools have 34 swaps in their
 *    entire lifetime and none in nine days; that is the honest state of a young market, and the page
 *    should say so rather than draw an empty chart that looks broken.
 */

/** Uniswap v4 `Swap(bytes32 indexed id, address indexed sender, int128, int128, uint160, uint128, int24, uint24)`. */
export const V4_SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
/** Uniswap/Pancake v3 `Swap(address indexed sender, address indexed recipient, int256, int256, uint160, uint128, int24)`. */
export const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

export interface PoolTrade {
  blockNumber: number;
  /** Unix seconds. Interpolated where a block was not fetched — see `timestampExact`. */
  timestamp: number;
  timestampExact: boolean;
  txHash: string;
  /** The address the pool credited/debited. For v4 this is the router, not the end user. */
  sender: string;
  /** Signed, from the POOL's perspective: negative means the pool paid it out. */
  amount0: bigint;
  amount1: bigint;
  /** True when the trade increased token0's price in token1 terms (token0 was bought out of the pool). */
  buysToken0: boolean;
  /**
   * |amount0| in WHOLE token0 units. Candle volume is summed from this, never from the raw integer:
   * summing wei put "9,860.34B" on the volume axis of an 18-decimal pool that had traded 0.0004 WETH.
   */
  size0: number;
  /** token1 per token0, decimal-adjusted, from the swap's own post-trade sqrtPriceX96. */
  price: number;
}

export interface Candle {
  /** Bucket start, unix seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Volume in token0 units (absolute). */
  v: number;
}

export interface PoolActivity {
  trades: PoolTrade[];
  candles: Candle[];
  /** Null where there is nothing to measure — never 0, which reads as "measured, and it was zero". */
  lastPrice: number | null;
  changePct: { h1: number | null; h6: number | null; h24: number | null };
  volumeToken0: { h1: number; h6: number; h24: number };
  tradeCount: { h1: number; h6: number; h24: number };
  /**
   * Totals across the WHOLE scanned window, whatever it was. Separate from the fixed 1h/6h/24h buckets
   * because a "Volume 30d" tile fed from `h24` prints a 24-hour number under a 30-day label — which is
   * not a rounding difference, it is a different question answered.
   */
  windowTotals: { volumeToken0: number; trades: number };
  high24h: number | null;
  low24h: number | null;
  covered: { fromBlock: number; toBlock: number; approxSeconds: number };
  /** False when the node truncated the result, so counts are lower bounds. */
  complete: boolean;
  venue: "v4" | "v3";
}

/** Robinhood Chain produces ~9.7 blocks/second (measured 2026-09-03 over 100k blocks). */
export const BLOCKS_PER_SECOND = 9.7;
export const blocksForSeconds = (s: number) => Math.ceil(s * BLOCKS_PER_SECOND);

type Rpc = (method: string, params: unknown[]) => Promise<any>;

/** Two's-complement read of a 32-byte word as a signed big integer. */
function toSigned(hexWord: string): bigint {
  const v = BigInt("0x" + hexWord);
  return v >> 255n === 1n ? v - (1n << 256n) : v;
}

function word(data: string, i: number): string {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  return body.slice(i * 64, i * 64 + 64);
}

/**
 * Price implied by a swap's post-trade sqrtPriceX96, in token1 per token0.
 *
 * Deliberately NOT amount1/amount0: that is the trade's average execution price including its own impact
 * and its own fee, so a chart built from it wobbles with trade size rather than tracking the market.
 */
export function priceFromSqrt(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  if (sqrtPriceX96 <= 0n) return 0;
  // Do the squaring in integer space; (2^96)^2 overflows a float long before the price does.
  const num = sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n;
  const raw = Number(num / (1n << 192n)) / 1e18;
  return raw * 10 ** (decimals0 - decimals1);
}

export interface DecodedSwap {
  blockNumber: number;
  txHash: string;
  sender: string;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
}

/** v4 PoolManager: data = [amount0, amount1, sqrtPriceX96, liquidity, tick, fee]; sender is topic[2]. */
export function decodeV4Swap(log: any): DecodedSwap {
  return {
    blockNumber: parseInt(log.blockNumber, 16),
    txHash: log.transactionHash,
    sender: "0x" + String(log.topics[2] ?? "").slice(-40),
    amount0: toSigned(word(log.data, 0)),
    amount1: toSigned(word(log.data, 1)),
    sqrtPriceX96: BigInt("0x" + word(log.data, 2)),
  };
}

/** v3 pool: data = [amount0, amount1, sqrtPriceX96, liquidity, tick]; recipient is topic[2]. */
export function decodeV3Swap(log: any): DecodedSwap {
  return {
    blockNumber: parseInt(log.blockNumber, 16),
    txHash: log.transactionHash,
    sender: "0x" + String(log.topics[2] ?? log.topics[1] ?? "").slice(-40),
    amount0: toSigned(word(log.data, 0)),
    amount1: toSigned(word(log.data, 1)),
    sqrtPriceX96: BigInt("0x" + word(log.data, 2)),
  };
}

/**
 * Bucket trades into OHLC candles.
 *
 * Empty buckets are FILLED FORWARD with a flat candle at the previous close rather than skipped: a gap
 * in a time series renders as a straight line between two distant points, which reads as a trend that
 * never happened. A flat segment reads as what it is — nothing traded.
 */
export function toCandles(trades: PoolTrade[], bucketSeconds: number, maxBuckets = 240): Candle[] {
  if (trades.length === 0 || bucketSeconds <= 0) return [];
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const bucketOf = (t: number) => Math.floor(t / bucketSeconds) * bucketSeconds;

  const byBucket = new Map<number, PoolTrade[]>();
  for (const t of sorted) {
    const b = bucketOf(t.timestamp);
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b)!.push(t);
  }

  const first = bucketOf(sorted[0]!.timestamp);
  const last = bucketOf(sorted[sorted.length - 1]!.timestamp);
  const out: Candle[] = [];
  let prevClose = sorted[0]!.price;
  for (let b = first; b <= last; b += bucketSeconds) {
    const inBucket = byBucket.get(b);
    if (!inBucket || inBucket.length === 0) {
      out.push({ t: b, o: prevClose, h: prevClose, l: prevClose, c: prevClose, v: 0 });
      continue;
    }
    const prices = inBucket.map((t) => t.price).filter((p) => p > 0);
    if (prices.length === 0) {
      out.push({ t: b, o: prevClose, h: prevClose, l: prevClose, c: prevClose, v: 0 });
      continue;
    }
    const o = prices[0]!;
    const c = prices[prices.length - 1]!;
    out.push({
      t: b,
      o,
      c,
      h: Math.max(...prices),
      l: Math.min(...prices),
      v: inBucket.reduce((s, t) => s + t.size0, 0),
    });
    prevClose = c;
  }
  // Keep the most recent window; a chart with 10,000 candles is unreadable and slow to draw.
  return out.length > maxBuckets ? out.slice(out.length - maxBuckets) : out;
}

/** The price `secondsAgo` before the newest trade, for a percentage change. Null when unmeasurable. */
export function priceAgo(trades: PoolTrade[], secondsAgo: number): number | null {
  if (trades.length === 0) return null;
  const newest = trades[trades.length - 1]!;
  const cutoff = newest.timestamp - secondsAgo;
  // The last trade at or before the cutoff IS the price then; nothing moved it in between.
  let candidate: PoolTrade | null = null;
  for (const t of trades) {
    if (t.timestamp <= cutoff) candidate = t;
    else break;
  }
  return candidate ? candidate.price : null;
}

export const pctChange = (from: number | null, to: number | null): number | null =>
  from === null || to === null || from === 0 ? null : ((to - from) / from) * 100;

/**
 * Read a pool's swaps and summarise them.
 *
 * `poolId` selects v4 (matched on the indexed PoolId) and `poolAddress` selects v3 (matched on the
 * emitting contract). Exactly one is required.
 */
export async function readPoolActivity(opts: {
  rpc: Rpc;
  /** v4: the PoolManager address plus the pool's id. */
  poolManager?: string;
  poolId?: string;
  /** v3: the pool contract. */
  poolAddress?: string;
  decimals0: number;
  decimals1: number;
  /** How far back to scan. Default 24h of blocks. */
  lookbackSeconds?: number;
  /** Cap on trades kept (newest first) — bounds both the response and the timestamp fetches. */
  maxTrades?: number;
  candleSeconds?: number;
}): Promise<PoolActivity> {
  const {
    rpc, poolManager, poolId, poolAddress,
    decimals0, decimals1,
    lookbackSeconds = 86_400, maxTrades = 120, candleSeconds = 300,
  } = opts;

  const isV4 = Boolean(poolId);
  if (!isV4 && !poolAddress) throw new Error("readPoolActivity needs a poolId (v4) or a poolAddress (v3)");

  const latest = parseInt(await rpc("eth_blockNumber", []), 16);
  const span = blocksForSeconds(lookbackSeconds);
  const fromBlock = Math.max(0, latest - span);

  const filter = isV4
    ? { address: poolManager, topics: [V4_SWAP_TOPIC, poolId] }
    : { address: poolAddress, topics: [V3_SWAP_TOPIC] };

  let logs: any[] = [];
  let complete = true;
  try {
    logs = await rpc("eth_getLogs", [
      { ...filter, fromBlock: "0x" + fromBlock.toString(16), toBlock: "0x" + latest.toString(16) },
    ]);
  } catch (e) {
    // A node that refuses the range (too many logs) is not an empty pool. Say so rather than
    // reporting zero trades, which is the same shape as a quiet market and means the opposite.
    const msg = e instanceof Error ? e.message : String(e);
    if (/exceed|limit|too many|range/i.test(msg)) complete = false;
    else throw e;
  }
  if (!Array.isArray(logs)) logs = [];

  const decoded = logs
    .map((l) => (isV4 ? decodeV4Swap(l) : decodeV3Swap(l)))
    .sort((a, b) => a.blockNumber - b.blockNumber);
  const kept = decoded.length > maxTrades ? decoded.slice(decoded.length - maxTrades) : decoded;
  if (decoded.length > maxTrades) complete = false;

  // Timestamps: fetch the distinct blocks we actually kept (bounded by maxTrades), and interpolate
  // nothing unless a fetch fails. A per-trade eth_getBlockByNumber on a busy pool would be hundreds of
  // round trips, which is why `maxTrades` bounds this rather than the block range alone.
  const uniqueBlocks = [...new Set(kept.map((d) => d.blockNumber))];
  const stamps = new Map<number, number>();
  const CONCURRENCY = 8;
  for (let i = 0; i < uniqueBlocks.length; i += CONCURRENCY) {
    const slice = uniqueBlocks.slice(i, i + CONCURRENCY);
    const blocks = await Promise.all(
      slice.map((b) =>
        rpc("eth_getBlockByNumber", ["0x" + b.toString(16), false]).catch(() => null),
      ),
    );
    blocks.forEach((blk, j) => {
      if (blk?.timestamp) stamps.set(slice[j]!, parseInt(blk.timestamp, 16));
    });
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const approx = (b: number) => nowSec - Math.round((latest - b) / BLOCKS_PER_SECOND);

  const trades: PoolTrade[] = kept.map((d) => ({
    blockNumber: d.blockNumber,
    timestamp: stamps.get(d.blockNumber) ?? approx(d.blockNumber),
    timestampExact: stamps.has(d.blockNumber),
    txHash: d.txHash,
    sender: d.sender,
    amount0: d.amount0,
    amount1: d.amount1,
    // The pool PAYING OUT token0 (negative amount0) is somebody buying token0.
    buysToken0: d.amount0 < 0n,
    size0: Math.abs(Number(d.amount0)) / 10 ** decimals0,
    price: priceFromSqrt(d.sqrtPriceX96, decimals0, decimals1),
  }));

  const newest = trades.length ? trades[trades.length - 1]! : null;
  const within = (s: number) => (newest ? trades.filter((t) => t.timestamp >= newest.timestamp - s) : []);
  const volOf = (ts: PoolTrade[]) => ts.reduce((sum, t) => sum + t.size0, 0);
  const w1 = within(3_600), w6 = within(21_600), w24 = within(86_400);
  const prices24 = w24.map((t) => t.price).filter((p) => p > 0);

  return {
    trades,
    candles: toCandles(trades, candleSeconds),
    lastPrice: newest && newest.price > 0 ? newest.price : null,
    changePct: {
      h1: pctChange(priceAgo(trades, 3_600), newest?.price ?? null),
      h6: pctChange(priceAgo(trades, 21_600), newest?.price ?? null),
      h24: pctChange(priceAgo(trades, 86_400), newest?.price ?? null),
    },
    volumeToken0: { h1: volOf(w1), h6: volOf(w6), h24: volOf(w24) },
    tradeCount: { h1: w1.length, h6: w6.length, h24: w24.length },
    windowTotals: { volumeToken0: volOf(trades), trades: trades.length },
    high24h: prices24.length ? Math.max(...prices24) : null,
    low24h: prices24.length ? Math.min(...prices24) : null,
    covered: { fromBlock, toBlock: latest, approxSeconds: Math.round(span / BLOCKS_PER_SECOND) },
    complete,
    venue: isV4 ? "v4" : "v3",
  };
}
