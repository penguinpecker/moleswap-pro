"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUpDown, Clock, Fuel, Search, X } from "lucide-react";
import { DappStep } from ".";
import Image from "next/image";
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

  // Token logos: the TOKEN's own logo, else a deterministic per-token identicon.
  // Never the chain icon — that made every unknown token render as ETH.
  const fromLogo = useMemo(
    () => fromTokenMeta?.logoURI || tokenFallbackIcon(fromToken, displaySymbolOf(fromTokenMeta)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fromTokenMeta?.logoURI, fromToken, fromTokenMeta?.symbol],
  );
  const toLogo = useMemo(
    () => toTokenMeta?.logoURI || tokenFallbackIcon(toToken, displaySymbolOf(toTokenMeta)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toTokenMeta?.logoURI, toToken, toTokenMeta?.symbol],
  );

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
      fromTokenMeta,
      toTokenMeta,
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
    // The app runs on one chain, so the TO picker is fixed to Robinhood Chain.
    if (mode === "to") {
      setSelectedNetwork("Robinhood Chain");
      return;
    }
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
    if (selectionMode === "from") {
      setFromChainId("4663");
      setFromToken(tokenAddress);
    } else if (selectionMode === "to") {
      setToChainId("4663");
      setToToken(tokenAddress);
    }
    setSelectionMode("none");
    setSelectedNetwork("");
    setSearchQuery("");
    setSearchQueryNetwork("");
  };
  // ----- Selection UI (modal) -----
  if (selectionMode !== "none") {
    return (
      <div className="relative flex w-full flex-col justify-center gap-2 sm:flex-row sm:gap-4">
        {/* Token Panel */}
        <div className="flex w-full max-w-3xl flex-1 flex-col px-2 sm:p-6">
          <div className="relative z-10 mx-auto flex w-[90%] items-center justify-center rounded-lg px-3 py-2 text-center sm:w-[85%] sm:px-6 sm:py-4">
            <button
              onClick={handleBackToExchange}
              className="border-ground-button-border bg-ground-button absolute left-6 cursor-pointer justify-center rounded border-2 p-1 text-yellow-100 hover:scale-105"
            >
              <ArrowLeft className="h-6 w-6" />
            </button>
            <h1 className="text-peach-300 font-family-ThaleahFat text-shadow-header text-xl font-bold tracking-widest uppercase sm:text-3xl lg:text-5xl">
              {selectionMode === "from" ? "FROM" : "TO"} TOKEN
            </h1>
            <Image
              src="/quest/header-quest-bg.png"
              alt="Header"
              width={200}
              height={200}
              className="absolute inset-0 left-0 z-[-1] h-full w-full"
            />
          </div>

          <div className="relative mb-6 block h-full">
            <Image
              src="/quest/Quest-BG.png"
              alt="BG"
              width={200}
              height={200}
              className="absolute inset-0 z-0 h-full w-full object-fill"
            />

            {/* Search Tokens */}
            <div className="relative z-10 mx-auto mt-12 mb-4 w-[85%]">
              <div className="relative flex items-center gap-3 px-6 py-4">
                <Search className="h-6 w-6 text-[#B0B0B0]" />
                <input
                  type="text"
                  placeholder="SEARCH BY TOKEN OR SYMBOL"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="font-family-ThaleahFat flex-1 bg-transparent text-lg tracking-widest text-white uppercase placeholder:text-[#8B8B8B] focus:outline-none"
                />
                <Image
                  src="/quest/header-quest-bg.png"
                  alt="BG"
                  width={200}
                  height={200}
                  className="absolute inset-0 left-0 z-[-1] h-full w-full"
                />
              </div>
            </div>

            {/* Token List for Selected Network */}
            <div className="relative z-10 mx-auto mb-4 w-full p-2 sm:w-[90%] sm:p-4">
              {/* <Image
                src="/dapp/exchange-token-bg.png"
                alt="BG"
                width={200}
                height={200}
                className="absolute inset-0 left-0 z-[-1] h-full w-full"
              /> */}
              {/* Context label above the list */}
              {selectedNetwork && (
                <div className="mb-2 flex items-center justify-between px-4">
                  <span className="font-family-ThaleahFat text-sm tracking-widest text-[#9a9a9a] uppercase">
                    {searchQuery.trim()
                      ? searchingIndex
                        ? "Searching tokens…"
                        : `${filteredModalTokens.length} result${filteredModalTokens.length === 1 ? "" : "s"}`
                      : heldList.length > 0
                        ? "Your tokens"
                        : "Popular tokens"}
                  </span>
                  {!searchQuery.trim() && loadingHeld && (
                    <span className="font-family-ThaleahFat text-xs tracking-wider text-[#8B8B8B] uppercase">
                      Loading balances…
                    </span>
                  )}
                </div>
              )}
              <div className="hide-scrollbar relative flex max-h-[450px] flex-col gap-3 overflow-y-auto">
                {selectedNetwork ? (
                  filteredModalTokens.length > 0 ? (
                    filteredModalTokens.map((token, idx) => {
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
                      return (
                      <button
                        key={`${token.address}-${idx}`}
                        onClick={() => handleSelectToken(token)}
                        className={`relative cursor-pointer px-6 py-4 text-left`}
                      >
                        {(() => {
                          const mi = marketInfo.get(token.address?.toLowerCase() || "");
                          const rowLogo = mi?.logo || token.logoURI || tokenFallbackIcon(token.address, symbolLabel);
                          const heldBal = (token as any).balance as string | undefined;
                          const fetched = tokenBalances[`${selectedNetwork}-${token.address}`];
                          const shownBal = heldBal ?? (fetched != null ? String(fetched) : undefined);
                          const isNative = token.address?.toLowerCase() === "0x0000000000000000000000000000000000000000";
                          return (
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center justify-start gap-3">
                            <div className="border-ground-button-border h-12 w-12 shrink-0 overflow-hidden rounded-lg sm:h-14 sm:w-14">
                              {/* market logo can be any external CDN — plain img avoids next/image domain config */}
                              <img src={rowLogo} alt={token.symbol || "token"} width={56} height={56} className="h-full w-full object-cover" />
                            </div>
                            <div className="min-w-0 text-left">
                              <h2 className="font-family-ThaleahFat flex items-center gap-1.5 text-lg tracking-wider text-white uppercase sm:text-2xl sm:tracking-widest">
                                {symbolLabel}
                                {(token as any).verified && (
                                  <span title="Verified — has real liquidity" className="text-xs text-[#4ADE80] sm:text-sm">✓</span>
                                )}
                              </h2>
                              <p className="font-family-ThaleahFat -mt-0.5 truncate text-xs tracking-wider text-[#B0B0B0] uppercase sm:text-base sm:tracking-widest">
                                {subtitleLabel}
                                {searchQuery.trim() && (token as any).verified === false && (
                                  <span className="ml-2 text-xs text-yellow-500/80 normal-case">· unverified</span>
                                )}
                              </p>
                              {/* live market stats + address */}
                              {!isNative && (
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] normal-case sm:text-xs">
                                  {mi?.marketCap != null && <span className="text-[#9a9a9a]">MC {fmtUsd(mi.marketCap)}</span>}
                                  {mi?.liquidityUsd != null && <span className="text-[#9a9a9a]">Liq {fmtUsd(mi.liquidityUsd)}</span>}
                                  {mi?.priceChange24 != null && (
                                    <span className={mi.priceChange24 >= 0 ? "text-green-400" : "text-red-400"}>
                                      {mi.priceChange24 >= 0 ? "+" : ""}{mi.priceChange24.toFixed(1)}%
                                    </span>
                                  )}
                                  <span className="font-mono text-[#6f6f6f]">{shortAddr(token.address)}</span>
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            {mi?.dexUrl && (
                              <span
                                role="link"
                                title="View on DexScreener"
                                onClick={(e) => { e.stopPropagation(); window.open(mi.dexUrl!, "_blank", "noopener,noreferrer"); }}
                                className="cursor-pointer text-xs font-bold tracking-wider text-[#7DD3FC] hover:underline"
                              >
                                DEX ↗
                              </span>
                            )}
                            {walletAddress && shownBal && (
                              <span className="font-family-ThaleahFat text-base text-yellow-100 sm:text-lg">
                                {Number(shownBal || 0).toLocaleString(undefined, { maximumFractionDigits: 6, minimumFractionDigits: 0 })}
                              </span>
                            )}
                          </div>
                        </div>
                          );
                        })()}

                        <Image
                          src={`${
                            selectionMode === "from"
                              ? String(fromToken) === String(token.address)
                                ? "/dapp/selected-network-bg.png"
                                : "/quest/header-quest-bg.png"
                              : String(toToken) === String(token.address)
                                ? "/dapp/selected-network-bg.png"
                                : "/quest/header-quest-bg.png"
                          }`}
                          alt="BG"
                          width={200}
                          height={200}
                          className="absolute inset-0 left-0 z-[-1] h-full w-full"
                        />
                      </button>
                      );
                    })
                  ) : (
                    <p className="font-family-ThaleahFat text-center text-xl text-gray-400">
                      {importing || searchingIndex
                        ? "Searching tokens…"
                        : isAddress(searchQuery.trim())
                          ? "No pool for this token yet"
                          : searchQuery.trim()
                            ? "No token found — paste a contract address to import it"
                            : "No token found"}
                    </p>
                  )
                ) : (
                  <p className="font-family-ThaleahFat text-center text-xl text-gray-400">
                    Select a network first
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Network Panel */}
        <div className="flex w-full flex-col px-2 sm:max-w-xl sm:flex-1 sm:p-6">
          <div className="relative z-10 mx-auto w-[85%] rounded-lg px-6 py-4 text-center">
            <h1 className="text-peach-300 font-family-ThaleahFat text-shadow-header text-xl font-bold tracking-widest uppercase sm:text-3xl lg:text-5xl">
              NETWORK
            </h1>
            <Image
              src="/quest/header-quest-bg.png"
              alt="Header"
              width={200}
              height={200}
              className="absolute inset-0 left-0 z-[-1] h-full w-full"
            />
          </div>

          <div className="relative mb-6 block h-full">
            <Image
              src="/quest/Quest-BG.png"
              alt="BG"
              width={200}
              height={200}
              className="absolute inset-0 z-[-1] h-full w-full object-fill"
            />

            {/* Search Networks */}
            <div className="relative z-10 mx-auto mt-12 mb-4 w-[85%]">
              <div className="relative flex items-center gap-3 px-6 py-4">
                <Search className="h-6 w-6 text-[#B0B0B0]" />
                <input
                  type="text"
                  placeholder="SEARCH BY NETWORK"
                  value={searchQueryNetwork}
                  onChange={(e) => setSearchQueryNetwork(e.target.value)}
                  className="font-family-ThaleahFat flex-1 bg-transparent text-lg tracking-widest text-white uppercase placeholder:text-[#8B8B8B] focus:outline-none"
                />
                <Image
                  src="/quest/header-quest-bg.png"
                  alt="BG"
                  width={200}
                  height={200}
                  className="absolute inset-0 left-0 z-[-1] h-full w-full"
                />
              </div>
            </div>

            {/* Network List (with real logos) */}
            <div className="relative z-10 mx-auto mb-4 w-full p-4 sm:w-[90%]">
              {/* <Image
                src="/dapp/exchange-token-bg.png"
                alt="BG"
                width={200}
                height={200}
                className="absolute inset-0 left-0 z-[-1] h-full w-full"
              /> */}
              <div className="hide-scrollbar relative z-20 flex max-h-[450px] w-full flex-col gap-3 overflow-x-visible overflow-y-auto">
                {loadingChains ? (
                  <div className="relative flex h-screen w-full items-center justify-center">
                    <Image
                      src="/quest/Quest-BG.png"
                      alt="Background"
                      fill
                      className="absolute inset-0 z-[-1] h-full w-full object-fill"
                    />
                    <div className="z-10 flex flex-col items-center gap-4">
                      <div className="h-10 w-10 animate-spin rounded-full border-4 border-yellow-100 border-t-transparent"></div>
                      <p className="font-family-ThaleahFat text-peach-300 text-xs tracking-wider uppercase sm:text-base sm:tracking-widest">
                        Loading Chains...
                      </p>
                    </div>
                  </div>
                ) : filteredNetworks.length > 0 ? (
                  filteredNetworks.map((network) => (
                    <button
                      key={network.name}
                      onClick={() => handleSelectNetwork(network.name)}
                      className={`relative cursor-pointer px-6 py-4 text-left`}
                    >
                      <div className="flex items-center justify-start gap-4 transition-all hover:scale-[1.02]">
                        <div className="border-ground-button-border h-12 w-12">
                          <Image
                            src={
                              network.iconUrl ||
                              network.logoUrl ||
                              "/placeholder-logo.png"
                            }
                            alt={network.displayName || network.name || "chain"}
                            width={48}
                            height={48}
                            className="h-full w-full object-cover"
                          />
                        </div>
                        <div className="text-left">
                          <h2 className="font-family-ThaleahFat text-sm tracking-wider text-white uppercase sm:text-2xl sm:tracking-widest">
                            {network.displayName || network.name}
                          </h2>
                        </div>
                      </div>
                      <Image
                        src={
                          selectedNetwork === network.name
                            ? "/dapp/selected-network-bg.png"
                            : "/quest/header-quest-bg.png"
                        }
                        alt="BG"
                        width={200}
                        height={200}
                        className="absolute inset-0 left-0 z-[-1] h-full w-full"
                      />
                    </button>
                  ))
                ) : (
                  <p className="font-family-ThaleahFat text-center text-xl text-gray-400">
                    No network found
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ----- Main Exchange UI -----
  return (
    <>
      {showSettings ? (
        <Settings setShowSettings={setShowSettings} />
      ) : (
        <div className="relative flex w-full flex-col justify-center gap-2 sm:flex-row sm:gap-4">
          <div className="flex w-full max-w-3xl flex-1 flex-col px-2 sm:p-6">
            {/* Header */}
            <div className="relative z-10 mx-auto flex w-[90%] items-center justify-center rounded-lg px-3 py-2 text-center sm:w-[85%] sm:px-6 sm:py-4">
              <h1 className="text-peach-300 font-family-ThaleahFat text-shadow-header text-xl font-bold tracking-widest uppercase sm:text-3xl lg:text-5xl">
                EXCHANGE
              </h1>

              <div className="absolute right-6 flex items-center gap-1.5">
                <button
                  onClick={() => {
                    setShowHistory(prev => !prev);
                  }}
                  className="border-ground-button-border bg-ground-button cursor-pointer justify-center rounded border-2 p-1 text-yellow-100 transition-all hover:scale-105"
                >
                  <Clock className="h-6 w-6" />
                </button>
                <button
                  onClick={() => setShowSettings(true)}
                  className="border-ground-button-border bg-ground-button cursor-pointer justify-center rounded border-2 p-1 text-yellow-100 transition-all hover:scale-105"
                >
                  <Image
                    src="/dapp/settings-icons.png"
                    alt="Settings"
                    width={200}
                    height={200}
                    className="h-6 w-6"
                  />
                </button>
              </div>

              <Image
                src="/quest/header-quest-bg.png"
                alt="Header BG"
                width={200}
                height={200}
                className="absolute inset-0 left-0 z-[-1] h-full w-full"
              />
            </div>

            {/* Swap History Modal */}
            {showHistory && (
              <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60" onClick={() => setShowHistory(false)}>
                <div className="relative mx-4 w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
                  <Image src="/quest/Quest-BG.png" alt="BG" width={400} height={400} className="absolute inset-0 z-[-1] h-full w-full rounded-xl object-fill" />
                  <div className="p-6 sm:p-8">
                    <div className="mb-5 flex items-center justify-between">
                      <h3 className="font-family-ThaleahFat text-peach-300 text-4xl tracking-wider">SWAP HISTORY</h3>
                      <button onClick={() => setShowHistory(false)} className="border-ground-button-border bg-ground-button cursor-pointer rounded border-2 p-2 text-yellow-100 hover:scale-105"><X className="h-6 w-6" /></button>
                    </div>
                    <div className="custom-scrollbar max-h-[450px] overflow-y-auto">
                      {swapHistory.length === 0 ? (
                        <div className="py-12 text-center">
                          <p className="font-family-ThaleahFat text-3xl text-gray-500">NO SWAPS YET</p>
                          <p className="font-family-ThaleahFat mt-2 text-lg text-gray-600">COMPLETED SWAPS WILL APPEAR HERE</p>
                        </div>
                      ) : (
                        swapHistory.map((swap: any) => {
                          const txHash = typeof swap.txHash === "object"
                            ? (swap.txHash?.hash || swap.txHash?.txHash || "")
                            : (swap.txHash || "");
                          return (
                            <div key={swap.id} className="relative mb-3 rounded-lg px-5 py-4">
                              <Image src="/quest/header-quest-bg.png" alt="BG" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded-lg" />
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-family-ThaleahFat text-3xl text-white">{swap.fromAmount}</span>
                                <span className="font-family-ThaleahFat text-peach-500 text-xl">{swap.fromSymbol}</span>
                                <span className="text-xl text-gray-500">→</span>
                                <span className="font-family-ThaleahFat text-3xl text-white">{swap.toAmount?.length > 10 ? swap.toAmount.slice(0, 10) + "..." : swap.toAmount}</span>
                                <span className="font-family-ThaleahFat text-xl text-[#6DBB3E]">{swap.toSymbol}</span>
                              </div>
                              <div className="mt-2 flex items-center justify-between">
                                <span className="font-family-ThaleahFat text-base text-gray-500">
                                  {swap.timestamp ? new Date(swap.timestamp).toLocaleString() : ""}
                                </span>
                                {txHash && (
                                  <a
                                    href={`https://robinhoodchain.blockscout.com/tx/${txHash}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-family-ThaleahFat text-peach-300 flex items-center gap-1 text-base underline"
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
              </div>
            )}
            {/* Body */}
            <div className="relative mb-6 block h-full">
              <Image
                src="/quest/Quest-BG.png"
                alt="BG"
                width={200}
                height={200}
                className="absolute inset-0 z-0 h-full w-full object-fill"
              />

              {/* Exchange Form */}
              <div className="relative z-50 mx-auto mt-4 mb-4 grid w-full grid-cols-1 gap-3 p-2 sm:mt-12 sm:mb-6 sm:gap-4 sm:p-4 sm:w-[85%]">
                {/* From */}
                <button
                  onClick={() => openSelect("from")}
                  className="relative z-10 mx-auto w-full cursor-pointer rounded-lg px-3 py-2 text-left transition-all hover:scale-[1.02] sm:px-6 sm:py-4 sm:text-center sm:w-[90%]"
                >
                  <div className="flex items-center justify-start gap-4">
                    <div className="border-ground-button-border h-8 w-8 overflow-hidden rounded-lg border-2 bg-black/50 sm:h-12 sm:w-12">
                      <Image
                        src={fromLogo}
                        alt="From"
                        width={48}
                        height={48}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="flex-1 min-w-0 overflow-hidden text-left">
                      <div className="flex items-center justify-between gap-2">
                        <h2 className="font-family-ThaleahFat text-sm tracking-wider text-[#B0B0B0] uppercase sm:text-2xl sm:tracking-widest">
                          From
                        </h2>
                        {walletAddress && (
                          <p className="font-family-ThaleahFat text-peach-300 text-xs tracking-wider uppercase sm:text-base sm:tracking-widest">
                            {formatWalletAddress(walletAddress)}
                          </p>
                        )}
                      </div>
                      <p className="font-family-ThaleahFat text-sm font-bold tracking-wider text-[#EEEEEE] uppercase sm:text-xl lg:text-3xl truncate">
                        {fromChain?.displayName ||
                          fromChain?.name ||
                          "Select Network"}{" "}
                        / {displaySymbolOf(fromTokenMeta) || "Select Token"}
                      </p>
                    </div>
                  </div>
                  <Image
                    src="/quest/header-quest-bg.png"
                    alt="BG"
                    width={200}
                    height={200}
                    className="absolute inset-0 left-0 z-[-1] h-full w-full"
                  />
                </button>

                {/* Swap Icon */}
                <div className="relative z-20 flex justify-center">
                  <button
                    onClick={() => {
                      const tempToken = fromToken;
                      const tempChain = fromChainId;
                      setFromToken(toToken);
                      setFromChainId(toChainId);
                      setToToken(tempToken);
                      setToChainId(tempChain);
                    }}
                    className="absolute inset-0 left-[50%] flex h-14 w-14 translate-x-[-50%] translate-y-[-50%] cursor-pointer items-center justify-center p-2 transition-all hover:scale-105"
                  >
                    <ArrowUpDown className="text-peach-300 h-6 w-6" />
                    <Image
                      src="/dapp/swap-button.png"
                      alt="Swap"
                      width={200}
                      height={200}
                      className="absolute inset-0 z-[-1] h-full w-full object-fill"
                    />
                  </button>
                </div>

                {/* To */}
                <div
                  onClick={() => openSelect("to")}
                  role="button"
                  tabIndex={0}
                  className="relative z-10 mx-auto w-full cursor-pointer rounded-lg px-3 py-2 text-left transition-all hover:scale-[1.02] sm:px-6 sm:py-4 sm:text-center sm:w-[90%]"
                >
                  <div className="flex items-center justify-start gap-4">
                    <div className="border-ground-button-border h-8 w-8 overflow-hidden rounded-lg border-2 bg-black/50 sm:h-12 sm:w-12">
                      <Image
                        src={toLogo}
                        alt="To"
                        width={48}
                        height={48}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="flex-1 min-w-0 overflow-hidden text-left">
                      <div className="flex items-center justify-between gap-2">
                        <h2 className="font-family-ThaleahFat text-sm tracking-wider text-[#B0B0B0] uppercase sm:text-2xl sm:tracking-widest">
                          To
                        </h2>
                        {walletAddress && (
                          <div
                            className="flex items-center gap-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {isEditingRecipient ? (
                              <input
                                type="text"
                                value={recipientAddress || ""}
                                onChange={(e) =>
                                  handleRecipientAddressChange(e.target.value)
                                }
                                onBlur={handleRecipientAddressBlur}
                                onKeyDown={handleRecipientAddressKeyDown}
                                onClick={(e) => e.stopPropagation()}
                                onFocus={(e) => e.stopPropagation()}
                                placeholder="0x..."
                                className="font-family-ThaleahFat border-peach-300 text-peach-300 focus:ring-peach-300 w-36 rounded border bg-black/50 px-2 py-1 text-sm tracking-wider sm:w-48 sm:text-xl sm:tracking-widest uppercase focus:ring-1 focus:outline-none sm:w-64"
                                autoFocus
                              />
                            ) : (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setIsEditingRecipient(true);
                                }}
                                className="font-family-ThaleahFat text-peach-300 cursor-pointer text-sm tracking-wider uppercase sm:text-xl sm:tracking-widest hover:underline"
                              >
                                {formatWalletAddress(
                                  recipientAddress || walletAddress,
                                )}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                      <p className="font-family-ThaleahFat text-sm font-bold tracking-wider text-[#EEEEEE] uppercase sm:text-xl lg:text-3xl truncate">
                        {toToken ? "Robinhood Chain" : "Select Network"}{" "}
                        / {(toTokenMeta as any)?.symbol ||
                          displaySymbolOf(toTokenMeta) ||
                          "Select Token"}
                      </p>
                    </div>
                  </div>
                  <Image
                    src="/quest/header-quest-bg.png"
                    alt="BG"
                    width={200}
                    height={200}
                    className="absolute inset-0 left-0 z-[-1] h-full w-full"
                  />
                </div>

                {/* Bridge-out preview — when the output is deliverable to the
                    user's origin-chain wallet as the real asset, surface this
                    upfront so they know the swap completes with a destination
                    settlement on their home chain. No extra clicks from the
                    user — they just see the promise of where funds will land. */}
                {/* Confirms the exact asset the user receives on Robinhood Chain. */}
                {toTokenMeta && (
                  <div className="relative z-10 mx-auto -mt-2 w-full px-6 sm:w-[90%]">
                    <p className="font-family-ThaleahFat text-xs tracking-wider uppercase text-[#7DD3FC] sm:text-sm">
                      ✓ Arrives as {(toTokenMeta as any)?.symbol || displaySymbolOf(toTokenMeta)} on Robinhood Chain
                      {recipientAddress && walletAddress && recipientAddress.toLowerCase() !== walletAddress.toLowerCase() && (
                        <> → {recipientAddress.slice(0, 6)}…{recipientAddress.slice(-4)}</>
                      )}
                    </p>
                  </div>
                )}

                {/* Amount */}
                <div className="relative z-10 mx-auto w-full rounded-lg px-6 py-4 text-center sm:w-[90%]">
                  <div className="flex items-center justify-start gap-4">
                    <div className="border-ground-button-border bg-ground-button h-8 w-8 rounded-lg border-2 p-2 sm:h-12 sm:w-12 sm:p-4"></div>
                    <div className="w-full text-left">
                      <h2 className="font-family-ThaleahFat text-sm tracking-wider text-[#B0B0B0] uppercase sm:text-2xl sm:tracking-widest">
                        Send
                      </h2>
                      <div className="font-family-ThaleahFat flex w-full items-center justify-between gap-2 text-base tracking-wider sm:text-2xl sm:tracking-widest uppercase">
                        <input
                          value={amount}
                          onChange={(e) =>
                            setAmount(e.target.value.replace(/[^0-9.]/g, ""))
                          }
                          placeholder="0.0"
                          className="w-full bg-transparent text-white outline-none placeholder:text-[#aaa]"
                          inputMode="decimal"
                        />
                        <span className="text-peach-300">
                          {displaySymbolOf(fromTokenMeta)}
                        </span>
                      </div>
                      {/* Balance Display inside Send card */}
                      {walletAddress && fromToken && fromChainId && (
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <div className="flex-1">
                            {balanceLoading ? (
                              <p className="font-family-ThaleahFat text-base tracking-widest text-yellow-100/85 uppercase sm:text-lg">
                                Loading balance...
                              </p>
                            ) : fromTokenBalance ? (
                              <p className="font-family-ThaleahFat text-base tracking-widest text-yellow-100 uppercase sm:text-lg">
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
                                  <span className="text-yellow-200">
                                    {" "}
                                    (${Number(balanceUsdValue).toFixed(2)})
                                  </span>
                                )}
                              </p>
                            ) : (
                              <p className="font-family-ThaleahFat text-base tracking-widest text-yellow-100 uppercase sm:text-lg">
                                Unable to load balance
                              </p>
                            )}
                          </div>
                          {/* Helper buttons */}
                          {fromTokenBalance && !balanceLoading && (
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={handleSet20Percent}
                                className="font-family-ThaleahFat border-ground-button-border bg-ground-button hover:bg-opacity-80 cursor-pointer rounded border p-1 text-base tracking-widest text-yellow-100 uppercase transition-all hover:scale-105"
                              >
                                20%
                              </button>
                              <button
                                type="button"
                                onClick={handleSet50Percent}
                                className="font-family-ThaleahFat border-ground-button-border bg-ground-button hover:bg-opacity-80 cursor-pointer rounded border p-1 text-base tracking-widest text-yellow-100 uppercase transition-all hover:scale-105"
                              >
                                50%
                              </button>
                              <button
                                type="button"
                                onClick={handleSetMax}
                                className="font-family-ThaleahFat border-ground-button-border bg-ground-button hover:bg-opacity-80 cursor-pointer rounded border p-1 text-base tracking-widest text-yellow-100 uppercase transition-all hover:scale-105"
                              >
                                MAX
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <Image
                    src="/quest/header-quest-bg.png"
                    alt="BG"
                    width={200}
                    height={200}
                    className="absolute inset-0 left-0 z-[-1] h-full w-full"
                  />
                </div>

                {/* Action Button (kept) */}
                {!walletAddress ? (
                  <button
                    onClick={handleConnectWallet}
                    className="relative w-full cursor-pointer rounded py-4 text-base font-bold text-white transition-all sm:text-xl hover:scale-105"
                  >
                    <span>CONNECT WALLET</span>
                    <Image
                      src="/dapp/connect-wallet.png"
                      alt="Connect"
                      width={200}
                      height={200}
                      className="absolute inset-0 z-[-1] h-full w-full object-fill"
                    />
                  </button>
                ) : (
                  <>
                    {thinPoolWarning && (
                      <div className="relative mb-3 rounded-lg px-4 py-3 text-center">
                        <p className="font-family-ThaleahFat text-sm tracking-wider text-yellow-200 uppercase sm:text-base">
                          ⚠️ {thinPoolWarning}
                        </p>
                        <Image
                          src="/quest/header-quest-bg.png"
                          alt="Warning BG"
                          width={200}
                          height={200}
                          className="absolute inset-0 left-0 z-[-1] h-full w-full opacity-80"
                        />
                      </div>
                    )}
                    <button
                      onClick={handleReviewSwap}
                      disabled={
                        !quote || !canQuote || !amount || Number(amount) <= 0 || insufficientBalance
                      }
                      className="relative w-full cursor-pointer rounded py-4 text-base font-bold text-white transition-all sm:text-xl hover:scale-105 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span>{insufficientBalance ? ` INSUFFICIENT ${displaySymbolOf(fromTokenMeta)} ` : " REVIEW SWAP "}</span>
                      <Image
                        src="/dapp/connect-wallet.png"
                        alt="Review"
                        width={200}
                        height={200}
                        className="absolute inset-0 z-[-1] h-full w-full object-fill"
                      />
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Receive Panel (kept, auto-shows when ready) */}
          {showReceive && (
            <div className="flex w-full flex-col px-2 sm:max-w-xl sm:flex-1 sm:p-6">
              <div className="relative z-10 mx-auto w-[85%] rounded-lg px-6 py-4 text-center">
                <h1 className="text-peach-300 font-family-ThaleahFat text-shadow-header text-xl font-bold tracking-widest uppercase sm:text-3xl lg:text-5xl">
                  RECEIVE
                </h1>
                <Image
                  src="/quest/header-quest-bg.png"
                  alt="Header"
                  width={200}
                  height={200}
                  className="absolute inset-0 left-0 z-[-1] h-full w-full"
                />
              </div>
              <div className="relative mb-6 block h-full">
                <Image
                  src="/quest/Quest-BG.png"
                  alt="BG"
                  width={200}
                  height={200}
                  className="absolute inset-0 z-[-1] h-full w-full object-fill"
                />
                <div className="relative z-10 mx-auto mt-4 w-[95%] sm:mt-12 sm:w-[90%]">
                  {!quote ? (
                    <div className="rounded bg-black/40 p-4 text-left text-sm text-[#BCBCBC]">
                      {quoteRefreshing
                        ? "Scanning every live pool for the best route…"
                        : canQuote
                          ? "No route with live liquidity for this pair."
                          : "Select tokens and enter an amount to get a live quote."}
                    </div>
                  ) : (
                    <div className="relative z-50 p-4">
                      <div className="flex w-full flex-col justify-between gap-3 py-1 sm:px-4">
                        {/* Headline: what you receive */}
                        <div className="flex items-center justify-between">
                          <div className="border-ground-button-border h-8 w-8 overflow-hidden rounded-lg border-2 bg-black/50 sm:h-12 sm:w-12">
                            <Image
                              src={toLogo}
                              alt={`${displaySymbolOf(toTokenMeta)} logo`}
                              width={48}
                              height={48}
                              className="h-full w-full object-cover"
                            />
                          </div>
                          <div className="mr-auto ml-4 min-w-0 flex-1 overflow-hidden text-left">
                            <div className="font-family-ThaleahFat text-lg text-yellow-100 truncate sm:text-3xl">
                              {expectedOut} {displaySymbolOf(toTokenMeta)}
                            </div>
                            <div className="text-sm font-semibold text-[#BCBCBC]">
                              {expectedOutUsd !== null && (
                                <span>≈ ${expectedOutUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} · </span>
                              )}
                              <span className="text-green-300">
                                LIVE · updated {secondsSinceUpdate <= 1 ? "just now" : `${secondsSinceUpdate}s ago`}
                              </span>
                            </div>
                          </div>
                          <button className="border-ground-button-border bg-ground-button justify-center rounded border-2 p-1 text-yellow-100">
                            <ArrowDown className="z-10 h-4 w-4" />
                          </button>
                        </div>

                        {/* Rate */}
                        <div className="text-left text-xs font-semibold text-[#BCBCBC]">
                          {rateLabel}
                        </div>

                        <div className="bg-peach-500 h-[1px] w-full" />

                        {/* Detail rows */}
                        <div className="space-y-1.5 text-left text-xs sm:text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[#9a9a9a]">Min received</span>
                            <span className="text-yellow-100">
                              {minReceived} {displaySymbolOf(toTokenMeta)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[#9a9a9a]">Slippage</span>
                            <span className="text-yellow-100">{(quote.slippageBps / 100).toFixed(2)}%</span>
                          </div>
                          {priceImpactLabel && (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[#9a9a9a]">Price impact</span>
                              <span className={priceImpactLabel.tone}>{priceImpactLabel.text}</span>
                            </div>
                          )}
                          {networkFeeLabel && (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[#9a9a9a]">
                                <Fuel className="mr-1 inline-block h-3.5 w-3.5" />
                                Network fee
                              </span>
                              <span className="text-yellow-100">{networkFeeLabel}</span>
                            </div>
                          )}
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[#9a9a9a]">Aggregator fee</span>
                            <span className={quote.feeBps ? "text-yellow-100" : "text-green-300"}>
                              {quote.feeBps ? `${(quote.feeBps / 100).toFixed(2)}%` : "0%"}
                            </span>
                          </div>
                          {etaSeconds != null && (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[#9a9a9a]">Est. time</span>
                              <span className="text-yellow-100">~{etaSeconds}s</span>
                            </div>
                          )}
                        </div>

                        {/* Route breakdown — every split, its path and venue */}
                        {routeRows.length > 0 && (
                          <>
                            <div className="bg-peach-500 h-[1px] w-full" />
                            <div className="space-y-1 text-left">
                              <div className="text-xs font-bold tracking-wider text-[#9a9a9a] uppercase">
                                Route · {quote.poolsQuoted} pools scanned
                              </div>
                              {routeRows.map((r, i) => (
                                <div key={i} className="flex items-center justify-between gap-2 text-xs">
                                  <span className="w-9 shrink-0 text-yellow-100">{r.pct}%</span>
                                  {/* Token path with a logo for every hop node */}
                                  <span className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
                                    {r.pathTokens.map((t, j) => (
                                      <span key={j} className="flex items-center gap-0.5">
                                        {j > 0 && <span className="text-[#7a7a7a]">›</span>}
                                        <Image
                                          src={t.logo}
                                          alt={t.symbol}
                                          width={16}
                                          height={16}
                                          className="h-4 w-4 shrink-0 rounded-full"
                                        />
                                        <span className="text-[#BCBCBC]">{t.symbol}</span>
                                      </span>
                                    ))}
                                  </span>
                                  <span className="shrink-0 text-right text-[#9a9a9a]">{r.venues}</span>
                                </div>
                              ))}
                            </div>
                          </>
                        )}

                        {priceImpactLabel?.severe && (
                          <div className="rounded bg-red-900/40 px-2 py-1 text-left text-xs text-red-300">
                            ⚠️ High price impact — this trade moves the pool
                            price by {priceImpactLabel.text}. Consider a smaller
                            amount.
                          </div>
                        )}
                      </div>
                      <Image
                        src="/quest/header-quest-bg.png"
                        alt="BG"
                        width={200}
                        height={200}
                        className="absolute inset-0 left-0 z-[-1] h-full w-full"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
};
