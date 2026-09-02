"use client";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NavBar, BackgroundImage, MoleMascot } from "../shared";
import { RefreshCw, Plus, Minus, ArrowUpRight, ChevronDown, AlertTriangle, Loader2 } from "lucide-react";
import { useWalletContext, useChainClient, WalletUI } from "@/lib/chain/provider";
import { useWallet } from "@/lib/chain/provider";
import { loadLivePools, tvlUsd as calcTvlUsd } from "@/lib/chain/livePools";
import {
  CONTRACTS, TOKENS,
  getTokenByAddress,
  getSwapQuote,
  getPoolDisplayInfo,
  AMM_ROUTER, AMM_FACTORY, RH_CHAIN_ID,
  type TokenInfo, type PoolInfo,
} from "@/lib/chain/amm";
// The chain the wallet is ACTUALLY on, and everything that has to be resolved from it: which pools to
// ask for, which RPC to read, which pool a position lives in, and where to offer a switch. See
// lib/mole/poolsSurface.ts for why every one of those used to be a Robinhood constant.
import { SUPPORTED_CHAINS, chainMetaFor, contractsFor } from "@/lib/chain/chains";
import {
  poolsChainView,
  poolsProvider,
  readSlot0,
  pairForPoolId,
  vaultPoolFor,
  type ListedPool,
  type PoolPair,
} from "@/lib/mole/poolsSurface";
import { ethers } from "ethers";
import { createClient } from "@/lib/supabase/client";
import { ProvenanceCard } from "./ProvenanceCard";
import { PoolActivityPanel } from "@/components/PoolActivity";
// Which engine can serve a pool is decided from its hook ADDRESS (== MoleHook or not), read from the
// key — never from the registry label. Provide / Queue are offered only on MoleHook-served pools.
import { poolServiceTag, engineActionsAllowed, SERVICE_TAG_LABEL, type PoolServiceTag } from "@/lib/mole/hookBitmap";
// One-sided deposit option in the add-liquidity modal: range/width math comes from the shared
// singleSided module (the same one lib/chain/amm.addLiquidityOneSided signs with) — never re-derived.
import { LIVE_POOL_KEY } from "@/lib/mole/chain";
// The live pool's deposit panel shows the hook's TWAP with its age through the ONE staleness helper;
// a deposit priced around a mid nobody has observed for hours should say so, in the same words everywhere.
import { useOracleHealth } from "@/lib/mole/useOracleHealth";
import { OracleStaleBadge } from "../shared/OracleStale";
import {
  computeOneSidedRange,
  MIN_RANGE_WIDTH,
  MAX_RANGE_WIDTH,
  TIGHT_WIDTH_TICKS,
  type OneSidedPreset,
  type OneSidedSide,
} from "@/lib/mole/singleSided";

/**
 * Real 24h volume + fees per pool from the swap-event indexer (mp_pool_volume_24h, read with the anon
 * key — public data).
 *
 * KEY CONTRACT (this used to be wrong, and silently zeroed volume/fees/APY for every pool). The one key
 * shared by writer and reader is `mp_pools.id`, lowercased:
 *   - v3 pools: `id` IS the 20-byte pool address, which is what the indexer writes
 *     (`pool: lc(l.address)` in services/indexer/src/index.mjs refreshVolume).
 *   - v4 pools: `id` IS the 32-byte PoolId; a v4 pool has no address at all.
 * So the caller must pass every identity a pool has — its PoolId AND its address where it has one — and
 * look the result up under either. Passing only one of the two is what made the join impossible.
 *
 * Empty on any error, so the pools page still renders (volume shows as "—", never a fabricated number).
 */
async function fetchPoolVolumes(poolKeys: string[]): Promise<Map<string, { vol: number; fees: number; swaps: number }>> {
  const out = new Map<string, { vol: number; fees: number; swaps: number }>();
  const keys = Array.from(new Set(poolKeys.filter(Boolean).map((k) => k.toLowerCase())));
  if (!keys.length) return out;
  try {
    const sb = createClient();
    const { data } = await sb
      .from("mp_pool_volume_24h")
      .select("pool,volume_usd,fees_usd,swaps")
      .in("pool", keys);
    for (const r of (data as any[]) || []) {
      out.set((r.pool as string).toLowerCase(), {
        vol: Number(r.volume_usd) || 0,
        fees: Number(r.fees_usd) || 0,
        swaps: Number(r.swaps) || 0,
      });
    }
  } catch (err) {
    console.error("Failed to fetch pool volumes:", err);
  }
  return out;
}

/**
 * Build a /dapp URL that pre-selects `from` → `to` ON THE CHAIN THE POOL IS ON. Used by the
 * zero-balance CTA in PoolDetail — if the user lacks one of a pool's tokens,
 * clicking "GET X" takes them to the swap page with the route already wired.
 *
 * The chain id is a PARAMETER and no longer `RH_CHAIN_ID`. Handing the swap page a Robinhood chain id
 * with two Arc token addresses does not fail loudly — it asks for a pair that does not exist on the
 * chain named, and the user is left looking at a broken route with no way to tell which half is wrong.
 */
function getSwapUrl(fromAddress: string, toAddress: string, chainId: number): string {
  const cid = String(chainId);
  const params = new URLSearchParams({ from: fromAddress, fromChainId: cid, to: toAddress, toChainId: cid });
  return `/dapp?${params.toString()}`;
}

const fmtFee = (n: number): string => {
  if (n === 0) return "0.00";
  return n.toFixed(20).replace(/\.?0+$/, "");
};

/**
 * A pool's fee, as a label.
 *
 * Every MoleSwap v4 pool is created with the DYNAMIC-FEE SENTINEL in its key (0x800000, the top bit of
 * the uint24 fee field) — the LP fee is set by MoleHook per swap, not fixed in the pool key. Dividing
 * that sentinel by 10 000 like a static fee tier prints "838.86%", which is what every pool row and the
 * pool detail header showed. It is not a fee, it is a flag. /api/v1/pools already reports these pools as
 * `feeTier: "dynamic"`; this says the same thing in the UI. Static-fee pools are unaffected.
 */
const DYNAMIC_FEE_FLAG = 0x800000;
const feeLabel = (fee: number): string =>
  (Number(fee) & DYNAMIC_FEE_FLAG) !== 0 ? "DYNAMIC" : `${(Number(fee) / 10000).toFixed(2)}%`;

/**
 * A deposited amount as text. "..." = not computed yet; "—" = the pool's tick could not be read, so
 * there is no honest number to print. Never a figure derived from a price the pool has never had.
 */
const amtText = (n: number | undefined) =>
  n === undefined ? "..." : Number.isFinite(n) ? n.toFixed(n < 0.01 ? 6 : 4) : "—";

/** Sum, skipping anything that is not a real number — an unknown amount must not poison a total. */
const sumFinite = (xs: number[]) => xs.reduce((s, x) => (Number.isFinite(x) ? s + x : s), 0);

const fmt = (n: number) => {
  if (!Number.isFinite(n) || isNaN(n)) return "0.00";
  if (n < 0) return "0.00";
  if (n >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  if (n < 0.01 && n > 0) return n.toExponential(2);
  return n.toFixed(2);
};

/**
 * Robinhood keeps the magenta this page has always drawn it in (its `.chainb` default); every other
 * supported chain is tinted with the accent the chain switcher in the chrome already uses for it, so a
 * badge and the switcher cannot disagree about which chain the user is looking at.
 */
const chainColors: Record<string, string> = {
  "Robinhood Chain": "#D548EC",
};
for (const c of SUPPORTED_CHAINS) if (!chainColors[c.name]) chainColors[c.name] = c.accent;

/* Coin-chip colors for tokens without a real remote logo (Burrow palette). */
const COIN_COLORS: Record<string, string> = {
  ETH: "#6f7ce0",
  WETH: "#627eea",
  USDG: "#1c74d4",
};
const coinColor = (symbol: string) => COIN_COLORS[symbol?.toUpperCase()] || "#8a5c33";

const USDG_LC = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

/* Annualising a day of fees over a pool holding a few dollars produces numbers like 838% that are
   arithmetic, not yield. Below this the APY column shows "—". */
const APY_MIN_TVL_USD = 1000;

const CATEGORIES = [
  { key: "all", label: "All" },
  { key: "mains", label: "Mains" },
  { key: "memes", label: "Memes" },
  { key: "stocks", label: "Stocks" },
  { key: "stables", label: "Stables" },
] as const;

interface PoolDisplay {
  name: string;
  token0: TokenInfo;
  token1: TokenInfo;
  pool: PoolInfo;
  fee: number;
  tvl: number;
  reserve0: string;
  reserve1: string;
  /** token1 per token0, decimal-adjusted. 0 only when the pool has no usable sqrt price. */
  price: number;
  /** Current tick from the pool's own slot0 — seeds the liquidity chart before the live read lands. */
  tick: number;
  liquidity: string;
  feeApy: number;
  vol24h: number;
  fees24h: number;
  category?: string;
  active: boolean;
  /** The key's hook address as registered (null if the row has none). */
  hooks: string | null;
  /** The key's tickSpacing (null if the row has none). */
  tickSpacing: number | null;
  /** molehook | foreign-v4 | v3 — from the hook address, never from the venue label. */
  serviceTag: PoolServiceTag;
}

/* The v3 pool ABI that used to sit here moved into lib/mole/poolsSurface with `readSlot0`, which is
   the only thing that ever used it — and which now reads it on the chain the pool is actually on. */

const ERC20_BAL_ABI = [
  "function balanceOf(address account) view returns (uint256)",
];

/**
 * price = how many whole token1 one whole token0 buys, from the pool's own sqrt price.
 *
 * (sqrtPriceX96 / 2^96)^2 is token1 BASE UNITS per token0 base unit, so it has to be rescaled by
 * 10^(decimals0 - decimals1) to become a human price. Skipping that on a 6-vs-18 pair is a 10^12 error,
 * so the adjustment is not optional. PRECISION is 1e36 rather than 1e18 because the base-unit ratio of
 * an 18-dec token0 against a 6-dec token1 is ~1e-9 for a $3k asset — 1e18 of headroom is thin, and
 * anything under 1e-18 would truncate to a flat zero, which is exactly the bug this replaces.
 */
function sqrtPriceToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  if (sqrtPriceX96 <= 0n) return 0;
  const PRECISION = 10n ** 36n;
  const Q192 = 2n ** 192n;
  const sqr = sqrtPriceX96 * sqrtPriceX96;
  const rawPrice = (sqr * PRECISION) / Q192; // token1 base units per token0 base unit, × 1e36
  const decimalAdj = decimals0 - decimals1;
  const price = (Number(rawPrice) / 1e36) * (10 ** decimalAdj);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

/** JSON carries uint160 as a decimal string; a malformed one must not take the whole page down. */
function safeBigInt(v: unknown): bigint {
  try {
    if (typeof v === "bigint") return v;
    if (v === null || v === undefined || v === "") return 0n;
    return BigInt(v as string | number);
  } catch {
    return 0n;
  }
}

/**
 * Live slot0 for either flavour of pool now lives in lib/mole/poolsSurface as `readSlot0(chainId, id)`.
 * It moved because the reader here built its provider from `getProvider()`, which is pinned to Robinhood
 * — so on Arc it asked Robinhood's StateView about an Arc PoolId, got nothing back, and the page kept
 * whatever tick it already had without ever saying the read had failed.
 */

function calcTvl(reserve0: number, reserve1: number, price: number): number {
  if (!Number.isFinite(price) || price <= 0) return reserve1 * 2;
  const val0InToken1 = reserve0 * price;
  const tvl = val0InToken1 + reserve1;
  if (!Number.isFinite(tvl) || tvl < 0) return reserve1 * 2;
  return tvl;
}

/**
 * MoleSwap's own pools ON ONE CHAIN.
 *
 * `chainId` is threaded into the query because /api/v1/pools has been chain-scoped for a while and this
 * page never said which chain it meant — so it always got the default, Robinhood, and rendered it under
 * whatever chain the switcher in the chrome happened to be showing. The endpoint refuses an unknown
 * chain by name rather than answering for Robinhood, so a bad id surfaces as an error here instead of as
 * another chain's pools wearing this chain's label.
 */
async function fetchPoolData(chainId: number): Promise<PoolDisplay[]> {
  // MoleSwap's own v4 pools, priced server-side. A v4 pool has no address to call slot0() on and no
  // per-pool token balance — its state lives in the PoolManager singleton keyed by PoolId, and its
  // TVL is derived from the open positions. That work belongs in one place, so this page consumes
  // /api/v1/pools rather than reimplementing it against a pool address that does not exist.
  const res = await fetch(`/api/v1/pools?chainId=${chainId}`, { cache: "no-store" });
  // Throw rather than return []: an empty array is the caller's "this venue has no pools" answer, and a
  // 429/500 must not be dressed up as that. loadPools() catches, logs, and keeps whatever list is
  // already on screen instead of blanking it.
  if (!res.ok) throw new Error(`/api/v1/pools responded ${res.status}`);
  const json = await res.json();
  const pools: any[] = json?.data?.pools || [];
  // The chain NAMES ITSELF in the response. Taken from there rather than from a constant so a token's
  // `sourceChain` — which is what every chain badge on this page renders — can never say one chain while
  // the addresses beside it belong to another.
  const sourceChain: string = json?.data?.chain || chainMetaFor(chainId)?.name || `chain ${chainId}`;
  if (!pools.length) return [];

  // Real 24h volume/fees where the indexer has them, keyed by mp_pools.id (see fetchPoolVolumes). Pass
  // both identities a pool can carry — the v4 PoolId and, for an address-backed pool, its address —
  // because the indexer keys its rows on whichever of the two is that pool's `id`.
  let volumes = new Map<string, { vol: number; fees: number }>();
  try {
    volumes = await fetchPoolVolumes(pools.flatMap((p) => [p.poolId, p.address].filter(Boolean)));
  } catch { /* volume is optional — a pool with no indexed swaps shows "—", never a made-up number */ }

  return pools.map((p) => {
    const t0: TokenInfo = {
      address: p.token0.address, symbol: p.token0.symbol, name: p.token0.name,
      decimals: p.token0.decimals, sourceChain, logoURI: p.token0.logoURI || "",
    } as TokenInfo;
    const t1: TokenInfo = {
      address: p.token1.address, symbol: p.token1.symbol, name: p.token1.name,
      decimals: p.token1.decimals, sourceChain, logoURI: p.token1.logoURI || "",
    } as TokenInfo;

    const vlm =
      volumes.get(String(p.poolId).toLowerCase()) ??
      (p.address ? volumes.get(String(p.address).toLowerCase()) : undefined);
    const vol24h = vlm?.vol ?? 0;
    const fees24h = vlm?.fees ?? 0;
    const tvl = Number(p.tvlUsd) || 0;

    // The single most important number on a pool page. /api/v1/pools already carries the pool's own
    // sqrtPriceX96 (livePools.ts reads it from StateView), so the price is derivable here exactly —
    // it was being thrown away and replaced with a hardcoded 0.
    const price = sqrtPriceToPrice(safeBigInt(p.sqrtPriceX96), t0.decimals, t1.decimals);

    return {
      name: p.name,
      token0: t0,
      token1: t1,
      pool: { address: p.poolId, token0: t0.address, token1: t1.address, fee: p.fee, name: p.name },
      fee: p.fee,
      category: p.category,
      tvl,
      reserve0: Number(p.reserve0).toFixed(6),
      reserve1: Number(p.reserve1).toFixed(6),
      price,
      tick: Number(p.tick) || 0,
      liquidity: String(p.liquidity),
      feeApy: tvl >= APY_MIN_TVL_USD && fees24h > 0 ? (fees24h / tvl) * 365 * 100 : 0,
      vol24h,
      fees24h,
      active: !!p.hasLiquidity,
      hooks: typeof p.hooks === "string" ? p.hooks : null,
      tickSpacing: Number.isFinite(Number(p.tickSpacing)) && p.tickSpacing !== null && p.tickSpacing !== undefined ? Number(p.tickSpacing) : null,
      // A v4 row (PoolId identity) is MoleHook-served only if its hook IS MoleHook; an unknown hook on a
      // PoolId-identified row is foreign v4, fail-closed — it never earns Provide / Queue by default.
      // Tagged against THIS chain's MoleHook. Arc's hook is a different address from Robinhood's (its
      // low 14 bits are mined, so it cannot be the same one), and without the chain the check compared
      // every pool against Robinhood's — which made MoleSwap's own live Arc pool read as "Foreign hook"
      // and stripped its Provide action.
      serviceTag: poolServiceTag({ venue: "mole_v4", hooks: typeof p.hooks === "string" ? p.hooks : null }, chainId),
    } as PoolDisplay;
  });
}

const Badge = ({ chain }: { chain: string }) => {
  const c = chainColors[chain] || "#D548EC";
  return (
    <span
      className="chainb"
      style={chain !== "Robinhood Chain" ? { color: c, background: c + "22", borderColor: c + "40" } : undefined}
    >
      {chain}
    </span>
  );
};

const TokenIcon = ({ token, size = 28 }: { token: TokenInfo; size?: number }) => {
  const [err, setErr] = useState(false);
  if (err || !token.logoURI) {
    // Coin-chip fallback — the Burrow drawn token mark, no image asset needed.
    return (
      <span
        className="coin"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.33), background: coinColor(token.symbol) }}
      >
        {token.symbol.slice(0, 2)}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={token.logoURI}
      alt={token.symbol}
      width={size}
      height={size}
      className="coin"
      style={{ width: size, height: size, objectFit: "cover", background: "#fff" }}
      onError={() => setErr(true)}
    />
  );
};

const TokenPair = ({ t0, t1, size = 28 }: { t0: TokenInfo; t1: TokenInfo; size?: number }) => (
  <span className="coins">
    <TokenIcon token={t0} size={size} />
    <TokenIcon token={t1} size={size} />
  </span>
);

const PoolsPage = () => (
  <>
    <BackgroundImage />
    <NavBar />
    <PoolsContent />
  </>
);

export default PoolsPage;

interface LiquidityPosition {
  tokenId: number;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  tokensOwed0: string;
  tokensOwed1: string;
  token0Info?: TokenInfo;
  token1Info?: TokenInfo;
  poolInfo?: PoolInfo;
  /**
   * The v4 PoolId this position is actually in, and the chain it was read from.
   *
   * Both used to be implicit, and both were wrong the moment a second chain existed: every ALM position
   * was labelled with the first pool in the Robinhood registry, so a CASHCAT/WETH position on Robinhood
   * read as WETH/USDG and an Arc position read as a Robinhood one. The id is what `pairForPoolId` joins
   * on; the chain is what the exit is sent to and what the switch prompt names.
   */
  poolId?: string;
  chainId?: number;
  /** The pool's current tick, when known — what the deposited amounts are computed at. */
  poolTick?: number | null;
}

/* Page-scoped Burrow styles (mirrors the pools.html prototype's style block). */
const POOLS_CSS = `
.foot-cap { margin: 34px 0 0; text-align: center; font-size: 12px; font-weight: 700;
  letter-spacing: .14em; text-transform: uppercase; color: var(--p-onbg-3); }
.seg button[aria-selected="true"] {
  background: linear-gradient(180deg, #ffcd7d, var(--amber));
  box-shadow: 0 2px 0 rgba(140,74,20,.6), inset 0 1px 0 rgba(255,255,255,.55); }

/* markets loading */
.load-block { padding: 52px 20px; text-align: center; }
.ldr { width: 32px; height: 32px; border-radius: 50%; border: 4px solid var(--amber);
  border-top-color: transparent; animation: rot 1s linear infinite; margin: 0 auto 14px; }
.load-block .t1 { font-weight: 800; font-size: 15px; color: var(--clay); letter-spacing: .03em; }
.load-block .t2 { margin-top: 4px; font-size: 12.5px; color: var(--ink-3); }

/* row "+ Liquidity" button (green, like the original) */
.liq-btn { justify-self: end; display: inline-flex; align-items: center; gap: 4px; text-decoration: none;
  font-size: 11.5px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: #fff;
  background: linear-gradient(180deg, #43a06a, var(--moss)); padding: 8px 12px; border-radius: 11px;
  box-shadow: 0 2px 0 #1e5837, inset 0 1px 0 rgba(255,255,255,.3); white-space: nowrap; }
.liq-btn:active { transform: translateY(1px); box-shadow: 0 1px 0 #1e5837, inset 0 1px 0 rgba(255,255,255,.3); }
@media (max-width: 780px) {
  .thead { display: none; }
  .thead, .row { grid-template-columns: minmax(120px, 1.5fr) 1fr 96px; }
}
/* Below ~560px the three-column row cannot hold the pair, the numbers and the button side by side:
   measured at 390px the pair cell had 120px for 218px of content. Stack it instead of squeezing —
   the pair gets the full width and the numbers sit under it as a labelled row. */
@media (max-width: 560px) {
  .thead, .row { grid-template-columns: 1fr; gap: 10px; }
  .row .nums { display: flex; flex-wrap: wrap; gap: 14px; }
  .row .liq-btn { justify-self: stretch; justify-content: center; }
  .pair .pnames { min-width: 0; }
  .pair .pnames b, .pair .pnames span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
}

/* pool detail */
.backlink { background: none; border: 0; cursor: pointer; font: inherit; padding: 0;
  color: #ffcd7d; font-weight: 800; font-size: 13px; letter-spacing: .04em; }
.backlink:hover { color: #ffe6c4; }
.det-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 14px 0 18px; }
.det-head h2 { margin: 0; font-size: 1.5rem; font-weight: 800; letter-spacing: -.02em; color: var(--p-onbg); }
.sm-lbl { font-size: 10.5px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
.sm-val { margin-top: 8px; font-family: var(--font-num); font-variant-numeric: tabular-nums;
  font-size: 1.25rem; font-weight: 700; letter-spacing: -.02em; }
.sm-val.pos { color: var(--moss); } .sm-val.neg { color: var(--rust); }
.dp { margin-top: 12px; font-size: 1.15rem; font-weight: 700; letter-spacing: -.02em; }

/* liquidity distribution graph */
.lg-wrap { position: relative; margin-top: 16px; }
.lg-wash { position: absolute; left: 5%; right: 5%; top: 0; bottom: 0; background: rgba(47,125,79,.07); border-radius: 6px; }
.lg-line { position: absolute; top: -4px; bottom: -2px; width: 2px; background: var(--amber);
  box-shadow: 0 0 8px rgba(240,160,60,.85); z-index: 2; border-radius: 2px; }
.lg-bars { position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 2px; }
.lg-bar { flex: 1; position: relative; height: 100%; display: flex; align-items: flex-end; cursor: crosshair; }
.lg-bar i { display: block; width: 100%; min-height: 2px; border-radius: 3px 3px 0 0; background: var(--moss);
  transition: background .1s ease, opacity .1s ease; }
.lg-bar:hover i { background: #43a06a; }
.lg-bar.cur i { background: var(--amber); box-shadow: 0 0 6px rgba(240,160,60,.9); }
.lg-tip { position: absolute; bottom: 100%; z-index: 5; pointer-events: none;
  background: rgba(42,24,10,.95); border: 1px solid var(--amber); border-radius: 10px; padding: 8px 10px;
  font-size: 11px; line-height: 1.5; white-space: nowrap; box-shadow: var(--sh-1); }
.lg-tip .l1 { color: #ffd47a; font-family: var(--font-num); font-weight: 700; }
.lg-tip .l2 { color: rgba(255,240,214,.85); font-family: var(--font-num); }
.lg-tip .l3 { color: #7ec98f; font-weight: 700; letter-spacing: .05em; }
.lg-foot { display: flex; justify-content: space-between; gap: 8px; margin-top: 10px;
  font-family: var(--font-num); font-size: 11.5px; color: var(--ink-3); flex-wrap: wrap; }
.lg-foot .in { color: var(--moss); font-weight: 700; }

/* detail actions */
.act-row { display: flex; gap: 10px; flex-wrap: wrap; }
.act-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  text-decoration: none; border: 0; cursor: pointer; font: inherit; font-size: 13px; font-weight: 800;
  letter-spacing: .05em; text-transform: uppercase; padding: 14px 16px; border-radius: 14px; white-space: nowrap; }
.act-btn.add { background: linear-gradient(180deg, #43a06a, var(--moss)); color: #fff;
  box-shadow: 0 3px 0 #1e5837, inset 0 1px 0 rgba(255,255,255,.35); }
.act-btn.rem { background: linear-gradient(180deg, #ffcd7d, var(--amber)); color: #3d2410;
  box-shadow: 0 3px 0 #8c4a14, inset 0 1px 0 rgba(255,255,255,.5); }
.act-btn:active { transform: translateY(1px); }

/* positions */
.mole2 { display: block; width: 92px; height: 92px; margin: 0 auto 8px; position: static; }
.pc-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.glowdot { width: 7px; height: 7px; border-radius: 50%; background: var(--moss);
  box-shadow: 0 0 6px var(--moss); display: inline-block; }
.exit2 { border: 0; cursor: pointer; font: inherit; font-size: 12px; font-weight: 800;
  letter-spacing: .06em; text-transform: uppercase; color: #fff;
  background: linear-gradient(180deg, #d9584a, var(--rust)); padding: 10px 18px; border-radius: 12px;
  box-shadow: 0 2px 0 #7e2415, inset 0 1px 0 rgba(255,255,255,.35); }
.exit2:disabled { opacity: .5; cursor: default; }
.exit2:not(:disabled):active { transform: translateY(1px); box-shadow: 0 1px 0 #7e2415; }
.pos-load .t1 { font-weight: 800; font-size: 15px; color: var(--clay); letter-spacing: .03em; }

/* modals */
.m-lbl { display: flex; align-items: center; gap: 10px; margin: 16px 0 4px;
  font-size: 11px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; color: var(--ink-3); }
.m-lbl::after { content: ""; flex: 1; height: 1px; background: rgba(44,26,12,.12); }
.tot-box { margin-top: 6px; padding: 12px 13px; border-radius: var(--r-md); text-align: center;
  background: rgba(255,255,255,.55); border: 1px solid rgba(44,26,12,.12);
  font-family: var(--font-num); font-weight: 700; font-size: 14.5px; letter-spacing: -.01em; }
.warnbox { margin-top: 14px; padding: 12px 14px; border-radius: var(--r-md); font-size: 12px; line-height: 1.55;
  background: rgba(240,160,60,.12); border: 1px solid rgba(240,160,60,.35); color: var(--ink-2); }
.m-actions { display: flex; gap: 10px; margin-top: 16px; }
.m-btn { flex: 1; height: 46px; border: 0; border-radius: 14px; cursor: pointer; font: inherit;
  font-size: 13px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; }
.m-btn.cancel { background: rgba(44,26,12,.08); color: var(--ink-2); border: 1px solid rgba(44,26,12,.12); }
.m-btn.danger { background: linear-gradient(180deg, #d9584a, var(--rust)); color: #fff;
  box-shadow: 0 3px 0 #7e2415, inset 0 1px 0 rgba(255,255,255,.3); }
.m-btn.amber { background: linear-gradient(180deg, #ffcd7d, var(--amber)); color: #3d2410;
  box-shadow: 0 3px 0 #8c4a14, inset 0 1px 0 rgba(255,255,255,.5); }
.m-btn:disabled { opacity: .5; cursor: default; }
.m-btn:not(:disabled):active { transform: translateY(1px); }
`;

/**
 * What the page renders where a list of pools would go, when the wallet is on a chain MoleSwap runs no
 * pools on.
 *
 * Copied in shape and in wording from the vault screen's `NoVaultHere`, deliberately: the two screens
 * refuse for the same reason and should refuse in the same voice. The switch is OFFERED rather than
 * performed — silently moving a wallet to another network is the app deciding where somebody's money
 * lives — but it IS offered, which is the whole gap this closes. Before this, a user on Arc got the
 * refusal sentence and no button.
 */
const NoPoolsHere = ({ chainName, chains, onSwitch, busy }: {
  chainName: string; chains: { id: number; name: string; shortName: string }[];
  onSwitch: (id: number) => void; busy: boolean;
}) => (
  <div className="p-card" data-testid="no-pools-here">
    <h3>Not on this network</h3>
    <p className="d" style={{ marginTop: 10 }}>
      MoleSwap runs no pools on {chainName}. They live on{" "}
      {chains.map((c) => c.name).join(" and ")} — switch there to provide liquidity, or stay here and use Swap.
    </p>
    <div className="p-chipset" style={{ marginTop: 14 }}>
      {chains.map((c) => (
        <button key={c.id} data-testid={`switch-to-${c.id}`} onClick={() => onSwitch(c.id)} disabled={busy}>
          SWITCH TO {c.shortName.toUpperCase()}
        </button>
      ))}
    </div>
  </div>
);

const PoolsContent = () => {
  const walletCtx = useWalletContext();
  const { chainClient } = useChainClient();
  const isConnected = walletCtx?.connectionStatus === WalletUI.CONSTANTS.CONNECTION.STATUS.CONNECTED;
  const { address, chainId, switchTo } = useWallet();

  // Everything on this page is about ONE chain: the one the wallet is on. `live` is false where MoleSwap
  // runs no pools, and that is rendered as an explanation with a switch button rather than as an empty
  // list — "No pools found" on Arc read as "MoleSwap has nothing here", which was never true.
  const chain = useMemo(() => poolsChainView(chainId), [chainId]);
  /**
   * The chain as of the LATEST render, readable from inside an awaited fetch.
   *
   * Without it a slow answer from the chain the user just left wins the race against the fast answer
   * from the chain they are on: switch Arc → Robinhood while the Arc pool list is in flight and it
   * lands afterwards, putting Arc's pools under Robinhood's header. Every setState below is gated on
   * this still matching the chain the request was made for.
   */
  const chainRef = useRef(chain.chainId);
  chainRef.current = chain.chainId;
  const [switching, setSwitching] = useState(false);
  const switchChain = useCallback(async (id: number) => {
    setSwitching(true);
    try {
      await switchTo(id);
    } finally {
      setSwitching(false);
    }
  }, [switchTo]);

  const [tab, setTab] = useState<"markets" | "positions">("markets");
  const [selectedPool, setSelectedPool] = useState<PoolDisplay | null>(null);
  const [sort, setSort] = useState<"tvl" | "apy" | "vol">("tvl");
  const [category, setCategory] = useState("all");
  const [loading, setLoading] = useState(true);
  const [pools, setPools] = useState<PoolDisplay[]>([]);
  const [positions, setPositions] = useState<LiquidityPosition[]>([]);
  const [posLoading, setPosLoading] = useState(false);

  const loadPools = useCallback(async () => {
    // A chain with no pools has nothing to fetch, and asking anyway would be answered for Robinhood by
    // the endpoint's default. Empty the list first so no previous chain's rows survive the switch.
    if (!chain.live) {
      setPools([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const forChain = chain.chainId;
    try {
      const data = await fetchPoolData(forChain);
      if (chainRef.current !== forChain) return; // the wallet moved while this was in flight
      setPools(data);
    } catch (err) {
      console.error("Failed to fetch pool data:", err);
    } finally {
      setLoading(false);
    }
  }, [chain.live, chain.chainId]);

  const loadPositions = useCallback(async () => {
    if (!address) return;
    if (!chain.live) {
      setPositions([]);
      return;
    }
    setPosLoading(true);
    try {
      // The user's LP venue on every chain is the v4 ALM vault, and WHICH vault is a function of the
      // chain: 0x6746…536A on Robinhood, 0x8e6b…9D77 on Arc. This call used to pass no chain at all, so
      // `vault.ts` fell back to its Robinhood default and a wallet on Arc was shown Robinhood's
      // positions. The chain goes in explicitly now — `getAlmPositions` reads exactly that chain's vault.
      const { getAlmPositions } = await import("@/lib/mole/vault");
      const forChain = chain.chainId;
      const alm = await getAlmPositions(address, forChain);
      if (chainRef.current !== forChain) return; // ditto: never show one chain's positions on another
      // Stored with the PoolId the vault holds against each position and the chain it was read from.
      // The pair is joined on separately (see `labelledPositions`) so that a pool list arriving late
      // relabels the positions already on screen instead of leaving them anonymous.
      const mapped = alm.map((p) => ({
        tokenId: Number(p.id),
        poolId: p.poolId,
        chainId: forChain,
        token0: "",
        token1: "",
        fee: 0,
        poolTick: null,
        liquidity: p.liquidity.toString(),
        amount0: "0",
        amount1: "0",
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        tokensOwed0: "0",
        tokensOwed1: "0",
        isAlm: true,
      }));
      setPositions(mapped as any);
    } catch (err) {
      console.error("Failed to load positions:", err);
    } finally {
      setPosLoading(false);
    }
  }, [address, chain.live, chain.chainId]);

  /**
   * Each position labelled with ITS OWN pool, matched by PoolId against this chain's pool list.
   *
   * A position whose pool is not in the list keeps a null pair and renders as a bare id. That is the
   * point: the old code labelled EVERY position with the first pool in the Robinhood registry, so a
   * CASHCAT/WETH position read as WETH/USDG and every Arc position read as a Robinhood one — with the
   * other pool's decimals used to format the amounts underneath.
   */
  const labelledPositions = useMemo(() => {
    const listed: ListedPool[] = pools.map((p) => ({
      poolId: p.pool.address,
      token0: p.token0,
      token1: p.token1,
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      tick: p.tick,
    }));
    return positions.map((p) => {
      const pair: PoolPair | null = pairForPoolId(p.poolId, listed, p.chainId ?? chain.chainId);
      if (!pair) return p;
      return {
        ...p,
        token0: pair.token0.address,
        token1: pair.token1.address,
        token0Info: { ...pair.token0, sourceChain: chain.name } as TokenInfo,
        token1Info: { ...pair.token1, sourceChain: chain.name } as TokenInfo,
        fee: pair.fee,
        poolTick: pair.tick,
      };
    });
  }, [positions, pools, chain.chainId, chain.name]);

  useEffect(() => { loadPools(); }, [loadPools]);
  useEffect(() => { if (tab === "positions" && address) loadPositions(); }, [tab, address, loadPositions]);
  // A chain change invalidates BOTH lists at once. Clearing them here rather than waiting for the reload
  // is what stops Robinhood's positions being visible for a beat under an Arc header — the exact frame
  // in which somebody would click Exit on a position that does not exist on the chain they are on.
  useEffect(() => {
    setPools([]);
    setPositions([]);
    setSelectedPool(null);
  }, [chain.chainId]);

  const chains = useMemo(() => ["all", ...new Set(pools.map(p => p.token0.sourceChain))], [pools]);
  const filtered = pools.filter(p => category === "all" || p.category === category);
  const sorted = [...filtered].sort((a, b) =>
    sort === "tvl" ? b.tvl - a.tvl : sort === "apy" ? b.feeApy - a.feeApy : b.vol24h - a.vol24h
  );

  const totalTvl = pools.reduce((s, p) => s + p.tvl, 0);
  const totalVol24h = pools.reduce((s, p) => s + p.vol24h, 0);
  const deepestTvl = pools.length > 0 ? Math.max(...pools.map((p) => p.tvl)) : 0;

  return (
    <main>
      <style>{POOLS_CSS}</style>

      <header className="hero">
        <h1>Liquidity pools.</h1>
        <p className="sub">Pools created on MoleSwap — Uniswap v4, hook-enforced fees and a built-in TWAP oracle.</p>
        <MoleMascot />
      </header>

      <div className="toolbar" style={{ margin: "0 0 22px" }}>
        <div className="seg" role="tablist">
          {/* Clicking a tab while a pool is opened must also close the detail
              view — otherwise PoolDetail keeps rendering (see the `selectedPool
              ? <PoolDetail/> : …` below) and the tab switch looks like a dead
              click. `clearDetail()` drops the selected pool alongside the tab
              change so users can navigate between Markets/Positions from ANY
              pool's detail page. */}
          <button role="tab" aria-selected={tab === "markets"} onClick={() => { setTab("markets"); setSelectedPool(null); }}>
            Markets
          </button>
          <button role="tab" aria-selected={tab === "positions"} onClick={() => { setTab("positions"); setSelectedPool(null); }}>
            Positions
          </button>
        </div>
      </div>

      {!chain.live ? (
        /* Neither tab can say anything true on a chain MoleSwap runs no pools on — so the page says
           that, and offers the switch, instead of rendering an empty market list under this chain's
           name and an empty position list that would have been another chain's. */
        <NoPoolsHere chainName={chain.name} chains={chain.alternatives} onSwitch={switchChain} busy={switching} />
      ) : selectedPool ? (
        <PoolDetail pool={selectedPool} onBack={() => setSelectedPool(null)} address={address} isConnected={isConnected} walletCtx={walletCtx} chainClient={chainClient} chainId={chain.chainId} chainName={chain.name} explorerUrl={chain.explorerUrl} />
      ) : tab === "markets" ? (
        <>
          <div className="stats" style={{ marginTop: 0 }}>
            {[
              { l: "Total value locked", v: loading ? "..." : `$${fmt(totalTvl)}` },
              { l: "Deepest pool", v: loading ? "..." : `$${fmt(deepestTvl)}` },
              { l: "Active pools", v: loading ? "..." : `${pools.filter(p => p.active).length}/${pools.length}` },
              { l: "24h volume", v: loading ? "..." : `$${fmt(totalVol24h)}` },
            ].map((s, i) => (
              <div key={i} className="chamber">
                <div className="label">{s.l}</div>
                <div className="value mono">{s.v}</div>
              </div>
            ))}
          </div>

          <div className="toolbar">
            <div className="p-chipset" aria-label="Filter by asset type">
              {CATEGORIES.map(c => {
                const n = c.key === "all" ? pools.length : pools.filter(p => p.category === c.key).length;
                return (
                  <button
                    key={c.key}
                    onClick={() => setCategory(c.key)}
                    data-on={category === c.key ? "true" : "false"}
                    disabled={n === 0 && c.key !== "all"}
                  >
                    {c.label}{n > 0 && <span className="chip-n">{n}</span>}
                  </button>
                );
              })}
            </div>
            <span className="spacer" style={{ marginLeft: "auto" }} />
            <div className="p-chipset" aria-label="Sort pools">
              {([["tvl", "TVL"], ["vol", "VOL"], ["apy", "APY"]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setSort(k)} data-on={sort === k ? "true" : "false"}>
                  {l}
                </button>
              ))}
            </div>
            <button className="ctl" onClick={loadPools} aria-label="Refresh pools" style={{ width: 38, height: 38, padding: 0, justifyContent: "center" }}>
              <RefreshCw size={15} className={loading ? "spin" : ""} />
            </button>
          </div>

          <div className="panel">
            <div className="thead">
              <span>Pool</span>
              <span className="num-h">TVL</span>
              <span className="num-h col-vol">24h vol</span>
              <span className="num-h col-apy">APY</span>
              <span />
            </div>

            {loading ? (
              <div className="load-block">
                <div className="ldr" />
                <div className="t1">Reading on-chain data...</div>
                <div className="t2">Fetching from {chain.name}</div>
              </div>
            ) : sorted.length === 0 ? (
              <div className="empty">
                <div style={{ fontSize: 16, fontWeight: 800, color: "var(--ink-2)" }}>No pools found</div>
                <div style={{ marginTop: 5 }}>No active liquidity on-chain for this filter</div>
              </div>
            ) : (
              sorted.map((p) => (
                <div key={p.pool.address} className="row" onClick={() => setSelectedPool(p)}>
                  <div className="pair">
                    <TokenPair t0={p.token0} t1={p.token1} size={32} />
                    <div>
                      <div className="nm">{p.name}</div>
                      <div className="tag">
                        <Badge chain={p.token0.sourceChain} />
                        <span className="fee">{feeLabel(p.fee)}</span>
                        {/* MoleHook-served vs foreign, from the key's hook address (a row with no hook on
                            record is not guessed to be ours). */}
                        <span className="badge2" data-service-tag={p.serviceTag}>
                          {p.hooks ? SERVICE_TAG_LABEL[p.serviceTag] : "Hook unknown"}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="num">${fmt(p.tvl)}</div>
                  <div className="num col-vol" style={p.vol24h > 0 ? undefined : { color: "var(--ink-3)" }}>
                    {p.vol24h > 0 ? `$${fmt(p.vol24h)}` : "—"}
                  </div>
                  {p.feeApy > 0 ? (
                    <span className="apy col-apy">{p.feeApy.toFixed(p.feeApy >= 100 ? 0 : 1)}%</span>
                  ) : (
                    <div className="num col-apy" style={{ color: "var(--ink-3)" }}>—</div>
                  )}
                  {/* Provide is the vault, and the vault only admits MoleHook pools — offer it nowhere else.
                      Let the link go to the vault without also opening the detail view.

                      THE HREF PINS NO CHAIN, AND MUST NOT. /vault resolves its chain from
                      useWallet().chainId through vaultChainFor() — the same wallet chain this list was
                      built from — so the context survives the navigation by construction. Pinning a
                      chain in the URL would be the bug in reverse: a link written on Arc still saying
                      4663, or a link the vault ignores while the reader believes it was honoured. */}
                  {engineActionsAllowed(p.serviceTag) ? (
                    <Link href="/vault" className="liq-btn" data-chain-id={chain.chainId} onClick={(e) => e.stopPropagation()}>
                      + Liquidity
                    </Link>
                  ) : (
                    <span />
                  )}
                </div>
              ))
            )}
          </div>
        </>
      ) : (
        /* ═══ POSITIONS TAB ═══ */
        <PositionsTab
          positions={labelledPositions}
          loading={posLoading}
          isConnected={isConnected}
          walletCtx={walletCtx}
          chainClient={chainClient}
          address={address}
          chainId={chain.chainId}
          chainName={chain.name}
          chains={chain.alternatives}
          onSwitchChain={switchChain}
          switching={switching}
          onRefresh={loadPositions}
          onGoToMarkets={() => setTab("markets")}
        />
      )}

      <p className="foot-cap">Concentrated liquidity on {chain.name} — best execution via the MoleSwap aggregator</p>
    </main>
  );
};


// ═══ V3 MATH ═══
function getTokenAmounts(
  liquidity: bigint, tickLower: number, tickUpper: number, currentTick: number,
  decimals0: number, decimals1: number
): { amount0: number; amount1: number } {
  if (liquidity === 0n) return { amount0: 0, amount1: 0 };
  const sqrtPriceLower = Math.sqrt(1.0001 ** tickLower);
  const sqrtPriceUpper = Math.sqrt(1.0001 ** tickUpper);
  const sqrtPriceCurrent = Math.sqrt(1.0001 ** currentTick);
  const liq = Number(liquidity);
  let amount0 = 0, amount1 = 0;
  if (currentTick < tickLower) {
    amount0 = liq * (1 / sqrtPriceLower - 1 / sqrtPriceUpper);
  } else if (currentTick > tickUpper) {
    amount1 = liq * (sqrtPriceUpper - sqrtPriceLower);
  } else {
    amount0 = liq * (1 / sqrtPriceCurrent - 1 / sqrtPriceUpper);
    amount1 = liq * (sqrtPriceCurrent - sqrtPriceLower);
  }
  return { amount0: amount0 / (10 ** decimals0), amount1: amount1 / (10 ** decimals1) };
}

interface EnrichedPosition extends LiquidityPosition {
  amount0: number;
  amount1: number;
  currentTick: number;
  feeTier: string;
  poolAddress: string;
}

// ═══ LIQUIDITY DISTRIBUTION GRAPH ═══
/**
 * A SCHEMATIC of where a range sits around the current price — NOT a depth chart.
 *
 * The bar heights are a decorative taper around the current-price marker; they are not liquidity and
 * never were. What is real here is the position of the range edges and the price line relative to them,
 * which is what the add-liquidity flow needs to show. It used to be rendered as a standalone "Liquidity
 * distribution" card on the pool page, where it read as measured depth; that card is now
 * `PoolActivityPanel`, which decodes the pool's actual Swap events.
 */
const LiquidityGraph = ({ currentTick, tickLower, tickUpper, height = 80, price, token0Symbol, token1Symbol }: {
  currentTick: number; tickLower: number; tickUpper: number; height?: number;
  price?: number; token0Symbol?: string; token1Symbol?: string;
}) => {
  const [hovered, setHovered] = useState<number | null>(null);
  const bars = 24;
  const isFullRange = tickLower <= -887200 && tickUpper >= 887200;
  const currentPos = isFullRange ? 0.55 : Math.min(1, Math.max(0, (currentTick - tickLower) / (tickUpper - tickLower)));
  const peakIdx = Math.round(currentPos * (bars - 1));

  const getBarData = (i: number) => {
    const dist = Math.abs(i - peakIdx);
    const h = Math.max(8, 100 - dist * (100 / bars) * 1.5);
    const ratio = i / (bars - 1);
    const barPrice = price ? price * (0.5 + ratio * 1.0) : 0;
    const liq = h;
    return { h, barPrice, liq, inRange: !isFullRange ? (i >= 1 && i <= bars - 2) : true };
  };

  return (
    <div className="lg-wrap" style={{ height }}>
      <div className="lg-wash" />
      {!isFullRange && <div style={{ position: "absolute", top: 0, bottom: 0, left: "5%", width: 1, borderLeft: "1px dashed rgba(44,26,12,.4)" }} />}
      {!isFullRange && <div style={{ position: "absolute", top: 0, bottom: 0, right: "5%", width: 1, borderRight: "1px dashed rgba(44,26,12,.4)" }} />}
      <div className="lg-line" style={{ left: `${5 + currentPos * 90}%` }} />

      {/* NO PRICE, NO "LIQ %". Those two numbers were computed from the bar's index — a made-up price
          axis and the bar's own height — so the tooltip was reporting its own drawing back as data.
          Whether a point falls inside the selected range is the one thing this shape genuinely knows. */}
      {hovered !== null && height > 50 && (() => {
        const bd = getBarData(hovered);
        const leftPct = (hovered / (bars - 1)) * 100;
        return (
          <div className="lg-tip" style={{ left: `${Math.min(Math.max(leftPct, 15), 85)}%`, transform: "translateX(-50%) translateY(-4px)" }}>
            <div className="l3">{bd.inRange ? "IN RANGE" : "OUT OF RANGE"}</div>
          </div>
        );
      })()}

      <div className="lg-bars">
        {Array.from({ length: bars }).map((_, i) => {
          const bd = getBarData(i);
          const isCurrent = i === peakIdx;
          const isHov = hovered === i;
          return (
            <div
              key={i}
              className={`lg-bar${isCurrent ? " cur" : ""}`}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            >
              <i style={{ height: `${bd.h}%`, opacity: isCurrent ? 1 : isHov ? 0.9 : 0.5 + (bd.h / 200) }} />
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ═══ REMOVE LIQUIDITY MODAL ═══
const RemoveLiquidityModal = ({ pos, ep, t0, t1, fees0, fees1, onConfirm, onCancel, removing }: {
  pos: LiquidityPosition; ep?: EnrichedPosition; t0: TokenInfo; t1: TokenInfo;
  fees0: number; fees1: number; onConfirm: () => void; onCancel: () => void; removing: boolean;
}) => {
  // DYNAMIC, not "838.86%": every MoleSwap v4 pool carries the dynamic-fee sentinel in its key, and
  // dividing a flag by 10 000 prints a fee no pool ever charged. Same helper the rest of the page uses.
  const feeTier = feeLabel(pos.fee);
  const isFullRange = pos.tickLower <= -887200 && pos.tickUpper >= 887200;

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="cm-scrim" style={{ opacity: 1 }} onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="cm-panel">
        <div className="cm-head">
          <h2>Remove liquidity</h2>
          <button className="cm-x" onClick={onCancel} aria-label="Close">✕</button>
        </div>
        <div className="cm-body">
          <div className="pair">
            <TokenPair t0={t0} t1={t1} size={32} />
            <div>
              <div className="nm">{t0.symbol} / {t1.symbol}</div>
              <div className="tag mono">NFT #{pos.tokenId} · {feeTier} FEE · {isFullRange ? "FULL RANGE" : "CUSTOM"}</div>
            </div>
          </div>

          <div className="m-lbl">You will receive</div>
          <div className="p-rows">
            <div className="p-row">
              <span className="k" style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><TokenIcon token={t0} size={16} />{t0.symbol}</span>
              <span className="v">{amtText(ep?.amount0)}</span>
            </div>
            <div className="p-row">
              <span className="k" style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><TokenIcon token={t1} size={16} />{t1.symbol}</span>
              <span className="v">{amtText(ep?.amount1)}</span>
            </div>
          </div>

          <div className="m-lbl">Fees collected</div>
          <div className="p-rows">
            <div className="p-row">
              <span className="k">{t0.symbol} fees</span>
              {fees0 > 0
                ? <span className="v pos">+{fmtFee(fees0)}</span>
                : <span className="v" style={{ color: "var(--ink-3)" }}>0.00</span>}
            </div>
            <div className="p-row">
              <span className="k">{t1.symbol} fees</span>
              {fees1 > 0
                ? <span className="v pos">+{fmtFee(fees1)}</span>
                : <span className="v" style={{ color: "var(--ink-3)" }}>0.00</span>}
            </div>
          </div>

          <div className="m-lbl">Total estimated</div>
          <div className="tot-box">
            {ep && Number.isFinite(ep.amount0) && Number.isFinite(ep.amount1)
              ? `${(ep.amount0 + fees0).toFixed(4)} ${t0.symbol} + ${(ep.amount1 + fees1).toFixed(4)} ${t1.symbol}`
              : "..."}
          </div>

          <div className="warnbox">
            ⚠ Removing 100% of liquidity. Your NFT #{pos.tokenId} will be burned and all tokens + accrued fees returned to your wallet.
          </div>

          <div className="m-actions">
            <button className="m-btn cancel" onClick={onCancel}>Cancel</button>
            <button className="m-btn danger" onClick={onConfirm} disabled={removing}>
              {removing ? "Removing..." : "Confirm remove"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

// ═══ COLLECT FEES MODAL ═══
const CollectFeesModal = ({ pos, t0, t1, fees0, fees1, onConfirm, onCancel, collecting }: {
  pos: LiquidityPosition; t0: TokenInfo; t1: TokenInfo;
  fees0: number; fees1: number; onConfirm: () => void; onCancel: () => void; collecting: boolean;
}) => {
  // DYNAMIC, not "838.86%": every MoleSwap v4 pool carries the dynamic-fee sentinel in its key, and
  // dividing a flag by 10 000 prints a fee no pool ever charged. Same helper the rest of the page uses.
  const feeTier = feeLabel(pos.fee);
  const hasAny = fees0 > 0 || fees1 > 0;

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="cm-scrim" style={{ opacity: 1 }} onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="cm-panel">
        <div className="cm-head">
          <h2>Collect fees</h2>
          <button className="cm-x" onClick={onCancel} aria-label="Close">✕</button>
        </div>
        <div className="cm-body">
          <div className="pair">
            <TokenPair t0={t0} t1={t1} size={32} />
            <div>
              <div className="nm">{t0.symbol} / {t1.symbol}</div>
              <div className="tag mono">NFT #{pos.tokenId} · {feeTier} FEE</div>
            </div>
          </div>

          <div className="m-lbl">Unclaimed fees</div>
          <div className="p-rows">
            <div className="p-row">
              <span className="k" style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><TokenIcon token={t0} size={16} />{t0.symbol}</span>
              {fees0 > 0
                ? <span className="v pos">+{fmtFee(fees0)}</span>
                : <span className="v" style={{ color: "var(--ink-3)" }}>0.00</span>}
            </div>
            <div className="p-row">
              <span className="k" style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><TokenIcon token={t1} size={16} />{t1.symbol}</span>
              {fees1 > 0
                ? <span className="v pos">+{fmtFee(fees1)}</span>
                : <span className="v" style={{ color: "var(--ink-3)" }}>0.00</span>}
            </div>
          </div>

          <div className="warnbox">
            {hasAny
              ? `⚠ This will send your accrued fees to your wallet. Position NFT #${pos.tokenId} stays intact — your liquidity keeps earning.`
              : `No fees accrued yet. You can still submit — the tx will just be a no-op. Fees accrue when swaps occur through your price range.`}
          </div>

          <div className="m-actions">
            <button className="m-btn cancel" onClick={onCancel}>Cancel</button>
            <button className="m-btn amber" onClick={onConfirm} disabled={collecting}>
              {collecting ? "Collecting..." : "Confirm collect"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

// ═══ POSITIONS TAB (REDESIGNED) ═══
const PositionsTab = ({ positions, loading, isConnected, walletCtx, chainClient, address, chainId, chainName, chains, onSwitchChain, switching, onRefresh, onGoToMarkets }: {
  positions: LiquidityPosition[]; loading: boolean; isConnected: boolean; walletCtx: any; chainClient: any; address: string | null;
  /** The chain these positions were READ from — and the chain their exits are sent to. */
  chainId: number; chainName: string;
  /** The chains LP is live on, for the switch prompt below. */
  chains: { id: number; name: string; shortName: string }[];
  onSwitchChain: (id: number) => void; switching: boolean;
  onRefresh: () => void; onGoToMarkets: () => void;
}) => {
  const [removing, setRemoving] = useState<number | null>(null);
  const [collecting, setCollecting] = useState<number | null>(null);
  const [txMsg, setTxMsg] = useState<string | null>(null);
  /** Set when an exit was refused because the wallet had moved off this list's chain. */
  const [mismatch, setMismatch] = useState(false);
  const [enriched, setEnriched] = useState<EnrichedPosition[]>([]);
  const [enriching, setEnriching] = useState(false);
  const [removeModal, setRemoveModal] = useState<LiquidityPosition | null>(null);
  const [collectModal, setCollectModal] = useState<LiquidityPosition | null>(null);

  /**
   * Real token amounts for each position, computed at ITS OWN POOL'S current tick, on ITS OWN CHAIN.
   *
   * What this replaces: a `getProvider()` pinned to Robinhood, a pool found by looking the position's
   * two tokens up in the Robinhood AMM registry, and a tick that stayed 0 whenever that lookup missed —
   * which, for a v4 ALM position, it always did, because a v4 pool has no address to call slot0() on.
   * A tick of 0 is not "unknown" to the concentrated-liquidity formulas below, it is a price of 1.0, so
   * every amount shown was arithmetic performed at a price no pool has ever had.
   *
   * Now: the tick comes from the position's own pool — seeded from the pool list, topped up by a single
   * StateView read per pool on the chain the position lives on. A pool whose tick cannot be established
   * yields no amounts at all rather than amounts at a fictional price.
   */
  useEffect(() => {
    if (positions.length === 0) { setEnriched([]); return; }
    let cancelled = false;
    (async () => {
      setEnriching(true);
      try {
        // One read per POOL, not per position: four Robinhood positions sit in three pools.
        const ids = Array.from(new Set(positions.map((p) => p.poolId).filter(Boolean))) as string[];
        const live = new Map<string, number>();
        await Promise.all(ids.map(async (id) => {
          const s = await readSlot0(chainId, id);
          if (s) live.set(id.toLowerCase(), s.tick);
        }));

        const enrichedList: EnrichedPosition[] = [];
        for (const pos of positions) {
          const t0 = pos.token0Info || getTokenByAddress(pos.token0);
          const t1 = pos.token1Info || getTokenByAddress(pos.token1);
          const tick = pos.poolId
            ? live.get(pos.poolId.toLowerCase()) ?? pos.poolTick ?? null
            : pos.poolTick ?? null;
          const known = tick !== null && t0 !== undefined && t1 !== undefined;
          const { amount0, amount1 } = known
            ? getTokenAmounts(BigInt(pos.liquidity), pos.tickLower, pos.tickUpper, tick as number, t0!.decimals, t1!.decimals)
            : { amount0: NaN, amount1: NaN };
          enrichedList.push({
            ...pos,
            amount0,
            amount1,
            currentTick: tick ?? 0,
            feeTier: feeLabel(pos.fee),
            // A v4 pool has no address; its identity IS the PoolId, which is what the card shows.
            poolAddress: pos.poolId || pos.poolInfo?.address || "",
          });
        }
        if (!cancelled) setEnriched(enrichedList);
      } catch (err) { console.error("Failed to enrich positions:", err); }
      finally { if (!cancelled) setEnriching(false); }
    })();
    return () => { cancelled = true; };
  }, [positions, chainId]);

  const handleRemove = async (pos: LiquidityPosition) => {
    if (!address || removing) return;
    setRemoving(pos.tokenId);
    setRemoveModal(null);
    setTxMsg("Exiting position...");
    setMismatch(false);
    try {
      // ALM positions exit via the verified-safe withdrawAll(id) — reads liquidity inside the call.
      // THE CHAIN GOES WITH THE ID. A position id is only meaningful against one vault, and the two
      // chains' vaults number their positions independently: id 2 is a live Arc position and also a
      // burnt Robinhood one. Passing no chain let `vault.ts` fall back to Robinhood, so an Arc exit was
      // aimed at Robinhood's vault — refused there by the wallet-network check, but refused is not the
      // same as correct, and the refusal named a chain the user had not chosen to be on.
      const { almWithdraw } = await import("@/lib/mole/vault");
      const result = await almWithdraw(String(pos.tokenId), pos.chainId ?? chainId);
      setTxMsg(result.success ? "Position exited!" : (result.error || "Failed"));
      // A refusal that names a network is answerable with a button, not with a sentence. `vault.ts`
      // refuses (rather than silently switching) when the wallet has moved since this list was read;
      // this is what turns that refusal into something the user can act on.
      if (!result.success && /wallet is on|switch network/i.test(result.error || "")) setMismatch(true);
      setTimeout(() => { setTxMsg(null); onRefresh(); }, 3000);
    } catch (err: any) {
      setTxMsg(err?.message?.slice(0, 100) || "Failed");
      setTimeout(() => setTxMsg(null), 4000);
    } finally { setRemoving(null); }
  };

  const handleCollect = async (pos: LiquidityPosition) => {
    if (!address || collecting) return;
    setCollecting(pos.tokenId);
    setCollectModal(null);
    setTxMsg("Collecting fees...");
    try {
      const { collectFees } = await import("@/lib/chain/amm");
      const result = await collectFees({
        chainClient,
        tokenId: pos.tokenId,
        recipient: address,
        liquidity: pos.liquidity,
      });
      setTxMsg(result.success ? "Fees collected!" : (result.error || "Failed"));
      setTimeout(() => { setTxMsg(null); onRefresh(); }, 3000);
    } catch (err: any) {
      setTxMsg(err?.message?.slice(0, 100) || "Failed");
      setTimeout(() => setTxMsg(null), 4000);
    } finally { setCollecting(null); }
  };

  if (!isConnected) {
    return (
      <div className="p-card center" style={{ padding: "44px 20px" }}>
        <MoleMascot className="mole2" />
        <h3 style={{ fontSize: "1.15rem" }}>Connect wallet to view positions</h3>
        <button
          onClick={() => walletCtx?.handleConnectWallet?.()}
          className="p-btn"
          style={{ maxWidth: 260, margin: "18px auto 0", display: "block" }}
        >
          Connect wallet
        </button>
      </div>
    );
  }

  if (loading || enriching) {
    return (
      <div className="p-card center pos-load" style={{ padding: "52px 20px" }}>
        <div className="ldr" />
        <div className="t1">Loading positions...</div>
        <p className="d" style={{ marginTop: 4 }}>Reading on-chain position data</p>
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div className="p-card center" style={{ padding: "44px 20px" }}>
        <MoleMascot className="mole2" />
        <h3 style={{ fontSize: "1.15rem" }}>No active positions</h3>
        <p className="d" style={{ maxWidth: 300, margin: "6px auto 0" }}>Add liquidity to a pool to start earning fees</p>
        <button
          onClick={onGoToMarkets}
          className="p-btn"
          style={{ maxWidth: 260, margin: "18px auto 0", display: "block" }}
        >
          Explore markets
        </button>
      </div>
    );
  }

  const displayPositions = enriched.length > 0 ? enriched : positions;
  const totalFees0 = enriched.reduce((s, p) => s + Number(ethers.formatUnits(p.tokensOwed0, (p.token0Info || getTokenByAddress(p.token0))?.decimals || 18)), 0);
  const totalFees1 = enriched.reduce((s, p) => s + Number(ethers.formatUnits(p.tokensOwed1, (p.token1Info || getTokenByAddress(p.token1))?.decimals || 18)), 0);
  const activeCount = positions.filter(p => BigInt(p.liquidity) > 0n).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {removeModal && (() => {
        const t0 = removeModal.token0Info || getTokenByAddress(removeModal.token0);
        const t1 = removeModal.token1Info || getTokenByAddress(removeModal.token1);
        const ep = enriched.find(e => e.tokenId === removeModal.tokenId);
        const f0 = t0 ? Number(ethers.formatUnits(removeModal.tokensOwed0, t0.decimals)) : 0;
        const f1 = t1 ? Number(ethers.formatUnits(removeModal.tokensOwed1, t1.decimals)) : 0;
        return t0 && t1 ? (
          <RemoveLiquidityModal pos={removeModal} ep={ep} t0={t0} t1={t1} fees0={f0} fees1={f1}
            removing={removing === removeModal.tokenId} onConfirm={() => handleRemove(removeModal)} onCancel={() => setRemoveModal(null)} />
        ) : null;
      })()}

      {collectModal && (() => {
        const t0 = collectModal.token0Info || getTokenByAddress(collectModal.token0);
        const t1 = collectModal.token1Info || getTokenByAddress(collectModal.token1);
        const f0 = t0 ? Number(ethers.formatUnits(collectModal.tokensOwed0, t0.decimals)) : 0;
        const f1 = t1 ? Number(ethers.formatUnits(collectModal.tokensOwed1, t1.decimals)) : 0;
        return t0 && t1 ? (
          <CollectFeesModal pos={collectModal} t0={t0} t1={t1} fees0={f0} fees1={f1}
            collecting={collecting === collectModal.tokenId} onConfirm={() => handleCollect(collectModal)} onCancel={() => setCollectModal(null)} />
        ) : null;
      })()}

      {txMsg && (
        <div className="statline" style={{ margin: "0 0 6px", color: "#ffcd7d" }}>{txMsg}</div>
      )}

      {/* The switch affordance the refusal never had. `vault.ts` answers a moved wallet with "your
          wallet is on X, but this position lives on Y" and stops there; a sentence naming a network is
          only actionable if the page can put the user on it. Same shape and same wording as the vault
          screen's own prompt, because it is the same refusal. */}
      {mismatch && (
        <div className="p-card" data-testid="position-chain-mismatch" style={{ marginBottom: 6 }}>
          <p className="d" style={{ margin: 0 }}>
            These positions live on {chainName}. Switch your wallet there to exit them.
          </p>
          <div className="p-chipset" style={{ marginTop: 12 }}>
            {(chains.some((c) => c.id === chainId) ? chains.filter((c) => c.id === chainId) : chains).map((c) => (
              <button key={c.id} data-testid={`switch-to-${c.id}`} onClick={() => onSwitchChain(c.id)} disabled={switching}>
                SWITCH TO {c.shortName.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Portfolio Summary */}
      <div className="p-grid p-3">
        <div className="p-card tight">
          <div className="sm-lbl">Total deposited</div>
          <div className="sm-val mono">
            {/* Positions whose pool tick is unknown carry NaN amounts (see the enrichment above) and are
                skipped rather than turning the whole total into "NaN". */}
            {enriched.length > 0
              ? `${sumFinite(enriched.map((e) => e.amount0)).toFixed(4)} / ${sumFinite(enriched.map((e) => e.amount1)).toFixed(4)}`
              : "..."}
          </div>
        </div>
        <div className="p-card tight">
          <div className="sm-lbl">Unclaimed fees</div>
          <div className="sm-val mono" style={{ color: totalFees0 > 0 || totalFees1 > 0 ? "var(--moss)" : "var(--ink-3)" }}>
            {(totalFees0 > 0 || totalFees1 > 0) ? `+${fmtFee(totalFees0)} / +${fmtFee(totalFees1)}` : "None"}
          </div>
        </div>
        <div className="p-card tight">
          <div className="sm-lbl">Positions</div>
          <div className="sm-val mono">
            {activeCount} <span style={{ fontSize: 12, color: "var(--moss)", fontWeight: 700 }}>ACTIVE</span>
          </div>
        </div>
      </div>

      <div className="p-sec" style={{ margin: "10px 0 0" }}>
        <h2>{positions.length} position{positions.length !== 1 ? "s" : ""}</h2>
        <span className="spacer" />
        <button onClick={onRefresh} className="linkish" style={{ textDecoration: "none", color: "#ffcd7d" }} aria-label="Refresh positions">
          <RefreshCw size={14} />
        </button>
      </div>

      {displayPositions.map((pos) => {
        const t0 = pos.token0Info || getTokenByAddress(pos.token0);
        const t1 = pos.token1Info || getTokenByAddress(pos.token1);
        const poolName = t0 && t1 ? `${t0.symbol}/${t1.symbol}` : `Position #${pos.tokenId}`;
        const hasLiq = BigInt(pos.liquidity) > 0n;
        const hasFees = BigInt(pos.tokensOwed0) > 0n || BigInt(pos.tokensOwed1) > 0n;
        const ep = enriched.find(e => e.tokenId === pos.tokenId);
        const fees0 = t0 ? Number(ethers.formatUnits(pos.tokensOwed0, t0.decimals)) : 0;
        const fees1 = t1 ? Number(ethers.formatUnits(pos.tokensOwed1, t1.decimals)) : 0;
        const isFullRange = pos.tickLower <= -887200 && pos.tickUpper >= 887200;

        return (
          <div key={pos.tokenId} className="p-card">
            {/* Header */}
            <div className="pc-top">
              <div className="pair">
                {t0 && t1 && <TokenPair t0={t0} t1={t1} size={32} />}
                <div>
                  <div className="nm">{poolName}</div>
                  <div className="tag">
                    {/* The chain this position was READ from, not the chain the app used to assume. It
                        is the same chain its exit will be sent to, which is why it is stated here. */}
                    <Badge chain={chainName} />
                    {t0 && t0.sourceChain && t0.sourceChain !== chainName && (
                      <span className="badge2">bridged from {t0.sourceChain}</span>
                    )}
                    <span className="fee">{ep?.feeTier || feeLabel(pos.fee)}</span>
                    <span className="badge2">NFT #{pos.tokenId}</span>
                  </div>
                </div>
              </div>
              <span className={`p-pill ${hasLiq ? "pos" : "mute"}`} style={{ marginLeft: "auto" }}>
                {hasLiq && <span className="glowdot" />}
                {hasLiq ? "Active" : "Closed"}
              </span>
            </div>

            <div className="p-rows" style={{ marginTop: 8 }}>
              {/* Deposited amounts */}
              {t0 && t1 && (
                <>
                  {[{ tok: t0, amt: ep?.amount0 }, { tok: t1, amt: ep?.amount1 }].map((item, i) => (
                    <div key={i} className="p-row">
                      <span className="k" style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                        <TokenIcon token={item.tok} size={16} />{item.tok.symbol} deposited
                      </span>
                      {/* "—" where the pool's tick could not be established: an amount computed at a
                          price no pool has had is worse than no amount. "..." still means "not read yet". */}
                      <span className="v">
                        {item.amt === undefined ? "..." : Number.isFinite(item.amt) ? item.amt.toFixed(item.amt < 0.01 ? 6 : 4) : "—"}
                      </span>
                    </div>
                  ))}
                </>
              )}

              {/* Unclaimed fees */}
              {t0 && t1 && (
                <>
                  <div className="p-row">
                    <span className="k">{t0.symbol} fees</span>
                    <span className="v" style={{ color: fees0 > 0 ? "var(--moss)" : "var(--ink-3)" }}>
                      {fees0 > 0 ? `+${fmtFee(fees0)}` : "0.00"}
                    </span>
                  </div>
                  <div className="p-row">
                    <span className="k">{t1.symbol} fees</span>
                    <span className="v" style={{ color: fees1 > 0 ? "var(--moss)" : "var(--ink-3)" }}>
                      {fees1 > 0 ? `+${fmtFee(fees1)}` : "0.00"}
                    </span>
                  </div>
                </>
              )}

              {/* Details */}
              <div className="p-row">
                <span className="k">Range</span>
                <span className="v" style={{ color: isFullRange ? "var(--moss)" : "var(--amber)" }}>
                  {isFullRange ? "FULL RANGE" : "CUSTOM"}
                </span>
              </div>
              <div className="p-row">
                <span className="k">Liquidity</span>
                <span className="v">
                  {BigInt(pos.liquidity) > 1e9 ? fmt(Number(BigInt(pos.liquidity))) : BigInt(pos.liquidity).toLocaleString()}
                </span>
              </div>
              <div className="p-row">
                <span className="k">Pool</span>
                <span className="v" style={{ color: "var(--ink-3)" }}>
                  {ep?.poolAddress ? `${ep.poolAddress.slice(0, 6)}...${ep.poolAddress.slice(-4)}` : "—"}
                </span>
              </div>
            </div>

            {/* Action buttons. ALM positions auto-compound fees (no separate claim), so there is only
                a single EXIT action — it returns the full underlying WETH/USDG including earned fees. */}
            {(pos as any).isAlm ? (
              <>
                <p className="d" style={{ marginTop: 10 }}>
                  Fees auto-compound into this position — exiting returns them with your liquidity.
                </p>
                {hasLiq && (
                  <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
                    <button className="exit2" onClick={() => setRemoveModal(pos)} disabled={removing === pos.tokenId}>
                      {removing === pos.tokenId ? "Exiting..." : "Exit position"}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
                <button
                  className="m-btn amber"
                  style={{ flex: "none", width: "100%" }}
                  onClick={() => setCollectModal(pos)}
                  disabled={collecting === pos.tokenId}
                >
                  {collecting === pos.tokenId ? "Collecting..." : "Collect fees"}
                </button>
                {hasLiq && (
                  <button
                    className="m-btn danger"
                    style={{ flex: "none", width: "100%" }}
                    onClick={() => setRemoveModal(pos)}
                    disabled={removing === pos.tokenId}
                  >
                    {removing === pos.tokenId ? "Removing..." : "Remove liquidity"}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

// ═══ POOL DETAIL (REDESIGNED) ═══
const PoolDetail = ({ pool, onBack, address, isConnected, walletCtx, chainClient, chainId, chainName, explorerUrl }: {
  pool: PoolDisplay; onBack: () => void; address: string | null; isConnected: boolean; walletCtx: any; chainClient: any;
  /** The chain this pool lives on — every balance, tick and explorer link below is read from it. */
  chainId: number; chainName: string; explorerUrl: string | null;
}) => {
  const router = useRouter();
  const [actionTab, setActionTab] = useState<"add" | "remove" | null>(null);
  const [amount0, setAmount0] = useState("");
  const [amount1, setAmount1] = useState("");
  const [balance0, setBalance0] = useState<string | null>(null);
  const [balance1, setBalance1] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [txDone, setTxDone] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [stepLabel, setStepLabel] = useState("");
  const [inputFocused, setInputFocused] = useState<0 | 1>(0);
  const [currentTick, setCurrentTick] = useState(pool.tick || 0);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [rangeMode, setRangeMode] = useState<"full" | "custom">("full");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  // ── Deposit mode: "both" (default, unchanged behaviour) or "one" (single-token, range beyond spot).
  const [depositMode, setDepositMode] = useState<"both" | "one">("both");
  const [oneSide, setOneSide] = useState<0 | 1>(0);
  const [oneSidedPresetKey, setOneSidedPresetKey] = useState<"launch" | "tight" | "custom">("launch");
  const [customWidth, setCustomWidth] = useState("6000");

  useEffect(() => {
    if (!address) return;
    const fetchBalances = async () => {
      try {
        // The chain the POOL is on, not Robinhood. `getProvider()` here read Robinhood balances for
        // Arc token addresses — which returns 0 for a token that does not exist there, i.e. it told a
        // funded user they held nothing.
        const provider = poolsProvider(chainId);
        if (!provider) { setBalance0(null); setBalance1(null); return; }
        const isNative0 = pool.token0.address === ethers.ZeroAddress || pool.token0.address === "0x0000000000000000000000000000000000000000";
        const isNative1 = pool.token1.address === ethers.ZeroAddress || pool.token1.address === "0x0000000000000000000000000000000000000000";
        const [b0, b1] = await Promise.all([
          isNative0 ? provider.getBalance(address) : new ethers.Contract(pool.token0.address, ERC20_BAL_ABI, provider).balanceOf(address),
          isNative1 ? provider.getBalance(address) : new ethers.Contract(pool.token1.address, ERC20_BAL_ABI, provider).balanceOf(address),
        ]);
        setBalance0(ethers.formatUnits(b0, pool.token0.decimals));
        setBalance1(ethers.formatUnits(b1, pool.token1.decimals));
      } catch (err) { console.error("Failed to fetch balances:", err); }
    };
    fetchBalances();
  }, [address, pool, chainId]);

  // Refresh tick AND price straight from the pool's slot0. The list already carries both (they come from
  // the same StateView read the API does), so this is a top-up, not the only source — a failed read
  // leaves the list values standing instead of collapsing the page to zeros.
  useEffect(() => {
    let cancelled = false;
    setCurrentTick(pool.tick || 0);
    setLivePrice(null);
    (async () => {
      const s = await readSlot0(chainId, pool.pool.address);
      if (!s || cancelled) return;
      setCurrentTick(s.tick);
      const px = sqrtPriceToPrice(s.sqrtPriceX96, pool.token0.decimals, pool.token1.decimals);
      if (px > 0) setLivePrice(px);
    })();
    return () => { cancelled = true; };
  }, [pool, chainId]);

  // One price for the whole detail view: the live slot0 read when it lands, else the list's value.
  const price = livePrice ?? pool.price;
  const priceUsable = Number.isFinite(price) && price > 0;
  const updateAmount1FromAmount0 = (val: string) => {
    setAmount0(val);
    if (inputFocused === 0 && priceUsable && val && !isNaN(Number(val)) && Number(val) > 0) {
      setAmount1((Number(val) * price).toFixed(Math.min(pool.token1.decimals, 8)));
    } else if (!val) setAmount1("");
  };
  const updateAmount0FromAmount1 = (val: string) => {
    setAmount1(val);
    if (inputFocused === 1 && priceUsable && val && !isNaN(Number(val)) && Number(val) > 0) {
      setAmount0((Number(val) / price).toFixed(Math.min(pool.token0.decimals, 8)));
    } else if (!val) setAmount0("");
  };
  const setPercentage0 = (pct: number) => { if (!balance0) return; setInputFocused(0); updateAmount1FromAmount0((Number(balance0) * pct).toFixed(Math.min(pool.token0.decimals, 8))); };
  const setPercentage1 = (pct: number) => { if (!balance1) return; setInputFocused(1); updateAmount0FromAmount1((Number(balance1) * pct).toFixed(Math.min(pool.token1.decimals, 8))); };

  const insufficientBalance0 = amount0 && balance0 && Number(amount0) > Number(balance0);
  const insufficientBalance1 = amount1 && balance1 && Number(amount1) > Number(balance1);
  const hasInsufficientBalance = insufficientBalance0 || insufficientBalance1;
  const canSubmit = amount0 && amount1 && Number(amount0) > 0 && Number(amount1) > 0 && !hasInsufficientBalance && !loading;

  // ── One-sided deposit derivations ────────────────────────────────────────────────────────────
  /**
   * Is this the pool THIS CHAIN's ALM vault manages? Matched by PoolId — the pool's real identity —
   * against `vaultChainFor(chainId)`, rather than against Robinhood's WETH/USDG token addresses, which
   * is what the comparison here used to be. Only the vault's own pool is whitelisted by MolePositions,
   * so anything gated on this is gated on where `open()` can actually succeed.
   */
  const vaultPool = useMemo(() => vaultPoolFor(chainId), [chainId]);
  const isVaultPool =
    vaultPool !== null && pool.pool.address.toLowerCase() === vaultPool.poolId.toLowerCase();
  /**
   * WHETHER THE ONE-TOKEN ADD MAY BE OFFERED, which is a narrower question than `isVaultPool`.
   *
   * `addLiquidityOneSided` in lib/chain/amm.ts is pinned to Robinhood in every line that matters: it
   * calls `wallet_switchEthereumChain` to 4663 before signing, builds its client on `robinhoodChain`,
   * and takes its currencies from `LIVE_POOL_KEY`. Offering the button on Arc's vault pool would move
   * the user's wallet to Robinhood and open a ROBINHOOD position with money they meant to put on Arc.
   * So it is offered only where the signer can honour it; the vault CTA beside it IS chain-aware and
   * is the path Arc deposits take.
   */
  const oneSidedAvailable = isVaultPool && chainId === RH_CHAIN_ID;
  // {mid, observedAt, ageSec, stale} for THIS chain's hook oracle — only the vault's pool has one, and
  // the hook that keeps it is a different contract on each chain.
  const { oracle } = useOracleHealth({ poolId: vaultPool?.poolId, chainId, enabled: isVaultPool });
  const oneSidedSide: OneSidedSide = oneSide === 0 ? "token0" : "token1";
  const oneSidedPreset: OneSidedPreset =
    oneSidedPresetKey === "custom"
      ? { widthTicks: Math.max(1, Math.floor(Number(customWidth) || 0)) }
      : oneSidedPresetKey;
  // Preview only — the signing path (addLiquidityOneSided) recomputes from a fresh tick and
  // re-asserts the range is strictly one-sided immediately before sending.
  const oneSidedRange = useMemo(() => {
    if (depositMode !== "one" || !oneSidedAvailable) return null;
    try {
      return computeOneSidedRange({
        side: oneSidedSide,
        currentTick,
        tickSpacing: LIVE_POOL_KEY.tickSpacing,
        preset: oneSidedPreset,
      });
    } catch {
      return null;
    }
    // oneSidedPreset is rebuilt each render; its inputs are the real deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depositMode, oneSidedAvailable, oneSidedSide, currentTick, oneSidedPresetKey, customWidth]);
  const off0 = depositMode === "one" && oneSide !== 0; // token0 input greyed out
  const off1 = depositMode === "one" && oneSide !== 1; // token1 input greyed out
  const oneAmt = oneSide === 0 ? amount0 : amount1;
  const oneTok = oneSide === 0 ? pool.token0 : pool.token1;
  const otherTok = oneSide === 0 ? pool.token1 : pool.token0;
  const oneInsufficient = oneSide === 0 ? insufficientBalance0 : insufficientBalance1;
  const canSubmitOneSided =
    depositMode === "one" && oneSidedAvailable && !!oneAmt && Number(oneAmt) > 0 &&
    !oneInsufficient && !loading && !!oneSidedRange;

  const handleAddLiquidityOneSided = async () => {
    if (!address || !canSubmitOneSided) return;
    setLoading(true); setTxError(null); setTxHash(null); setStepLabel("Preparing...");
    try {
      const { addLiquidityOneSided } = await import("@/lib/chain/amm");
      const amountWei = ethers.parseUnits(oneAmt, oneTok.decimals).toString();
      const result = await addLiquidityOneSided({
        chainClient,
        side: oneSidedSide,
        amount: amountWei,
        preset: oneSidedPreset,
        onStep: (_step: number, label: string, status: string) => { setStepLabel(label); if (status === "error") setTxError(label); },
      });
      if (result.success) { setTxHash(result.txHash || null); setTxDone(true); setAmount0(""); setAmount1(""); }
      else setTxError(result.error || "Transaction failed");
    } catch (err: any) {
      setTxError((err?.message || "Transaction failed").slice(0, 150));
    } finally { setLoading(false); setStepLabel(""); }
  };

  const getOneSidedButtonLabel = () => {
    if (loading) return stepLabel || "PROCESSING...";
    if (oneInsufficient) return `GET ${oneTok.symbol} →`;
    if (!oneAmt || Number(oneAmt) <= 0) return "ENTER AMOUNT";
    if (!oneSidedRange) return "RANGE UNAVAILABLE";
    return "ADD ONE-SIDED LIQUIDITY";
  };

  /**
   * priceToTick: Math.log is -Infinity at 0 and NaN for negatives, which
   * would propagate as bad ticks and silently revert the position mint.
   * Fall back to 0 for any non-positive / non-finite input — caller already
   * only calls this when price > 0, but we double-check defensively.
   */
  const priceToTick = (p: number) => {
    if (!Number.isFinite(p) || p <= 0) return 0;
    return Math.round(Math.log(p) / Math.log(1.0001));
  };
  const tickSpacing = pool.fee === 500 ? 10 : pool.fee === 3000 ? 60 : pool.fee === 10000 ? 200 : 10;
  const nearestTick = (t: number) => Math.round(t / tickSpacing) * tickSpacing;

  const selectedTickLower = rangeMode === "full" ? -887272 : (minPrice && Number(minPrice) > 0 ? nearestTick(priceToTick(Number(minPrice))) : -887272);
  const selectedTickUpper = rangeMode === "full" ? 887272 : (maxPrice && Number(maxPrice) > 0 ? nearestTick(priceToTick(Number(maxPrice))) : 887272);

  // Zero-balance CTA targets: swap from the OTHER pool token into the missing one.
  const getMissingTokenSwapUrl = (missing: TokenInfo) => {
    const other = missing.address.toLowerCase() === pool.token0.address.toLowerCase() ? pool.token1 : pool.token0;
    return getSwapUrl(other.address, missing.address, chainId);
  };
  // Which pool token should the primary CTA try to acquire? The first one the
  // user is short of (entered amount > balance, or balance is 0).
  const missingToken: TokenInfo | null =
    insufficientBalance0 ? pool.token0 :
    insufficientBalance1 ? pool.token1 :
    null;

  const handleAddLiquidity = async () => {
    if (!address || !canSubmit) return;
    setLoading(true); setTxError(null); setTxHash(null); setStepLabel("Preparing...");
    try {
      const { addLiquidity } = await import("@/lib/chain/amm");
      const amount0Wei = ethers.parseUnits(amount0, pool.token0.decimals).toString();
      const amount1Wei = ethers.parseUnits(amount1, pool.token1.decimals).toString();
      const result = await addLiquidity({
        chainClient, token0: pool.pool.token0, token1: pool.pool.token1, fee: pool.fee,
        amount0: amount0Wei, amount1: amount1Wei, recipient: address,
        tickLower: selectedTickLower, tickUpper: selectedTickUpper,
        onStep: (_step: any, label: string, status: string) => { setStepLabel(label); if (status === "error") setTxError(label); },
      });
      if (result.success) { setTxHash(result.txHash); setTxDone(true); setAmount0(""); setAmount1(""); }
      else setTxError(result.error || "Transaction failed");
    } catch (err: any) {
      const msg = err?.message || "Transaction failed";
      setTxError(msg.includes("STF") ? "Insufficient token balance or allowance (STF)" : msg.slice(0, 150));
    } finally { setLoading(false); setStepLabel(""); }
  };

  const getButtonLabel = () => {
    if (loading) return stepLabel || "PROCESSING...";
    if (insufficientBalance0) return `GET ${pool.token0.symbol} →`;
    if (insufficientBalance1) return `GET ${pool.token1.symbol} →`;
    if (!amount0 || Number(amount0) <= 0) return "ENTER AMOUNT";
    return "ADD LIQUIDITY";
  };

  const priceStr = priceUsable ? (price > 1000 ? fmt(price) : price < 0.001 ? price.toExponential(2) : price.toFixed(4)) : "N/A";

  return (
    <div>
      {/* Header */}
      <button className="backlink" onClick={onBack}>← Back</button>
      <div className="det-head">
        <TokenPair t0={pool.token0} t1={pool.token1} size={32} />
        <h2>
          {getPoolDisplayInfo(pool.token0).symbol}/{getPoolDisplayInfo(pool.token1).symbol}
        </h2>
        <Badge chain={chainName} />
        {pool.token0.sourceChain && pool.token0.sourceChain !== chainName && (
          <span className="badge2">bridged from {pool.token0.sourceChain}</span>
        )}
        <span className="badge2">Fee {feeLabel(pool.fee)}</span>
        <span className="badge2" data-service-tag={pool.serviceTag}>
          {pool.hooks ? SERVICE_TAG_LABEL[pool.serviceTag] : "Hook unknown"}
        </span>
      </div>

      {/* Provenance — rendered from chain for a MoleHook-served pool: the hook bitmap proof, PoolId,
          currencies + decimals, tickSpacing, the live lpFee, and each parameter's honest mutability. */}
      {engineActionsAllowed(pool.serviceTag) && pool.hooks && pool.tickSpacing !== null && (
        <div style={{ marginBottom: 14 }}>
          <ProvenanceCard
            chainId={chainId}
            poolKey={{
              currency0: pool.token0.address as `0x${string}`,
              currency1: pool.token1.address as `0x${string}`,
              fee: pool.fee,
              tickSpacing: pool.tickSpacing,
              hooks: pool.hooks as `0x${string}`,
            }}
            defaultOpen
          />
        </div>
      )}

      {/* Stats row */}
      <div className="p-grid p-3">
        {[
          { l: "TVL", v: `$${fmt(pool.tvl)}`, cls: "" },
          { l: "24h vol", v: pool.vol24h > 0 ? `$${fmt(pool.vol24h)}` : "—", cls: "" },
          { l: "APY", v: pool.feeApy > 0 ? `${pool.feeApy.toFixed(pool.feeApy >= 100 ? 0 : 1)}%` : "—", cls: pool.feeApy > 0 ? "pos" : "" },
          { l: "Fee tier", v: feeLabel(pool.fee), cls: "pos" },
          { l: "Price", v: priceUsable ? `$${fmt(price)}` : "—", cls: "" },
          { l: "Liquidity", v: BigInt(pool.liquidity) > 0n ? "ACTIVE" : "EMPTY", cls: BigInt(pool.liquidity) > 0n ? "pos" : "neg" },
        ].map((s) => (
          <div key={s.l} className="p-card tight">
            <div className="sm-lbl">{s.l}</div>
            <div className={`sm-val mono${s.cls ? " " + s.cls : ""}`}>{s.v}</div>
          </div>
        ))}
      </div>

      {/* Pooled amounts */}
      <div className="p-grid p-2" style={{ marginTop: 14 }}>
        {[{ tok: pool.token0, reserve: pool.reserve0 }, { tok: pool.token1, reserve: pool.reserve1 }].map((item, i) => {
          const poolDisp = getPoolDisplayInfo(item.tok);
          return (
            <div key={i} className="p-card tight">
              <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                <TokenIcon token={item.tok} size={24} />
                <b style={{ fontSize: 14.5 }}>{poolDisp.symbol}</b>
                <Badge chain={chainName} />
              </div>
              <div className="sm-lbl" style={{ marginTop: 14 }}>Pooled amount</div>
              <div className="sm-val mono">{item.reserve}</div>
            </div>
          );
        })}
      </div>

      {/* WHAT REPLACED THE "LIQUIDITY DISTRIBUTION" CARD, and why.
          That card drew 24 bars whose heights were `100 - distance-from-a-hard-coded-0.55-peak`, over a
          price axis invented as `price * (0.5 + ratio)`, with a tooltip reporting the bar height as
          "LIQ: n%". None of it came from the chain. It sat directly beneath a cryptographic provenance
          panel, which is the worst possible place for decoration dressed as data.
          Everything below is decoded from Swap events the pool itself emitted. */}
      {/* `pool.pool.address` carries the v4 PoolId for a v4 row and the pool CONTRACT for a v3 row —
          the field is overloaded upstream, so which one it is comes from serviceTag, never from shape. */}
      <PoolActivityPanel
        poolId={pool.serviceTag === "v3" ? undefined : pool.pool.address || undefined}
        poolAddress={pool.serviceTag === "v3" ? pool.pool.address || undefined : undefined}
        poolManager={contractsFor(chainId).POOL_MANAGER}
        decimals0={pool.token0.decimals}
        decimals1={pool.token1.decimals}
        symbol0={pool.token0.symbol}
        symbol1={pool.token1.symbol}
        explorerUrl={explorerUrl ?? ""}
      />

      {/* Price + manage */}
      <div className="p-grid p-2" style={{ marginTop: 14 }}>
        <div className="p-card">
          <h3>Price</h3>
          <div className="dp mono">1 {pool.token0.symbol} = {priceStr} {pool.token1.symbol}</div>
        </div>
        <div className="p-card">
          <h3>Manage liquidity</h3>
          <div style={{ marginTop: 12 }}>
            {!isConnected ? (
              <button onClick={() => walletCtx?.handleConnectWallet?.()} className="p-btn" style={{ marginTop: 0 }}>
                Connect wallet
              </button>
            ) : txDone ? (
              <div className="center" style={{ padding: "8px 0" }}>
                <p className="statline ok" style={{ marginTop: 0 }}>Liquidity added ✓</p>
                {/* This chain's explorer, from the chain registry. The hard-coded Blockscout URL that
                    used to be here sent an Arc user to a Robinhood explorer, where their transaction
                    hash simply does not exist. */}
                {txHash && explorerUrl && (
                  <a href={`${explorerUrl}/tx/${txHash}`} target="_blank" rel="noopener noreferrer" className="linkish" style={{ display: "block", marginTop: 6 }}>
                    View on explorer →
                  </a>
                )}
                <button onClick={() => { setTxDone(false); setActionTab(null); }} className="linkish" style={{ marginTop: 10 }}>
                  Done
                </button>
              </div>
            ) : txError ? (
              <div className="center" style={{ padding: "8px 0" }}>
                <p className="statline err" style={{ marginTop: 0 }}>Transaction failed ✗</p>
                <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--ink-2)", wordBreak: "break-word" }}>{txError.slice(0, 150)}</p>
                <button onClick={() => setTxError(null)} className="linkish" style={{ marginTop: 10 }}>
                  Try again
                </button>
              </div>
            ) : actionTab === null ? (
              <>
                {/* Provide (the vault) is bound to MoleHook pools — the vault's admission pin refuses any
                    other hook, so the buttons are offered only where the call can succeed. */}
                {engineActionsAllowed(pool.serviceTag) ? (
                  <div className="act-row">
                    <button className="act-btn add" onClick={() => router.push("/vault")}>
                      + Add liquidity
                    </button>
                    <button className="act-btn rem" onClick={() => router.push("/vault")}>
                      − Remove liquidity
                    </button>
                  </div>
                ) : (
                  <p className="d" style={{ marginTop: 0 }} data-testid="not-served">
                    Not a MoleHook pool — the vault and the queue cannot serve it.
                  </p>
                )}
                {/* Direct one-token deposit (MolePositions.open with a beyond-spot range) — the
                    single-sided OPTION this feature adds. Only offered on the live whitelisted
                    pool; everything else stays vault-managed exactly as before. */}
                {oneSidedAvailable && (
                  <div className="act-row" style={{ marginTop: 8 }}>
                    <button
                      className="act-btn add"
                      data-testid="one-token-add"
                      onClick={() => { setDepositMode("one"); setActionTab("add"); }}
                    >
                      ◈ One-token add
                    </button>
                  </div>
                )}
                {/* Names the pool the vault ACTUALLY manages on this chain, from the resolved config,
                    rather than Robinhood's pair — on Arc the sentence said WETH/USDG about a pool that
                    holds neither token. */}
                {engineActionsAllowed(pool.serviceTag) && (
                  <p className="d" style={{ marginTop: 12 }}>
                    {isVaultPool
                      ? `${pool.token0.symbol}/${pool.token1.symbol} liquidity is auto-managed by the MoleSwap ALM vault on ${chainName} — deposit or exit there.`
                      : `The MoleSwap ALM vault on ${chainName} runs ${vaultPool?.label ?? "no pool"} — this pool is MoleHook-served, and the vault is where MoleSwap-managed liquidity lives.`}
                  </p>
                )}
              </>
            ) : (
              /* Add-liquidity form — reached via the live pool's "One-token add" button. The
                 "both tokens" mode remains the fail-closed ALM stub; the one-token mode signs
                 through lib/chain/amm.addLiquidityOneSided. */
              <div className="overflow-hidden rounded-lg border-3 border-[#3A1F0E] bg-gradient-to-b from-[#52301A] to-[#4A2C15]">
                <div className="flex items-center justify-between border-b-2 border-[#3A1F0E] bg-black/20 px-4 py-3">
                  <span className="font-display text-xl tracking-wider text-white">+ ADD LIQUIDITY</span>
                  <button onClick={() => { setActionTab(null); setAmount0(""); setAmount1(""); }} className="font-display cursor-pointer text-lg text-gray-300 hover:text-white">✕</button>
                </div>
                <div className="px-4 py-3">
                  {/* Deposit mode — Both tokens (default, unchanged) / One token (range beyond spot).
                      Same pattern as create-pool. One-sided is only offered on the whitelisted
                      WETH/USDG v4 pool, the only pool MolePositions.open accepts. */}
                  {oneSidedAvailable && (
                    <div className="relative mb-2 rounded px-3 py-2.5">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="font-display text-lg text-gray-200">DEPOSIT MODE</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button onClick={() => setDepositMode("both")}
                          className={`font-display cursor-pointer rounded-lg border-2 px-3 py-2 text-center text-sm tracking-wider transition-all ${
                            depositMode === "both" ? "border-[#6DBB3E] bg-[#6DBB3E]/10 text-[#6DBB3E]" : "border-[#3A1F0E] text-gray-300 hover:text-white"
                          }`}>BOTH TOKENS</button>
                        <button onClick={() => setDepositMode("one")}
                          className={`font-display cursor-pointer rounded-lg border-2 px-3 py-2 text-center text-sm tracking-wider transition-all ${
                            depositMode === "one" ? "border-[#FFD47A] bg-[#FFD47A]/10 text-[#FFD47A]" : "border-[#3A1F0E] text-gray-300 hover:text-white"
                          }`}>ONE TOKEN</button>
                      </div>
                      {depositMode === "one" && (
                        <>
                          {/* Which token funds the deposit */}
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            {([0, 1] as const).map((i) => (
                              <button key={i} onClick={() => setOneSide(i)}
                                className={`font-display cursor-pointer rounded-lg border-2 px-3 py-2 text-center text-sm tracking-wider transition-all ${
                                  oneSide === i ? "border-[#FFD47A] bg-[#FFD47A]/10 text-[#FFD47A]" : "border-[#3A1F0E] text-gray-300 hover:text-white"
                                }`}>{(i === 0 ? pool.token0 : pool.token1).symbol} ONLY</button>
                            ))}
                          </div>
                          {/* Range presets */}
                          <div className="mt-2 grid grid-cols-3 gap-2">
                            {([["launch", "LAUNCH"], ["tight", "TIGHT"], ["custom", "CUSTOM"]] as const).map(([k, l]) => (
                              <button key={k} onClick={() => setOneSidedPresetKey(k)}
                                className={`font-display cursor-pointer rounded-lg border-2 px-3 py-2 text-center text-sm tracking-wider transition-all ${
                                  oneSidedPresetKey === k ? "border-[#FFD47A] bg-[#FFD47A]/10 text-[#FFD47A]" : "border-[#3A1F0E] text-gray-300 hover:text-white"
                                }`}>{l}</button>
                            ))}
                          </div>
                          {oneSidedPresetKey === "custom" && (
                            <div className="mt-2 rounded border-2 border-[#3A1F0E] bg-black/20 px-3 py-2">
                              <div className="font-display mb-1 text-sm text-gray-300">RANGE WIDTH (TICKS)</div>
                              <input type="text" value={customWidth} onChange={e => setCustomWidth(e.target.value.replace(/[^0-9]/g, ""))}
                                placeholder={String(TIGHT_WIDTH_TICKS)}
                                className="font-display w-full bg-transparent text-lg text-[#FFD47A] placeholder:text-gray-500 focus:outline-none" />
                              <div className="font-display text-sm text-gray-400">{MIN_RANGE_WIDTH}–{MAX_RANGE_WIDTH} ticks, snapped to spacing</div>
                            </div>
                          )}
                          {/* Which side of spot the range sits on, and what that means */}
                          <div className="font-display mt-2 text-sm text-gray-300">
                            {oneSide === 0
                              ? `Deposits ${oneTok.symbol} only. Your range sits entirely ABOVE the current price — it earns nothing until the price rises into it, then sells ${oneTok.symbol} into ${otherTok.symbol}. None of your ${otherTok.symbol} is pulled.`
                              : `Deposits ${oneTok.symbol} only. Your range sits entirely BELOW the current price — it earns nothing until the price falls into it, then buys ${otherTok.symbol} with ${oneTok.symbol}. None of your ${otherTok.symbol} is pulled.`}
                            {oneSidedRange
                              ? ` Range: ticks ${oneSidedRange.tickLower} to ${oneSidedRange.tickUpper}.`
                              : " No legal range fits here right now."}
                          </div>
                          {oneSidedRange && (
                            <div className="mt-2">
                              <LiquidityGraph currentTick={currentTick} tickLower={oneSidedRange.tickLower} tickUpper={oneSidedRange.tickUpper} height={36} price={price} token0Symbol={pool.token0.symbol} token1Symbol={pool.token1.symbol} />
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {/* Token 0 input */}
                  <div className="relative mb-2 rounded px-3 py-2.5" style={off0 ? { opacity: 0.45 } : undefined}>
                    <div className="mb-1 flex justify-between">
                      <span className="font-display text-lg text-gray-200">{pool.token0.symbol}</span>
                      <span className={`font-display text-lg ${insufficientBalance0 && !off0 ? "text-red-400" : "text-gray-200"}`}>
                        BAL: {balance0 !== null ? Number(balance0).toFixed(4) : "..."}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <TokenIcon token={pool.token0} size={28} />
                      <input type="text" value={off0 ? "" : amount0} disabled={off0} onFocus={() => setInputFocused(0)}
                        onChange={e => {
                          const v = e.target.value.replace(/[^0-9.]/g, "");
                          // One-sided: no paired auto-fill — only the deposit token's amount matters.
                          if (depositMode === "one") setAmount0(v); else updateAmount1FromAmount0(v);
                        }} placeholder="0.0"
                        className="font-display w-full flex-1 bg-transparent text-2xl tracking-wider text-white placeholder:text-gray-600 focus:outline-none" />
                      {[{ l: "25%", v: 0.25 }, { l: "50%", v: 0.5 }, { l: "MAX", v: 1 }].map(p => (
                        <button key={p.l} disabled={off0} onClick={() => {
                          if (depositMode === "one") { if (balance0) setAmount0((Number(balance0) * p.v).toFixed(Math.min(pool.token0.decimals, 8))); }
                          else setPercentage0(p.v);
                        }} className="font-display text-peach-500 border-ground-button-border bg-ground-button-border cursor-pointer rounded-sm border px-2 py-1 text-sm disabled:cursor-not-allowed">{p.l}</button>
                      ))}
                    </div>
                    {insufficientBalance0 && !off0 && <div className="mt-1 flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-red-400" /><span className="font-display text-xs text-red-400">INSUFFICIENT {pool.token0.symbol} BALANCE</span></div>}
                  </div>

                  <div className="my-1 flex justify-center"><span className="font-display text-2xl text-gray-300">+</span></div>

                  {/* Token 1 input */}
                  <div className="relative mb-3 rounded px-3 py-2.5" style={off1 ? { opacity: 0.45 } : undefined}>
                    <div className="mb-1 flex justify-between">
                      <span className="font-display text-lg text-gray-200">{pool.token1.symbol}</span>
                      <span className={`font-display text-lg ${insufficientBalance1 && !off1 ? "text-red-400" : "text-gray-200"}`}>
                        BAL: {balance1 !== null ? Number(balance1).toFixed(4) : "..."}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <TokenIcon token={pool.token1} size={28} />
                      <input type="text" value={off1 ? "" : amount1} disabled={off1} onFocus={() => setInputFocused(1)}
                        onChange={e => {
                          const v = e.target.value.replace(/[^0-9.]/g, "");
                          if (depositMode === "one") setAmount1(v); else updateAmount0FromAmount1(v);
                        }} placeholder="0.0"
                        className="font-display w-full flex-1 bg-transparent text-2xl tracking-wider text-white placeholder:text-gray-600 focus:outline-none" />
                      {[{ l: "25%", v: 0.25 }, { l: "50%", v: 0.5 }, { l: "MAX", v: 1 }].map(p => (
                        <button key={p.l} disabled={off1} onClick={() => {
                          if (depositMode === "one") { if (balance1) setAmount1((Number(balance1) * p.v).toFixed(Math.min(pool.token1.decimals, 8))); }
                          else setPercentage1(p.v);
                        }} className="font-display text-peach-500 border-ground-button-border bg-ground-button-border cursor-pointer rounded-sm border px-2 py-1 text-sm disabled:cursor-not-allowed">{p.l}</button>
                      ))}
                    </div>
                    {insufficientBalance1 && !off1 && <div className="mt-1 flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-red-400" /><span className="font-display text-xs text-red-400">INSUFFICIENT {pool.token1.symbol} BALANCE</span></div>}
                  </div>

                  {/* Range selector — both-tokens mode only; a one-sided range is set by its preset. */}
                  {depositMode === "both" && (
                  <div className="relative mb-3 rounded px-3 py-2.5">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-display text-lg text-gray-200">SELECT RANGE</span>
                    </div>
                    <div className="mb-3 grid grid-cols-2 gap-2">
                      <button onClick={() => { setRangeMode("full"); setMinPrice(""); setMaxPrice(""); }}
                        className={`font-display cursor-pointer rounded-lg border-2 px-3 py-2 text-center text-sm tracking-wider transition-all ${
                          rangeMode === "full" ? "border-[#6DBB3E] bg-[#6DBB3E]/10 text-[#6DBB3E]" : "border-[#3A1F0E] text-gray-300 hover:text-white"
                        }`}>FULL RANGE</button>
                      <button onClick={() => setRangeMode("custom")}
                        className={`font-display cursor-pointer rounded-lg border-2 px-3 py-2 text-center text-sm tracking-wider transition-all ${
                          rangeMode === "custom" ? "border-[#FFD47A] bg-[#FFD47A]/10 text-[#FFD47A]" : "border-[#3A1F0E] text-gray-300 hover:text-white"
                        }`}>CUSTOM RANGE</button>
                    </div>

                    {rangeMode === "custom" && (
                      <div className="mb-2 grid grid-cols-2 gap-2">
                        <div className="rounded border-2 border-[#3A1F0E] bg-black/20 px-3 py-2">
                          <div className="font-display mb-1 text-sm text-gray-300">MIN PRICE</div>
                          <input type="text" value={minPrice} onChange={e => setMinPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                            placeholder="0" className="font-display w-full bg-transparent text-lg text-[#FFD47A] placeholder:text-gray-500 focus:outline-none" />
                          <div className="font-display text-sm text-gray-400">{pool.token1.symbol} per {pool.token0.symbol}</div>
                        </div>
                        <div className="rounded border-2 border-[#3A1F0E] bg-black/20 px-3 py-2">
                          <div className="font-display mb-1 text-sm text-gray-300">MAX PRICE</div>
                          <input type="text" value={maxPrice} onChange={e => setMaxPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                            placeholder="∞" className="font-display w-full bg-transparent text-lg text-[#FFD47A] placeholder:text-gray-500 focus:outline-none" />
                          <div className="font-display text-sm text-gray-400">{pool.token1.symbol} per {pool.token0.symbol}</div>
                        </div>
                      </div>
                    )}

                    <div className="mb-1.5 flex justify-between">
                      <span className="font-display text-sm text-[#E8A849]">YOUR RANGE</span>
                      <span className={`font-display text-sm ${rangeMode === "full" ? "text-[#6DBB3E]" : "text-[#FFD47A]"}`}>
                        {rangeMode === "full" ? "● FULL RANGE" : "◆ CUSTOM"}
                      </span>
                    </div>
                    <LiquidityGraph currentTick={currentTick} tickLower={selectedTickLower} tickUpper={selectedTickUpper} height={36} price={price} token0Symbol={pool.token0.symbol} token1Symbol={pool.token1.symbol} />
                  </div>
                  )}

                  {/* Info rows */}
                  <div className="relative mb-3 rounded px-3 py-2">
                    {[
                      ["PRICE", `1 ${pool.token0.symbol} = ${priceUsable ? price.toFixed(4) : "N/A"} ${pool.token1.symbol}`, "text-peach-300"],
                      ["FEE TIER", feeLabel(pool.fee), "text-peach-300"],
                      ["DEPOSIT", depositMode === "one" ? `${oneTok.symbol} ONLY (${oneSide === 0 ? "ABOVE" : "BELOW"} SPOT)` : "BOTH TOKENS", depositMode === "one" ? "text-[#FFD47A]" : "text-[#6DBB3E]"],
                      ["RANGE",
                        depositMode === "one"
                          ? (oneSidedRange ? `TICKS ${oneSidedRange.tickLower} → ${oneSidedRange.tickUpper}` : "—")
                          : rangeMode === "full" ? "FULL RANGE" : `${minPrice || "0"} — ${maxPrice || "∞"} ${pool.token1.symbol}`,
                        depositMode === "one" ? "text-[#FFD47A]" : rangeMode === "full" ? "text-[#6DBB3E]" : "text-[#FFD47A]"],
                      ["SLIPPAGE", depositMode === "one" ? "N/A (NO SWAP)" : "0.5%", "text-gray-200"],
                      ["ON-CHAIN", pool.active ? "LIVE ✓" : "NO LIQUIDITY", pool.active ? "text-[#6DBB3E]" : "text-red-400"],
                    ].map(([k, v, c]) => (
                      <div key={k} className="flex justify-between py-0.5">
                        <span className="font-display text-base text-gray-200">{k}</span>
                        <span className={`font-display text-base ${c || "text-peach-300"}`}>{v}</span>
                      </div>
                    ))}
                    {/* The hook's TWAP mid with its observation age — the number the vault re-centres on
                        and the queue crosses at. Stale = the last tick, extended, not an average. */}
                    {isVaultPool && (
                      <div className="flex items-center justify-between py-0.5">
                        <span className="font-display text-base text-gray-200">ORACLE</span>
                        <span className={`font-display flex items-center gap-2 text-base ${oracle?.stale ? "text-red-400" : "text-[#5b9bd5]"}`}>
                          {oracle?.mid != null ? `TWAP TICK ${oracle.mid}` : "—"}
                          {oracle?.stale && <OracleStaleBadge ageSec={oracle.ageSec} />}
                        </span>
                      </div>
                    )}
                  </div>

                  <button
                    onClick={
                      depositMode === "one"
                        ? (oneInsufficient ? () => router.push(getMissingTokenSwapUrl(oneTok)) : handleAddLiquidityOneSided)
                        : (missingToken ? () => router.push(getMissingTokenSwapUrl(missingToken)) : handleAddLiquidity)
                    }
                    disabled={depositMode === "one" ? (!oneInsufficient && !canSubmitOneSided) : (!missingToken && !canSubmit)}
                    className={`font-display w-full cursor-pointer rounded-lg px-6 py-3 text-xl tracking-wider transition-all hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50 ${
                      (depositMode === "one" ? oneInsufficient : missingToken)
                        ? "bg-peach-500 text-black shadow-[0px_-4px_0px_0px_#C97E00_inset,0px_4px_0px_0px_rgba(255,212,122,0.6)_inset]"
                        : "bg-[#6DBB3E] text-white shadow-[0px_-4px_0px_0px_#4A8B29_inset,0px_4px_0px_0px_rgba(255,255,255,0.3)_inset]"
                    }`}>
                    {depositMode === "one" ? getOneSidedButtonLabel() : getButtonLabel()}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
