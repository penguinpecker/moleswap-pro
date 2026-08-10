"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NavBar, BackgroundImage } from "../shared";
import { RefreshCw, Plus, Minus, ArrowUpRight, ChevronDown, AlertTriangle, Loader2 } from "lucide-react";
import { useWalletContext, useChainClient, WalletUI } from "@/lib/chain/provider";
import { useWallet } from "@/lib/chain/provider";
import {
  CONTRACTS, TOKENS, POOLS as AMM_POOLS,
  getTokenByAddress, findPool,
  getSwapQuote, getProvider,
  getPoolDisplayInfo,
  AMM_ROUTER, AMM_FACTORY, RH_CHAIN_ID,
  type TokenInfo, type PoolInfo,
} from "@/lib/chain/amm";
import { ethers } from "ethers";

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
  const provider = getProvider();

  const results = await Promise.allSettled(
    AMM_POOLS.map(async (pool) => {
      const t0 = TOKENS.find(t => t.address.toLowerCase() === pool.token0.toLowerCase());
      const t1 = TOKENS.find(t => t.address.toLowerCase() === pool.token1.toLowerCase());
      if (!t0 || !t1) return null;

      const poolContract = new ethers.Contract(pool.address, POOL_ABI, provider);
      const token0Contract = new ethers.Contract(pool.token0, ERC20_BAL_ABI, provider);
      const token1Contract = new ethers.Contract(pool.token1, ERC20_BAL_ABI, provider);

      const [slot0, liquidity, bal0, bal1] = await Promise.all([
        poolContract.slot0(),
        poolContract.liquidity(),
        token0Contract.balanceOf(pool.address),
        token1Contract.balanceOf(pool.address),
      ]);

      const sqrtPriceX96 = slot0[0];
      const hasLiquidity = liquidity > 0n;

      const reserve0 = Number(ethers.formatUnits(bal0, t0.decimals));
      const reserve1 = Number(ethers.formatUnits(bal1, t1.decimals));

      const price = sqrtPriceToPrice(sqrtPriceX96, t0.decimals, t1.decimals);
      const tvl = calcTvl(reserve0, reserve1, price);

      // No fabricated volume/APY — the UI shows only real fields (TVL, fee tier, price, liquidity).
      // Real 24h volume/APY needs a swap-event indexer (TODO); these stay 0 rather than invented.
      const feeApy = 0;
      const vol24h = 0;
      const fees24h = 0;

      return {
        name: pool.name,
        token0: t0,
        token1: t1,
        pool,
        fee: pool.fee,
        tvl,
        reserve0: reserve0.toFixed(4),
        reserve1: reserve1.toFixed(4),
        price,
        liquidity: liquidity.toString(),
        feeApy,
        vol24h,
        fees24h,
        active: hasLiquidity,
      } as PoolDisplay;
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<PoolDisplay | null> => r.status === "fulfilled")
    .map(r => r.value)
    .filter(Boolean) as PoolDisplay[];
}

const Badge = ({ chain }: { chain: string }) => {
  const c = chainColors[chain] || "#D548EC";
  return (
    <span
      className="font-family-ThaleahFat rounded-sm px-1.5 py-px text-sm tracking-wider"
      style={{ color: c, background: c + "22", border: `1px solid ${c}33` }}
    >
      {chain.toUpperCase()}
    </span>
  );
};

const TokenIcon = ({ token, size = 28 }: { token: TokenInfo; size?: number }) => {
  const [err, setErr] = useState(false);
  if (err || !token.logoURI) {
    return (
      <div
        className="bg-ground-button border-ground-button-border flex items-center justify-center rounded border-2"
        style={{ width: size, height: size }}
      >
        <span className="font-family-ThaleahFat text-peach-300" style={{ fontSize: size * 0.35 }}>
          {token.symbol.slice(0, 2)}
        </span>
      </div>
    );
  }
  return (
    <img
      src={token.logoURI}
      alt={token.symbol}
      width={size}
      height={size}
      className="border-ground-button-border rounded border-2"
      onError={() => setErr(true)}
    />
  );
};

const TokenPair = ({ t0, t1, size = 28 }: { t0: TokenInfo; t1: TokenInfo; size?: number }) => (
  <div className="flex items-center">
    <TokenIcon token={t0} size={size} />
    <div style={{ marginLeft: -size * 0.25, zIndex: 1 }}>
      <TokenIcon token={t1} size={size * 0.7} />
    </div>
  </div>
);

const PoolsPage = () => (
  <div className="relative flex min-h-screen w-full flex-col items-center">
    <BackgroundImage />
    <div className="relative z-50 mx-auto mt-4 block w-full px-2 sm:px-4">
      <NavBar />
    </div>
    <div className="relative z-20 mt-2 flex w-full flex-1 justify-center">
      <PoolsContent />
    </div>
  </div>
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

const PoolsContent = () => {
  const walletCtx = useWalletContext();
  const { chainClient } = useChainClient();
  const isConnected = walletCtx?.connectionStatus === WalletUI.CONSTANTS.CONNECTION.STATUS.CONNECTED;
  const { address } = useWallet();

  const [tab, setTab] = useState<"markets" | "positions">("markets");
  const [selectedPool, setSelectedPool] = useState<PoolDisplay | null>(null);
  const [sort, setSort] = useState<"tvl" | "apy" | "vol">("tvl");
  const [chainFilter, setChainFilter] = useState("all");
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
  const filtered = pools.filter(p => chainFilter === "all" || p.token0.sourceChain === chainFilter);
  const sorted = [...filtered].sort((a, b) =>
    sort === "tvl" ? b.tvl - a.tvl : sort === "apy" ? a.fee - b.fee : b.price - a.price
  );

  const totalTvl = pools.reduce((s, p) => s + p.tvl, 0);
  // Real, cheap-to-read aggregates only (no fabricated volume/APY — those need a swap-event indexer).
  const deepestTvl = pools.length > 0 ? Math.max(...pools.map((p) => p.tvl)) : 0;
  const feeTiers = [...new Set(pools.map((p) => p.fee))].sort((a, b) => a - b);
  const feeRange =
    feeTiers.length === 0 ? "—" : feeTiers.length === 1 ? `${(feeTiers[0] / 10000).toFixed(2)}%`
      : `${(feeTiers[0] / 10000).toFixed(2)}–${(feeTiers[feeTiers.length - 1] / 10000).toFixed(2)}%`;

  const tabClass = (t: string) =>
    `font-family-ThaleahFat text-shadow-black px-4 py-1 rounded-full text-base sm:text-2xl sm:px-6 transition-colors duration-150 cursor-pointer ${
      tab === t
        ? "bg-ground-button border-3 sm:border-4 border-ground-button-border text-peach-400"
        : "text-gray-200 hover:text-yellow-200 border-3 sm:border-4 border-transparent"
    }`;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-2 sm:px-6">
      <div className="relative z-10 mx-auto mt-2 w-[90%] rounded-lg px-4 py-3 text-center sm:w-[85%] sm:px-6 sm:py-4">
        <h1 className="text-peach-300 text-shadow-header font-family-ThaleahFat text-2xl font-bold tracking-widest uppercase sm:text-5xl">
          LIQUIDITY POOLS
        </h1>
        <p className="font-family-ThaleahFat mt-1 text-base tracking-wider text-gray-200 sm:text-lg">
          ROBINHOOD CHAIN — AGGREGATED ACROSS EVERY VENUE
        </p>
        <Image
          src="/quest/header-quest-bg.png" alt="Header" width={200} height={200}
          className="absolute inset-0 left-0 z-[-1] h-full w-full"
        />
      </div>

      <div className="relative mb-6 h-full min-h-[500px]">
        <Image
          src="/quest/Quest-BG.png" alt="BG" width={200} height={200}
          className="absolute inset-0 z-0 h-full w-full object-fill"
        />

        <div className="relative z-50 mt-8 flex justify-center gap-2 px-2 pt-3 sm:mt-12 sm:gap-4 sm:px-4">
          {/* Clicking a tab while a pool is opened must also close the detail
              view — otherwise PoolDetail keeps rendering (see the `selectedPool
              ? <PoolDetail/> : …` below) and the tab switch looks like a dead
              click. `clearDetail()` drops the selected pool alongside the tab
              change so users can navigate between Markets/Positions from ANY
              pool's detail page. */}
          <button className={tabClass("markets")} onClick={() => { setTab("markets"); setSelectedPool(null); }}>
            <svg width="20" height="20" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" className="mr-1 inline sm:mr-2" style={{imageRendering:"pixelated"}}><rect x="3" y="4" width="8" height="2" fill="#FFD47A"/><rect x="3" y="4" width="8" height="1" fill="#FFF3B0"/><rect x="10" y="2" width="2" height="2" fill="#FFD47A"/><rect x="10" y="6" width="2" height="2" fill="#FFD47A"/><rect x="12" y="4" width="2" height="2" fill="#FFD47A"/><rect x="12" y="4" width="2" height="1" fill="#FFF3B0"/><rect x="5" y="10" width="8" height="2" fill="#E8A849"/><rect x="5" y="10" width="8" height="1" fill="#FFD47A"/><rect x="4" y="8" width="2" height="2" fill="#E8A849"/><rect x="4" y="12" width="2" height="2" fill="#E8A849"/><rect x="2" y="10" width="2" height="2" fill="#E8A849"/><rect x="2" y="10" width="2" height="1" fill="#FFD47A"/></svg>
            MARKETS
          </button>
          <button className={tabClass("positions")} onClick={() => { setTab("positions"); setSelectedPool(null); }}>
            <svg width="20" height="20" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" className="mr-1 inline sm:mr-2" style={{imageRendering:"pixelated"}}><rect x="3" y="11" width="1" height="1" fill="#8B5E3C"/><rect x="4" y="10" width="1" height="1" fill="#8B5E3C"/><rect x="5" y="9" width="1" height="1" fill="#A0704A"/><rect x="6" y="8" width="1" height="1" fill="#A0704A"/><rect x="7" y="7" width="1" height="1" fill="#A0704A"/><rect x="2" y="12" width="1" height="1" fill="#7A5030"/><rect x="1" y="13" width="1" height="1" fill="#7A5030"/><rect x="8" y="6" width="1" height="1" fill="#C0C0C0"/><rect x="9" y="5" width="1" height="1" fill="#D8D8D8"/><rect x="10" y="4" width="1" height="1" fill="#E8E8E8"/><rect x="11" y="3" width="1" height="1" fill="#F0F0F0"/><rect x="12" y="2" width="2" height="1" fill="#E8E8E8"/><rect x="13" y="3" width="1" height="1" fill="#D8D8D8"/><rect x="12" y="4" width="1" height="1" fill="#C0C0C0"/><rect x="10" y="8" width="2" height="2" fill="#FFD47A"/><rect x="10" y="8" width="1" height="1" fill="#FFF3B0"/><rect x="12" y="10" width="2" height="2" fill="#E8A849"/><rect x="12" y="10" width="1" height="1" fill="#FFD47A"/><rect x="8" y="11" width="2" height="1" fill="#E8A849"/><rect x="9" y="12" width="1" height="1" fill="#FFD47A"/></svg>
            POSITIONS
          </button>
        </div>

        <div className="relative z-10 mx-auto mt-4 mb-8 w-[95%] p-2 sm:p-4">
          {selectedPool ? (
            <PoolDetail pool={selectedPool} onBack={() => setSelectedPool(null)} address={address} isConnected={isConnected} walletCtx={walletCtx} chainClient={chainClient} />
          ) : tab === "markets" ? (
            <>
              <div className="mb-4 grid grid-cols-2 gap-1.5 sm:mb-5 sm:grid-cols-4 sm:gap-3">
                {[
                  { l: "TOTAL VALUE LOCKED", v: loading ? "..." : `$${fmt(totalTvl)}`, icon: <svg width="28" height="28" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" style={{imageRendering:"pixelated"}}><rect x="2" y="7" width="12" height="7" fill="#8B5E3C"/><rect x="2" y="7" width="12" height="1" fill="#A0704A"/><rect x="2" y="13" width="12" height="1" fill="#5D3A1F"/><rect x="2" y="4" width="12" height="4" fill="#A0704A"/><rect x="2" y="4" width="12" height="1" fill="#C49A6C"/><rect x="3" y="5" width="10" height="1" fill="#B8896A"/><rect x="1" y="7" width="14" height="1" fill="#E8A849"/><rect x="1" y="4" width="14" height="1" fill="#E8A849"/><rect x="7" y="6" width="2" height="3" fill="#FFD47A"/><rect x="7" y="5" width="2" height="1" fill="#E8A849"/><rect x="4" y="3" width="2" height="2" fill="#FFD47A"/><rect x="5" y="3" width="1" height="1" fill="#FFF3B0"/><rect x="9" y="2" width="2" height="2" fill="#FFD47A"/><rect x="10" y="2" width="1" height="1" fill="#FFF3B0"/><rect x="7" y="2" width="2" height="2" fill="#E8A849"/><rect x="8" y="2" width="1" height="1" fill="#FFD47A"/></svg> },
                  { l: "DEEPEST POOL", v: loading ? "..." : `$${fmt(deepestTvl)}`, icon: <svg width="28" height="28" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" style={{imageRendering:"pixelated"}}><rect x="2" y="9" width="2" height="5" fill="#E8A849"/><rect x="2" y="9" width="2" height="1" fill="#FFD47A"/><rect x="5" y="5" width="2" height="9" fill="#FFD47A"/><rect x="5" y="5" width="2" height="1" fill="#FFF3B0"/><rect x="8" y="7" width="2" height="7" fill="#E8A849"/><rect x="8" y="7" width="2" height="1" fill="#FFD47A"/><rect x="11" y="3" width="2" height="11" fill="#FFD47A"/><rect x="11" y="3" width="2" height="1" fill="#FFF3B0"/><rect x="1" y="14" width="14" height="1" fill="#C49A6C"/><rect x="13" y="1" width="1" height="1" fill="#7FE87F"/><rect x="12" y="2" width="1" height="1" fill="#7FE87F"/><rect x="14" y="2" width="1" height="1" fill="#7FE87F"/></svg> },
                  { l: "ACTIVE POOLS", v: loading ? "..." : `${pools.filter(p => p.active).length}/${pools.length}`, icon: <svg width="28" height="28" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" style={{imageRendering:"pixelated"}}><rect x="7" y="1" width="2" height="1" fill="#5BC0DE"/><rect x="6" y="2" width="4" height="1" fill="#5BC0DE"/><rect x="5" y="3" width="6" height="1" fill="#5BC0DE"/><rect x="4" y="4" width="8" height="1" fill="#5BC0DE"/><rect x="3" y="5" width="10" height="1" fill="#5BC0DE"/><rect x="3" y="6" width="10" height="1" fill="#4AADCC"/><rect x="3" y="7" width="10" height="1" fill="#4AADCC"/><rect x="3" y="8" width="10" height="1" fill="#3A9ABB"/><rect x="3" y="9" width="10" height="1" fill="#3A9ABB"/><rect x="4" y="10" width="8" height="1" fill="#2D87A8"/><rect x="5" y="11" width="6" height="1" fill="#2D87A8"/><rect x="6" y="12" width="4" height="1" fill="#2D87A8"/><rect x="5" y="4" width="2" height="1" fill="#9EEAFF"/><rect x="4" y="5" width="2" height="1" fill="#9EEAFF"/><rect x="4" y="6" width="1" height="2" fill="#7FD9F0"/></svg> },
                  { l: "FEE TIERS", v: loading ? "..." : feeRange, icon: <svg width="28" height="28" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" style={{imageRendering:"pixelated"}}><rect x="2" y="12" width="1" height="1" fill="#E8A849"/><rect x="3" y="11" width="1" height="1" fill="#E8A849"/><rect x="4" y="10" width="1" height="1" fill="#FFD47A"/><rect x="5" y="9" width="1" height="1" fill="#FFD47A"/><rect x="6" y="10" width="1" height="1" fill="#FFD47A"/><rect x="7" y="9" width="1" height="1" fill="#FFD47A"/><rect x="8" y="8" width="1" height="1" fill="#FFD47A"/><rect x="9" y="7" width="1" height="1" fill="#FFD47A"/><rect x="10" y="6" width="1" height="1" fill="#FFD47A"/><rect x="11" y="5" width="1" height="1" fill="#FFD47A"/><rect x="12" y="4" width="1" height="1" fill="#FFD47A"/><rect x="13" y="3" width="1" height="1" fill="#FFD47A"/><rect x="13" y="2" width="2" height="1" fill="#7FE87F"/><rect x="14" y="3" width="1" height="1" fill="#7FE87F"/><rect x="13" y="4" width="1" height="1" fill="#7FE87F"/><rect x="2" y="13" width="12" height="1" fill="#5D3A1F"/><rect x="3" y="12" width="11" height="1" fill="#5D3A1F"/><rect x="4" y="11" width="10" height="1" fill="#5D3A1F"/><rect x="5" y="10" width="9" height="1" fill="#4A2C15"/><rect x="7" y="9" width="7" height="1" fill="#4A2C15"/><rect x="9" y="8" width="5" height="1" fill="#4A2C15"/><rect x="1" y="14" width="14" height="1" fill="#C49A6C"/></svg> },
                ].map((s, i) => (
                  <div key={i} className="relative overflow-hidden rounded px-3 py-3 text-center">
                    <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200}
                      className="absolute inset-0 z-[-1] h-full w-full rounded" />
                    <div className="mb-1 flex items-center justify-center">{s.icon}</div>
                    <div className="font-family-ThaleahFat text-base tracking-wider text-gray-200 sm:text-lg">{s.l}</div>
                    <div className="font-family-ThaleahFat text-peach-300 truncate text-xl sm:text-3xl">{s.v}</div>
                  </div>
                ))}
              </div>

              <div className="no-scrollbar mb-3 flex gap-1.5 overflow-x-auto pb-1 sm:mb-4 sm:gap-2">
                {chains.map(ch => (
                  <button
                    key={ch}
                    onClick={() => setChainFilter(ch)}
                    className={`font-family-ThaleahFat cursor-pointer whitespace-nowrap rounded px-3 py-1.5 text-base tracking-wider transition-all ${
                      chainFilter === ch
                        ? "border-2 border-yellow-400 text-yellow-400"
                        : "border-2 border-[#E8A849]/55 text-gray-300 hover:border-[#FFD47A]/80 hover:text-white"
                    }`}
                    style={chainFilter === ch && ch !== "all" ? {
                      borderColor: chainColors[ch] || "#D548EC",
                      color: chainColors[ch] || "#D548EC",
                      background: (chainColors[ch] || "#D548EC") + "18",
                    } : {}}
                  >
                    {ch === "all" ? "ALL CHAINS" : ch.toUpperCase()}
                  </button>
                ))}
              </div>

              <div className="mb-2 flex items-center justify-end gap-1">
                {([["tvl", "TVL"], ["apy", "FEE"], ["vol", "PRICE"]] as const).map(([k, l]) => (
                  <button
                    key={k}
                    onClick={() => setSort(k)}
                    className={`font-family-ThaleahFat cursor-pointer rounded px-3 py-1 text-base transition-all ${
                      sort === k
                        ? "bg-ground-button border-ground-button-border text-peach-500 border"
                        : "border border-transparent text-gray-300"
                    }`}
                  >
                    {l}
                  </button>
                ))}
                <button onClick={loadPools} className="text-peach-300 ml-2 cursor-pointer transition-all hover:scale-110">
                  <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                </button>
              </div>

              <div className="hidden px-3 pb-2 sm:grid" style={{ gridTemplateColumns: "2.4fr .6fr .7fr .7fr .9fr" }}>
                {["POOL", "TVL", "FEE", "PRICE", ""].map((h, i) => (
                  <span key={i} className={`font-family-ThaleahFat text-xl tracking-wider text-gray-300 ${i > 0 ? "text-right" : ""}`}>
                    {h}
                  </span>
                ))}
              </div>

              {loading ? (
                <div className="py-12 text-center">
                  <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-yellow-100 border-t-transparent" />
                  <p className="font-family-ThaleahFat text-peach-300 mt-4 text-xl">READING ON-CHAIN DATA...</p>
                  <p className="font-family-ThaleahFat mt-1 text-sm text-gray-300">Fetching from Robinhood Chain</p>
                </div>
              ) : sorted.length === 0 ? (
                <div className="py-12 text-center">
                  <p className="font-family-ThaleahFat text-2xl text-gray-100">NO POOLS FOUND</p>
                  <p className="font-family-ThaleahFat mt-2 text-base text-gray-300">No active liquidity on-chain for this filter</p>
                </div>
              ) : (
              <div className="flex flex-col gap-1.5">
                {sorted.map((p) => (
                  <button
                    key={p.pool.address}
                    onClick={() => setSelectedPool(p)}
                    className="relative w-full cursor-pointer rounded text-left transition-all hover:scale-[1.005]"
                  >
                    <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200}
                      className="absolute inset-0 z-[-1] h-full w-full rounded" />
                    <div className="hidden items-center gap-1 px-3 py-3 sm:grid" style={{ gridTemplateColumns: "2.4fr .6fr .7fr .7fr .9fr" }}>
                      <div className="flex items-center gap-3">
                        <TokenPair t0={p.token0} t1={p.token1} size={36} />
                        <div>
                          <div className="font-family-ThaleahFat text-xl tracking-wider text-white">{p.name}</div>
                          <div className="mt-0.5 flex gap-1">
                            <Badge chain="Robinhood Chain" />
                            <span className="font-family-ThaleahFat bg-ground-button-border rounded-sm px-1.5 py-px text-sm text-gray-200">
                              {(p.fee / 10000).toFixed(2)}%
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="text-right"><span className="font-family-ThaleahFat truncate text-2xl text-white">${fmt(p.tvl)}</span></div>
                      <div className="font-family-ThaleahFat text-right text-2xl text-[#6DBB3E]">{(p.fee / 10000).toFixed(2)}%</div>
                      <div className="font-family-ThaleahFat text-right text-2xl text-gray-300">{p.price > 0 ? `$${fmt(p.price)}` : "—"}</div>
                      <div className="flex justify-end gap-1.5">
                        <Link href="/vault" className="font-family-ThaleahFat cursor-pointer rounded bg-[#6DBB3E] px-3 py-1.5 text-lg text-white shadow-[0_-2px_0_#4A8B29_inset] transition-all hover:brightness-110">
                          + LIQUIDITY
                        </Link>
                      </div>
                    </div>
                    <div className="flex items-center justify-between px-3 py-3 sm:hidden">
                      <div className="flex items-center gap-2">
                        <TokenPair t0={p.token0} t1={p.token1} size={32} />
                        <div>
                          <div className="font-family-ThaleahFat text-lg text-white">{p.name}</div>
                          <Badge chain="Robinhood Chain" />
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-family-ThaleahFat text-xl text-[#6DBB3E]">{(p.fee / 10000).toFixed(2)}% FEE</div>
                        <div className="font-family-ThaleahFat text-xl text-gray-200">${fmt(p.tvl)}</div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              )}
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

          <p className="font-family-ThaleahFat mt-6 text-center text-sm tracking-widest text-gray-400">
            CONCENTRATED LIQUIDITY ON ROBINHOOD CHAIN — BEST EXECUTION VIA THE MOLESWAP AGGREGATOR
          </p>
        </div>
      </div>
    </div>
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
    <div className="relative overflow-hidden rounded" style={{ height, background: "rgba(0,0,0,0.2)", border: "1px solid #3A1F0E" }}>
      <div style={{ position: "absolute", top: 0, bottom: 0, left: "5%", right: "5%", background: "rgba(107,187,62,0.06)" }} />
      {!isFullRange && <div style={{ position: "absolute", top: 0, bottom: 0, left: "5%", width: 1, borderLeft: "1px dashed #6B7280" }} />}
      {!isFullRange && <div style={{ position: "absolute", top: 0, bottom: 0, right: "5%", width: 1, borderRight: "1px dashed #6B7280" }} />}
      <div style={{ position: "absolute", top: 0, bottom: 0, left: `${5 + currentPos * 90}%`, width: 2, background: "#FFD47A", zIndex: 2, boxShadow: "0 0 6px #FFD47A" }} />

      {hovered !== null && price && height > 50 && (() => {
        const bd = getBarData(hovered);
        const leftPct = (hovered / (bars - 1)) * 100;
        return (
          <div className="pointer-events-none absolute z-50 rounded border border-[#E8A849] bg-[#3A1F0E]/95 px-2.5 py-1.5 shadow-lg" style={{ bottom: "100%", left: `${Math.min(Math.max(leftPct, 15), 85)}%`, transform: "translateX(-50%) translateY(-4px)", whiteSpace: "nowrap" }}>
            <div className="font-family-ThaleahFat text-xs text-[#FFD47A]">{bd.barPrice > 1000 ? fmt(bd.barPrice) : bd.barPrice.toFixed(2)} {token1Symbol || ""}</div>
            <div className="font-family-ThaleahFat text-xs text-gray-200">LIQ: {bd.liq.toFixed(0)}%</div>
            <div className="font-family-ThaleahFat text-xs text-[#6DBB3E]">{bd.inRange ? "IN RANGE" : "OUT OF RANGE"}</div>
          </div>
        );
      })()}

      <div className="flex items-end gap-px px-1" style={{ height: "100%", padding: "4px 2px" }}>
        {Array.from({ length: bars }).map((_, i) => {
          const bd = getBarData(i);
          const isCurrent = i === peakIdx;
          const isHov = hovered === i;
          return (
            <div key={i}
              onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}
              style={{
                flex: 1, borderRadius: "1px 1px 0 0", minHeight: 2, cursor: "crosshair",
                height: `${bd.h}%`,
                background: isCurrent ? "#FFD47A" : isHov ? "#8FDB5E" : "#6DBB3E",
                opacity: isCurrent ? 1 : isHov ? 0.9 : 0.5 + (bd.h / 200),
                boxShadow: isCurrent ? "0 0 6px #FFD47A" : isHov ? "0 0 4px #6DBB3E" : "none",
                transition: "opacity 0.1s, background 0.1s",
              }} />
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
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="border-ground mx-4 w-full max-w-md overflow-hidden rounded-xl border-3 bg-gradient-to-b from-[#52301A] to-[#4A2C15] shadow-[0_0_40px_rgba(232,168,73,0.12),0_8px_0_#3A1F0E]" style={{ borderColor: "#E8A849" }}>
        <div className="flex items-center justify-between border-b-2 border-[#3A1F0E] bg-black/20 px-5 py-3">
          <span className="font-family-ThaleahFat text-xl tracking-wider text-[#FFD47A]">REMOVE LIQUIDITY</span>
          <button onClick={onCancel} className="font-family-ThaleahFat cursor-pointer text-lg text-gray-300 hover:text-white">✕</button>
        </div>
        <div className="px-5 py-4">
          <div className="mb-4 flex items-center gap-3 border-b border-white/5 pb-4">
            <TokenPair t0={t0} t1={t1} size={32} />
            <div>
              <div className="font-family-ThaleahFat text-lg tracking-wider text-white">{t0.symbol} / {t1.symbol}</div>
              <div className="font-family-ThaleahFat mt-0.5 text-sm text-gray-300">NFT #{pos.tokenId} · {feeTier} FEE · {isFullRange ? "FULL RANGE" : "CUSTOM"}</div>
            </div>
          </div>

          <div className="mb-3">
            <div className="font-family-ThaleahFat mb-2 flex items-center gap-2 text-sm text-[#E8A849]">YOU WILL RECEIVE <span className="flex-1 border-t border-white/5" /></div>
            <div className="flex justify-between py-1">
              <span className="font-family-ThaleahFat flex items-center gap-2 text-base text-gray-200"><TokenIcon token={t0} size={16} />{t0.symbol}</span>
              <span className="font-family-ThaleahFat text-base text-[#FFD47A]">{ep ? ep.amount0.toFixed(ep.amount0 < 0.01 ? 6 : 4) : "..."}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="font-family-ThaleahFat flex items-center gap-2 text-base text-gray-200"><TokenIcon token={t1} size={16} />{t1.symbol}</span>
              <span className="font-family-ThaleahFat text-base text-[#FFD47A]">{ep ? ep.amount1.toFixed(ep.amount1 < 0.01 ? 6 : 4) : "..."}</span>
            </div>
          </div>

          <div className="mb-3">
            <div className="font-family-ThaleahFat mb-2 flex items-center gap-2 text-sm text-[#E8A849]">FEES COLLECTED <span className="flex-1 border-t border-white/5" /></div>
            <div className="flex justify-between py-1">
              <span className="font-family-ThaleahFat flex items-center gap-2 text-base text-gray-200"><TokenIcon token={t0} size={16} />{t0.symbol} FEES</span>
              <span className={`font-family-ThaleahFat text-base ${fees0 > 0 ? "text-[#6DBB3E]" : "text-gray-400"}`}>{fees0 > 0 ? `+${fmtFee(fees0)}` : "0.00"}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="font-family-ThaleahFat flex items-center gap-2 text-base text-gray-200"><TokenIcon token={t1} size={16} />{t1.symbol} FEES</span>
              <span className={`font-family-ThaleahFat text-base ${fees1 > 0 ? "text-[#6DBB3E]" : "text-gray-400"}`}>{fees1 > 0 ? `+${fmtFee(fees1)}` : "0.00"}</span>
            </div>
          </div>

          <div className="my-3 rounded-lg border-2 border-[#3A1F0E] bg-black/20 px-4 py-2.5">
            <div className="flex items-center justify-between">
              <span className="font-family-ThaleahFat text-sm text-[#C49A6C]">TOTAL ESTIMATED</span>
              <span className="font-family-ThaleahFat text-lg text-[#FFD47A]">
                {ep ? `${(ep.amount0 + fees0).toFixed(4)} ${t0.symbol} + ${(ep.amount1 + fees1).toFixed(4)} ${t1.symbol}` : "..."}
              </span>
            </div>
          </div>

          <div className="mb-4 rounded border border-[#E8A849]/20 bg-[#E8A849]/5 px-3 py-2">
            <p className="font-family-ThaleahFat text-xs leading-relaxed text-[#E8A849]">
              ⚠ REMOVING 100% OF LIQUIDITY. YOUR NFT #{pos.tokenId} WILL BE BURNED AND ALL TOKENS + ACCRUED FEES RETURNED TO YOUR WALLET.
            </p>
          </div>

          <div className="flex gap-2">
            <button onClick={onCancel} className="font-family-ThaleahFat flex-1 cursor-pointer rounded-lg border-2 border-[#5D3A1F] bg-[#3A1F0E] px-4 py-3 text-base tracking-wider text-[#C49A6C] transition-all hover:scale-[1.01]">
              CANCEL
            </button>
            <button onClick={onConfirm} disabled={removing} className="font-family-ThaleahFat flex-1 cursor-pointer rounded-lg bg-red-600 px-4 py-3 text-base tracking-wider text-white shadow-[0px_-3px_0px_0px_#991B1B_inset] transition-all hover:scale-[1.01] disabled:opacity-50">
              {removing ? "REMOVING..." : "CONFIRM REMOVE"}
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
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="border-ground mx-4 w-full max-w-md overflow-hidden rounded-xl border-3 bg-gradient-to-b from-[#52301A] to-[#4A2C15] shadow-[0_0_40px_rgba(232,168,73,0.12),0_8px_0_#3A1F0E]" style={{ borderColor: "#E8A849" }}>
        <div className="flex items-center justify-between border-b-2 border-[#3A1F0E] bg-black/20 px-5 py-3">
          <span className="font-family-ThaleahFat text-xl tracking-wider text-[#FFD47A]">COLLECT FEES</span>
          <button onClick={onCancel} className="font-family-ThaleahFat cursor-pointer text-lg text-gray-300 hover:text-white">✕</button>
        </div>
        <div className="px-5 py-4">
          <div className="mb-4 flex items-center gap-3 border-b border-white/5 pb-4">
            <TokenPair t0={t0} t1={t1} size={32} />
            <div>
              <div className="font-family-ThaleahFat text-lg tracking-wider text-white">{t0.symbol} / {t1.symbol}</div>
              <div className="font-family-ThaleahFat mt-0.5 text-sm text-gray-300">NFT #{pos.tokenId} · {feeTier} FEE</div>
            </div>
          </div>

          <div className="mb-3">
            <div className="font-family-ThaleahFat mb-2 flex items-center gap-2 text-sm text-[#E8A849]">UNCLAIMED FEES <span className="flex-1 border-t border-white/5" /></div>
            <div className="flex justify-between py-1">
              <span className="font-family-ThaleahFat flex items-center gap-2 text-base text-gray-200"><TokenIcon token={t0} size={16} />{t0.symbol}</span>
              <span className={`font-family-ThaleahFat text-base ${fees0 > 0 ? "text-[#6DBB3E]" : "text-gray-400"}`}>{fees0 > 0 ? `+${fmtFee(fees0)}` : "0.00"}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="font-family-ThaleahFat flex items-center gap-2 text-base text-gray-200"><TokenIcon token={t1} size={16} />{t1.symbol}</span>
              <span className={`font-family-ThaleahFat text-base ${fees1 > 0 ? "text-[#6DBB3E]" : "text-gray-400"}`}>{fees1 > 0 ? `+${fmtFee(fees1)}` : "0.00"}</span>
            </div>
          </div>

          <div className="mb-4 rounded border border-[#E8A849]/20 bg-[#E8A849]/5 px-3 py-2">
            <p className="font-family-ThaleahFat text-xs leading-relaxed text-[#E8A849]">
              {hasAny
                ? `⚠ THIS WILL SEND YOUR ACCRUED FEES TO YOUR WALLET. POSITION NFT #${pos.tokenId} STAYS INTACT — YOUR LIQUIDITY KEEPS EARNING.`
                : `NO FEES ACCRUED YET. YOU CAN STILL SUBMIT — THE TX WILL JUST BE A NO-OP. FEES ACCRUE WHEN SWAPS OCCUR THROUGH YOUR PRICE RANGE.`}
            </p>
          </div>

          <div className="flex gap-2">
            <button onClick={onCancel} className="font-family-ThaleahFat flex-1 cursor-pointer rounded-lg border-2 border-[#5D3A1F] bg-[#3A1F0E] px-4 py-3 text-base tracking-wider text-[#C49A6C] transition-all hover:scale-[1.01]">
              CANCEL
            </button>
            <button onClick={onConfirm} disabled={collecting} className="font-family-ThaleahFat bg-peach-500 flex-1 cursor-pointer rounded-lg px-4 py-3 text-base tracking-wider text-black shadow-[0px_-3px_0px_0px_#C97E00_inset] transition-all hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100">
              {collecting ? "COLLECTING..." : "CONFIRM COLLECT"}
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
      <div className="flex flex-col items-center gap-4 py-12">
        <Image src="/profile/c2.png" alt="Mole" width={80} height={80} className="object-contain" style={{ imageRendering: "pixelated" }} />
        <p className="font-family-ThaleahFat text-shadow-black text-2xl tracking-wider text-white">CONNECT WALLET TO VIEW POSITIONS</p>
        <button onClick={() => walletCtx?.handleConnectWallet?.()} className="font-family-ThaleahFat bg-peach-500 border-3 mt-2 cursor-pointer rounded-lg border-[#523525] px-8 py-3 text-xl tracking-wider text-black shadow-[0px_-6px_0px_0px_#C97E00_inset,0px_7.5px_0px_0px_rgba(255,212,122,0.6)_inset] transition-all hover:scale-[1.02]">
          CONNECT WALLET
        </button>
      </div>
    );
  }

  if (loading || enriching) {
    return (
      <div className="py-12 text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-yellow-100 border-t-transparent" />
        <p className="font-family-ThaleahFat text-peach-300 mt-4 text-xl">LOADING POSITIONS...</p>
        <p className="font-family-ThaleahFat mt-1 text-sm text-gray-300">Reading on-chain position data</p>
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <Image src="/profile/c2.png" alt="Mole" width={80} height={80} className="object-contain" style={{ imageRendering: "pixelated" }} />
        <p className="font-family-ThaleahFat text-shadow-black text-2xl tracking-wider text-white">NO ACTIVE POSITIONS</p>
        <p className="font-family-ThaleahFat max-w-xs text-center text-base text-gray-200">ADD LIQUIDITY TO A POOL TO START EARNING FEES</p>
        <button onClick={onGoToMarkets} className="font-family-ThaleahFat mt-2 cursor-pointer rounded-lg bg-[#6DBB3E] px-8 py-3 text-xl tracking-wider text-white shadow-[0px_-4px_0px_0px_#4A8B29_inset,0px_4px_0px_0px_rgba(255,255,255,0.3)_inset] transition-all hover:scale-[1.02]">
          EXPLORE MARKETS
        </button>
      </div>
    );
  }

  const displayPositions = enriched.length > 0 ? enriched : positions;
  const totalFees0 = enriched.reduce((s, p) => s + Number(ethers.formatUnits(p.tokensOwed0, (p.token0Info || getTokenByAddress(p.token0))?.decimals || 18)), 0);
  const totalFees1 = enriched.reduce((s, p) => s + Number(ethers.formatUnits(p.tokensOwed1, (p.token1Info || getTokenByAddress(p.token1))?.decimals || 18)), 0);
  const activeCount = positions.filter(p => BigInt(p.liquidity) > 0n).length;

  return (
    <div className="flex flex-col gap-3">
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
        <div className="relative rounded px-4 py-3 text-center">
          <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
          <p className="font-family-ThaleahFat text-peach-300 text-lg">{txMsg}</p>
        </div>
      )}

      {/* Portfolio Summary */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { l: "TOTAL DEPOSITED", v: enriched.length > 0 ? `${enriched.reduce((s, e) => s + e.amount0, 0).toFixed(4)} / ${enriched.reduce((s, e) => s + e.amount1, 0).toFixed(4)}` : "...", c: "text-peach-300" },
          { l: "UNCLAIMED FEES", v: (totalFees0 > 0 || totalFees1 > 0) ? `+${fmtFee(totalFees0)} / +${fmtFee(totalFees1)}` : "NONE", c: totalFees0 > 0 || totalFees1 > 0 ? "text-[#6DBB3E]" : "text-gray-400" },
          { l: "POSITIONS", v: `${activeCount} ACTIVE`, c: "text-peach-300" },
        ].map((s, i) => (
          <div key={i} className="relative rounded px-3 py-2 text-center">
            <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
            <div className="font-family-ThaleahFat text-sm tracking-wider text-gray-300">{s.l}</div>
            <div className={`font-family-ThaleahFat mt-0.5 truncate text-base ${s.c}`}>{s.v}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <span className="font-family-ThaleahFat text-xl text-white">{positions.length} POSITION{positions.length !== 1 ? "S" : ""}</span>
        <button onClick={onRefresh} className="text-peach-300 cursor-pointer transition-all hover:scale-110"><RefreshCw className="h-4 w-4" /></button>
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
          <div key={pos.tokenId} className="overflow-hidden rounded-lg border-3 border-[#3A1F0E] bg-gradient-to-b from-[#52301A] to-[#4A2C15]">
            {/* Header */}
            <div className="flex items-center justify-between border-b-2 border-[#3A1F0E] bg-black/15 px-4 py-3">
              <div className="flex items-center gap-3">
                {t0 && t1 && <TokenPair t0={t0} t1={t1} size={36} />}
                <div>
                  <span className="font-family-ThaleahFat text-2xl tracking-wider text-white">{poolName}</span>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    <Badge chain="Robinhood Chain" />
                    {t0 && t0.sourceChain !== "Robinhood Chain" && (
                      <span className="font-family-ThaleahFat rounded-sm bg-[#3A1F0E] px-1.5 py-px text-sm text-[#C49A6C]">
                        bridged from {t0.sourceChain}
                      </span>
                    )}
                    <span className="font-family-ThaleahFat rounded-sm bg-[#3A1F0E] px-1.5 py-px text-sm text-[#C49A6C]">
                      {ep?.feeTier || `${(pos.fee / 10000).toFixed(2)}%`}
                    </span>
                    <span className="font-family-ThaleahFat rounded-sm bg-gray-800 px-1.5 py-px text-sm text-gray-300">NFT #{pos.tokenId}</span>
                  </div>
                </div>
              </div>
              <span className={`font-family-ThaleahFat text-lg ${hasLiq ? "text-[#6DBB3E]" : "text-gray-300"}`}>
                {hasLiq && <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[#6DBB3E] shadow-[0_0_6px_#6DBB3E]" />}
                {hasLiq ? "ACTIVE" : "CLOSED"}
              </span>
            </div>

            <div className="px-4 py-3">
              {/* Deposited amounts */}
              {t0 && t1 && (
                <div className="mb-2 grid grid-cols-2 gap-2">
                  {[{ tok: t0, amt: ep?.amount0, label: "DEPOSITED" }, { tok: t1, amt: ep?.amount1, label: "DEPOSITED" }].map((item, i) => (
                    <div key={i} className="rounded border-2 border-[#3A1F0E] bg-black/20 px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <TokenIcon token={item.tok} size={16} />
                        <span className="font-family-ThaleahFat text-sm text-gray-300">{item.tok.symbol} {item.label}</span>
                      </div>
                      <div className="font-family-ThaleahFat text-peach-300 mt-1 text-lg">
                        {item.amt !== undefined ? item.amt.toFixed(item.amt < 0.01 ? 6 : 4) : "..."}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Unclaimed fees */}
              {t0 && t1 && (
                <div className="mb-2 rounded border-2 border-[#3A1F0E] bg-black/15 px-3 py-2">
                  <div className="mb-1 flex items-center">
                    <span className="font-family-ThaleahFat text-sm text-[#E8A849]">UNCLAIMED FEES</span>
                  </div>
                  <div className="flex gap-4">
                    <div>
                      <div className="font-family-ThaleahFat text-sm text-gray-300">{t0.symbol}</div>
                      <div className={`font-family-ThaleahFat text-base ${fees0 > 0 ? "text-[#6DBB3E]" : "text-gray-400"}`}>
                        {fees0 > 0 ? `+${fmtFee(fees0)}` : "0.00"}
                      </div>
                    </div>
                    <div>
                      <div className="font-family-ThaleahFat text-sm text-gray-300">{t1.symbol}</div>
                      <div className={`font-family-ThaleahFat text-base ${fees1 > 0 ? "text-[#6DBB3E]" : "text-gray-400"}`}>
                        {fees1 > 0 ? `+${fmtFee(fees1)}` : "0.00"}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Details grid */}
              <div className="mb-3 grid grid-cols-3 gap-2">
                {[
                  { l: "RANGE", v: isFullRange ? "FULL RANGE" : "CUSTOM", c: isFullRange ? "text-[#6DBB3E]" : "text-[#FFD47A]" },
                  { l: "LIQUIDITY", v: BigInt(pos.liquidity) > 1e9 ? fmt(Number(BigInt(pos.liquidity))) : BigInt(pos.liquidity).toLocaleString(), c: "text-peach-300" },
                  { l: "POOL", v: ep?.poolAddress ? `${ep.poolAddress.slice(0, 6)}...${ep.poolAddress.slice(-4)}` : "—", c: "text-gray-400" },
                ].map(({ l, v, c }) => (
                  <div key={l} className="rounded bg-black/10 px-2 py-1.5">
                    <div className="font-family-ThaleahFat text-sm text-gray-300">{l}</div>
                    <div className={`font-family-ThaleahFat mt-0.5 truncate text-base ${c}`}>{v}</div>
                  </div>
                ))}
              </div>

              {/* Action buttons. ALM positions auto-compound fees (no separate claim), so there is only
                  a single EXIT action — it returns the full underlying WETH/USDG including earned fees. */}
              <div className="flex flex-col gap-2">
                {(pos as any).isAlm ? (
                  <>
                    <p className="font-family-ThaleahFat text-center text-xs tracking-wider text-gray-400">
                      Fees auto-compound into this position — exiting returns them with your liquidity.
                    </p>
                    {hasLiq && (
                      <button onClick={() => setRemoveModal(pos)} disabled={removing === pos.tokenId}
                        className="font-family-ThaleahFat w-full cursor-pointer rounded-lg bg-red-600 px-4 py-2.5 text-lg tracking-wider text-white shadow-[0px_-3px_0px_0px_#991B1B_inset] transition-all hover:scale-[1.01] disabled:opacity-50">
                        {removing === pos.tokenId ? "EXITING..." : "EXIT POSITION"}
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => setCollectModal(pos)}
                      disabled={collecting === pos.tokenId}
                      className="font-family-ThaleahFat bg-peach-500 w-full cursor-pointer rounded-lg px-4 py-2.5 text-lg tracking-wider text-black shadow-[0px_-3px_0px_0px_#C97E00_inset] transition-all hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
                    >
                      {collecting === pos.tokenId ? "COLLECTING..." : "COLLECT FEES"}
                    </button>
                    {hasLiq && (
                      <button onClick={() => setRemoveModal(pos)} disabled={removing === pos.tokenId}
                        className="font-family-ThaleahFat w-full cursor-pointer rounded-lg bg-red-600 px-4 py-2.5 text-lg tracking-wider text-white shadow-[0px_-3px_0px_0px_#991B1B_inset] transition-all hover:scale-[1.01] disabled:opacity-50">
                        {removing === pos.tokenId ? "REMOVING..." : "REMOVE LIQUIDITY"}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
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
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <button onClick={onBack} className="font-family-ThaleahFat text-peach-300 cursor-pointer bg-transparent text-base">← BACK</button>
        <TokenPair t0={pool.token0} t1={pool.token1} size={36} />
        <div className="min-w-0 flex-1">
          <h2 className="font-family-ThaleahFat truncate text-2xl tracking-wider text-white sm:text-3xl">
            {getPoolDisplayInfo(pool.token0).symbol}/{getPoolDisplayInfo(pool.token1).symbol}
          </h2>
          <div className="mt-0.5 flex flex-wrap gap-1">
            <Badge chain="Robinhood Chain" />
            {pool.token0.sourceChain !== "Robinhood Chain" && (
              <span className="font-family-ThaleahFat rounded-sm bg-[#3A1F0E] px-1.5 py-px text-sm text-[#C49A6C]">
                bridged from {pool.token0.sourceChain}
              </span>
            )}
            <span className="font-family-ThaleahFat rounded-sm bg-[#3A1F0E] px-1.5 py-px text-sm text-[#C49A6C]">FEE {(pool.fee / 10000).toFixed(2)}%</span>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { l: "TVL", v: `$${fmt(pool.tvl)}`, c: "text-peach-500" },
          { l: "FEE TIER", v: `${(pool.fee / 10000).toFixed(2)}%`, c: "text-[#6DBB3E]" },
          { l: "PRICE", v: pool.price > 0 ? `$${fmt(pool.price)}` : "—", c: "text-[#6DBB3E]" },
          { l: "LIQUIDITY", v: BigInt(pool.liquidity) > 0n ? "ACTIVE" : "EMPTY", c: BigInt(pool.liquidity) > 0n ? "text-[#6DBB3E]" : "text-red-400" },
        ].map((s, i) => (
          <div key={i} className="relative rounded px-3 py-3 text-center">
            <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
            <div className="font-family-ThaleahFat text-base tracking-wider text-gray-200">{s.l}</div>
            <div className={`font-family-ThaleahFat text-2xl ${s.c}`}>{s.v}</div>
          </div>
        ))}
      </div>

      {/* Pooled amounts */}
      <div className="grid grid-cols-2 gap-2">
        {[{ tok: pool.token0, reserve: pool.reserve0 }, { tok: pool.token1, reserve: pool.reserve1 }].map((item, i) => {
          const poolDisp = getPoolDisplayInfo(item.tok);
          return (
            <div key={i} className="relative rounded px-3 py-3">
              <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
              <div className="flex items-center gap-2">
                <TokenIcon token={item.tok} size={24} />
                <span className="font-family-ThaleahFat text-base text-white">{poolDisp.symbol}</span>
                <Badge chain="Robinhood Chain" />
              </div>
              <div className="font-family-ThaleahFat mt-1 text-base text-gray-200">POOLED AMOUNT</div>
              <div className="font-family-ThaleahFat text-peach-300 text-2xl">{item.reserve}</div>
            </div>
          );
        })}
      </div>

      {/* Liquidity Distribution Graph */}
      <div className="relative rounded px-3 py-3">
        <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
        <div className="mb-2 flex items-center justify-between">
          <span className="font-family-ThaleahFat text-sm text-[#E8A849]">LIQUIDITY DISTRIBUTION</span>
          <span className="font-family-ThaleahFat text-peach-300 text-sm">1 {pool.token0.symbol} = {priceStr} {pool.token1.symbol}</span>
        </div>
        <LiquidityGraph currentTick={currentTick} tickLower={-887272} tickUpper={887272} height={80} price={pool.price} token0Symbol={pool.token0.symbol} token1Symbol={pool.token1.symbol} />
        <div className="mt-1.5 flex justify-between">
          <span className="font-family-ThaleahFat text-sm text-gray-400">MIN: 0</span>
          <span className="font-family-ThaleahFat text-sm text-[#6DBB3E]">● IN RANGE — FULL</span>
          <span className="font-family-ThaleahFat text-sm text-gray-400">MAX: ∞</span>
        </div>
      </div>

      {/* Price */}
      <div className="relative rounded px-3 py-3">
        <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
        <div className="flex justify-between">
          <span className="font-family-ThaleahFat text-lg text-gray-200">PRICE</span>
          <span className="font-family-ThaleahFat text-peach-300 text-lg">1 {pool.token0.symbol} = {priceStr} {pool.token1.symbol}</span>
        </div>
      </div>

      {/* Actions */}
      {!isConnected ? (
        <button onClick={() => walletCtx?.handleConnectWallet?.()} className="font-family-ThaleahFat bg-peach-500 border-3 w-full cursor-pointer rounded-lg border-[#523525] px-8 py-3 text-xl tracking-wider text-black shadow-[0px_-6px_0px_0px_#C97E00_inset,0px_7.5px_0px_0px_rgba(255,212,122,0.6)_inset] transition-all hover:scale-[1.02]">
          CONNECT WALLET
        </button>
      ) : txDone ? (
        <div className="py-4 text-center">
          <p className="font-family-ThaleahFat text-2xl text-[#6DBB3E]">LIQUIDITY ADDED ✓</p>
          {txHash && <a href={`https://robinhoodchain.blockscout.com/tx/${txHash}`} target="_blank" rel="noopener noreferrer" className="font-family-ThaleahFat text-peach-300 mt-1 block text-base underline">VIEW ON EXPLORER →</a>}
          <button onClick={() => { setTxDone(false); setActionTab(null); }} className="font-family-ThaleahFat text-peach-300 mt-3 cursor-pointer text-base underline">DONE</button>
        </div>
      ) : txError ? (
        <div className="py-4 text-center">
          <p className="font-family-ThaleahFat text-xl text-red-400">TRANSACTION FAILED ✗</p>
          <p className="font-family-ThaleahFat mt-1 break-words text-base text-gray-200">{txError.slice(0, 150)}</p>
          <button onClick={() => setTxError(null)} className="font-family-ThaleahFat text-peach-300 mt-2 cursor-pointer text-base underline">TRY AGAIN</button>
        </div>
      ) : actionTab === null ? (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button onClick={() => router.push("/vault")} className="font-family-ThaleahFat flex-1 cursor-pointer rounded-lg bg-[#6DBB3E] px-6 py-3 text-xl tracking-wider text-white shadow-[0px_-4px_0px_0px_#4A8B29_inset,0px_4px_0px_0px_rgba(255,255,255,0.3)_inset] transition-all hover:scale-[1.01]">
              + ADD LIQUIDITY
            </button>
            <button onClick={() => router.push("/vault")} className="font-family-ThaleahFat bg-peach-500 flex-1 cursor-pointer rounded-lg px-6 py-3 text-xl tracking-wider text-black shadow-[0px_-4px_0px_0px_#C97E00_inset,0px_4px_0px_0px_rgba(255,212,122,0.6)_inset] transition-all hover:scale-[1.01]">
              − REMOVE LIQUIDITY
            </button>
          </div>
          <p className="font-family-ThaleahFat text-center text-xs tracking-wider text-gray-400">
            WETH/USDG liquidity is auto-managed by the MoleSwap ALM vault — deposit or exit there.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border-3 border-[#3A1F0E] bg-gradient-to-b from-[#52301A] to-[#4A2C15]">
          <div className="flex items-center justify-between border-b-2 border-[#3A1F0E] bg-black/20 px-4 py-3">
            <span className="font-family-ThaleahFat text-xl tracking-wider text-white">+ ADD LIQUIDITY</span>
            <button onClick={() => { setActionTab(null); setAmount0(""); setAmount1(""); }} className="font-family-ThaleahFat cursor-pointer text-lg text-gray-300 hover:text-white">✕</button>
          </div>
          <div className="px-4 py-3">
            {/* Token 0 input */}
            <div className="relative mb-2 rounded px-3 py-2.5">
              <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
              <div className="mb-1 flex justify-between">
                <span className="font-family-ThaleahFat text-lg text-gray-200">{pool.token0.symbol}</span>
                <span className={`font-family-ThaleahFat text-lg ${insufficientBalance0 ? "text-red-400" : "text-gray-200"}`}>
                  BAL: {balance0 !== null ? Number(balance0).toFixed(4) : "..."}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <TokenIcon token={pool.token0} size={28} />
                <input type="text" value={amount0} onFocus={() => setInputFocused(0)} onChange={e => updateAmount1FromAmount0(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0"
                  className="font-family-ThaleahFat w-full flex-1 bg-transparent text-2xl tracking-wider text-white placeholder:text-gray-600 focus:outline-none" />
                {[{ l: "25%", v: 0.25 }, { l: "50%", v: 0.5 }, { l: "MAX", v: 1 }].map(p => (
                  <button key={p.l} onClick={() => setPercentage0(p.v)} className="font-family-ThaleahFat text-peach-500 border-ground-button-border bg-ground-button-border cursor-pointer rounded-sm border px-2 py-1 text-sm">{p.l}</button>
                ))}
              </div>
              {insufficientBalance0 && <div className="mt-1 flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-red-400" /><span className="font-family-ThaleahFat text-xs text-red-400">INSUFFICIENT {pool.token0.symbol} BALANCE</span></div>}
            </div>

            <div className="my-1 flex justify-center"><span className="font-family-ThaleahFat text-2xl text-gray-300">+</span></div>

            {/* Token 1 input */}
            <div className="relative mb-3 rounded px-3 py-2.5">
              <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
              <div className="mb-1 flex justify-between">
                <span className="font-family-ThaleahFat text-lg text-gray-200">{pool.token1.symbol}</span>
                <span className={`font-family-ThaleahFat text-lg ${insufficientBalance1 ? "text-red-400" : "text-gray-200"}`}>
                  BAL: {balance1 !== null ? Number(balance1).toFixed(4) : "..."}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <TokenIcon token={pool.token1} size={28} />
                <input type="text" value={amount1} onFocus={() => setInputFocused(1)} onChange={e => updateAmount0FromAmount1(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0"
                  className="font-family-ThaleahFat w-full flex-1 bg-transparent text-2xl tracking-wider text-white placeholder:text-gray-600 focus:outline-none" />
                {[{ l: "25%", v: 0.25 }, { l: "50%", v: 0.5 }, { l: "MAX", v: 1 }].map(p => (
                  <button key={p.l} onClick={() => setPercentage1(p.v)} className="font-family-ThaleahFat text-peach-500 border-ground-button-border bg-ground-button-border cursor-pointer rounded-sm border px-2 py-1 text-sm">{p.l}</button>
                ))}
              </div>
              {insufficientBalance1 && <div className="mt-1 flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-red-400" /><span className="font-family-ThaleahFat text-xs text-red-400">INSUFFICIENT {pool.token1.symbol} BALANCE</span></div>}
            </div>

            {/* Range selector */}
            <div className="relative mb-3 rounded px-3 py-2.5">
              <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
              <div className="mb-2 flex items-center justify-between">
                <span className="font-family-ThaleahFat text-lg text-gray-200">SELECT RANGE</span>
              </div>
              <div className="mb-3 grid grid-cols-2 gap-2">
                <button onClick={() => { setRangeMode("full"); setMinPrice(""); setMaxPrice(""); }}
                  className={`font-family-ThaleahFat cursor-pointer rounded-lg border-2 px-3 py-2 text-center text-sm tracking-wider transition-all ${
                    rangeMode === "full" ? "border-[#6DBB3E] bg-[#6DBB3E]/10 text-[#6DBB3E]" : "border-[#3A1F0E] text-gray-300 hover:text-white"
                  }`}>FULL RANGE</button>
                <button onClick={() => setRangeMode("custom")}
                  className={`font-family-ThaleahFat cursor-pointer rounded-lg border-2 px-3 py-2 text-center text-sm tracking-wider transition-all ${
                    rangeMode === "custom" ? "border-[#FFD47A] bg-[#FFD47A]/10 text-[#FFD47A]" : "border-[#3A1F0E] text-gray-300 hover:text-white"
                  }`}>CUSTOM RANGE</button>
              </div>

              {rangeMode === "custom" && (
                <div className="mb-2 grid grid-cols-2 gap-2">
                  <div className="rounded border-2 border-[#3A1F0E] bg-black/20 px-3 py-2">
                    <div className="font-family-ThaleahFat mb-1 text-sm text-gray-300">MIN PRICE</div>
                    <input type="text" value={minPrice} onChange={e => setMinPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                      placeholder="0" className="font-family-ThaleahFat w-full bg-transparent text-lg text-[#FFD47A] placeholder:text-gray-500 focus:outline-none" />
                    <div className="font-family-ThaleahFat text-sm text-gray-400">{pool.token1.symbol} per {pool.token0.symbol}</div>
                  </div>
                  <div className="rounded border-2 border-[#3A1F0E] bg-black/20 px-3 py-2">
                    <div className="font-family-ThaleahFat mb-1 text-sm text-gray-300">MAX PRICE</div>
                    <input type="text" value={maxPrice} onChange={e => setMaxPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                      placeholder="∞" className="font-family-ThaleahFat w-full bg-transparent text-lg text-[#FFD47A] placeholder:text-gray-500 focus:outline-none" />
                    <div className="font-family-ThaleahFat text-sm text-gray-400">{pool.token1.symbol} per {pool.token0.symbol}</div>
                  </div>
                </div>
              )}

              <div className="mb-1.5 flex justify-between">
                <span className="font-family-ThaleahFat text-sm text-[#E8A849]">YOUR RANGE</span>
                <span className={`font-family-ThaleahFat text-sm ${rangeMode === "full" ? "text-[#6DBB3E]" : "text-[#FFD47A]"}`}>
                  {rangeMode === "full" ? "● FULL RANGE" : "◆ CUSTOM"}
                </span>
              </div>
              <LiquidityGraph currentTick={currentTick} tickLower={selectedTickLower} tickUpper={selectedTickUpper} height={36} price={pool.price} token0Symbol={pool.token0.symbol} token1Symbol={pool.token1.symbol} />
            </div>

            {/* Info rows */}
            <div className="relative mb-3 rounded px-3 py-2">
              <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
              {[
                ["PRICE", `1 ${pool.token0.symbol} = ${pool.price > 0 ? pool.price.toFixed(4) : "N/A"} ${pool.token1.symbol}`, "text-peach-300"],
                ["FEE TIER", `${(pool.fee / 10000).toFixed(2)}%`, "text-peach-300"],
                ["RANGE", rangeMode === "full" ? "FULL RANGE" : `${minPrice || "0"} — ${maxPrice || "∞"} ${pool.token1.symbol}`, rangeMode === "full" ? "text-[#6DBB3E]" : "text-[#FFD47A]"],
                ["SLIPPAGE", "0.5%", "text-gray-200"],
                ["ON-CHAIN", pool.active ? "LIVE ✓" : "NO LIQUIDITY", pool.active ? "text-[#6DBB3E]" : "text-red-400"],
              ].map(([k, v, c]) => (
                <div key={k} className="flex justify-between py-0.5">
                  <span className="font-family-ThaleahFat text-base text-gray-200">{k}</span>
                  <span className={`font-family-ThaleahFat text-base ${c || "text-peach-300"}`}>{v}</span>
                </div>
              ))}
            </div>

            <button
              onClick={missingToken ? () => router.push(getMissingTokenSwapUrl(missingToken)) : handleAddLiquidity}
              disabled={!missingToken && !canSubmit}
              className={`font-family-ThaleahFat w-full cursor-pointer rounded-lg px-6 py-3 text-xl tracking-wider transition-all hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50 ${
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
  );
};
