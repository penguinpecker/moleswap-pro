/**
 * live.ts — the 1-second live quote session behind the exchange page.
 *
 * Split of responsibilities, and why it exists at all: quoting is pure math over cached pool state
 * (`getQuote` never touches the network), so the ONLY thing that has to be paced is the state refresh.
 * A session holds the pool set for one pair, refreshes the DYNAMIC state (slot0, in-range liquidity,
 * tick window) for every pool in ONE Multicall3 round trip per second, and recomputes the quote locally
 * on every tick or keystroke. This is what makes the quote feel live without re-running discovery or
 * bursting the RPC — the exact failure that once 429'd the endpoint and broke ETH→USDG entirely.
 */

import { fetchRelevantPoolStates, type PoolRow } from "./client";
import { getQuote, NATIVE, type Quote } from "./quote";
import { encodePlan, type EncodedPlan } from "./router";
import type { PoolState, TickData } from "./venues/v3Pool";
import { decodeSlot0, decodeUint, decodePopulatedTicks, INDEXER_SELECTORS, DEFAULT_WORD_RADIUS, wordsToFetch } from "./indexer";
import { fetchV4MolePool } from "./venues/v4Reader";
import { discoverForPair } from "./discover";
import { PANCAKE_V3, ROBINHOOD_RPC_URL } from "../mole/chain";
import { getAggFeeBps, cachedAggFeeBps } from "../mole/aggFee";
// The aggregate3 machinery lives in ./multicall — one implementation, shared with the cold quote path.
import { MULTICALL3, encAddress, encInt16, encodeAggregate3, decodeAggregate3, rpcCall, type RawCall } from "./multicall";

const USDG_LC = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

const lc = (a: string) => a.toLowerCase();

/* ----------------------------------------------------------------------------- UI-facing quote */

export interface LiveRouteHop {
  venue: string; // "PancakeSwap V3" | "Uniswap V3" | "MoleSwap v4"
  feePct: string; // "0.05%"
  tokenIn: string;
  tokenOut: string;
  poolAddress: string;
}

export interface LiveRoute {
  hops: LiveRouteHop[];
  splitPct: number; // 0..100, share of amountIn
  amountIn: bigint;
  amountOut: bigint;
}

export interface LiveQuote {
  amountIn: bigint;
  amountOut: bigint;
  /** The on-chain floor MoleRouter enforces — the ONLY promise the contract makes. */
  minAmountOut: bigint;
  slippageBps: number;
  routes: LiveRoute[];
  /** Execution vs spot, percent (0.42 = 0.42% worse than spot). Null when spot is unavailable. */
  priceImpactPct: number | null;
  /** tokenOut per tokenIn, decimals-adjusted (for "1 ETH = 1,918.4 USDG"). */
  execRate: number;
  /** The aggregator fee the router skims from the output: bps + amount in the output token. amountOut is
   *  already NET of this — it is what the recipient receives. */
  feeBps: number;
  feeAmount: bigint;
  /** The raw route output BEFORE the fee, for a "you'd get X, fee Y" breakdown if desired. */
  grossAmountOut: bigint;
  /** USD value helpers, derived from the deepest live WETH/USDG pool — no external price feed. */
  usdPerWeth: number | null;
  /** Modeled gas for the router call (calibrated against real receipts; display-grade). */
  gasUnits: bigint;
  gasEth: number | null;
  encoded: EncodedPlan;
  value: bigint;
  updatedAt: number;
  poolsQuoted: number;
}

/* ----------------------------------------------------------------------------------- the session */

const VENUE_LABELS: Record<string, string> = {
  pancake_v3: "PancakeSwap V3",
  uniswap_v3: "Uniswap V3",
  mole_v4: "MoleSwap v4",
};

// Display-grade gas model, calibrated against real MoleRouter receipts on RH mainnet.
const GAS_BASE = 60_000n;
const GAS_PER_V3_HOP = 95_000n;
const GAS_PER_V4_HOP = 140_000n;

export class LivePairSession {
  private states: PoolState[] = [];
  private venueByAddr = new Map<string, string>();
  private gasPriceWei: bigint | null = null;
  private refreshing = false;
  private gasPriceAge = 0;
  private feeBps = cachedAggFeeBps();
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly weth: string;
  private readonly rpc: string;

  constructor(tokenIn: string, tokenOut: string, weth: string) {
    this.tokenIn = tokenIn;
    this.tokenOut = tokenOut;
    this.weth = weth;
    this.rpc =
      (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) || ROBINHOOD_RPC_URL;
  }

  get poolCount(): number {
    return this.states.length;
  }

  get poolStates(): readonly PoolState[] {
    return this.states;
  }

  /** Full load: registry + on-chain discovery + complete state fetch. Call once per pair. */
  async init(rows: PoolRow[]): Promise<void> {
    // Venue labels: registry rows first, then discovery (cached 60s inside discoverForPair, so this
    // is not a second network round trip after fetchRelevantPoolStates already ran it).
    for (const r of rows) if (r.address) this.venueByAddr.set(lc(r.address), VENUE_LABELS[r.venue] ?? "V3 pool");
    try {
      const discovered = await discoverForPair(this.tokenIn, this.tokenOut, this.weth);
      for (const r of discovered) if (r.address) this.venueByAddr.set(lc(r.address), VENUE_LABELS[r.venue] ?? "V3 pool");
    } catch {
      /* labels fall back to generic */
    }
    // Fetch pool state over the SAME configured RPC as discovery/refresh — the default
    // FetchTransport points at the public RPC, which rate-limits a many-pool fetch and
    // silently drops most venues (measured: 14 pools discovered → only 2 survive on the
    // public endpoint). Using the configured (Alchemy) RPC keeps the full set.
    this.states = await fetchRelevantPoolStates(
      rows,
      this.tokenIn,
      this.tokenOut,
      this.weth,
      this.rpc,
    );
    // Read the live aggregator fee before the first quote so minAmountOut is built on the post-fee output.
    this.feeBps = await getAggFeeBps(Date.now());
    await this.refreshGasPrice();
  }

  private async refreshGasPrice(): Promise<void> {
    try {
      const res = await fetch(this.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
      });
      const j = await res.json();
      if (j.result) this.gasPriceWei = BigInt(j.result);
      this.gasPriceAge = Date.now();
    } catch {
      /* keep the previous price */
    }
  }

  /**
   * Refresh the dynamic state of every known pool — ONE Multicall3 eth_call for all v3 pools
   * (slot0 + liquidity + the tick window), plus the v4 StateView read when the v4 pool is in the set.
   * Immutables (tokens, fee, spacing) are kept from init; ticks re-read around the LAST known tick,
   * which self-heals next tick if price moves a whole word between refreshes.
   */
  async refresh(): Promise<void> {
    if (this.refreshing || this.states.length === 0) return;
    this.refreshing = true;
    // Keep the fee current without blocking the tick — getAggFeeBps caches 30s, so this is a no-op read
    // most ticks and one cheap eth_call every 30s.
    void getAggFeeBps(Date.now()).then((b) => { this.feeBps = b; }).catch(() => {});
    try {
      const v3 = this.states.filter((s) => s.venue !== "UniswapV4");
      const hasV4 = this.states.some((s) => s.venue === "UniswapV4");

      const calls: RawCall[] = [];
      const layout: { pool: PoolState; slot0Idx: number; liqIdx: number; wordIdxs: number[] }[] = [];
      for (const p of v3) {
        const slot0Idx = calls.length;
        calls.push({ target: p.address, callData: INDEXER_SELECTORS.slot0 });
        const liqIdx = calls.length;
        calls.push({ target: p.address, callData: INDEXER_SELECTORS.liquidity });
        const centerWord = Math.floor(Math.floor(p.tick / p.tickSpacing) / 256);
        const wordIdxs: number[] = [];
        for (const w of wordsToFetch(centerWord, p.tickSpacing)) {
          wordIdxs.push(calls.length);
          calls.push({
            target: PANCAKE_V3.tickLens,
            callData: "0x" + INDEXER_SELECTORS.getPopulatedTicksInWord.replace(/^0x/, "") + encAddress(p.address) + encInt16(w),
          });
        }
        layout.push({ pool: p, slot0Idx, liqIdx, wordIdxs });
      }

      const next: PoolState[] = [];
      if (calls.length > 0) {
        const raw = await rpcCall(this.rpc, MULTICALL3, encodeAggregate3(calls));
        const results = decodeAggregate3(raw);
        for (const item of layout) {
          const slot0Res = results[item.slot0Idx];
          const liqRes = results[item.liqIdx];
          if (!slot0Res?.success || !liqRes?.success) {
            next.push(item.pool); // keep the stale state rather than dropping the venue
            continue;
          }
          try {
            const slot0 = decodeSlot0(slot0Res.data);
            const liquidity = decodeUint(liqRes.data);
            const ticks: TickData[] = [];
            for (const wi of item.wordIdxs) {
              const r = results[wi];
              if (r?.success && r.data && r.data !== "0x") ticks.push(...decodePopulatedTicks(r.data));
            }
            const byIndex = new Map<number, TickData>();
            for (const t of ticks) byIndex.set(t.index, t);
            next.push({
              ...item.pool,
              sqrtPriceX96: slot0.sqrtPriceX96,
              tick: slot0.tick,
              liquidity,
              ticks: [...byIndex.values()].sort((a, b) => a.index - b.index),
            });
          } catch {
            next.push(item.pool);
          }
        }
      }

      if (hasV4) {
        try {
          const v4 = await fetchV4MolePool();
          if (v4 && (v4.liquidity > 0n || v4.ticks.length > 0)) next.push(v4);
          else {
            const stale = this.states.find((s) => s.venue === "UniswapV4");
            if (stale) next.push(stale);
          }
        } catch {
          const stale = this.states.find((s) => s.venue === "UniswapV4");
          if (stale) next.push(stale);
        }
      }

      this.states = next;
      if (Date.now() - this.gasPriceAge > 30_000) await this.refreshGasPrice();
    } finally {
      this.refreshing = false;
    }
  }

  /** Pure quote off the cached snapshot — safe to call per keystroke and per refresh tick. */
  quote(params: {
    amountIn: bigint;
    recipient: string;
    slippageBps: number;
    decimalsIn: number;
    decimalsOut: number;
  }): LiveQuote | null {
    if (params.amountIn <= 0n || this.states.length === 0) return null;
    let q: Quote;
    try {
      q = getQuote(this.states, {
        tokenIn: this.tokenIn,
        tokenOut: this.tokenOut,
        amountIn: params.amountIn,
        recipient: params.recipient,
        nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
        ttlSeconds: 60n,
        slippageBps: params.slippageBps,
        feeBps: this.feeBps,
        weth: this.weth,
      });
    } catch {
      return null;
    }

    let encoded: EncodedPlan;
    let value: bigint;
    try {
      ({ arg: encoded, value } = encodePlan(q.plan));
    } catch {
      return null;
    }

    const routes: LiveRoute[] = q.split.parts.map((part) => ({
      hops: part.hops.map((h) => ({
        venue:
          h.pool.venue === "UniswapV4"
            ? "MoleSwap v4"
            : this.venueByAddr.get(lc(h.pool.address)) ?? "PancakeSwap V3",
        feePct: `${(h.pool.fee / 10_000).toFixed(h.pool.fee % 10_000 === 0 ? 0 : 2)}%`,
        tokenIn: h.tokenIn,
        tokenOut: h.tokenOut,
        poolAddress: h.pool.address,
      })),
      splitPct: Number((part.amountIn * 10_000n) / q.amountIn) / 100,
      amountIn: part.amountIn,
      amountOut: part.amountOut,
    }));

    // Price impact: execution rate vs the spot rate composed across each part's hops, weighted by
    // each part's input share. All raw-unit ratios, so decimals cancel.
    const spot = this.spotRateRaw(q);
    const execRaw = Number(q.amountOut) / Number(q.amountIn);
    const priceImpactPct = spot && spot > 0 ? Math.max(0, (1 - execRaw / spot) * 100) : null;

    const decimalsAdj = Math.pow(10, params.decimalsIn - params.decimalsOut);
    const execRate = execRaw * decimalsAdj;

    let gasUnits = GAS_BASE;
    for (const part of q.split.parts) {
      for (const h of part.hops) gasUnits += h.pool.venue === "UniswapV4" ? GAS_PER_V4_HOP : GAS_PER_V3_HOP;
    }
    const gasEth = this.gasPriceWei !== null ? Number(gasUnits * this.gasPriceWei) / 1e18 : null;

    return {
      amountIn: q.amountIn,
      // amountOut shown to the user is NET of the aggregator fee — what the recipient actually receives.
      amountOut: q.netAmountOut,
      grossAmountOut: q.amountOut,
      feeBps: q.feeBps,
      feeAmount: q.feeAmount,
      minAmountOut: q.minAmountOut,
      slippageBps: params.slippageBps,
      routes,
      priceImpactPct,
      execRate,
      usdPerWeth: this.usdPerWeth(),
      gasUnits,
      gasEth,
      encoded,
      value,
      updatedAt: Date.now(),
      poolsQuoted: this.states.length,
    };
  }

  /** Spot rate (tokenOut per tokenIn, RAW units) composed across the quote's hops, split-weighted. */
  private spotRateRaw(q: Quote): number | null {
    let weighted = 0;
    for (const part of q.split.parts) {
      let rate = 1;
      for (const h of part.hops) {
        const p = Number(h.pool.sqrtPriceX96) / 2 ** 96;
        const price1per0 = p * p;
        const zeroForOne = lc(h.tokenIn) === lc(h.pool.token0) ||
          (lc(h.tokenIn) === lc(NATIVE) && lc(this.weth) === lc(h.pool.token0));
        rate *= zeroForOne ? price1per0 : 1 / price1per0;
      }
      if (!isFinite(rate) || rate <= 0) return null;
      weighted += rate * (Number(part.amountIn) / Number(q.amountIn));
    }
    return weighted > 0 && isFinite(weighted) ? weighted : null;
  }

  /** USD per WETH from the deepest live WETH/USDG pool in the snapshot (USDG ≈ $1). */
  usdPerWeth(): number | null {
    let best: PoolState | null = null;
    for (const s of this.states) {
      const t0 = lc(s.token0);
      const t1 = lc(s.token1);
      const isPair =
        (t0 === lc(this.weth) && t1 === USDG_LC) || (t1 === lc(this.weth) && t0 === USDG_LC);
      if (!isPair) continue;
      if (!best || s.liquidity > best.liquidity) best = s;
    }
    if (!best) return null;
    const p = Number(best.sqrtPriceX96) / 2 ** 96;
    const price1per0 = p * p; // token1 raw per token0 raw
    const wethIsToken0 = lc(best.token0) === lc(this.weth);
    // USDG has 6 decimals, WETH 18 → human USD/WETH scales by 1e12.
    const usd = wethIsToken0 ? price1per0 * 1e12 : (1 / price1per0) * 1e12;
    return isFinite(usd) && usd > 0 ? usd : null;
  }
}

export { NATIVE };
