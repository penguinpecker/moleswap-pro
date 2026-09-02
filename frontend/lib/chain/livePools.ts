/**
 * livePools.ts — the pools MoleSwap itself runs.
 *
 * SCOPE
 * This lists ONLY pools created on MoleSwap: Uniswap-v4 pools bound to MoleHook, registered in
 * `mp_pools` under venue `mole_v4`. External PancakeSwap/Uniswap pools are deliberately NOT listed
 * here even though the aggregator routes through them — the router's job is to trade wherever the
 * price is best, but this page is about our own venue.
 *
 * WHY A v4 POOL CANNOT BE READ LIKE A v3 ONE
 * A v4 pool is not a contract. It is a key hashed into a PoolId inside the PoolManager singleton, so
 * there is no per-pool address to call `slot0()` on and no per-pool token balance to read: every v4
 * pool's tokens sit commingled in the singleton. State comes from StateView keyed by PoolId, and TVL
 * has to be derived from the positions themselves rather than from a balance lookup.
 *
 * HOW TVL IS DERIVED
 * By summing the real token amounts of every open MolePositions position in the pool, using the
 * standard concentrated-liquidity amount formulas at the pool's current price. That is an exact
 * measure of what is actually deposited, not an estimate from active liquidity (which only counts
 * the band straddling spot and would understate a pool with positions parked out of range).
 */
import { ethers } from "ethers";
import { createClient } from "@supabase/supabase-js";
import { CONTRACTS, type TokenInfo, type PoolInfo } from "./contracts";

const USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
/** The v4 StateView. Uniswap's deployment, at the SAME address on Robinhood and on Arc (verified). */
const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";

/**
 * WHICH CHAIN'S POOLS TO LOAD.
 *
 * This module was written when MoleSwap ran one chain, so every address in it was a module constant.
 * The ALM now runs on Arc too, and the numbers here — the vault to enumerate positions from, which
 * leg prices the pool, what a token's `sourceChain` says — are all chain-specific. They move into a
 * scope so a caller names the chain instead of inheriting Robinhood's by accident. Callers who pass
 * nothing get exactly the Robinhood behaviour they had before.
 */
export interface LivePoolScope {
  chainId: number;
  /** MolePositions on this chain — the vault whose open positions ARE the pool's reserves. */
  positions: string;
  /** What a token's `sourceChain` reports. */
  sourceChain: string;
  /** The stable leg that prices a pool in dollars directly. */
  hubStable: string;
  /** Wrapped native, priced through the stable/native pool. null where the chain has none (Arc). */
  hubNative: string | null;
  /**
   * Pools to list when the registry has no rows for this chain, as code.
   *
   * The indexer writes every `mp_pools` row with chain_id 4663 — Arc's live pool is simply not in the
   * table. Filtering by chain_id and stopping there would report `count: 0` for a pool holding real
   * money, which is the same class of lie as reporting Robinhood's. Each entry's key was verified to
   * keccak-hash to exactly its id, so these are on-chain identities, not a cache. Same discipline as
   * the aggregator's degraded-mode rows.
   */
  staticPools?: {
    id: string;
    token0: string;
    token1: string;
    fee: number;
    tick_spacing: number;
    hooks: string;
  }[];
  /** Token metadata for chains `mp_tokens` does not index. Looked up by address, never by symbol. */
  staticTokens?: TokenInfo[];
}

const RH_SCOPE: LivePoolScope = {
  chainId: 4663,
  positions: CONTRACTS.MOLE_POSITIONS,
  sourceChain: "Robinhood Chain",
  hubStable: USDG_ADDRESS,
  hubNative: CONTRACTS.WETH,
};

/** Asset class of a pool, derived from its non-hub leg. Drives the category filter on /pools. */
export type AssetCategory = "mains" | "stables" | "stocks" | "memes";

export interface LivePool {
  pool: PoolInfo;
  token0: TokenInfo;
  token1: TokenInfo;
  /** v4 PoolId — the pool's real identity. `pool.address` is empty for these. */
  poolId: string;
  /** The pool key's hook, as registered. Which engine can serve the pool is decided from THIS address
   *  (== MoleHook or not), never from the `venue` label the row was filed under. null if the row has none. */
  hooks: string | null;
  /** The pool key's tickSpacing — immutable, part of the PoolId. null if the row has none. */
  tickSpacing: number | null;
  tick: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  reserve0: number;
  reserve1: number;
  tvlUsd: number;
  category: AssetCategory;
  /** Which ROLE priced this pool: "usdg" = the chain's stable hub, "weth" = its wrapped native. The
   *  two labels are Robinhood's token symbols for historical reasons; on Arc the stable hub is USDC. */
  hub: "weth" | "usdg";
}

const stateViewAbi = [
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32) view returns (uint128)",
];
const positionsAbi = [
  "function positionCount() view returns (uint256)",
  "function getPosition(uint256) view returns (address owner, bytes32 poolId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint64 openedAtL1Block, uint64 lastRebalancedAt)",
];

const Q96 = 1n << 96n;

/** sqrt(1.0001^tick) * 2^96, via float — precise enough for display-layer reserve sums. */
function sqrtRatioAtTick(tick: number): bigint {
  return BigInt(Math.floor(Math.pow(1.0001, tick / 2) * 2 ** 96));
}

/** Token amounts a position of `liquidity` holds over [lower, upper] at the current price. */
function amountsForLiquidity(sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, L: bigint) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  let a0 = 0n;
  let a1 = 0n;
  if (sqrtP <= sqrtA) {
    a0 = (L * Q96 * (sqrtB - sqrtA)) / (sqrtA * sqrtB);
  } else if (sqrtP < sqrtB) {
    a0 = (L * Q96 * (sqrtB - sqrtP)) / (sqrtP * sqrtB);
    a1 = (L * (sqrtP - sqrtA)) / Q96;
  } else {
    a1 = (L * (sqrtB - sqrtA)) / Q96;
  }
  return { a0, a1 };
}

/**
 * Classify a pool by its non-hub leg. Data-driven where the data allows it: Robinhood's tokenised
 * equities all carry "Robinhood Token" in their name, and the indexer already flags stablecoins.
 * Everything else that is not a hub asset is a memecoin, which on this chain is overwhelmingly true.
 */
function classify(token: TokenInfo, isHubPair: boolean): AssetCategory {
  const sym = token.symbol.toUpperCase();
  const name = (token.name || "").toLowerCase();
  if (isHubPair) return "mains";
  if ((token as any).isStable || sym === "USDG" || sym === "USDC" || sym === "USDT") return "stables";
  if (name.includes("robinhood token") || name.includes("• robi")) return "stocks";
  if (sym === "WETH" || sym === "ETH") return "mains";
  return "memes";
}

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Keyed by chain: one chain's answer must never be served as another's. */
const _cache = new Map<number, { at: number; rows: LivePool[] }>();

/**
 * Thrown when the CHAIN, not the registry, could not be read and there is no earlier answer to serve.
 * Distinct on purpose: an empty list means "MoleSwap runs no pools here"; this means "we could not look".
 */
export class ChainReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainReadError";
  }
}

export async function loadLivePools(
  provider: ethers.Provider,
  _limit = 24,
  ttlMs = 60_000,
  scope: LivePoolScope = RH_SCOPE,
): Promise<LivePool[]> {
  const now = Date.now();
  const cached = _cache.get(scope.chainId);
  if (cached && now - cached.at < ttlMs) return cached.rows;
  const stale = () => cached?.rows ?? [];

  const client = sb();
  if (!client) return stale();

  // NOT gated on `active`. That column answers the AGGREGATOR's question — "may the router build a
  // path through this pool" — and the indexer sets it from `routable`, which is false for any v4 pool
  // whose hook returns a swap delta (services/indexer/src/index.mjs discoverV4). MoleHook does exactly
  // that, so every MoleSwap pool, including the live WETH/USDG one the vault and the queue run on
  // (LIVE_POOL_ID 0x9aca9d2f…, real liquidity on-chain right now), was stamped active=false and this
  // query returned nothing — /api/v1/pools answered `count: 0` and /pools listed no pool at all.
  // Whether a pool is listed is a different question from whether the router may route through it, and
  // the emptiness gate that belongs here is the one the API route already applies: a pool shows up when
  // it holds real deposited reserves (route.ts `hasLiquidity`), not when the router likes it.
  //
  // RETRIED, because this query fails intermittently in production. `mp_pools` holds ~390k rows and
  // `venue` is not indexed, so the filter is a sequential scan that lands either side of PostgREST's
  // 3s anon statement_timeout: measured locally it returned in ~0.8s on some calls and came back
  // `canceling statement due to statement timeout` on others. A single timed-out attempt used to render
  // /pools as "No pools found" — a live pool list vanishing at random. Two attempts turn a coin-flip
  // into a rare miss without risking the API route's own time budget.
  let poolRows: any[] | null = null;
  let error: { message?: string } | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client
      .from("mp_pools")
      .select("id,token0,token1,fee,tick_spacing,hooks")
      .eq("venue", "mole_v4")
      // Scoped to the chain, so a chain the indexer does not cover reads as EMPTY rather than as
      // Robinhood's pools wearing another chain's label.
      .eq("chain_id", scope.chainId);
    poolRows = res.data as any[] | null;
    error = res.error;
    if (!error) break;
    console.warn(`loadLivePools: mp_pools query attempt ${attempt + 1} failed:`, error.message || error);
  }
  // Never swallow the failure silently: an unlogged error here is indistinguishable from "MoleSwap runs
  // no pools", which is exactly how /pools sat empty without anyone seeing a reason.
  if (error) {
    console.error("loadLivePools: mp_pools query failed:", error.message || error);
    if (!scope.staticPools?.length) return stale();
    poolRows = null;
  }
  if (!poolRows?.length) {
    // The registry has nothing for this chain. Where the chain's pools are pinned as code, list those
    // — a live pool that the indexer has not reached is still a live pool.
    if (scope.staticPools?.length) {
      poolRows = scope.staticPools.map((p) => ({ ...p }));
    } else {
      console.warn(`loadLivePools: no mole_v4 pools registered in mp_pools for chain ${scope.chainId}`);
      return stale();
    }
  }

  // Token metadata for every leg in one round trip.
  const addrs = Array.from(
    new Set(poolRows.flatMap((r: any) => [String(r.token0).toLowerCase(), String(r.token1).toLowerCase()])),
  );
  const { data: tokenRows } = await client
    .from("mp_tokens")
    .select("address,symbol,name,decimals,logo_url,is_stable")
    .in("address", addrs);
  const metaOf = new Map<string, any>((tokenRows || []).map((t: any) => [String(t.address).toLowerCase(), t]));

  // Metadata the registry does not carry, pinned per chain. Consulted only where mp_tokens is silent,
  // so the indexer stays authoritative wherever it has actually indexed the token.
  const pinned = new Map<string, TokenInfo>(
    (scope.staticTokens || []).map((t) => [t.address.toLowerCase(), t]),
  );

  const toToken = (addr: string): TokenInfo => {
    const m = metaOf.get(addr.toLowerCase());
    const p = pinned.get(addr.toLowerCase());
    // DECIMALS ARE NEVER GUESSED WHERE THEY ARE KNOWN. Arc's USDC leg is 6-decimal through the ERC-20
    // view; defaulting it to 18 would misreport that pool's reserves by a factor of a trillion.
    const decimals = m?.decimals !== undefined && m?.decimals !== null
      ? Number(m.decimals)
      : p?.decimals ?? 18;
    return {
      address: ethers.getAddress(addr),
      symbol: m?.symbol || p?.symbol || "???",
      name: m?.name || m?.symbol || p?.name || "Unknown",
      decimals,
      sourceChain: scope.sourceChain,
      logoURI: m?.logo_url || p?.logoURI || "",
      swappable: true,
      ...(m?.is_stable || (p as any)?.isStable ? { isStable: true } : {}),
    } as TokenInfo;
  };

  const sv = new ethers.Contract(STATE_VIEW, stateViewAbi, provider);
  const pm = new ethers.Contract(scope.positions, positionsAbi, provider);

  // All open positions once, then bucketed by pool — one pass instead of a scan per pool.
  const byPool = new Map<string, { lower: number; upper: number; L: bigint }[]>();
  try {
    const count = Number(await pm.positionCount());
    const positions = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        pm.getPosition(i + 1).catch(() => null),
      ),
    );
    for (const p of positions) {
      if (!p) continue;
      const L = BigInt(p[4]);
      if (L <= 0n) continue;
      const id = String(p[1]).toLowerCase();
      if (!byPool.has(id)) byPool.set(id, []);
      byPool.get(id)!.push({ lower: Number(p[2]), upper: Number(p[3]), L });
    }
  } catch {
    /* positions unreadable — pools still list, with zero derived TVL */
  }

  const settled = await Promise.allSettled(
    poolRows.map(async (row: any) => {
      const poolId = String(row.id);
      const [slot0, liquidity] = await Promise.all([sv.getSlot0(poolId), sv.getLiquidity(poolId)]);
      const sqrtPriceX96 = BigInt(slot0[0]);
      if (sqrtPriceX96 === 0n) return null; // never initialised

      const token0 = toToken(String(row.token0));
      const token1 = toToken(String(row.token1));
      const tick = Number(slot0[1]);

      // Sum every open position's real token amounts at the current price.
      let a0 = 0n;
      let a1 = 0n;
      for (const pos of byPool.get(poolId.toLowerCase()) || []) {
        const r = amountsForLiquidity(
          sqrtPriceX96, sqrtRatioAtTick(pos.lower), sqrtRatioAtTick(pos.upper), pos.L,
        );
        a0 += r.a0;
        a1 += r.a1;
      }
      const reserve0 = Number(ethers.formatUnits(a0, token0.decimals));
      const reserve1 = Number(ethers.formatUnits(a1, token1.decimals));

      // price = token1 per token0, decimal-adjusted from the pool's own sqrt price.
      const sqr = sqrtPriceX96 * sqrtPriceX96;
      const raw = Number((sqr * 10n ** 18n) / (1n << 192n)) / 1e18;
      const price = raw * 10 ** (token0.decimals - token1.decimals);

      const usdgLc = scope.hubStable.toLowerCase();
      // A chain with no wrapped native (Arc) has no native hub to compare against; the sentinel below
      // can never equal a real leg, so every pool there prices off the stable hub alone.
      const wethLc = scope.hubNative ? scope.hubNative.toLowerCase() : "\u0000";
      const legs = [token0.address.toLowerCase(), token1.address.toLowerCase()];
      const hub: "weth" | "usdg" = legs.includes(usdgLc) ? "usdg" : "weth";
      const isHubPair = legs.includes(usdgLc) && legs.includes(wethLc);
      const other = legs[0] === (hub === "usdg" ? usdgLc : wethLc) ? token1 : token0;

      const pool: PoolInfo = {
        address: "",
        token0: token0.address,
        token1: token1.address,
        fee: Number(row.fee),
        name: `${token0.symbol}/${token1.symbol}`,
      };

      return {
        pool, token0, token1, poolId, tick, sqrtPriceX96,
        hooks: row.hooks ? String(row.hooks) : null,
        tickSpacing: row.tick_spacing === null || row.tick_spacing === undefined ? null : Number(row.tick_spacing),
        liquidity: BigInt(liquidity),
        reserve0, reserve1,
        tvlUsd: 0, // filled in below, once the ETH price is known
        category: classify(other, isHubPair),
        hub,
        _price: price,
      } as any;
    }),
  );

  for (const r of settled) {
    // A rejected read means the chain, not the registry, is the problem — say so rather than reporting
    // an empty pool list that reads as "MoleSwap has no pools".
    if (r.status === "rejected") console.error("loadLivePools: pool state read failed:", (r.reason as any)?.shortMessage || r.reason);
  }
  const rows = settled
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter(Boolean);
  if (!rows.length) {
    // EVERY pool read failed and nothing earlier is cached: that is the chain being unreadable, and it
    // was answered with `count: 0` — /pools rendered "No pools found" for a chain with real deposits (live
    // on Arc while its RPC upstream was exhausted). With a previous answer in hand a stale list is still a
    // true list, so it is served; with none, refuse and say why so the caller can keep what it has.
    const rejected = settled.filter((r) => r.status === "rejected");
    if (settled.length > 0 && rejected.length === settled.length && !cached) {
      const why = (rejected[0] as PromiseRejectedResult).reason;
      throw new ChainReadError(
        `${scope.sourceChain} could not be read (RPC): ${why?.shortMessage || why?.message || String(why)}`,
      );
    }
    return stale();
  }

  // ETH price from our own deepest native/stable pool, so the page agrees with the swap engine.
  const wethLc = scope.hubNative ? scope.hubNative.toLowerCase() : "\u0000";
  const usdgLc = scope.hubStable.toLowerCase();
  const ethRow = rows
    .filter((r: any) => {
      const l = [r.token0.address.toLowerCase(), r.token1.address.toLowerCase()];
      return l.includes(wethLc) && l.includes(usdgLc);
    })
    .sort((a: any, b: any) => Number(b.liquidity) - Number(a.liquidity))[0];
  const ethUsd = ethRow
    ? ethRow.token0.address.toLowerCase() === wethLc
      ? ethRow._price
      : ethRow._price > 0 ? 1 / ethRow._price : 0
    : 0;

  const priced: LivePool[] = rows.map((r: any) => {
    const t0IsUsdg = r.token0.address.toLowerCase() === usdgLc;
    const t1IsUsdg = r.token1.address.toLowerCase() === usdgLc;
    const t0IsWeth = r.token0.address.toLowerCase() === wethLc;
    const t1IsWeth = r.token1.address.toLowerCase() === wethLc;
    const tvl = poolTvlUsd({
      reserve0: r.reserve0, reserve1: r.reserve1, price: r._price,
      t0IsUsdg, t1IsUsdg, t0IsWeth, t1IsWeth, ethUsd,
    });
    const { _price, ...rest } = r;
    return { ...rest, tvlUsd: Number.isFinite(tvl) && tvl > 0 ? tvl : 0 } as LivePool;
  });

  priced.sort((a, b) => b.tvlUsd - a.tvlUsd);
  _cache.set(scope.chainId, { at: now, rows: priced });
  return priced;
}

/**
 * The dollar value of ONE pool's reserves, given which legs are the chain's hubs.
 *
 * Extracted so the DECISION is testable, not only the arithmetic. `tvlUsd` below was always correct;
 * the bug was that this caller did not use it. It valued the hub leg and DOUBLED it, on the reasoning
 * that a two-sided position holds matched value on each side at spot — true of a position straddling
 * spot, false of one parked entirely to one side, which holds a single token. Every single-sided pool
 * therefore reported exactly twice its real TVL, and a pool holding ONLY the non-hub token reported
 * zero. Live proof, 2026-08-25: NVDA/USDG held 0.999999 USDG and 0 NVDA and was published as $2.00.
 *
 * USDG is preferred as the denominator whenever it is a leg, so WETH/USDG is valued in dollars
 * directly rather than converted through an ETH price derived from that same pool.
 *
 * DISPLAY ONLY, AND THAT IS A CONSTRAINT RATHER THAN AN OBSERVATION. The non-hub leg is valued at
 * the pool's OWN spot, which on a thin pool is a number a third party can move for very little — so
 * this figure is inflatable by whoever wants the pool to look bigger. That is acceptable for a TVL
 * label and is not acceptable anywhere a decision is made. Today the only consumers are the /pools
 * page and /api/v1/pools. The one path with teeth is `screens/pools/index.tsx`'s `feeApy`, which
 * divides 24h fees by this number; it is gated behind APY_MIN_TVL_USD = 1000 and every live pool is
 * under $2, so nothing is published from it right now. Before wiring this into a cap, a headroom
 * figure, a router preference or any signed value, price the non-hub leg against an independent
 * reference (lib/aggregator/referencePrice.ts) instead of the pool being measured.
 */
export function poolTvlUsd(a: {
  reserve0: number; reserve1: number; price: number;
  t0IsUsdg: boolean; t1IsUsdg: boolean; t0IsWeth: boolean; t1IsWeth: boolean;
  ethUsd: number;
}): number {
  const hubIsUsdg = a.t0IsUsdg || a.t1IsUsdg;
  if (!hubIsUsdg && !a.t0IsWeth && !a.t1IsWeth) return 0; // neither leg is a hub: no dollar price exists
  const hubIsToken0 = hubIsUsdg ? a.t0IsUsdg : a.t0IsWeth;
  return tvlUsd({
    reserve0: a.reserve0, reserve1: a.reserve1, price: a.price,
    hubIsToken0, hubIsUsdg, ethUsd: a.ethUsd,
  });
}

/** Kept for the API route, which prices external fallbacks in hub terms. */
export function tvlUsd(args: {
  reserve0: number; reserve1: number; price: number;
  hubIsToken0: boolean; hubIsUsdg: boolean; ethUsd: number;
}): number {
  const { reserve0, reserve1, price, hubIsToken0, hubIsUsdg, ethUsd } = args;
  if (!Number.isFinite(price) || price <= 0) return 0;
  const inHub = hubIsToken0 ? reserve0 + reserve1 / price : reserve0 * price + reserve1;
  if (!Number.isFinite(inHub) || inHub <= 0) return 0;
  const usd = hubIsUsdg ? inHub : inHub * ethUsd;
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}
