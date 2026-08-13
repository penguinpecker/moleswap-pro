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
const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";
const POSITIONS = CONTRACTS.MOLE_POSITIONS;

/** Asset class of a pool, derived from its non-hub leg. Drives the category filter on /pools. */
export type AssetCategory = "mains" | "stables" | "stocks" | "memes";

export interface LivePool {
  pool: PoolInfo;
  token0: TokenInfo;
  token1: TokenInfo;
  /** v4 PoolId — the pool's real identity. `pool.address` is empty for these. */
  poolId: string;
  tick: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  reserve0: number;
  reserve1: number;
  tvlUsd: number;
  category: AssetCategory;
  /** Which leg is the pricing hub. */
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

let _cache: { at: number; rows: LivePool[] } | null = null;

export async function loadLivePools(
  provider: ethers.Provider,
  _limit = 24,
  ttlMs = 60_000,
): Promise<LivePool[]> {
  const now = Date.now();
  if (_cache && now - _cache.at < ttlMs) return _cache.rows;

  const client = sb();
  if (!client) return _cache?.rows ?? [];

  const { data: poolRows, error } = await client
    .from("mp_pools")
    .select("id,token0,token1,fee,tick_spacing,hooks")
    .eq("venue", "mole_v4")
    .eq("active", true);
  if (error || !poolRows?.length) return _cache?.rows ?? [];

  // Token metadata for every leg in one round trip.
  const addrs = Array.from(
    new Set(poolRows.flatMap((r: any) => [String(r.token0).toLowerCase(), String(r.token1).toLowerCase()])),
  );
  const { data: tokenRows } = await client
    .from("mp_tokens")
    .select("address,symbol,name,decimals,logo_url,is_stable")
    .in("address", addrs);
  const metaOf = new Map<string, any>((tokenRows || []).map((t: any) => [String(t.address).toLowerCase(), t]));

  const toToken = (addr: string): TokenInfo => {
    const m = metaOf.get(addr.toLowerCase());
    return {
      address: ethers.getAddress(addr),
      symbol: m?.symbol || "???",
      name: m?.name || m?.symbol || "Unknown",
      decimals: Number(m?.decimals ?? 18),
      sourceChain: "Robinhood Chain",
      logoURI: m?.logo_url || "",
      swappable: true,
      ...(m?.is_stable ? { isStable: true } : {}),
    } as TokenInfo;
  };

  const sv = new ethers.Contract(STATE_VIEW, stateViewAbi, provider);
  const pm = new ethers.Contract(POSITIONS, positionsAbi, provider);

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

      const usdgLc = USDG_ADDRESS.toLowerCase();
      const wethLc = CONTRACTS.WETH.toLowerCase();
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
        liquidity: BigInt(liquidity),
        reserve0, reserve1,
        tvlUsd: 0, // filled in below, once the ETH price is known
        category: classify(other, isHubPair),
        hub,
        _price: price,
      } as any;
    }),
  );

  const rows = settled
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter(Boolean);
  if (!rows.length) return _cache?.rows ?? [];

  // ETH price from our own deepest WETH/USDG pool, so the page agrees with the swap engine.
  const wethLc = CONTRACTS.WETH.toLowerCase();
  const usdgLc = USDG_ADDRESS.toLowerCase();
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
    // Value the hub leg directly and double it: a two-sided position holds matched value on each
    // side at spot, and the non-hub leg has no independent dollar price on this chain.
    let hubValue = 0;
    if (t0IsUsdg) hubValue = r.reserve0;
    else if (t1IsUsdg) hubValue = r.reserve1;
    else if (t0IsWeth) hubValue = r.reserve0 * ethUsd;
    else if (t1IsWeth) hubValue = r.reserve1 * ethUsd;
    const isHubPair = (t0IsWeth && t1IsUsdg) || (t0IsUsdg && t1IsWeth);
    const tvlUsd = isHubPair
      ? (t0IsUsdg ? r.reserve0 : r.reserve1) + (t0IsWeth ? r.reserve0 : r.reserve1) * ethUsd
      : hubValue * 2;
    const { _price, ...rest } = r;
    return { ...rest, tvlUsd: Number.isFinite(tvlUsd) && tvlUsd > 0 ? tvlUsd : 0 } as LivePool;
  });

  priced.sort((a, b) => b.tvlUsd - a.tvlUsd);
  _cache = { at: now, rows: priced };
  return priced;
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
