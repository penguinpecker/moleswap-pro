/**
 * livePools.ts — the REAL pool list, derived from what is actually on-chain.
 *
 * WHY THIS EXISTS
 * `POOLS` in contracts.ts is a hardcoded array of three PancakeSwap WETH/USDG pools. Measured on
 * 2026-08-13, two of them were effectively empty (~$2 and ~$0.03 of TVL) and were still reported to
 * users as having liquidity, while the pool the aggregator ACTUALLY swaps through — a fee-100
 * WETH/USDG pool holding ~$9.5M — was not in the list at all. So the pools surface was showing ~$85k
 * of depth for a venue that really has ~$9.5M, and listing two dead pools as live.
 *
 * The aggregator was never wrong about this: `lib/aggregator/discover.ts` probes six V3 factories
 * across seven fee tiers live on every quote, which is how it finds pools the static list and even
 * the `mp_pools` registry are missing. This module brings the DISPLAY surface up to the same standard.
 *
 * SOURCE OF TRUTH
 * `mp_tokens` — the indexer's per-token registry. Each verified row carries the token's metadata and
 * the address of its DEEPEST pool (`pool`) plus which hub it pairs against (`pool_hub` = weth|usdg),
 * ranked by `liquidity` (denominated in WETH). That gives a real, self-maintaining list: every
 * memecoin/WETH pool with genuine depth appears automatically, and a pool that drains falls off.
 * The pair's fee tier and currency ordering are read from the pool contract itself rather than
 * assumed, because the registry does not always carry them (and `mp_pools` is missing rows that
 * `mp_tokens` has — verified, do not "simplify" this by joining the two).
 */
import { ethers } from "ethers";
import { createClient } from "@supabase/supabase-js";
import { CONTRACTS, type TokenInfo, type PoolInfo } from "./contracts";

const USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

/** The two hub legs every listed pool pairs against. Decimals are pinned — USDG is SIX. */
const HUBS: Record<"weth" | "usdg", TokenInfo> = {
  weth: {
    address: CONTRACTS.WETH,
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    sourceChain: "Robinhood Chain",
    logoURI: "/tokens/weth.svg",
    swappable: true,
  },
  usdg: {
    address: USDG_ADDRESS,
    symbol: "USDG",
    name: "Global Dollar",
    decimals: 6,
    sourceChain: "Robinhood Chain",
    logoURI: "/tokens/usdg.svg",
    swappable: true,
  },
};

export interface LivePool {
  pool: PoolInfo;
  token0: TokenInfo;
  token1: TokenInfo;
  /** Depth of this token's pool in WETH, as measured by the indexer. Ranking key, not a price. */
  liquidityWeth: number;
  /** Which leg is the hub — the other leg is the interesting token. */
  hub: "weth" | "usdg";
}

const POOL_META_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];

/**
 * TVL in DOLLARS, not in "whatever token1 happens to be".
 *
 * Valuing a pool in its own token1 produces numbers that cannot be compared or even read — a
 * WETH/MANCER pool comes out as "166,416,858", which is memecoin units, not money. Every listed pool
 * pairs against a hub (WETH or USDG), so both legs are priced into the HUB leg using the pool's own
 * price, then the hub is converted once: USDG is a dollar, WETH uses the live ETH price.
 *
 * `price` is token1-per-token0, as read from the pool's own sqrtPriceX96 — no external feed.
 */
export function tvlUsd(args: {
  reserve0: number;
  reserve1: number;
  price: number;
  hubIsToken0: boolean;
  hubIsUsdg: boolean;
  ethUsd: number;
}): number {
  const { reserve0, reserve1, price, hubIsToken0, hubIsUsdg, ethUsd } = args;
  if (!Number.isFinite(price) || price <= 0) return 0;
  // Value the non-hub leg into hub units, then add the hub leg.
  const inHub = hubIsToken0
    ? reserve0 + reserve1 / price // token1 -> token0(hub)
    : reserve0 * price + reserve1; // token0 -> token1(hub)
  if (!Number.isFinite(inHub) || inHub <= 0) return 0;
  const usd = hubIsUsdg ? inHub : inHub * ethUsd;
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

let _cache: { at: number; rows: LivePool[] } | null = null;

/**
 * Load the top `limit` pools by real indexed depth, newest metadata first.
 *
 * Fails SOFT: if the registry is unreachable the caller still gets the flagship WETH/USDG pool via
 * `fallback`, so the pools surface degrades to "fewer pools" and never to "a wrong pool".
 */
export async function loadLivePools(
  provider: ethers.Provider,
  limit = 24,
  ttlMs = 60_000,
): Promise<LivePool[]> {
  const now = Date.now();
  if (_cache && now - _cache.at < ttlMs) return _cache.rows;

  const client = sb();
  if (!client) return _cache?.rows ?? [];

  const { data, error } = await client
    .from("mp_tokens")
    .select("address,symbol,name,decimals,logo_url,liquidity,pool,pool_hub")
    .eq("verified", true)
    .not("pool", "is", null)
    .not("liquidity", "is", null)
    .order("liquidity", { ascending: false })
    .limit(limit);

  if (error || !data?.length) return _cache?.rows ?? [];

  // One pool can be the deepest pool for more than one token (USDG and WETH both point at the
  // flagship pair). Keep the first — the list is already ordered by depth.
  const seen = new Set<string>();
  const candidates = data.filter((r: any) => {
    const p = String(r.pool || "").toLowerCase();
    if (!p || seen.has(p)) return false;
    seen.add(p);
    return true;
  });

  const settled = await Promise.allSettled(
    candidates.map(async (row: any) => {
      const poolAddr = String(row.pool);
      const c = new ethers.Contract(poolAddr, POOL_META_ABI, provider);
      // Read ordering and fee from the POOL, never assume them.
      const [t0, t1, fee] = await Promise.all([c.token0(), c.token1(), c.fee()]);

      const hubKey: "weth" | "usdg" = String(row.pool_hub || "weth").toLowerCase() === "usdg" ? "usdg" : "weth";
      const hub = HUBS[hubKey];

      const token: TokenInfo = {
        address: ethers.getAddress(String(row.address)),
        symbol: row.symbol || "???",
        name: row.name || row.symbol || "Unknown",
        decimals: Number(row.decimals ?? 18),
        sourceChain: "Robinhood Chain",
        logoURI: row.logo_url || "",
        swappable: true,
      };

      // Whichever of the two legs matches token0 on-chain becomes token0 here.
      const t0lc = String(t0).toLowerCase();
      const isTokenFirst = token.address.toLowerCase() === t0lc;
      const hubMatches = hub.address.toLowerCase() === t0lc || hub.address.toLowerCase() === String(t1).toLowerCase();
      if (!hubMatches) return null; // pool is not actually against the hub we were told — drop it

      const token0 = isTokenFirst ? token : hub;
      const token1 = isTokenFirst ? hub : token;

      const pool: PoolInfo = {
        address: poolAddr,
        token0: token0.address,
        token1: token1.address,
        fee: Number(fee),
        name: `${token0.symbol}/${token1.symbol}`,
      };

      return {
        pool,
        token0,
        token1,
        liquidityWeth: Number(row.liquidity) || 0,
        hub: hubKey,
      } as LivePool;
    }),
  );

  const rows = settled
    .filter((r): r is PromiseFulfilledResult<LivePool | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter(Boolean) as LivePool[];

  if (!rows.length) return _cache?.rows ?? [];
  _cache = { at: now, rows };
  return rows;
}
