"use client";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpDown, Clock, Fuel, Search, Settings as SettingsIcon } from "lucide-react";
import { DappStep } from ".";
import { getChains, getTokensForChain, tokenFallbackIcon, type ChainEntry } from "@/lib/chain/tokenList";
import { useWallet } from "@/lib/chain/provider";
import { getTokenByAddress, POOLS, CONTRACTS, getPoolDisplayInfo, TOKENS } from "@/lib/chain/contracts";
import { loadPoolRows } from "@/lib/chain/amm";
import { LivePairSession, type LiveQuote } from "@/lib/aggregator/live";
import { getOrCreateUser, getUserSwapHistory } from "@/lib/supabase/api";
import { getTokenBalance } from "@/lib/wallet/walletClient";
import { useRouter } from "next/navigation";
import type { Address } from "viem";
import { createPublicClient, http, isAddress, parseUnits, formatUnits, parseEther } from "viem";
import { robinhoodChain } from "@/lib/chain/wagmi-config";
import { createClient as createSupabaseBrowser } from "@/lib/supabase/client";
import { tokenHasPool } from "@/lib/aggregator/discover";
import { searchIndex, heldTokens, popularTokens, resolveTokenMetas, type IndexedToken, type HeldToken } from "@/lib/chain/tokenSearch";
import { fetchTokenInfo, fmtUsd, shortAddr, type TokenMarketInfo } from "@/lib/chain/tokenInfo";
import Settings from "../settings";
import { diagnostics } from "@/lib/diagnostics";
import { MoleMascot } from "../shared";

// Minimal ERC-20 metadata surface for importing an arbitrary token by address.
const ERC20_META_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

interface ExchangePageProps {
  onNext: (step: DappStep, data?: any) => void;
}

type SelectionMode = "none" | "from" | "to";

declare global {
  interface Window {
    ethereum?: any;
  }
}

/**
 * UI display helpers — prefer displaySymbol/displaySubtitle, fall back to the
 * raw symbol/name. Accepts null/undefined so callers pass metadata directly.
 */
function displaySymbolOf(t: any): string {
  if (!t) return "";
  return t.displaySymbol || t.symbol || "";
}
function displaySubtitleOf(t: any): string {
  if (!t) return "";
  return t.displaySubtitle || t.name || "";
}

// ---------- Burrow render helpers (presentation only) ----------

/** Deterministic Burrow coin colour for tokens without a hosted logo. */
const COIN_PALETTE = ["#b5601f", "#2f7d4f", "#2384c8", "#cd5f2a", "#7a4d29", "#8a5c33", "#b13ac5", "#627eea"];
function coinColor(seed?: string | null): string {
  const s = (seed || "?").toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return COIN_PALETTE[h % COIN_PALETTE.length];
}

/**
 * Token icon: keep the REAL logo (DexScreener / registry logoURI / local asset)
 * when one exists; fall back to the Burrow coin chip instead of the identicon
 * data-URI (which is exactly what tokenFallbackIcon produces).
 */
const TokenIcon = ({
  logo,
  symbol,
  address,
  size = 32,
}: {
  logo?: string | null;
  symbol?: string;
  address?: string;
  size?: number;
}) => {
  const real = logo && !logo.startsWith("data:");
  if (real) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logo}
        alt={symbol || "token"}
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flex: "none", background: "#fff" }}
      />
    );
  }
  return (
    <span
      className="coin"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.33)),
        background: coinColor(address || symbol),
      }}
    >
      {(symbol || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?"}
    </span>
  );
};

/** Shared hero — the Burrow header above both the exchange and picker views. */
export const ExchangeHero = () => (
  <header className="hero">
    <h1>
      Swap at the <span className="under">best price on chain.</span>
    </h1>
    <p className="sub">
      One quote, every live pool. The router splits your order across venues and re-prices it every block.
    </p>
    <MoleMascot />
  </header>
);

/** Page-scoped Burrow styles — carried from the prototype's exchange page. */
const ExchangeStyles = () => (
  <style jsx global>{`
    .card-tools { display: flex; gap: 8px; }
    .tool-btn {
      width: 34px; height: 34px; border-radius: 11px; cursor: pointer; display: grid; place-items: center;
      background: var(--p-chip); border: 1px solid var(--p-card-line); color: var(--p-card-ink-2);
      box-shadow: var(--p-card-sh);
    }
    .tool-btn:active { transform: scale(.94); }
    .sel-card {
      display: flex; align-items: center; gap: 14px; width: 100%; text-align: left;
      padding: 15px 17px; border-radius: var(--r-lg); cursor: pointer; font: inherit;
      background: var(--p-field); border: 1px solid var(--p-card-line); color: var(--p-card-ink);
      transition: transform 150ms ease;
    }
    .sel-card:hover { transform: scale(1.012); }
    .sel-card .sc-ic { flex: none; display: inline-flex; }
    .sel-card .sc-lbl { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 11px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: var(--p-card-ink-3); }
    .sel-card .sc-main { display: block; margin-top: 5px; font-size: 16.5px; font-weight: 800; letter-spacing: -.014em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sel-card .sc-body { flex: 1; min-width: 0; }
    .wal-chip { font-family: var(--font-num); font-size: 11px; font-weight: 700; color: var(--clay); text-transform: none; letter-spacing: 0; }
    .recip-btn { background: none; border: 0; padding: 0; cursor: pointer; font-family: var(--font-num); font-size: 11px; font-weight: 700; color: var(--clay); text-transform: none; letter-spacing: 0; }
    .recip-btn:hover { text-decoration: underline; }
    .recip-in {
      width: 150px; font-family: var(--font-num); font-size: 11px; font-weight: 700; color: var(--clay);
      background: rgba(255,255,255,.8); border: 1px solid var(--clay); border-radius: 8px; padding: 3px 7px; outline: none;
      text-transform: none; letter-spacing: 0;
    }
    .arrive { margin: -4px 0 0 4px; font-size: 12px; font-weight: 700; color: #2277b8; }
    .bal-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 9px; font-size: 12px; }
    .bal-row .b1 { color: var(--p-card-ink-3); font-weight: 600; font-family: var(--font-num); }
    .bal-row .chips { display: flex; gap: 6px; }
    .bal-row .chips button {
      border: 1px solid var(--p-card-line); background: var(--p-chip); color: var(--p-card-ink-2);
      font: inherit; font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 8px; cursor: pointer;
    }
    .bal-row .chips button:hover { background: rgba(240,160,60,.15); }
    .warn-thin { margin-top: 12px; padding: 12px 14px; border-radius: var(--r-md); font-size: 12.5px; font-weight: 600;
      background: rgba(240,160,60,.15); border: 1px solid rgba(240,160,60,.4); color: #8a5a14; text-align: center; }
    .warn-red { margin-top: 12px; padding: 11px 13px; border-radius: var(--r-md); font-size: 12px;
      background: rgba(184,55,31,.1); border: 1px solid rgba(184,55,31,.3); color: var(--rust); }
    .quote-head { display: flex; align-items: center; gap: 12px; }
    .quote-head .qh-amt { font-family: var(--font-num); font-size: 1.55rem; font-weight: 700; letter-spacing: -.03em; overflow-wrap: anywhere; }
    .quote-head .qh-sub { font-size: 12px; color: var(--p-card-ink-3); margin-top: 3px; }
    .qh-live { color: #1e6b40; font-weight: 700; }
    .rate-line { margin-top: 10px; font-family: var(--font-num); font-size: 12px; color: var(--p-card-ink-3); font-weight: 600; min-height: 1em; }
    .route-h { margin: 14px 0 4px; font-size: 10.5px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--p-card-ink-3); }
    .route-row { display: flex; align-items: center; gap: 8px; padding: 7px 0; font-size: 12.5px; flex-wrap: wrap; }
    .route-row .pct { font-family: var(--font-num); font-weight: 800; width: 38px; flex: none; color: var(--clay); }
    .route-row .path { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; font-weight: 700; min-width: 0; }
    .route-row .path .sep { color: var(--ink-3); }
    .route-row .ven { margin-left: auto; font-size: 11.5px; color: var(--p-card-ink-3); text-align: right; }
    .noq { padding: 18px 16px; border-radius: var(--r-md); background: rgba(44,26,12,.06); color: var(--p-card-ink-3); font-size: 13.5px; }
    .pick-head { display: flex; align-items: center; gap: 12px; }
    .pick-head h3 { flex: 1; }
    .ctx-row { display: flex; justify-content: space-between; margin: 12px 2px 4px; font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: var(--p-card-ink-3); }
    .tk-list { max-height: 430px; overflow: auto; margin-top: 4px; }
    .tk-row.sel { background: rgba(240,160,60,.16); }
    .risk-chip { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 999px;
      font-family: var(--font-ui); font-size: 9.5px; font-weight: 800; letter-spacing: .07em;
      vertical-align: middle; }
    .risk-chip.caution { background: rgba(240,160,60,.18); color: #8a5a12; border: 1px solid rgba(240,160,60,.45); }
    .risk-chip.unvetted { background: rgba(200,60,40,.14); color: #a33422; border: 1px solid rgba(200,60,40,.4); }
    .unvetted-toggle { display: block; width: 100%; margin-top: 8px; padding: 9px; border-radius: 12px;
      background: rgba(44,26,12,.05); border: 1px dashed rgba(44,26,12,.22); cursor: pointer;
      font-family: var(--font-ui); font-size: 11.5px; font-weight: 800; letter-spacing: .06em;
      text-transform: uppercase; color: var(--p-card-ink-3); }
    .unvetted-toggle:hover { background: rgba(44,26,12,.09); color: var(--p-card-ink-2); }
    .tk-group { padding: 10px 4px 4px; font-size: 10.5px; font-weight: 800; letter-spacing: .1em;
      text-transform: uppercase; color: var(--p-card-ink-3); }
    .tk-stats { display: flex; gap: 12px; font-size: 12.5px; font-weight: 700; color: var(--p-card-ink-2); margin-top: 5px; font-family: var(--font-num); flex-wrap: wrap; }
    .tk-stats .up { color: var(--moss); } .tk-stats .dn { color: var(--rust); }
    .dexlink { display: inline-block; font-size: 11px; font-weight: 800; color: #2277b8; cursor: pointer; background: none; border: 0; padding: 0; font-family: inherit; }
    .dexlink:hover { text-decoration: underline; }
    .vtick { color: #1e9e50; font-weight: 800; cursor: default; }
    .hist-row { padding: 13px 14px; border-radius: var(--r-md); background: rgba(255,255,255,.6);
      border: 1px solid rgba(44,26,12,.08); margin-bottom: 8px; }
    .hist-row .h1 { font-family: var(--font-num); font-size: 15.5px; font-weight: 700; letter-spacing: -.02em; display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline; }
    .hist-row .h1 .fs { color: var(--clay); font-size: 12.5px; }
    .hist-row .h1 .ts { color: #1e6b40; font-size: 12.5px; }
    .hist-row .h2 { display: flex; justify-content: space-between; gap: 10px; margin-top: 6px; font-size: 11.5px; color: var(--p-card-ink-3); flex-wrap: wrap; }
    .hist-row .h2 a { color: var(--clay); font-family: var(--font-num); }
    .p-card .search input::placeholder { color: var(--ink-3); }

    /* Swap layout. The receive panel only mounts once there is a quote, so a fixed two-column
       grid leaves the exchange card stranded in the left ~53% with dead space beside it (which
       is exactly how it looked at 0.0). Centring the GROUP keeps the card centred when it is
       alone and still lets the panel sit beside it, instead of the card jumping left the moment
       you type an amount. Wrapping is what makes it work on a phone. */
    .swap-grid { display: flex; flex-wrap: wrap; justify-content: center; align-items: stretch; gap: 16px; }
    /* Equal basis and an equal cap so the exchange card and the receive panel are the SAME width and
       sit on one row rather than two mismatched blocks; stretch keeps their tops and bottoms aligned. */
    .swap-grid > * { flex: 1 1 520px; min-width: 0; max-width: 620px; display: flex; flex-direction: column; }
    .swap-grid > * > .p-card { flex: 1; }
    @media (max-width: 1120px) { .swap-grid > * { flex-basis: 100%; max-width: 620px; } }

    /* The dapp page runs wider than the 1140px default so two 620px panels fit side by side. */
    main.swap-main { max-width: 1300px; }

    /* One line on desktop. The break used to be a hardcoded <br>, which forced two lines at every
       width; the type is now sized so the full sentence fits the measure, and only wraps on narrow
       screens where one line genuinely cannot work. */
    @media (min-width: 901px) {
      .hero h1 { white-space: nowrap; font-size: clamp(2rem, 4.3vw, 3.6rem); }
      /* The base .sub is capped at 50ch for readability, which split the tagline over two lines.
         On the wide dapp measure the whole sentence fits one line, so the cap is lifted here only. */
      .hero .sub { max-width: none; }
    }
    .p-btn:disabled { opacity: .5; cursor: default; }
    .p-btn:disabled:active { transform: none; }
  `}</style>
);

export const ExchangePage = ({ onNext }: ExchangePageProps) => {
  const router = useRouter();
  const walletState = useWallet();

  // ----- Original state (kept) -----
  const [fromToken, setFromToken] = useState(""); // address
  const [toToken, setToToken] = useState(""); // address
  const [amount, setAmount] = useState(""); // human amount
  const [showReceive, setShowReceive] = useState(false);

  const [chains, setChains] = useState<ChainEntry[]>([]);
  const [fromChainId, setFromChainId] = useState<string>("");
  const [toChainId, setToChainId] = useState<string>("");

  const [loadingChains, setLoadingChains] = useState(false);
  // The live quote: recomputed locally on every keystroke and refreshed against
  // fresh pool state every second (Jupiter-style). Null = no route / no input.
  const [quote, setQuote] = useState<LiveQuote | null>(null);
  const [quoteRefreshing, setQuoteRefreshing] = useState(false);
  const sessionRef = useRef<LivePairSession | null>(null);
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [quoteUpdatedAt, setQuoteUpdatedAt] = useState<number | null>(null);
  const [secondsSinceUpdate, setSecondsSinceUpdate] = useState<number>(0);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [fromTokenBalance, setFromTokenBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [recipientAddress, setRecipientAddress] = useState<string | null>(null);
  const [isEditingRecipient, setIsEditingRecipient] = useState(false);
  // Store balances for tokens in the selection modal: key = "chainId-tokenAddress"
  const [tokenBalances, setTokenBalances] = useState<
    Record<string, string | null>
  >({});
  const [loadingBalances, setLoadingBalances] = useState<
    Record<string, boolean>
  >({});
  // Track which balances have been requested to avoid duplicate fetches
  const fetchedBalancesRef = useRef<Set<string>>(new Set());

  // ----- UI state for modal selector -----
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("none");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchQueryNetwork, setSearchQueryNetwork] = useState("");
  // Tokens the user imported by pasting a contract address (resolved on-chain, must have a live pool).
  const [importedTokens, setImportedTokens] = useState<any[]>([]);
  const [importing, setImporting] = useState(false);
  const [selectedNetwork, setSelectedNetwork] = useState<string>(""); // temp network while selecting
  // Whole-chain token search results (name/symbol/address against the mp_tokens index).
  const [searchResults, setSearchResults] = useState<IndexedToken[]>([]);
  const [searchingIndex, setSearchingIndex] = useState(false);
  // Tokens the connected wallet actually holds on Robinhood Chain (balanceOf sweep).
  const [heldList, setHeldList] = useState<HeldToken[]>([]);
  const [loadingHeld, setLoadingHeld] = useState(false);
  // The default "verified" list: most-liquid vetted tokens on the chain.
  const [popularList, setPopularList] = useState<IndexedToken[]>([]);
  // Live market data (logo, mcap, liquidity, dexscreener link) for the visible picker rows.
  const [marketInfo, setMarketInfo] = useState<Map<string, TokenMarketInfo>>(new Map());
  const [showUnvetted, setShowUnvetted] = useState(false);

  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Swap history: loaded from Supabase when wallet connects
  const [swapHistory, setSwapHistory] = useState<any[]>([]);
  // ----- Load chains (kept) -----
  // Deep-link support: `?from=<addr>&fromChainId=<id>&to=<addr>&toChainId=<id>`
  // lets other screens open the swap with the
  // route already wired. Params are read from `window.location` to avoid
  // Next.js Suspense requirements on `useSearchParams`.
  useEffect(() => {
    setLoadingChains(true);
    getChains()
      .then((c) => {
        setChains(c);
        if (c[0]) {
          // Sensible defaults
          let initFromChainId = String(c[0].id);
          let initToChainId = String(c[0].id);
          let initFromToken =
            c[0].currency?.address || "0x0000000000000000000000000000000000000000";
          // Default receive side = USDG, the chain's stable leg. (The registry is
          // the source of truth — a token address the registry doesn't know
          // renders a broken card, so deep-links are validated below.)
          let initToToken =
            TOKENS.find((t) => t.symbol === "USDG")?.address ||
            "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

          // URL overrides — only if the chain id appears in the loaded list
          // (otherwise keep defaults so the picker doesn't show an empty chain).
          if (typeof window !== "undefined") {
            const sp = new URLSearchParams(window.location.search);
            const urlFrom = sp.get("from");
            const urlTo = sp.get("to");
            const urlFromCid = sp.get("fromChainId");
            const urlToCid = sp.get("toChainId");
            const knownChain = (id: string | null) =>
              !!id && c.some((ch) => String(ch.id) === id);
            const knownToken = (addr: string | null) =>
              !!addr &&
              c.some((ch) =>
                getTokensForChain(ch).some(
                  (t) => t.address?.toLowerCase() === addr.toLowerCase(),
                ),
              );

            if (knownChain(urlFromCid)) initFromChainId = urlFromCid!;
            if (knownChain(urlToCid)) initToChainId = urlToCid!;
            // Unknown deep-linked tokens keep the defaults instead of breaking
            // the quote card with unresolvable metadata.
            if (knownToken(urlFrom)) initFromToken = urlFrom!;
            if (knownToken(urlTo)) initToToken = urlTo!;
          }

          setFromChainId(initFromChainId);
          setToChainId(initToChainId);
          setFromToken(initFromToken);
          setToToken(initToToken);
        }
      })
      .finally(() => setLoadingChains(false));
  }, []);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Wallet address mirror. useWallet() (wagmi) is the single source of truth;
  // this keeps the local walletAddress/recipient/history in sync with it.
  useEffect(() => {
    if (walletState.isConnected && walletState.address) {
      if (walletState.address !== walletAddress) {
        setSwapHistory([]);
        try { window.sessionStorage?.removeItem("moleswap_history"); } catch {}
      }
      setWalletAddress(walletState.address);
      setRecipientAddress((r) => r || walletState.address);
    } else if (!walletState.isConnected && walletAddress) {
      setWalletAddress(null);
      setRecipientAddress(null);
      setFromTokenBalance(null);
      setSwapHistory([]);
      try { window.sessionStorage?.removeItem("moleswap_history"); } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletState.isConnected, walletState.address]);

  // Load persistent swap history from Supabase
  useEffect(() => {
    if (!walletState.isConnected || !walletState.address) return;
    (async () => {
      try {
        const user = await getOrCreateUser(walletState.address!);
        if (!user?.id) return;
        const history = await getUserSwapHistory(user.id, 50);
        if (!history || history.length === 0) return;

        // Resolve real token names for every address in the history (registry -> mp_tokens index ->
        // on-chain), so rows show HOODRAT/SUSHICAT etc. instead of a truncated address. NATIVE = ETH.
        const NATIVE_LC = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        const addrs = Array.from(
          new Set(
            history
              .flatMap((s: any) => [s.from_token, s.to_token])
              .map((a: string) => (a || "").toLowerCase())
              .filter((a: string) => a && a !== NATIVE_LC),
          ),
        );
        const metas = await resolveTokenMetas(addrs);
        const symOf = (a: string) => {
          const lc = (a || "").toLowerCase();
          if (!lc || lc === NATIVE_LC) return "ETH";
          return metas.get(lc)?.symbol || getTokenByAddress(lc)?.symbol || `${lc.slice(0, 6)}…${lc.slice(-4)}`;
        };
        const logoOf = (a: string) => {
          const lc = (a || "").toLowerCase();
          const m = metas.get(lc) || (getTokenByAddress(lc) as any);
          return m?.logoURI || tokenFallbackIcon(a, m?.symbol);
        };

        const mapped = history.map((s: any) => ({
          id: s.id,
          fromSymbol: symOf(s.from_token),
          toSymbol: symOf(s.to_token),
          fromAmount: s.from_amount || "0",
          toAmount: s.to_amount || "0",
          txHash: s.tx_hash || "",
          timestamp: s.created_at,
          fromLogo: logoOf(s.from_token),
          toLogo: logoOf(s.to_token),
        }));
        setSwapHistory(mapped);
      } catch (e) {
        console.warn("[MoleSwap] Failed to load swap history from DB:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletState.isConnected, walletState.address]);

  // ----- Derived chain/token lists (kept) -----
  // Since all virtual chains share id=4663, find the chain GROUP containing
  // the selected token (not just the first chain matching the id).
  const allTokens = useMemo(
    () => [...chains.flatMap((c) => getTokensForChain(c)), ...importedTokens],
    [chains, importedTokens],
  );

  // Resolve a pasted contract address into a selectable token: it must (a) be a valid address,
  // (b) have at least one active pool in the indexer so the aggregator can actually route it, and
  // (c) expose ERC-20 symbol/decimals on-chain. This is what makes MoleSwap a real aggregator —
  // any token with liquidity is tradable, not just the three in the default list.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!isAddress(q)) return;
    const lc = q.toLowerCase();
    if (allTokens.some((t) => t.address?.toLowerCase() === lc)) return;
    let cancelled = false;
    setImporting(true);
    (async () => {
      try {
        // On-chain discovery: does this token have ANY live pool (vs WETH or USDG) across every
        // executable factory? This finds launchpad/un-indexed tokens the moment they have liquidity.
        const found = await tokenHasPool(lc);
        if (cancelled) return;
        if (found.length === 0) {
          setImporting(false);
          return; // no live pool anywhere → not importable
        }
        const client = createPublicClient({ chain: robinhoodChain, transport: http() });
        const [symbol, decimals, name] = await Promise.all([
          client.readContract({ address: q as Address, abi: ERC20_META_ABI, functionName: "symbol" }).catch(() => "TOKEN"),
          client.readContract({ address: q as Address, abi: ERC20_META_ABI, functionName: "decimals" }).catch(() => 18),
          client.readContract({ address: q as Address, abi: ERC20_META_ABI, functionName: "name" }).catch(() => "Imported Token"),
        ]);
        if (cancelled) return;
        setImportedTokens((prev) =>
          prev.some((t) => t.address?.toLowerCase() === lc)
            ? prev
            : [
                ...prev,
                {
                  id: q,
                  address: q,
                  symbol: String(symbol),
                  name: String(name),
                  decimals: Number(decimals),
                  logoURI: tokenFallbackIcon(q, String(symbol)),
                  displaySymbol: String(symbol),
                  displaySubtitle: "Imported · Robinhood Chain",
                  sourceChain: "Robinhood Chain",
                },
              ],
        );
      } catch {
        /* ignore — token stays unimportable */
      } finally {
        if (!cancelled) setImporting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchQuery, allTokens]);

  // Whole-chain name/symbol search: query the mp_tokens index (debounced). This is what makes the
  // search bar find ANY token on Robinhood Chain by typing its name/symbol — not just the 3 in the
  // default list and not just by pasting an address.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2 || isAddress(q)) {
      setSearchResults([]);
      setSearchingIndex(false);
      return;
    }
    let cancelled = false;
    setSearchingIndex(true);
    const t = setTimeout(async () => {
      const res = await searchIndex(q, 40);
      if (!cancelled) {
        setSearchResults(res);
        setSearchingIndex(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [searchQuery]);

  // Load the default "verified" list (most-liquid vetted tokens) when the picker opens.
  useEffect(() => {
    if (selectionMode === "none") return;
    let cancelled = false;
    popularTokens(30).then((p) => {
      if (!cancelled) setPopularList(p);
    });
    return () => {
      cancelled = true;
    };
  }, [selectionMode]);

  // When the picker opens with a connected wallet, sweep the wallet's balances across the whole
  // indexed token universe so we can surface the tokens the user actually holds.
  useEffect(() => {
    if (selectionMode === "none" || !walletAddress) {
      setHeldList([]);
      return;
    }
    let cancelled = false;
    setLoadingHeld(true);
    (async () => {
      try {
        const held = await heldTokens(walletAddress);
        if (!cancelled) setHeldList(held);
      } catch {
        if (!cancelled) setHeldList([]);
      } finally {
        if (!cancelled) setLoadingHeld(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectionMode, walletAddress]);

  const fromChain = useMemo(
    () => chains.find((c) =>
      getTokensForChain(c).some((t) => t.address?.toLowerCase() === fromToken.toLowerCase())
    ) || chains.find((c) => String(c.id) === fromChainId) || chains[0],
    [chains, fromChainId, fromToken],
  );
  const toChain = useMemo(
    () => chains.find((c) =>
      getTokensForChain(c).some((t) => t.address?.toLowerCase() === toToken.toLowerCase())
    ) || chains.find((c) => String(c.id) === toChainId) || chains[0],
    [chains, toChainId, toToken],
  );

  const fromTokens = useMemo(
    () => allTokens,
    [allTokens],
  );
  const toTokens = useMemo(
    () => allTokens,
    [allTokens],
  );

  const fromTokenMeta = useMemo(
    () =>
      allTokens.find(
        (t) => t.address?.toLowerCase() === fromToken.toLowerCase(),
      ),
    [allTokens, fromToken],
  );
  const toTokenMeta = useMemo(
    () =>
      allTokens.find((t) => t.address?.toLowerCase() === toToken.toLowerCase()),
    [allTokens, toToken],
  );

  // ----- Amount -> wei (kept) -----
  const amountWei = useMemo(() => {
    const decimals = fromTokenMeta?.decimals ?? 18;
    if (!amount) return "";
    try {
      const [ints, frac = ""] = amount.split(".");
      const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
      const normalized =
        `${BigInt(ints || "0").toString()}${fracPadded}`.replace(/^0+/, "");
      return normalized || "0";
    } catch {
      return "";
    }
  }, [amount, fromTokenMeta]);

  // ----- Can quote (kept) -----
  const canQuote = useMemo(() => {
    return Boolean(
      fromChainId &&
        toChainId &&
        fromToken &&
        toToken &&
        amountWei &&
        amountWei !== "0",
    );
  }, [fromChainId, toChainId, fromToken, toToken, amountWei]);

  // True when the entered amount exceeds the wallet's balance — the swap would revert
  // with TransferFailed on the token pull, so block it in the UI instead.
  const insufficientBalance = useMemo(() => {
    if (!walletAddress || !fromTokenBalance || !amountWei || amountWei === "0") return false;
    try {
      const balRaw = parseUnits(fromTokenBalance as `${number}`, fromTokenMeta?.decimals ?? 18);
      return BigInt(amountWei) > balRaw;
    } catch {
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, fromTokenBalance, amountWei, fromTokenMeta?.decimals]);

  // ----- Live quote engine -----
  // One session per pair: init loads the registry + on-chain pool discovery +
  // full pool state. After that, quoting is pure math over the cached snapshot
  // (instant per keystroke) and a 1-second loop refreshes the snapshot in ONE
  // batched Multicall3 read, Jupiter-style — no per-tick discovery, no RPC bursts.
  const NATIVE_MARKER = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  const toAggToken = (a: string) => {
    const l = (a || "").toLowerCase();
    return !l ||
      l === "0x0000000000000000000000000000000000000000" ||
      l === "native" ||
      l === "eth"
      ? NATIVE_MARKER
      : a;
  };

  useEffect(() => {
    if (!fromToken || !toToken) return;
    let cancelled = false;
    sessionRef.current = null;
    setQuote(null);
    setQuoteRefreshing(true);
    (async () => {
      try {
        const rows = await loadPoolRows();
        const s = new LivePairSession(
          toAggToken(fromToken),
          toAggToken(toToken),
          CONTRACTS.WETH,
        );
        await s.init(rows);
        if (cancelled) return;
        sessionRef.current = s;
        setSessionEpoch((e) => e + 1);
      } catch (e) {
        console.error("[MoleSwap] pair session init failed:", e);
      } finally {
        if (!cancelled) setQuoteRefreshing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromToken, toToken]);

  // Pure recompute off the cached snapshot — runs on every keystroke and after
  // every state refresh. Never touches the network.
  const computeQuoteNow = useMemo(
    () => () => {
      const s = sessionRef.current;
      if (!s || !canQuote) {
        setQuote(null);
        return;
      }
      const q = s.quote({
        amountIn: BigInt(amountWei || "0"),
        recipient:
          recipientAddress ||
          walletAddress ||
          "0x000000000000000000000000000000000000dEaD",
        slippageBps: 50,
        decimalsIn: fromTokenMeta?.decimals ?? 18,
        decimalsOut: toTokenMeta?.decimals ?? 18,
      });
      setQuote(q);
      if (q) setQuoteUpdatedAt(q.updatedAt);
    },
    [
      canQuote,
      amountWei,
      recipientAddress,
      walletAddress,
      fromTokenMeta?.decimals,
      toTokenMeta?.decimals,
      sessionEpoch,
    ],
  );

  useEffect(() => {
    computeQuoteNow();
  }, [computeQuoteNow]);

  // The 1-second live refresh. Skips while the tab is hidden and while a
  // previous refresh is still in flight (the session guards re-entrancy).
  useEffect(() => {
    if (!canQuote) return;
    const id = setInterval(async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const s = sessionRef.current;
      if (!s) return;
      try {
        await s.refresh();
        computeQuoteNow();
      } catch {
        /* keep the previous quote on a failed refresh */
      }
    }, 1000);
    return () => clearInterval(id);
  }, [canQuote, computeQuoteNow]);

  // "Updated Xs ago" ticker — makes staleness visible if the RPC ever stalls.
  useEffect(() => {
    const id = setInterval(() => {
      if (!quoteUpdatedAt) return setSecondsSinceUpdate(0);
      setSecondsSinceUpdate(
        Math.max(0, Math.floor((Date.now() - quoteUpdatedAt) / 1000)),
      );
    }, 500);
    return () => clearInterval(id);
  }, [quoteUpdatedAt]);

  // ----- Display derivations (all from the typed LiveQuote) -----
  const formatTokenAmount = (
    wei: string | bigint | undefined,
    decimals: number | undefined,
  ) => {
    if (wei === undefined || wei === null || decimals === undefined || decimals === null)
      return "-";
    try {
      const s = wei.toString();
      const pad = decimals - Math.min(decimals, s.length);
      const full = pad > 0 ? "0".repeat(pad) + s : s;
      const i = full.slice(0, full.length - decimals) || "0";
      const f = full.slice(-decimals).replace(/0+$/, "").slice(0, 8);
      return f ? `${i}.${f}` : i;
    } catch {
      return "-";
    }
  };

  const expectedOut = useMemo(
    () => (quote ? formatTokenAmount(quote.amountOut, toTokenMeta?.decimals) : "-"),
    [quote, toTokenMeta?.decimals],
  );
  const minReceived = useMemo(
    () => (quote ? formatTokenAmount(quote.minAmountOut, toTokenMeta?.decimals) : "-"),
    [quote, toTokenMeta?.decimals],
  );

  // USD helper: USDG ≈ $1; ETH/WETH priced from the live WETH/USDG pool spot.
  const usdValueOf = useMemo(
    () => (human: number, tokenAddr: string | undefined) => {
      if (!isFinite(human) || human <= 0 || !tokenAddr) return null;
      const a = tokenAddr.toLowerCase();
      const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
      const wethLc = CONTRACTS.WETH.toLowerCase();
      if (a === usdg) return human;
      const ethUsd = quote?.usdPerWeth ?? null;
      if (ethUsd && (a === wethLc || a === "0x0000000000000000000000000000000000000000"))
        return human * ethUsd;
      return null;
    },
    [quote?.usdPerWeth],
  );

  const expectedOutUsd = useMemo(() => {
    if (!quote || !toTokenMeta?.decimals) return null;
    const human = Number(quote.amountOut) / Math.pow(10, toTokenMeta.decimals);
    return usdValueOf(human, toTokenMeta?.address);
  }, [quote, toTokenMeta?.decimals, toTokenMeta?.address, usdValueOf]);

  // Per-part route rows: "47% · ETH → WETH → USDG · PancakeSwap V3 (0.05%)"
  const routeRows = useMemo(() => {
    if (!quote) return [];
    const tokenInfoFor = (addr: string): { symbol: string; logo: string } => {
      const a = addr.toLowerCase();
      if (a === NATIVE_MARKER.toLowerCase())
        return { symbol: "ETH", logo: "/tokens/eth.svg" };
      const t = allTokens.find((x) => x.address?.toLowerCase() === a);
      if (t) return { symbol: displaySymbolOf(t), logo: t.logoURI || tokenFallbackIcon(a, displaySymbolOf(t)) };
      if (a === CONTRACTS.WETH.toLowerCase())
        return { symbol: "WETH", logo: "/tokens/weth.svg" };
      const short = `${addr.slice(0, 6)}…`;
      return { symbol: short, logo: tokenFallbackIcon(a, short) };
    };
    return quote.routes.map((r) => {
      // The token path with a logo for every node: tokenIn → …hops→ tokenOut.
      const pathTokens = [
        tokenInfoFor(r.hops[0]?.tokenIn ?? ""),
        ...r.hops.map((h) => tokenInfoFor(h.tokenOut)),
      ];
      const venues = [...new Set(r.hops.map((h) => `${h.venue} (${h.feePct})`))].join(" · ");
      return {
        pct: r.splitPct.toFixed(r.splitPct % 1 === 0 ? 0 : 1),
        pathTokens,
        path: pathTokens.map((t) => t.symbol).join(" → "),
        venues,
        out: formatTokenAmount(r.amountOut, toTokenMeta?.decimals),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote, allTokens, toTokenMeta?.decimals]);

  const rateLabel = useMemo(() => {
    if (!quote || !isFinite(quote.execRate) || quote.execRate <= 0) return undefined;
    const digits = quote.execRate >= 100 ? 2 : quote.execRate >= 1 ? 4 : 6;
    return `1 ${displaySymbolOf(fromTokenMeta)} = ${quote.execRate.toLocaleString(undefined, { maximumFractionDigits: digits })} ${displaySymbolOf(toTokenMeta)}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote, fromTokenMeta?.symbol, toTokenMeta?.symbol]);

  const priceImpactLabel = useMemo(() => {
    if (!quote || quote.priceImpactPct === null) return null;
    const v = quote.priceImpactPct;
    return {
      text: v < 0.01 ? "<0.01%" : `${v.toFixed(2)}%`,
      tone: v >= 3 ? "text-red-400" : v >= 1 ? "text-yellow-400" : "text-green-300",
      severe: v >= 3,
    };
  }, [quote]);

  const networkFeeLabel = useMemo(() => {
    if (!quote) return null;
    if (quote.gasEth === null) return `~${(Number(quote.gasUnits) / 1000).toFixed(0)}k gas`;
    const usd = quote.usdPerWeth ? quote.gasEth * quote.usdPerWeth : null;
    const eth = quote.gasEth < 0.000001 ? "<0.000001" : quote.gasEth.toFixed(6);
    return usd !== null ? `${eth} ETH ($${usd.toFixed(4)})` : `${eth} ETH`;
  }, [quote]);
  const isRhSwap = fromChainId === toChainId && String(fromChainId) === "4663";

  // Liquidity warning driven by the LIVE quote's real price impact across every
  // pool the aggregator scanned — not a hardcoded per-pool flag (which wrongly
  // fired for deep pairs like WETH/USDG that merely also have a thin fee tier).
  const thinPoolWarning = useMemo(() => {
    if (!quote || quote.priceImpactPct === null) return null;
    if (quote.priceImpactPct >= 5) {
      return `High price impact (${quote.priceImpactPct.toFixed(1)}%) — this pair is thin at this size. Try a smaller amount.`;
    }
    return null;
  }, [quote]);

  // Balance USD value from the live spot (USDG ≈ $1, ETH/WETH via the pool).
  const balanceUsdValue = useMemo(() => {
    if (!fromTokenBalance) return null;
    const n = Number(fromTokenBalance);
    if (!isFinite(n) || n <= 0) return null;
    return usdValueOf(n, fromTokenMeta?.address || fromToken);
  }, [fromTokenBalance, fromTokenMeta?.address, fromToken, usdValueOf]);

  const shortAddress = (addr?: string | null) => {
    if (!addr) return "";
    return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
  };

  const formatWalletAddress = (addr?: string | null) => {
    if (!addr) return "";
    return `${addr.slice(0, 4)}***${addr.slice(-3)}`;
  };

  const isValidAddress = (addr: string): boolean => {
    return /^0x[a-fA-F0-9]{40}$/.test(addr);
  };

  const handleRecipientAddressChange = (value: string) => {
    setRecipientAddress(value);
  };

  // Belt and braces for the picker's flip: a pair can also end up identical through a URL, a restored
  // session or the swap-direction button, and an identical pair has no route — the quote would simply
  // fail with a confusing "no route" instead of telling the user what is actually wrong.
  const sameAsset = !!fromToken && !!toToken && fromToken.toLowerCase() === toToken.toLowerCase();

  /**
   * Token risk tiering, in the shape Relay and Jumper use: never silently drop a token, but make an
   * unvetted one look unvetted and make the user opt in to seeing them.
   *
   * None of these signals inspect the contract, so none of them prove a token is safe — that is why
   * the label says "unverified" rather than "safe". What they do reliably catch is the shape of a
   * throwaway: no pool depth, no project page, minted minutes ago. A real project almost always has
   * a website or socials on its listing; a drainer deployed to catch one victim almost never does.
   *
   * Anything the user already HOLDS is always shown — hiding an asset someone owns would strand it.
   */
  const riskOf = (token: any): { tier: "ok" | "caution" | "unvetted"; why: string } => {
    const mi = marketInfo.get((token.address || "").toLowerCase());
    const lc = (token.address || "").toLowerCase();
    const curated = TOKENS.some((t) => t.address?.toLowerCase() === lc);
    if (curated) return { tier: "ok", why: "" };

    const liq = mi?.liquidityUsd ?? 0;
    const ageDays = mi?.pairCreatedAt ? (Date.now() - mi.pairCreatedAt) / 86_400_000 : undefined;

    if (!mi) return { tier: "unvetted", why: "No market data — this token has no indexed pair" };
    if (!mi.hasProjectInfo && liq < 5_000)
      return { tier: "unvetted", why: "No project info and thin liquidity" };
    if (liq < 1_000) return { tier: "unvetted", why: "Almost no liquidity — you may not be able to sell" };
    if (!mi.hasProjectInfo) return { tier: "caution", why: "No website or socials on its listing" };
    if (ageDays != null && ageDays < 2) return { tier: "caution", why: "Pair is less than 2 days old" };
    if (liq < 25_000) return { tier: "caution", why: "Low liquidity" };
    return { tier: "ok", why: "" };
  };

  const handleRecipientAddressBlur = () => {
    if (recipientAddress && !isValidAddress(recipientAddress)) {
      // Reset to wallet address if invalid
      setRecipientAddress(walletAddress);
    }
    setIsEditingRecipient(false);
  };

  const handleRecipientAddressKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key === "Enter") {
      handleRecipientAddressBlur();
    } else if (e.key === "Escape") {
      setRecipientAddress(walletAddress);
      setIsEditingRecipient(false);
    }
  };

  // Token logos: DexScreener (best long-tail source) → the token's own registry logo → identicon.
  // Never the chain icon — that made every unknown token render as ETH.
  const fromLogo = useMemo(
    () =>
      marketInfo.get((fromToken || "").toLowerCase())?.logo ||
      fromTokenMeta?.logoURI ||
      tokenFallbackIcon(fromToken, displaySymbolOf(fromTokenMeta)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [marketInfo, fromTokenMeta?.logoURI, fromToken, fromTokenMeta?.symbol],
  );
  const toLogo = useMemo(
    () =>
      marketInfo.get((toToken || "").toLowerCase())?.logo ||
      toTokenMeta?.logoURI ||
      tokenFallbackIcon(toToken, displaySymbolOf(toTokenMeta)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [marketInfo, toTokenMeta?.logoURI, toToken, toTokenMeta?.symbol],
  );

  // Fetch DexScreener market data (incl. the real logo) for the SELECTED from/to tokens, so the quote
  // card, the SEND panel and the review screen show real logos — not just the picker rows. Also patches
  // importedTokens' logoURI so the review screen (which reads the token meta) inherits it.
  useEffect(() => {
    const addrs = [fromToken, toToken]
      .map((a) => (a || "").toLowerCase())
      .filter((a) => a && a !== "0x0000000000000000000000000000000000000000" && a !== "eth" && a !== "native");
    if (addrs.length === 0) return;
    let cancelled = false;
    fetchTokenInfo(addrs).then((m) => {
      if (cancelled || m.size === 0) return;
      setMarketInfo((prev) => {
        const next = new Map(prev);
        for (const [k, v] of m) next.set(k, v);
        return next;
      });
      setImportedTokens((prev) =>
        prev.map((t) => {
          const info = m.get((t.address || "").toLowerCase());
          // Only upgrade an identicon/placeholder logo, never a curated one.
          const isPlaceholder = !t.logoURI || t.logoURI.startsWith("data:");
          return info?.logo && isPlaceholder ? { ...t, logoURI: info.logo } : t;
        }),
      );
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromToken, toToken]);

  const handleConnectWallet = async () => {
    try {
      walletState.connect();
    } catch (e) {
      // optional toast
    }
  };

  // Percentage / MAX buttons. These work in RAW wei with BigInt so they can never
  // exceed the on-chain balance — the previous float `.toFixed(6)` ROUNDED UP (e.g.
  // 886.4120619274 → 886.412062), making the swap try to spend more than the wallet
  // held, which reverts the whole tx with TransferFailed on the token pull.
  const setAmountFromRaw = (raw: bigint, decimals: number) => {
    if (raw <= 0n) {
      setAmount("");
      return;
    }
    setAmount(formatUnits(raw, decimals).replace(/\.?0+$/, ""));
  };
  const setAmountPercentage = (percentage: number) => {
    if (!fromTokenBalance) return;
    const decimals = fromTokenMeta?.decimals ?? 18;
    let raw: bigint;
    try {
      raw = parseUnits(fromTokenBalance as `${number}`, decimals);
    } catch {
      return;
    }
    const bps = BigInt(Math.round(percentage * 10000));
    setAmountFromRaw((raw * bps) / 10000n, decimals); // integer division floors
  };

  const handleSet20Percent = () => setAmountPercentage(0.2);
  const handleSet50Percent = () => setAmountPercentage(0.5);
  const handleSetMax = () => {
    if (!fromTokenBalance) return;
    const decimals = fromTokenMeta?.decimals ?? 18;
    let raw: bigint;
    try {
      raw = parseUnits(fromTokenBalance as `${number}`, decimals);
    } catch {
      return;
    }
    // For native ETH, keep a small buffer so the swap can still pay gas; for ERC-20
    // tokens MAX is the exact balance (the router pulls precisely this amount).
    const lc = (fromToken || "").toLowerCase();
    const isNativeIn = !fromToken || lc === "0x0000000000000000000000000000000000000000" || lc === "eth" || lc === "native";
    if (isNativeIn) {
      const gasBuffer = parseEther("0.0003");
      raw = raw > gasBuffer ? raw - gasBuffer : 0n;
    }
    setAmountFromRaw(raw, decimals);
  };

  // Honest ETA on Robinhood Chain: ~1s blocks, so a swap confirms in inclusion (~2s) plus roughly one
  // block per hop of the deepest route.
  const etaSeconds = useMemo(() => {
    if (!quote) return undefined;
    const maxHops = quote.routes.reduce((m, r) => Math.max(m, r.hops.length), 1);
    return 2 + maxHops;
  }, [quote]);

  const handleReviewSwap = () => {
    if (!quote) {
      // eslint-disable-next-line no-console
      console.warn("No quote available to review");
      return;
    }
    onNext("swap", {
      quote,
      fromToken: fromToken || "ETH",
      toToken,
      amount: amount || "0",
      expectedOut: expectedOut || "0",
      minReceived: minReceived || "0",
      // Carry the RESOLVED logos (DexScreener-preferred) onto the metas so the review + tx screens show
      // real token logos, not the identicon fallback.
      fromTokenMeta: fromTokenMeta ? { ...fromTokenMeta, logoURI: fromLogo } : fromTokenMeta,
      toTokenMeta: toTokenMeta ? { ...toTokenMeta, logoURI: toLogo } : toTokenMeta,
      fromChain,
      toChain,
      // Structured route rows (with per-hop token logos) for a clean depiction downstream.
      routes: routeRows,
      routeLabel:
        routeRows.length > 0
          ? routeRows.map((r) => `${r.pct}% ${r.path}`).join("  |  ")
          : "Auto",
      feesLabel: networkFeeLabel || "-",
      priceImpact: priceImpactLabel?.text,
      rateLabel: rateLabel || "-",
      etaSeconds,
      walletAddress,
      recipientAddress: recipientAddress || walletAddress,
    });
  };

  // Preview the quote as soon as there's a pair + amount — no wallet required
  // (Jupiter-style: see the price before connecting). The swap button still
  // gates on the wallet.
  useEffect(() => {
    setShowReceive(Boolean(fromToken && toToken && Number(amount) > 0));
  }, [fromToken, toToken, amount]);

  // ----- Fetch balance when wallet, chain, and token are selected -----
  useEffect(() => {
    let cancelled = false;

    const fetchBalance = async () => {
      if (!walletAddress || !fromChainId || !fromToken) {
        if (!cancelled) {
          setFromTokenBalance(null);
          setBalanceLoading(false);
        }
        return;
      }

      // Set loading immediately when conditions are met
      if (!cancelled) {
        setBalanceLoading(true);
      }

      try {
        const chain = chains.find((c) => String(c.id) === fromChainId);
        const vmType = chain?.vmType;
        const balance = await getTokenBalance(
          walletAddress as Address,
          fromToken,
          Number(fromChainId),
          fromTokenMeta?.decimals,
          vmType,
        );

        if (!cancelled) {
          setFromTokenBalance(balance);
          setBalanceLoading(false);
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("Failed to fetch balance:", error);
        if (!cancelled) {
          setFromTokenBalance(null);
          setBalanceLoading(false);
        }
      }
    };

    // Start fetching immediately (no delay for initial load)
    fetchBalance();

    return () => {
      cancelled = true;
    };
  }, [walletAddress, fromChainId, fromToken, fromTokenMeta?.decimals, (fromTokenMeta as any)?.bridgeable, chains, walletState.origin, walletState.originChain]);

  // ----- Modal select logic -----
  // open modal: seed selectedNetwork with the chain group containing the current token
  const openSelect = (mode: SelectionMode) => {
    setSelectionMode(mode);
    setSearchQuery("");
    setSearchQueryNetwork("");
    // The app runs on one chain, so BOTH pickers are fixed to Robinhood Chain. The FROM side used to
    // wait for a network choice before showing anything, which buried the user's own holdings behind
    // a step that has exactly one possible answer.
    setSelectedNetwork("Robinhood Chain");
    if (mode === "to") return;
    // Find the chain group that contains the currently selected token for this side
    const currentToken = fromToken;
    const matchedChain = chains.find((c) =>
      getTokensForChain(c).some((t) => t.address?.toLowerCase() === currentToken?.toLowerCase())
    );
    setSelectedNetwork(matchedChain?.name || chains[0]?.name || "");
  };

  const handleBackToExchange = () => {
    setSelectionMode("none");
    setSearchQuery("");
    setSearchQueryNetwork("");
    setSelectedNetwork("");
  };

  // Network list (single chain — Robinhood Chain — filtered by search).
  const filteredNetworks = useMemo(() => {
    const src = selectionMode === "to"
      ? chains.filter((c) => c.name === "Robinhood Chain")
      : chains;
    return src.filter((net) =>
      (net.displayName || net.name || "")
        .toLowerCase()
        .includes(searchQueryNetwork.toLowerCase()),
    );
  }, [chains, searchQueryNetwork, selectionMode]);

  // Tokens for the currently selected network in the modal.
  const modalChain =
    chains.find((c) => c.name === selectedNetwork) || null;
  // The default list (no search): the wallet's held tokens first, then the curated registry, then any
  // the user imported by address.
  const modalTokens = useMemo(() => {
    const seen = new Set<string>();
    const merged: any[] = [];
    const add = (t: any) => {
      const key = (t.address || "").toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push(t);
    };
    for (const t of heldList) add(t); // tokens the user actually owns, balance-desc
    if (selectionMode === "to") {
      for (const c of chains) for (const t of getTokensForChain(c)) add(t);
    } else if (modalChain) {
      for (const t of getTokensForChain(modalChain)) add(t);
    }
    for (const t of popularList) add(t); // most-liquid verified tokens on the chain
    for (const t of importedTokens) add(t);
    return merged;
  }, [modalChain, chains, selectionMode, importedTokens, heldList, popularList]);

  // With a query: local matches (held + registry + imported) UNION the whole-chain index results.
  const filteredModalTokens = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return modalTokens;
    const seen = new Set<string>();
    const out: any[] = [];
    const add = (t: any) => {
      const key = (t.address || "").toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(t);
    };
    for (const t of modalTokens) {
      if (
        (t.symbol || "").toLowerCase().includes(q) ||
        (t.name || "").toLowerCase().includes(q) ||
        (t.address || "").toLowerCase().includes(q)
      )
        add(t);
    }
    for (const t of searchResults) add(t); // whole-chain index matches
    return out;
  }, [modalTokens, searchQuery, searchResults]);

  // Enrich the visible picker rows with live market data (logo, mcap, liquidity, dexscreener link).
  useEffect(() => {
    if (selectionMode === "none") return;
    const addrs = filteredModalTokens
      .map((t) => t.address)
      .filter((a) => a && a.toLowerCase() !== "0x0000000000000000000000000000000000000000")
      .slice(0, 40);
    if (addrs.length === 0) return;
    let cancelled = false;
    fetchTokenInfo(addrs).then((m) => {
      if (cancelled || m.size === 0) return;
      setMarketInfo((prev) => {
        const next = new Map(prev);
        for (const [k, v] of m) next.set(k, v);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionMode, filteredModalTokens]);

  // Fetch balances for all tokens in the selected network
  // Optimized to batch fetch and cache results (similar to relay-kit demo pattern)
  useEffect(() => {
    if (!walletAddress || !selectedNetwork || !modalChain) {
      // Reset fetched ref when conditions aren't met
      fetchedBalancesRef.current.clear();
      return;
    }

    let cancelled = false;

    const fetchTokenBalances = async () => {
      const chainId = modalChain?.id || 4663;
      const vmType = modalChain.vmType;

      // While searching, skip the per-token sweep: held tokens already carry their balance and the
      // (up to 40) whole-chain search results don't need one — fetching each would storm the RPC.
      if (searchQuery.trim()) return;

      // Filter tokens that need balance fetching (skip held tokens — they already have .balance).
      const tokensToFetch = filteredModalTokens.filter((token) => {
        if ((token as any).balance != null) return false;
        const balanceKey = `${selectedNetwork}-${token.address}`;
        return (
          !fetchedBalancesRef.current.has(balanceKey) &&
          tokenBalances[balanceKey] === undefined &&
          !loadingBalances[balanceKey]
        );
      });

      if (tokensToFetch.length === 0) return;

      // Mark as fetched to prevent duplicate requests
      tokensToFetch.forEach((token) => {
        const balanceKey = `${selectedNetwork}-${token.address}`;
        fetchedBalancesRef.current.add(balanceKey);
      });

      // Mark all as loading
      setLoadingBalances((prev) => {
        const newState = { ...prev };
        tokensToFetch.forEach((token) => {
          const balanceKey = `${selectedNetwork}-${token.address}`;
          newState[balanceKey] = true;
        });
        return newState;
      });

      // Fetch balances for all tokens in parallel (batched).
      const balancePromises = tokensToFetch.map(async (token) => {
        if (cancelled) return null;

        const balanceKey = `${selectedNetwork}-${token.address}`;

        try {
          const balance = await getTokenBalance(
            walletAddress as Address,
            token.address,
            chainId,
            token.decimals,
            vmType,
          );

          if (!cancelled) {
            return { balanceKey, balance };
          }
        } catch (error) {
          if (!cancelled) {
            console.error(`Error fetching balance for ${token.symbol}:`, error);
            return { balanceKey, balance: null };
          }
        }
        return null;
      });

      const results = await Promise.all(balancePromises);

      if (!cancelled) {
        // Update all balances at once
        setTokenBalances((prev) => {
          const newState = { ...prev };
          results.forEach((result) => {
            if (result) {
              newState[result.balanceKey] = result.balance;
            }
          });
          return newState;
        });

        // Clear loading states
        setLoadingBalances((prev) => {
          const newState = { ...prev };
          tokensToFetch.forEach((token) => {
            const balanceKey = `${selectedNetwork}-${token.address}`;
            delete newState[balanceKey];
          });
          return newState;
        });
      }
    };

    // Small delay to debounce rapid network changes
    const timeoutId = setTimeout(() => {
      fetchTokenBalances();
    }, 100);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [
    walletAddress,
    selectedNetwork,
    modalChain?.id,
    modalChain?.vmType,
    filteredModalTokens.length,
  ]);

  // Reset fetched balances ref when network changes
  useEffect(() => {
    fetchedBalancesRef.current.clear();
  }, [selectedNetwork]);

  const handleSelectNetwork = (chainName: string) => {
    setSelectedNetwork(chainName);
  };

  const handleSelectToken = (token: any) => {
    const tokenAddress = typeof token === "string" ? token : token.address;
    if (!tokenAddress) return;
    // A searched / held token isn't in the registry, so persist its metadata into importedTokens —
    // otherwise fromTokenMeta/toTokenMeta can't resolve its symbol/decimals/logo and the card breaks.
    if (typeof token === "object") {
      const lc = tokenAddress.toLowerCase();
      const known =
        allTokens.some((t) => t.address?.toLowerCase() === lc) ||
        importedTokens.some((t) => t.address?.toLowerCase() === lc);
      if (!known) {
        setImportedTokens((prev) =>
          prev.some((t) => t.address?.toLowerCase() === lc)
            ? prev
            : [
                ...prev,
                {
                  id: tokenAddress,
                  address: tokenAddress,
                  symbol: token.symbol,
                  name: token.name,
                  decimals: token.decimals,
                  logoURI: token.logoURI || tokenFallbackIcon(tokenAddress, token.symbol),
                  displaySymbol: token.displaySymbol || token.symbol,
                  displaySubtitle: token.displaySubtitle || "Robinhood Chain",
                  sourceChain: "Robinhood Chain",
                },
              ],
        );
      }
    }
    // Single chain — always set chainId to 4663 (Robinhood Chain)
    const lcPick = tokenAddress.toLowerCase();
    if (selectionMode === "from") {
      // Same asset on both sides is not a swap and has no route. Picking the token already selected
      // opposite flips the pair, which is what the user meant.
      if (toToken && toToken.toLowerCase() === lcPick) setToToken(fromToken);
      setFromChainId("4663");
      setFromToken(tokenAddress);
    } else if (selectionMode === "to") {
      if (fromToken && fromToken.toLowerCase() === lcPick) setFromToken(toToken);
      setToChainId("4663");
      setToToken(tokenAddress);
    }
    setSelectionMode("none");
    setSelectedNetwork("");
    setSearchQuery("");
    setSearchQueryNetwork("");
  };
  // ----- Selection UI (token + network picker) -----
  if (selectionMode !== "none") {
    return (
      <>
        <main className="w-full">
          <ExchangeHero />

          <section className="p-grid p-side">
            {/* Token panel */}
            <div className="p-card">
              <div className="pick-head">
                <button className="tool-btn" onClick={handleBackToExchange} aria-label="Back">
                  <ArrowLeft size={16} />
                </button>
                <h3>{selectionMode === "from" ? "From" : "To"} token</h3>
              </div>

              <label
                className="search"
                style={{ marginTop: 14, background: "rgba(44,26,12,.07)", borderColor: "rgba(44,26,12,.12)" }}
              >
                <Search size={15} style={{ color: "var(--ink-3)" }} />
                <input
                  type="text"
                  placeholder="Search by token or symbol"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{ color: "var(--ink)" }}
                />
              </label>

              {/* Context label above the list */}
              {selectedNetwork && (
                <div className="ctx-row">
                  <span>
                    {searchQuery.trim()
                      ? searchingIndex
                        ? "Searching tokens…"
                        : `${filteredModalTokens.length} result${filteredModalTokens.length === 1 ? "" : "s"}`
                      : heldList.length > 0
                        ? "Your tokens"
                        : "Popular tokens"}
                  </span>
                  {!searchQuery.trim() && loadingHeld && <span>Loading balances…</span>}
                </div>
              )}

              <div className="tk-list">
                {selectedNetwork ? (
                  filteredModalTokens.length > 0 ? (
                    filteredModalTokens
                      .filter((token: any) => {
                        if (showUnvetted) return true;
                        const lc = (token.address || "").toLowerCase();
                        // Held tokens are never hidden: burying an asset someone owns strands it.
                        if (heldList.some((h) => h.address?.toLowerCase() === lc)) return true;
                        // A pasted address is an explicit request for that exact token.
                        if (isAddress(searchQuery.trim())) return true;
                        return riskOf(token).tier !== "unvetted";
                      })
                      .map((token, idx) => {
                      // Token row framing pulls symbol/subtitle from the registry.
                      const tokenInfo = TOKENS.find(
                        (t) => t.address?.toLowerCase() === token.address?.toLowerCase(),
                      );
                      const toDisp = tokenInfo ? getPoolDisplayInfo(tokenInfo) : null;
                      const symbolLabel = selectionMode === "to" && toDisp
                        ? toDisp.symbol
                        : displaySymbolOf(token);
                      const subtitleLabel = selectionMode === "to" && toDisp
                        ? toDisp.subtitle
                        : displaySubtitleOf(token);
                      const mi = marketInfo.get(token.address?.toLowerCase() || "");
                      const rowLogo = mi?.logo || token.logoURI || tokenFallbackIcon(token.address, symbolLabel);
                      const heldBal = (token as any).balance as string | undefined;
                      const fetched = tokenBalances[`${selectedNetwork}-${token.address}`];
                      const shownBal = heldBal ?? (fetched != null ? String(fetched) : undefined);
                      const isNative = token.address?.toLowerCase() === "0x0000000000000000000000000000000000000000";
                      const isSelected =
                        selectionMode === "from"
                          ? String(fromToken) === String(token.address)
                          : String(toToken) === String(token.address);
                      // heldList is merged in first, so the boundary between "owned" and the rest is
                      // simply the first row that is not held. Labelling it makes the ordering legible
                      // instead of something the user has to infer.
                      const heldSet = new Set(heldList.map((h) => h.address?.toLowerCase()));
                      const isHeld = heldSet.has(token.address?.toLowerCase() || "");
                      const prev = filteredModalTokens[idx - 1];
                      const prevHeld = idx > 0 && heldSet.has(prev?.address?.toLowerCase() || "");
                      const showRestHead = !isHeld && (idx === 0 ? false : prevHeld);
                      return (
                        <Fragment key={`${token.address}-${idx}`}>
                        {showRestHead && <div className="tk-group">All tokens</div>}
                        <button
                          onClick={() => handleSelectToken(token)}
                          className={`tk-row ${isSelected ? "sel" : ""}`}
                        >
                          <TokenIcon logo={rowLogo} symbol={symbolLabel} address={token.address} size={36} />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div className="tk-nm">
                              {symbolLabel}{" "}
                              {(() => {
                                const r = riskOf(token);
                                if (r.tier === "ok") return null;
                                return (
                                  <span
                                    className={`risk-chip ${r.tier}`}
                                    title={r.why}
                                    aria-label={`Risk: ${r.why}`}
                                  >
                                    {r.tier === "unvetted" ? "UNVERIFIED" : "CAUTION"}
                                  </span>
                                );
                              })()}
                              {(token as any).verified && (
                                <span className="vtick" title="Has real liquidity — not an endorsement">✓</span>
                              )}
                              {searchQuery.trim() && (token as any).verified === false && (
                                <span style={{ fontSize: "10.5px", color: "#b8860b", fontWeight: 600 }}> · unverified</span>
                              )}
                            </div>
                            <div className="tk-sub">{subtitleLabel}</div>
                            {/* live market stats + address */}
                            {!isNative && (
                              <div className="tk-stats">
                                {mi?.marketCap != null && <span>MC {fmtUsd(mi.marketCap)}</span>}
                                {mi?.liquidityUsd != null && <span>Liq {fmtUsd(mi.liquidityUsd)}</span>}
                                {mi?.priceChange24 != null && (
                                  <span className={mi.priceChange24 >= 0 ? "up" : "dn"}>
                                    {mi.priceChange24 >= 0 ? "+" : ""}
                                    {mi.priceChange24.toFixed(1)}%
                                  </span>
                                )}
                                <span>{shortAddr(token.address)}</span>
                              </div>
                            )}
                          </div>
                          <div className="tk-bal">
                            {mi?.dexUrl && (
                              <span
                                role="link"
                                title="View on DexScreener"
                                className="dexlink"
                                onClick={(e) => { e.stopPropagation(); window.open(mi.dexUrl!, "_blank", "noopener,noreferrer"); }}
                              >
                                DEX ↗
                              </span>
                            )}
                            {walletAddress && shownBal && (
                              <small>
                                {Number(shownBal || 0).toLocaleString(undefined, { maximumFractionDigits: 6, minimumFractionDigits: 0 })}
                              </small>
                            )}
                          </div>
                        </button>
                        </Fragment>
                      );
                    })
                  ) : (
                    <div className="p-empty">
                      {importing || searchingIndex
                        ? "Searching tokens…"
                        : isAddress(searchQuery.trim())
                          ? "No pool for this token yet"
                          : searchQuery.trim()
                            ? "No token found — paste a contract address to import it"
                            : "No token found"}
                    </div>
                  )
                ) : (
                  <div className="p-empty">Select a network first</div>
                )}
              </div>

              {/* Hidden tokens stay discoverable. Silently dropping them would read as "this token
                  does not exist", which is worse than showing it behind a deliberate opt-in. */}
              {selectedNetwork && !isAddress(searchQuery.trim()) && (
                <button className="unvetted-toggle" onClick={() => setShowUnvetted((v) => !v)}>
                  {showUnvetted ? "Hide unverified tokens" : "Show unverified tokens"}
                </button>
              )}
            </div>

            {/* Network panel */}
            <div className="p-card">
              <h3>Network</h3>

              <label
                className="search"
                style={{ marginTop: 14, background: "rgba(44,26,12,.07)", borderColor: "rgba(44,26,12,.12)" }}
              >
                <Search size={15} style={{ color: "var(--ink-3)" }} />
                <input
                  type="text"
                  placeholder="Search by network"
                  value={searchQueryNetwork}
                  onChange={(e) => setSearchQueryNetwork(e.target.value)}
                  style={{ color: "var(--ink)" }}
                />
              </label>

              <div style={{ marginTop: 12 }}>
                {loadingChains ? (
                  <div className="p-empty">
                    <span className="spin" aria-hidden="true">⟳</span> Loading chains...
                  </div>
                ) : filteredNetworks.length > 0 ? (
                  filteredNetworks.map((network) => (
                    <button
                      key={network.name}
                      onClick={() => handleSelectNetwork(network.name)}
                      className={`tk-row ${selectedNetwork === network.name ? "sel" : ""}`}
                    >
                      <TokenIcon
                        logo={network.iconUrl || network.logoUrl || "/placeholder-logo.png"}
                        symbol={network.displayName || network.name}
                        size={34}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div className="tk-nm">{network.displayName || network.name}</div>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="p-empty">No network found</div>
                )}
              </div>
            </div>
          </section>
        </main>
        <ExchangeStyles />
      </>
    );
  }

  // ----- Main Exchange UI -----
  return (
    <>
      {showSettings ? (
        <Settings setShowSettings={setShowSettings} />
      ) : (
        <>
          <main className="w-full swap-main">
            <ExchangeHero />

            <section className="swap-grid">
              <div>
                <div className="p-card">
                  {/* Header */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h3>Exchange</h3>
                    <div className="card-tools">
                      <button
                        className="tool-btn"
                        title="Swap history"
                        aria-label="Swap history"
                        onClick={() => {
                          setShowHistory(prev => !prev);
                        }}
                      >
                        <Clock size={16} />
                      </button>
                      <button
                        className="tool-btn"
                        title="Settings"
                        aria-label="Settings"
                        onClick={() => setShowSettings(true)}
                      >
                        <SettingsIcon size={16} />
                      </button>
                    </div>
                  </div>

                  {/* From */}
                  <button onClick={() => openSelect("from")} className="sel-card" style={{ marginTop: 14 }}>
                    <span className="sc-ic">
                      <TokenIcon logo={fromLogo} symbol={displaySymbolOf(fromTokenMeta)} address={fromToken} size={34} />
                    </span>
                    <span className="sc-body">
                      <span className="sc-lbl">
                        <span>From</span>
                        {walletAddress && (
                          <span className="wal-chip">{formatWalletAddress(walletAddress)}</span>
                        )}
                      </span>
                      <span className="sc-main">
                        {fromChain?.displayName ||
                          fromChain?.name ||
                          "Select Network"}{" "}
                        / {displaySymbolOf(fromTokenMeta) || "Select Token"}
                      </span>
                    </span>
                  </button>

                  {/* Flip */}
                  <div className="p-flip">
                    <button
                      aria-label="Swap direction"
                      onClick={() => {
                        const tempToken = fromToken;
                        const tempChain = fromChainId;
                        setFromToken(toToken);
                        setFromChainId(toChainId);
                        setToToken(tempToken);
                        setToChainId(tempChain);
                      }}
                    >
                      <ArrowUpDown size={17} />
                    </button>
                  </div>

                  {/* To */}
                  <div onClick={() => openSelect("to")} role="button" tabIndex={0} className="sel-card">
                    <span className="sc-ic">
                      <TokenIcon logo={toLogo} symbol={displaySymbolOf(toTokenMeta)} address={toToken} size={34} />
                    </span>
                    <span className="sc-body">
                      <span className="sc-lbl">
                        <span>To</span>
                        {walletAddress && (
                          <span onClick={(e) => e.stopPropagation()}>
                            {isEditingRecipient ? (
                              <input
                                type="text"
                                className="recip-in"
                                value={recipientAddress || ""}
                                onChange={(e) =>
                                  handleRecipientAddressChange(e.target.value)
                                }
                                onBlur={handleRecipientAddressBlur}
                                onKeyDown={handleRecipientAddressKeyDown}
                                onClick={(e) => e.stopPropagation()}
                                onFocus={(e) => e.stopPropagation()}
                                placeholder="0x..."
                                autoFocus
                              />
                            ) : (
                              <button
                                type="button"
                                className="recip-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setIsEditingRecipient(true);
                                }}
                              >
                                {formatWalletAddress(
                                  recipientAddress || walletAddress,
                                )}
                              </button>
                            )}
                          </span>
                        )}
                      </span>
                      <span className="sc-main">
                        {toToken ? "Robinhood Chain" : "Select Network"}{" "}
                        / {(toTokenMeta as any)?.symbol ||
                          displaySymbolOf(toTokenMeta) ||
                          "Select Token"}
                      </span>
                    </span>
                  </div>

                  {/* The "arrives as X on Robinhood Chain" confirmation was removed — it restated the
                      token already named directly above it on a single-chain deployment. The custom
                      recipient is NOT restating anything, so it stays: sending someone else's address
                      the proceeds is the one thing here worth showing back to the user before they sign. */}
                  {recipientAddress && walletAddress && recipientAddress.toLowerCase() !== walletAddress.toLowerCase() && (
                    <div className="arrive">
                      → Sending to {recipientAddress.slice(0, 6)}…{recipientAddress.slice(-4)}
                    </div>
                  )}

                  {/* Send */}
                  <div className="p-field" style={{ marginTop: 12 }}>
                    <div className="lbl">
                      <span>Send</span>
                    </div>
                    <div className="amt">
                      <input
                        className="big"
                        value={amount}
                        onChange={(e) =>
                          setAmount(e.target.value.replace(/[^0-9.]/g, ""))
                        }
                        placeholder="0.0"
                        inputMode="decimal"
                        aria-label="Amount to send"
                      />
                      <span className="p-mini" style={{ flex: "none", color: "var(--clay)", fontWeight: 800 }}>
                        {displaySymbolOf(fromTokenMeta)}
                      </span>
                    </div>
                    {/* Balance row inside the Send field */}
                    {walletAddress && fromToken && fromChainId && (
                      <div className="bal-row">
                        <span className="b1">
                          {balanceLoading ? (
                            <>Loading balance...</>
                          ) : fromTokenBalance ? (
                            <>
                              Balance:{" "}
                              {Number(fromTokenBalance).toLocaleString(
                                undefined,
                                {
                                  maximumFractionDigits: 6,
                                  minimumFractionDigits: 0,
                                },
                              )}{" "}
                              {displaySymbolOf(fromTokenMeta)}
                              {balanceUsdValue && (
                                <span>
                                  {" "}
                                  (${Number(balanceUsdValue).toFixed(2)})
                                </span>
                              )}
                            </>
                          ) : (
                            <>Unable to load balance</>
                          )}
                        </span>
                        {/* Helper buttons */}
                        {fromTokenBalance && !balanceLoading && (
                          <span className="chips">
                            <button type="button" onClick={handleSet20Percent}>
                              20%
                            </button>
                            <button type="button" onClick={handleSet50Percent}>
                              50%
                            </button>
                            <button type="button" onClick={handleSetMax}>
                              MAX
                            </button>
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Action Button (kept) */}
                  {!walletAddress ? (
                    <button onClick={handleConnectWallet} className="p-btn">
                      Connect wallet
                    </button>
                  ) : (
                    <>
                      {thinPoolWarning && (
                        <div className="warn-thin">⚠️ {thinPoolWarning}</div>
                      )}
                      <button
                        onClick={handleReviewSwap}
                        disabled={
                          !quote || !canQuote || !amount || Number(amount) <= 0 || insufficientBalance || sameAsset
                        }
                        className="p-btn"
                      >
                        {sameAsset
                          ? "Pick two different tokens"
                          : insufficientBalance
                            ? `Insufficient ${displaySymbolOf(fromTokenMeta)}`
                            : "Review swap"}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Receive Panel (kept, auto-shows when ready) */}
              {showReceive && (
                <div>
                  <div className="p-card">
                    <h3>Receive</h3>
                    <div style={{ marginTop: 12 }}>
                      {!quote ? (
                        <div className="noq">
                          {quoteRefreshing
                            ? "Scanning every live pool for the best route…"
                            : canQuote
                              ? "No route with live liquidity for this pair."
                              : "Select tokens and enter an amount to get a live quote."}
                        </div>
                      ) : (
                        <>
                          {/* Headline: what you receive */}
                          <div className="quote-head">
                            <TokenIcon logo={toLogo} symbol={displaySymbolOf(toTokenMeta)} address={toToken} size={40} />
                            <div style={{ minWidth: 0 }}>
                              <div className="qh-amt">
                                {expectedOut} {displaySymbolOf(toTokenMeta)}
                              </div>
                              <div className="qh-sub">
                                {expectedOutUsd !== null && (
                                  <span>≈ ${expectedOutUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} · </span>
                                )}
                                <span className="qh-live">
                                  LIVE · updated {secondsSinceUpdate <= 1 ? "just now" : `${secondsSinceUpdate}s ago`}
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Rate */}
                          <div className="rate-line">{rateLabel}</div>

                          {/* Detail rows */}
                          <div className="p-rows" style={{ marginTop: 6 }}>
                            <div className="p-row">
                              <span className="k">Min received</span>
                              <span className="v">
                                {minReceived} {displaySymbolOf(toTokenMeta)}
                              </span>
                            </div>
                            <div className="p-row">
                              <span className="k">Slippage</span>
                              <span className="v">{(quote.slippageBps / 100).toFixed(2)}%</span>
                            </div>
                            {priceImpactLabel && (
                              <div className="p-row">
                                <span className="k">Price impact</span>
                                <span
                                  className="v"
                                  style={{
                                    color:
                                      priceImpactLabel.tone === "text-red-400"
                                        ? "var(--rust)"
                                        : priceImpactLabel.tone === "text-yellow-400"
                                          ? "#b8860b"
                                          : "#1e9e50",
                                  }}
                                >
                                  {priceImpactLabel.text}
                                </span>
                              </div>
                            )}
                            {networkFeeLabel && (
                              <div className="p-row">
                                <span className="k">
                                  <Fuel size={13} style={{ display: "inline-block", verticalAlign: "-2px", marginRight: 5 }} />
                                  Network fee
                                </span>
                                <span className="v">{networkFeeLabel}</span>
                              </div>
                            )}
                            <div className="p-row">
                              <span className="k">Aggregator fee</span>
                              <span className={quote.feeBps ? "v" : "v pos"}>
                                {quote.feeBps ? `${(quote.feeBps / 100).toFixed(2)}%` : "0%"}
                              </span>
                            </div>
                            {etaSeconds != null && (
                              <div className="p-row">
                                <span className="k">Est. time</span>
                                <span className="v">~{etaSeconds}s</span>
                              </div>
                            )}
                          </div>

                          {/* Route breakdown — every split, its path and venue */}
                          {routeRows.length > 0 && (
                            <>
                              <div className="route-h">
                                Route · {quote.poolsQuoted} pools scanned
                              </div>
                              {routeRows.map((r, i) => (
                                <div key={i} className="route-row">
                                  <span className="pct">{r.pct}%</span>
                                  {/* Token path with a logo for every hop node */}
                                  <span className="path">
                                    {r.pathTokens.map((t, j) => (
                                      <span key={j} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                                        {j > 0 && <span className="sep">›</span>}
                                        <TokenIcon logo={t.logo} symbol={t.symbol} size={16} />
                                        <span>{t.symbol}</span>
                                      </span>
                                    ))}
                                  </span>
                                  <span className="ven">{r.venues}</span>
                                </div>
                              ))}
                            </>
                          )}

                          {priceImpactLabel?.severe && (
                            <div className="warn-red">
                              ⚠️ High price impact — this trade moves the pool
                              price by {priceImpactLabel.text}. Consider a smaller
                              amount.
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>
          </main>

          {/* Swap History Modal */}
          {showHistory && (
            <div className="cm-scrim" style={{ opacity: 1 }} onClick={() => setShowHistory(false)}>
              <div className="cm-panel wide" onClick={(e) => e.stopPropagation()}>
                <div className="cm-head">
                  <h2>Swap history</h2>
                  <button className="cm-x" onClick={() => setShowHistory(false)} aria-label="Close">
                    ✕
                  </button>
                </div>
                <div className="cm-body" style={{ maxHeight: 440, overflow: "auto" }}>
                  {swapHistory.length === 0 ? (
                    <div className="p-empty" style={{ padding: "44px 10px" }}>
                      <div style={{ fontSize: "1.3rem", fontWeight: 800, color: "var(--ink-2)" }}>No swaps yet</div>
                      <div style={{ marginTop: 6 }}>Completed swaps will appear here</div>
                    </div>
                  ) : (
                    swapHistory.map((swap: any) => {
                      const txHash = typeof swap.txHash === "object"
                        ? (swap.txHash?.hash || swap.txHash?.txHash || "")
                        : (swap.txHash || "");
                      return (
                        <div key={swap.id} className="hist-row">
                          <div className="h1">
                            {swap.fromAmount} <span className="fs">{swap.fromSymbol}</span>
                            <span style={{ color: "var(--ink-3)" }}>→</span>
                            {swap.toAmount?.length > 10 ? swap.toAmount.slice(0, 10) + "..." : swap.toAmount}{" "}
                            <span className="ts">{swap.toSymbol}</span>
                          </div>
                          <div className="h2">
                            <span>
                              {swap.timestamp ? new Date(swap.timestamp).toLocaleString() : ""}
                            </span>
                            {txHash && (
                              <a
                                href={`https://robinhoodchain.blockscout.com/tx/${txHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {txHash.slice(0, 10)}...{txHash.slice(-6)} ↗
                              </a>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}

          <ExchangeStyles />
        </>
      )}
    </>
  );
};
