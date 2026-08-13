"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NavBar, BackgroundImage, MoleMascot } from "../shared";
import { RefreshCw, Plus, Minus, ArrowUpRight, ChevronDown, AlertTriangle, Loader2 } from "lucide-react";
import { useWalletContext, useChainClient, WalletUI } from "@/lib/chain/provider";
import { useWallet } from "@/lib/chain/provider";
import { loadLivePools, tvlUsd as calcTvlUsd } from "@/lib/chain/livePools";
import {
  CONTRACTS, TOKENS, POOLS as AMM_POOLS,
  getTokenByAddress, findPool,
  getSwapQuote, getProvider,
  getPoolDisplayInfo,
  AMM_ROUTER, AMM_FACTORY, RH_CHAIN_ID,
  type TokenInfo, type PoolInfo,
} from "@/lib/chain/amm";
import { ethers } from "ethers";
import { createClient } from "@/lib/supabase/client";

/**
 * Real 24h volume + fees per pool from the swap-event indexer (mp_pool_volume_24h, read with the anon
 * key — public data). Returns a map keyed by lowercased pool address. Empty on any error, so the pools
 * page still renders (volume just shows as "—" rather than a fabricated number).
 */
async function fetchPoolVolumes(addresses: string[]): Promise<Map<string, { vol: number; fees: number; swaps: number }>> {
  const out = new Map<string, { vol: number; fees: number; swaps: number }>();
  try {
    const sb = createClient();
    const { data } = await sb
      .from("mp_pool_volume_24h")
      .select("pool,volume_usd,fees_usd,swaps")
      .in("pool", addresses.map((a) => a.toLowerCase()));
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
 * Build a /dapp URL that pre-selects `from` → `to` on Robinhood Chain. Used by the
 * zero-balance CTA in PoolDetail — if the user lacks one of a pool's tokens,
 * clicking "GET X" takes them to the swap page with the route already wired.
 */
function getSwapUrl(fromAddress: string, toAddress: string): string {
  const cid = String(RH_CHAIN_ID);
  const params = new URLSearchParams({ from: fromAddress, fromChainId: cid, to: toAddress, toChainId: cid });
  return `/dapp?${params.toString()}`;
}

const fmtFee = (n: number): string => {
  if (n === 0) return "0.00";
  return n.toFixed(20).replace(/\.?0+$/, "");
};

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

const chainColors: Record<string, string> = {
  "Robinhood Chain": "#D548EC",
};

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
  price: number;
  liquidity: string;
  feeApy: number;
  vol24h: number;
  fees24h: number;
  category?: string;
  active: boolean;
}

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];

const ERC20_BAL_ABI = [
  "function balanceOf(address account) view returns (uint256)",
];

function sqrtPriceToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const PRECISION = 10n ** 18n;
  const Q192 = 2n ** 192n;
  const sqr = sqrtPriceX96 * sqrtPriceX96;
  const rawPrice = (sqr * PRECISION) / Q192;
  const decimalAdj = decimals0 - decimals1;
  const price = Number(rawPrice) / 1e18 * (10 ** decimalAdj);
  return price;
}

function calcTvl(reserve0: number, reserve1: number, price: number): number {
  if (!Number.isFinite(price) || price <= 0) return reserve1 * 2;
  const val0InToken1 = reserve0 * price;
  const tvl = val0InToken1 + reserve1;
  if (!Number.isFinite(tvl) || tvl < 0) return reserve1 * 2;
  return tvl;
}

async function fetchPoolData(): Promise<PoolDisplay[]> {
  // MoleSwap's own v4 pools, priced server-side. A v4 pool has no address to call slot0() on and no
  // per-pool token balance — its state lives in the PoolManager singleton keyed by PoolId, and its
  // TVL is derived from the open positions. That work belongs in one place, so this page consumes
  // /api/v1/pools rather than reimplementing it against a pool address that does not exist.
  const res = await fetch("/api/v1/pools", { cache: "no-store" });
  if (!res.ok) return [];
  const json = await res.json();
  const pools: any[] = json?.data?.pools || [];
  if (!pools.length) return [];

  // Real 24h volume/fees where the indexer has them, keyed by pool id.
  let volumes = new Map<string, { vol: number; fees: number }>();
  try {
    volumes = await fetchPoolVolumes(pools.map((p) => p.poolId));
  } catch { /* volume is optional — a pool with no indexed swaps shows "—", never a made-up number */ }

  return pools.map((p) => {
    const t0: TokenInfo = {
      address: p.token0.address, symbol: p.token0.symbol, name: p.token0.name,
      decimals: p.token0.decimals, sourceChain: "Robinhood Chain", logoURI: p.token0.logoURI || "",
    } as TokenInfo;
    const t1: TokenInfo = {
      address: p.token1.address, symbol: p.token1.symbol, name: p.token1.name,
      decimals: p.token1.decimals, sourceChain: "Robinhood Chain", logoURI: p.token1.logoURI || "",
    } as TokenInfo;

    const vlm = volumes.get(String(p.poolId).toLowerCase());
    const vol24h = vlm?.vol ?? 0;
    const fees24h = vlm?.fees ?? 0;
    const tvl = Number(p.tvlUsd) || 0;

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
      price: 0,
      liquidity: String(p.liquidity),
      feeApy: tvl >= APY_MIN_TVL_USD && fees24h > 0 ? (fees24h / tvl) * 365 * 100 : 0,
      vol24h,
      fees24h,
      active: !!p.hasLiquidity,
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

const PoolsContent = () => {
  const walletCtx = useWalletContext();
  const { chainClient } = useChainClient();
  const isConnected = walletCtx?.connectionStatus === WalletUI.CONSTANTS.CONNECTION.STATUS.CONNECTED;
  const { address } = useWallet();

  const [tab, setTab] = useState<"markets" | "positions">("markets");
  const [selectedPool, setSelectedPool] = useState<PoolDisplay | null>(null);
  const [sort, setSort] = useState<"tvl" | "apy" | "vol">("tvl");
  const [category, setCategory] = useState("all");
  const [loading, setLoading] = useState(true);
  const [pools, setPools] = useState<PoolDisplay[]>([]);
  const [positions, setPositions] = useState<LiquidityPosition[]>([]);
  const [posLoading, setPosLoading] = useState(false);

  const loadPools = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchPoolData();
      setPools(data);
    } catch (err) {
      console.error("Failed to fetch pool data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPositions = useCallback(async () => {
    if (!address) return;
    setPosLoading(true);
    try {
      // The only user LP venue on this deployment is the v4 ALM vault (WETH/USDG). Read the real ALM
      // positions and map them into the shape this tab renders; the enrichment effect below then computes
      // real token amounts from the pool's slot0. (getUserPositions in amm.ts is a fail-closed stub.)
      const { getAlmPositions } = await import("@/lib/mole/vault");
      const alm = await getAlmPositions(address);
      const wethUsdg = AMM_POOLS[0];
      const mapped = alm.map((p) => ({
        tokenId: p.id,
        token0: wethUsdg.token0,
        token1: wethUsdg.token1,
        fee: wethUsdg.fee,
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
  }, [address]);

  useEffect(() => { loadPools(); }, [loadPools]);
  useEffect(() => { if (tab === "positions" && address) loadPositions(); }, [tab, address, loadPositions]);

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

      {selectedPool ? (
        <PoolDetail pool={selectedPool} onBack={() => setSelectedPool(null)} address={address} isConnected={isConnected} walletCtx={walletCtx} chainClient={chainClient} />
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
                <div className="t2">Fetching from Robinhood Chain</div>
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
                        <Badge chain="Robinhood Chain" />
                        <span className="fee">{(p.fee / 10000).toFixed(2)}%</span>
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
                  {/* Let the link go to the vault without also opening the detail view. */}
                  <Link href="/vault" className="liq-btn" onClick={(e) => e.stopPropagation()}>
                    + Liquidity
                  </Link>
                </div>
              ))
            )}
          </div>
        </>
      ) : (
        /* ═══ POSITIONS TAB ═══ */
        <PositionsTab
          positions={positions}
          loading={posLoading}
          isConnected={isConnected}
          walletCtx={walletCtx}
          chainClient={chainClient}
          address={address}
          onRefresh={loadPositions}
          onGoToMarkets={() => setTab("markets")}
        />
      )}

      <p className="foot-cap">Concentrated liquidity on Robinhood Chain — best execution via the MoleSwap aggregator</p>
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

      {hovered !== null && price && height > 50 && (() => {
        const bd = getBarData(hovered);
        const leftPct = (hovered / (bars - 1)) * 100;
        return (
          <div className="lg-tip" style={{ left: `${Math.min(Math.max(leftPct, 15), 85)}%`, transform: "translateX(-50%) translateY(-4px)" }}>
            <div className="l1">{bd.barPrice > 1000 ? fmt(bd.barPrice) : bd.barPrice.toFixed(2)} {token1Symbol || ""}</div>
            <div className="l2">LIQ: {bd.liq.toFixed(0)}%</div>
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
  const feeTier = `${(pos.fee / 10000).toFixed(2)}%`;
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
              <span className="v">{ep ? ep.amount0.toFixed(ep.amount0 < 0.01 ? 6 : 4) : "..."}</span>
            </div>
            <div className="p-row">
              <span className="k" style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><TokenIcon token={t1} size={16} />{t1.symbol}</span>
              <span className="v">{ep ? ep.amount1.toFixed(ep.amount1 < 0.01 ? 6 : 4) : "..."}</span>
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
            {ep ? `${(ep.amount0 + fees0).toFixed(4)} ${t0.symbol} + ${(ep.amount1 + fees1).toFixed(4)} ${t1.symbol}` : "..."}
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
  const feeTier = `${(pos.fee / 10000).toFixed(2)}%`;
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
const PositionsTab = ({ positions, loading, isConnected, walletCtx, chainClient, address, onRefresh, onGoToMarkets }: {
  positions: LiquidityPosition[]; loading: boolean; isConnected: boolean; walletCtx: any; chainClient: any; address: string | null;
  onRefresh: () => void; onGoToMarkets: () => void;
}) => {
  const [removing, setRemoving] = useState<number | null>(null);
  const [collecting, setCollecting] = useState<number | null>(null);
  const [txMsg, setTxMsg] = useState<string | null>(null);
  const [enriched, setEnriched] = useState<EnrichedPosition[]>([]);
  const [enriching, setEnriching] = useState(false);
  const [removeModal, setRemoveModal] = useState<LiquidityPosition | null>(null);
  const [collectModal, setCollectModal] = useState<LiquidityPosition | null>(null);

  useEffect(() => {
    if (positions.length === 0) { setEnriched([]); return; }
    let cancelled = false;
    (async () => {
      setEnriching(true);
      try {
        const provider = getProvider();
        const enrichedList: EnrichedPosition[] = [];
        for (const pos of positions) {
          const t0 = pos.token0Info || getTokenByAddress(pos.token0);
          const t1 = pos.token1Info || getTokenByAddress(pos.token1);
          const poolInfo = pos.poolInfo || findPool(pos.token0, pos.token1);
          let currentTick = 0;
          let poolAddress = poolInfo?.address || "";
          if (poolAddress) {
            try {
              const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
              const slot0 = await poolContract.slot0();
              currentTick = Number(slot0[1]);
            } catch {}
          }
          const { amount0, amount1 } = getTokenAmounts(
            BigInt(pos.liquidity), pos.tickLower, pos.tickUpper, currentTick,
            t0?.decimals || 18, t1?.decimals || 18
          );
          enrichedList.push({ ...pos, amount0, amount1, currentTick, feeTier: `${(pos.fee / 10000).toFixed(2)}%`, poolAddress });
        }
        if (!cancelled) setEnriched(enrichedList);
      } catch (err) { console.error("Failed to enrich positions:", err); }
      finally { if (!cancelled) setEnriching(false); }
    })();
    return () => { cancelled = true; };
  }, [positions]);

  const handleRemove = async (pos: LiquidityPosition) => {
    if (!address || removing) return;
    setRemoving(pos.tokenId);
    setRemoveModal(null);
    setTxMsg("Exiting position...");
    try {
      // ALM positions exit via the verified-safe withdrawAll(id) — reads liquidity inside the call.
      const { almWithdraw } = await import("@/lib/mole/vault");
      const result = await almWithdraw(pos.tokenId);
      setTxMsg(result.success ? "Position exited!" : (result.error || "Failed"));
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

      {/* Portfolio Summary */}
      <div className="p-grid p-3">
        <div className="p-card tight">
          <div className="sm-lbl">Total deposited</div>
          <div className="sm-val mono">
            {enriched.length > 0 ? `${enriched.reduce((s, e) => s + e.amount0, 0).toFixed(4)} / ${enriched.reduce((s, e) => s + e.amount1, 0).toFixed(4)}` : "..."}
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
                    <Badge chain="Robinhood Chain" />
                    {t0 && t0.sourceChain !== "Robinhood Chain" && (
                      <span className="badge2">bridged from {t0.sourceChain}</span>
                    )}
                    <span className="fee">{ep?.feeTier || `${(pos.fee / 10000).toFixed(2)}%`}</span>
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
                      <span className="v">
                        {item.amt !== undefined ? item.amt.toFixed(item.amt < 0.01 ? 6 : 4) : "..."}
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
const PoolDetail = ({ pool, onBack, address, isConnected, walletCtx, chainClient }: {
  pool: PoolDisplay; onBack: () => void; address: string | null; isConnected: boolean; walletCtx: any; chainClient: any;
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
  const [currentTick, setCurrentTick] = useState(0);
  const [rangeMode, setRangeMode] = useState<"full" | "custom">("full");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");

  useEffect(() => {
    if (!address) return;
    const fetchBalances = async () => {
      try {
        const provider = getProvider();
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
  }, [address, pool]);

  useEffect(() => {
    (async () => {
      try {
        const provider = getProvider();
        const poolContract = new ethers.Contract(pool.pool.address, POOL_ABI, provider);
        const slot0 = await poolContract.slot0();
        setCurrentTick(Number(slot0[1]));
      } catch {}
    })();
  }, [pool]);

  const priceUsable = Number.isFinite(pool.price) && pool.price > 0;
  const updateAmount1FromAmount0 = (val: string) => {
    setAmount0(val);
    if (inputFocused === 0 && priceUsable && val && !isNaN(Number(val)) && Number(val) > 0) {
      setAmount1((Number(val) * pool.price).toFixed(Math.min(pool.token1.decimals, 8)));
    } else if (!val) setAmount1("");
  };
  const updateAmount0FromAmount1 = (val: string) => {
    setAmount1(val);
    if (inputFocused === 1 && priceUsable && val && !isNaN(Number(val)) && Number(val) > 0) {
      setAmount0((Number(val) / pool.price).toFixed(Math.min(pool.token0.decimals, 8)));
    } else if (!val) setAmount0("");
  };
  const setPercentage0 = (pct: number) => { if (!balance0) return; setInputFocused(0); updateAmount1FromAmount0((Number(balance0) * pct).toFixed(Math.min(pool.token0.decimals, 8))); };
  const setPercentage1 = (pct: number) => { if (!balance1) return; setInputFocused(1); updateAmount0FromAmount1((Number(balance1) * pct).toFixed(Math.min(pool.token1.decimals, 8))); };

  const insufficientBalance0 = amount0 && balance0 && Number(amount0) > Number(balance0);
  const insufficientBalance1 = amount1 && balance1 && Number(amount1) > Number(balance1);
  const hasInsufficientBalance = insufficientBalance0 || insufficientBalance1;
  const canSubmit = amount0 && amount1 && Number(amount0) > 0 && Number(amount1) > 0 && !hasInsufficientBalance && !loading;

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
    return getSwapUrl(other.address, missing.address);
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
        amount0Desired: amount0Wei, amount1Desired: amount1Wei, recipient: address,
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

  const priceStr = Number.isFinite(pool.price) ? (pool.price > 1000 ? fmt(pool.price) : pool.price < 0.001 ? pool.price.toExponential(2) : pool.price.toFixed(4)) : "N/A";

  return (
    <div>
      {/* Header */}
      <button className="backlink" onClick={onBack}>← Back</button>
      <div className="det-head">
        <TokenPair t0={pool.token0} t1={pool.token1} size={32} />
        <h2>
          {getPoolDisplayInfo(pool.token0).symbol}/{getPoolDisplayInfo(pool.token1).symbol}
        </h2>
        <Badge chain="Robinhood Chain" />
        {pool.token0.sourceChain !== "Robinhood Chain" && (
          <span className="badge2">bridged from {pool.token0.sourceChain}</span>
        )}
        <span className="badge2">Fee {(pool.fee / 10000).toFixed(2)}%</span>
      </div>

      {/* Stats row */}
      <div className="p-grid p-3">
        {[
          { l: "TVL", v: `$${fmt(pool.tvl)}`, cls: "" },
          { l: "24h vol", v: pool.vol24h > 0 ? `$${fmt(pool.vol24h)}` : "—", cls: "" },
          { l: "APY", v: pool.feeApy > 0 ? `${pool.feeApy.toFixed(pool.feeApy >= 100 ? 0 : 1)}%` : "—", cls: pool.feeApy > 0 ? "pos" : "" },
          { l: "Fee tier", v: `${(pool.fee / 10000).toFixed(2)}%`, cls: "pos" },
          { l: "Price", v: pool.price > 0 ? `$${fmt(pool.price)}` : "—", cls: "" },
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
                <Badge chain="Robinhood Chain" />
              </div>
              <div className="sm-lbl" style={{ marginTop: 14 }}>Pooled amount</div>
              <div className="sm-val mono">{item.reserve}</div>
            </div>
          );
        })}
      </div>

      {/* Liquidity Distribution Graph */}
      <div className="p-card" style={{ marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h3>Liquidity distribution</h3>
          <span className="p-mini" style={{ color: "var(--clay)", fontWeight: 700 }}>
            1 {pool.token0.symbol} = {priceStr} {pool.token1.symbol}
          </span>
        </div>
        <LiquidityGraph currentTick={currentTick} tickLower={-887272} tickUpper={887272} height={80} price={pool.price} token0Symbol={pool.token0.symbol} token1Symbol={pool.token1.symbol} />
        <div className="lg-foot">
          <span>MIN: 0</span>
          <span className="in">● IN RANGE — FULL</span>
          <span>MAX: ∞</span>
        </div>
      </div>

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
                {txHash && (
                  <a href={`https://robinhoodchain.blockscout.com/tx/${txHash}`} target="_blank" rel="noopener noreferrer" className="linkish" style={{ display: "block", marginTop: 6 }}>
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
                <div className="act-row">
                  <button className="act-btn add" onClick={() => router.push("/vault")}>
                    + Add liquidity
                  </button>
                  <button className="act-btn rem" onClick={() => router.push("/vault")}>
                    − Remove liquidity
                  </button>
                </div>
                <p className="d" style={{ marginTop: 12 }}>
                  WETH/USDG liquidity is auto-managed by the MoleSwap ALM vault — deposit or exit there.
                </p>
              </>
            ) : (
              /* Unreachable add-liquidity form (nothing sets actionTab to "add") — logic kept
                 as-is; not ported to Burrow beyond compiling without the pixel-art assets. */
              <div className="overflow-hidden rounded-lg border-3 border-[#3A1F0E] bg-gradient-to-b from-[#52301A] to-[#4A2C15]">
                <div className="flex items-center justify-between border-b-2 border-[#3A1F0E] bg-black/20 px-4 py-3">
                  <span className="font-display text-xl tracking-wider text-white">+ ADD LIQUIDITY</span>
                  <button onClick={() => { setActionTab(null); setAmount0(""); setAmount1(""); }} className="font-display cursor-pointer text-lg text-gray-300 hover:text-white">✕</button>
                </div>
                <div className="px-4 py-3">
                  {/* Token 0 input */}
                  <div className="relative mb-2 rounded px-3 py-2.5">
                    <div className="mb-1 flex justify-between">
                      <span className="font-display text-lg text-gray-200">{pool.token0.symbol}</span>
                      <span className={`font-display text-lg ${insufficientBalance0 ? "text-red-400" : "text-gray-200"}`}>
                        BAL: {balance0 !== null ? Number(balance0).toFixed(4) : "..."}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <TokenIcon token={pool.token0} size={28} />
                      <input type="text" value={amount0} onFocus={() => setInputFocused(0)} onChange={e => updateAmount1FromAmount0(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0"
                        className="font-display w-full flex-1 bg-transparent text-2xl tracking-wider text-white placeholder:text-gray-600 focus:outline-none" />
                      {[{ l: "25%", v: 0.25 }, { l: "50%", v: 0.5 }, { l: "MAX", v: 1 }].map(p => (
                        <button key={p.l} onClick={() => setPercentage0(p.v)} className="font-display text-peach-500 border-ground-button-border bg-ground-button-border cursor-pointer rounded-sm border px-2 py-1 text-sm">{p.l}</button>
                      ))}
                    </div>
                    {insufficientBalance0 && <div className="mt-1 flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-red-400" /><span className="font-display text-xs text-red-400">INSUFFICIENT {pool.token0.symbol} BALANCE</span></div>}
                  </div>

                  <div className="my-1 flex justify-center"><span className="font-display text-2xl text-gray-300">+</span></div>

                  {/* Token 1 input */}
                  <div className="relative mb-3 rounded px-3 py-2.5">
                    <div className="mb-1 flex justify-between">
                      <span className="font-display text-lg text-gray-200">{pool.token1.symbol}</span>
                      <span className={`font-display text-lg ${insufficientBalance1 ? "text-red-400" : "text-gray-200"}`}>
                        BAL: {balance1 !== null ? Number(balance1).toFixed(4) : "..."}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <TokenIcon token={pool.token1} size={28} />
                      <input type="text" value={amount1} onFocus={() => setInputFocused(1)} onChange={e => updateAmount0FromAmount1(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0"
                        className="font-display w-full flex-1 bg-transparent text-2xl tracking-wider text-white placeholder:text-gray-600 focus:outline-none" />
                      {[{ l: "25%", v: 0.25 }, { l: "50%", v: 0.5 }, { l: "MAX", v: 1 }].map(p => (
                        <button key={p.l} onClick={() => setPercentage1(p.v)} className="font-display text-peach-500 border-ground-button-border bg-ground-button-border cursor-pointer rounded-sm border px-2 py-1 text-sm">{p.l}</button>
                      ))}
                    </div>
                    {insufficientBalance1 && <div className="mt-1 flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-red-400" /><span className="font-display text-xs text-red-400">INSUFFICIENT {pool.token1.symbol} BALANCE</span></div>}
                  </div>

                  {/* Range selector */}
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
                    <LiquidityGraph currentTick={currentTick} tickLower={selectedTickLower} tickUpper={selectedTickUpper} height={36} price={pool.price} token0Symbol={pool.token0.symbol} token1Symbol={pool.token1.symbol} />
                  </div>

                  {/* Info rows */}
                  <div className="relative mb-3 rounded px-3 py-2">
                    {[
                      ["PRICE", `1 ${pool.token0.symbol} = ${pool.price > 0 ? pool.price.toFixed(4) : "N/A"} ${pool.token1.symbol}`, "text-peach-300"],
                      ["FEE TIER", `${(pool.fee / 10000).toFixed(2)}%`, "text-peach-300"],
                      ["RANGE", rangeMode === "full" ? "FULL RANGE" : `${minPrice || "0"} — ${maxPrice || "∞"} ${pool.token1.symbol}`, rangeMode === "full" ? "text-[#6DBB3E]" : "text-[#FFD47A]"],
                      ["SLIPPAGE", "0.5%", "text-gray-200"],
                      ["ON-CHAIN", pool.active ? "LIVE ✓" : "NO LIQUIDITY", pool.active ? "text-[#6DBB3E]" : "text-red-400"],
                    ].map(([k, v, c]) => (
                      <div key={k} className="flex justify-between py-0.5">
                        <span className="font-display text-base text-gray-200">{k}</span>
                        <span className={`font-display text-base ${c || "text-peach-300"}`}>{v}</span>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={missingToken ? () => router.push(getMissingTokenSwapUrl(missingToken)) : handleAddLiquidity}
                    disabled={!missingToken && !canSubmit}
                    className={`font-display w-full cursor-pointer rounded-lg px-6 py-3 text-xl tracking-wider transition-all hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50 ${
                      missingToken
                        ? "bg-peach-500 text-black shadow-[0px_-4px_0px_0px_#C97E00_inset,0px_4px_0px_0px_rgba(255,212,122,0.6)_inset]"
                        : "bg-[#6DBB3E] text-white shadow-[0px_-4px_0px_0px_#4A8B29_inset,0px_4px_0px_0px_rgba(255,255,255,0.3)_inset]"
                    }`}>
                    {getButtonLabel()}
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
