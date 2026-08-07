"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUpDown, Clock, Fuel, Search, X } from "lucide-react";
import { DappStep } from ".";
import Image from "next/image";
import { getChains, getTokensForChain, type RelayChain } from "@/lib/relay/api";
import { relayClient } from "@/lib/relay/client";
import { usePushWallet } from "@/lib/pushchain/provider";
import { getTokenByAddress, POOLS, CONTRACTS, getPoolDisplayInfo, TOKENS } from "@/lib/pushchain/contracts";
import { estimateSwapDetails } from "@/lib/pushchain/amm";
import { getOrCreateUser, getUserSwapHistory } from "@/lib/supabase/api";
import { getTokenBalance } from "@/lib/wallet/walletClient";
import { fetchOriginBalance } from "@/lib/wallet/originBalance";
import { useRouter } from "next/navigation";
import type { Address } from "viem";
import Settings from "../settings";
import { diagnostics } from "@/lib/diagnostics";

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
 * UI-facing display helpers. Always prefer the RelayCurrency's displaySymbol /
 * displaySubtitle when present — they carry real-asset names ("ETH", "SOL",
 * "USDT") with origin chain subtitles ("on Solana", "on Ethereum"). Fall back
 * to the raw symbol/name if a token hasn't been annotated yet.
 *
 * Accepts `unknown | null | undefined` so callers can pass `fromTokenMeta`
 * directly without null-checking — the helper returns safe defaults.
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
  const pushWallet = usePushWallet();

  // ----- Original state (kept) -----
  const [fromToken, setFromToken] = useState(""); // address
  const [toToken, setToToken] = useState(""); // address
  const [amount, setAmount] = useState(""); // human amount
  const [showReceive, setShowReceive] = useState(false);

  const [chains, setChains] = useState<RelayChain[]>([]);
  const [fromChainId, setFromChainId] = useState<string>("");
  const [toChainId, setToChainId] = useState<string>("");

  const [loadingChains, setLoadingChains] = useState(false);
  const [quote, setQuote] = useState<any>(null);
  const [quoteRefreshing, setQuoteRefreshing] = useState(false);
  const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [quoteUpdatedAt, setQuoteUpdatedAt] = useState<number | null>(null);
  const [ttlLeft, setTtlLeft] = useState<number>(0);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [pushEstimate, setPushEstimate] = useState<{ etaSeconds: number; totalGas: number; txCount: number; breakdown: string[] } | null>(null);
  const [fromTokenBalance, setFromTokenBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  // Origin-chain balance for cross-chain users: e.g. Phantom user's actual
  // SOL on Solana Devnet (shown alongside pSOL balance so they understand
  // what gets bridged in when they swap).
  const [originBalance, setOriginBalance] = useState<string | null>(null);
  // For Solana origins, whether Phantom is actually on Devnet. When false,
  // any bridge attempt fails with "Me: Unexpected error" from Phantom.
  const [phantomClusterWarning, setPhantomClusterWarning] = useState<string | null>(null);
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
  const [selectedNetwork, setSelectedNetwork] = useState<string>(""); // temp network while selecting

  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Swap history: loaded from Supabase when wallet connects
  const [swapHistory, setSwapHistory] = useState<any[]>([]);
  // ----- Load chains (kept) -----
  // Deep-link support: `?from=<addr>&fromChainId=<id>&to=<addr>&toChainId=<id>`
  // lets other screens (e.g. pools "GET pSOL" CTA) open the swap with the
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
          let initToToken = "0x2971824Db68229D087931155C2b8bB820B275809";

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

            if (knownChain(urlFromCid)) initFromChainId = urlFromCid!;
            if (knownChain(urlToCid)) initToChainId = urlToCid!;
            if (urlFrom) initFromToken = urlFrom;
            if (urlTo) initToToken = urlTo;
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

  // Session-owner guard. When the user has connected (or is connecting) via the
  // Push Universal Wallet modal, Push owns the session — any direct read of
  // window.ethereum / WalletConnect would stomp the resolved UEA with a stale
  // MetaMask address (since MetaMask wins the EIP-1193 injection race whenever
  // both MM and Phantom are installed). We mirror the flag into a ref so the
  // mount-only effects below can consult the *current* value without capturing
  // stale closures.
  const pushOwnsSessionRef = useRef(false);
  useEffect(() => {
    pushOwnsSessionRef.current =
      pushWallet.isConnected || pushWallet.isConnecting;
  }, [pushWallet.isConnected, pushWallet.isConnecting]);

  // Sync wallet address from PushChain context
  useEffect(() => {
    if (pushWallet.isConnected && pushWallet.address) {
      if (pushWallet.address !== walletAddress) {
        diagnostics.logSessionEvent("PushChain wallet changed", {
          from: walletAddress?.slice(0, 10),
          to: pushWallet.address?.slice(0, 10),
        });
        setSwapHistory([]);
        try { window.sessionStorage?.removeItem("moleswap_history"); } catch {}
      }
      setWalletAddress(pushWallet.address);
      setRecipientAddress(pushWallet.address);
      setShowReceive(true);
    }
    if (!pushWallet.isConnected && walletAddress) {
      diagnostics.logSessionEvent("PushChain wallet disconnected", {
        previousAddress: walletAddress?.slice(0, 10),
      });
      setWalletAddress(null);
      setRecipientAddress(null);
      setShowReceive(false);
      setFromTokenBalance(null);
      setSwapHistory([]);
      try { window.sessionStorage?.removeItem("moleswap_history"); } catch {}
    }
  }, [pushWallet.isConnected, pushWallet.address]);

  // Load persistent swap history from Supabase
  useEffect(() => {
    if (!pushWallet.isConnected || !pushWallet.address) return;
    (async () => {
      try {
        const user = await getOrCreateUser(pushWallet.address!);
        if (!user?.id) return;
        const history = await getUserSwapHistory(user.id, 50);
        if (!history || history.length === 0) return;
        const mapped = history.map((s: any) => {
          const fromInfo = getTokenByAddress(s.from_token);
          const toInfo = getTokenByAddress(s.to_token);
          return {
            id: s.id,
            fromSymbol: fromInfo?.symbol || s.from_token?.slice(0, 8) || "?",
            toSymbol: toInfo?.symbol || s.to_token?.slice(0, 8) || "?",
            fromAmount: s.from_amount || "0",
            toAmount: s.to_amount || "0",
            txHash: s.tx_hash || "",
            timestamp: s.created_at,
            fromLogo: fromInfo?.logoURI || "/placeholder-logo.png",
            toLogo: toInfo?.logoURI || "/placeholder-logo.png",
          };
        });
        setSwapHistory(mapped);
      } catch (e) {
        console.warn("[MoleSwap] Failed to load swap history from DB:", e);
      }
    })();
  }, [pushWallet.isConnected, pushWallet.address]);
  useEffect(() => {
    const checkWalletConnection = async () => {
      if (typeof window === "undefined") return;

      // Guard: only accept 0x-prefixed 42-char EVM addresses.
      // Phantom (and some other multi-chain wallets) inject window.ethereum
      // but return their Solana pubkey from eth_accounts when that's the
      // active account. Writing that pubkey into walletAddress leaks it into
      // eth_getBalance calls and breaks the Push Chain RPC.
      const isEvmAddress = (s: unknown): s is string =>
        typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

      // Check MetaMask / injected provider
      const eth = window.ethereum;
      if (eth?.request) {
        try {
          const accounts: string[] = await eth.request({
            method: "eth_accounts",
          });
          const first = accounts?.[0];
          // Skip if Push owns the session — eth_accounts is a silent read that
          // would otherwise stomp the resolved UEA with MetaMask's address
          // during the Phantom → UEA resolution window.
          if (isEvmAddress(first) && !pushOwnsSessionRef.current) {
            setWalletAddress(first);
            setRecipientAddress(first); // Initialize recipient to wallet address
            setShowReceive(true);
          }
          // else: probably Phantom returning Solana pubkey — ignore, let
          // the push-wallet provider (usePushWallet) set walletAddress to
          // the correct UEA once resolved.
        } catch (e) {
          // Silently fail if wallet is not connected
        }
      }

      // Listen for account changes
      if (eth?.on) {
        const onAccountsChanged = (accounts: string[]) => {
          // Ignore MetaMask account events while Push owns the session —
          // otherwise switching MM accounts would silently overwrite the
          // Phantom user's UEA.
          if (pushOwnsSessionRef.current) return;

          const first = accounts?.[0];
          // CRITICAL: Clear swap history when wallet changes to prevent cross-wallet data leakage
          diagnostics.logSessionEvent("MetaMask accountsChanged", {
            newAccount: first?.slice(0, 10) || "none",
          });
          setSwapHistory([]);
          try { window.sessionStorage?.removeItem("moleswap_history"); } catch {}

          if (isEvmAddress(first)) {
            setWalletAddress(first);
            setRecipientAddress(first); // Update recipient when wallet changes
            setShowReceive(true);
          } else if (!first) {
            setWalletAddress(null);
            setRecipientAddress(null);
            setShowReceive(false);
            setFromTokenBalance(null);
          }
          // else: non-EVM address (e.g. Solana pubkey from Phantom) — ignore
        };
        eth.on("accountsChanged", onAccountsChanged);

        return () => {
          eth.removeListener?.("accountsChanged", onAccountsChanged);
        };
      }
    };

    checkWalletConnection();
  }, []);

  // ----- Listen for WalletConnect events -----
  useEffect(() => {
    const setupWalletConnect = async () => {
      try {
        const { getWalletConnectProvider } = await import(
          "@/lib/wallet/walletconnect/provider"
        );
        const provider = await getWalletConnectProvider();
        if (provider) {
          // Same hex guard as the window.ethereum path — reject non-EVM addresses.
          const isEvmAddr = (s: unknown): s is string =>
            typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

          // Listen for account changes from WalletConnect
          provider.on("accountsChanged", (accounts: string[]) => {
            // Ignore WC account events while Push owns the session.
            if (pushOwnsSessionRef.current) return;

            const first = accounts?.[0];
            // CRITICAL: Clear swap history when wallet changes to prevent cross-wallet data leakage
            diagnostics.logSessionEvent("WalletConnect accountsChanged", {
              newAccount: first?.slice(0, 10) || "none",
            });
            setSwapHistory([]);
            try { window.sessionStorage?.removeItem("moleswap_history"); } catch {}

            if (isEvmAddr(first)) {
              setWalletAddress(first);
              setRecipientAddress(first);
              setShowReceive(true);
            } else if (!first) {
              setWalletAddress(null);
              setRecipientAddress(null);
              setShowReceive(false);
            }
          });

          // Listen for disconnect events from WalletConnect
          provider.on("disconnect", () => {
            // A WC-session disconnect shouldn't clobber an active Push session.
            if (pushOwnsSessionRef.current) return;

            diagnostics.logSessionEvent("WalletConnect disconnected");
            setWalletAddress(null);
            setRecipientAddress(null);
            setShowReceive(false);
            setFromTokenBalance(null);
            // CRITICAL: Clear swap history on disconnect
            setSwapHistory([]);
            try { window.sessionStorage?.removeItem("moleswap_history"); } catch {}
          });

          // Listen for chain changes
          provider.on("chainChanged", () => {
            // Chain changed, but wallet is still connected
            // Optionally refresh chain-specific data here
          });

          // Check if already connected via WalletConnect — but only adopt the
          // WC address if Push isn't already the session owner.
          const wcFirst = provider.accounts?.[0];
          if (isEvmAddr(wcFirst) && !pushOwnsSessionRef.current) {
            setWalletAddress(wcFirst);
            setRecipientAddress(wcFirst);
            setShowReceive(true);
          }
        }
      } catch (error) {
        // Provider might not be initialized yet, that's okay
      }
    };

    setupWalletConnect();
  }, []);

  // ----- Listen for custom wallet disconnect event -----
  useEffect(() => {
    const handleWalletDisconnect = () => {
      diagnostics.logSessionEvent("Custom walletDisconnected event");
      setWalletAddress(null);
      setRecipientAddress(null);
      setShowReceive(false);
      setFromTokenBalance(null);
      // CRITICAL: Clear swap history on disconnect
      setSwapHistory([]);
      try { window.sessionStorage?.removeItem("moleswap_history"); } catch {}
    };

    window.addEventListener("walletDisconnected", handleWalletDisconnect);
    return () => {
      window.removeEventListener("walletDisconnected", handleWalletDisconnect);
    };
  }, []);

  // ----- Listen for custom wallet connection event from ConnectWalletButton -----
  useEffect(() => {
    const handleWalletConnected = (event: Event) => {
      const customEvent = event as CustomEvent<{ address: string }>;
      const addr = customEvent.detail?.address;
      // Same hex guard — reject non-EVM addresses that would break Push RPC calls
      if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) {
        diagnostics.logSessionEvent("Custom walletConnected event", {
          address: addr.slice(0, 10),
        });
        // CRITICAL: Clear swap history when new wallet connects (might be different user)
        setSwapHistory([]);
        try { window.sessionStorage?.removeItem("moleswap_history"); } catch {}

        setWalletAddress(addr);
        setRecipientAddress(addr);
        setShowReceive(true);
      }
    };

    window.addEventListener("walletConnected", handleWalletConnected);
    return () => {
      window.removeEventListener("walletConnected", handleWalletConnected);
    };
  }, []);

  // ----- Derived chain/token lists (kept) -----
  // Since all virtual chains share id=42101, find the chain GROUP containing
  // the selected token (not just the first chain matching the id).
  const allTokens = useMemo(
    () => chains.flatMap((c) => getTokensForChain(c)),
    [chains],
  );

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

  // Bridge-out preview: when toToken is bridgeable AND the user's wallet
  // origin matches the toToken's origin chain, we'll auto-deliver the real
  // asset to their external wallet after the swap. Surface this in the card
  // BEFORE the user clicks "Start Swapping" so there are no surprises.
  // The preview pulls labels from the same PRC20_BRIDGE_MAP used by the
  // actual send flow in SwapPage.tsx, so label text is always consistent.
  const [bridgeOutPreview, setBridgeOutPreview] = useState<{
    label: string;
    originSymbol: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!toToken || !pushWallet.originChain || !pushWallet.origin) {
          if (!cancelled) setBridgeOutPreview(null);
          return;
        }
        const { canAutoBridgeFrom, getBridgeInfoForPrc20 } = await import(
          "@/lib/pushchain/prc20-bridge-map"
        );
        if (!canAutoBridgeFrom(toToken, pushWallet.originChain)) {
          if (!cancelled) setBridgeOutPreview(null);
          return;
        }
        const info = getBridgeInfoForPrc20(toToken);
        if (info && !cancelled) {
          setBridgeOutPreview({
            label: info.uiLabel,
            originSymbol: info.originSymbol,
          });
        }
      } catch {
        if (!cancelled) setBridgeOutPreview(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toToken, pushWallet.originChain, pushWallet.origin]);

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

  // ----- Fetch quote (kept) -----
  const fetchQuote = useMemo(
    () => async () => {
      if (!canQuote) {
        setQuote(null);
        return;
      }
      setQuoteRefreshing(true);
      try {
        // Check if this is a wrap operation (native to wrapped native on same chain)
        // Relay API requires user and recipient to match for wrap operations
        const nativeAddress = "0x0000000000000000000000000000000000000000";
        const fromTokenLower = fromToken?.toLowerCase() || "";
        const isFromNative =
          !fromToken ||
          fromToken === "" ||
          fromTokenLower === nativeAddress ||
          fromTokenLower === "native" ||
          fromTokenLower === "eth" ||
          fromTokenLower === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

        const isSameChain = fromChainId === toChainId;
        // If same chain and from native token, likely a wrap operation
        // Also check if toToken is a wrapped version (has a contract address)
        const toTokenLower = toToken?.toLowerCase() || "";
        const isToWrapped =
          toToken &&
          toTokenLower !== nativeAddress &&
          toTokenLower !== "" &&
          toTokenLower !== "native" &&
          toTokenLower !== "eth";

        const isWrapOperation =
          isSameChain && isFromNative && isToWrapped && walletAddress;

        // For wrap operations (ETH to WETH), user and recipient MUST match
        // For other operations, use recipient address or fallback to wallet address
        const finalRecipient = isWrapOperation
          ? walletAddress
          : recipientAddress || walletAddress;

        // Ensure user and recipient match for wrap operations
        const finalUser = walletAddress || undefined;
        const finalRecipientForQuote = isWrapOperation
          ? finalUser // Force recipient to match user for wraps
          : finalRecipient;

        const q = await relayClient.actions.getQuote(
          {
            chainId: Number(fromChainId),
            toChainId: Number(toChainId),
            currency: fromToken,
            toCurrency: toToken,
            amount: amountWei,
            tradeType: "EXACT_INPUT",
            user: finalUser,
            recipient: finalRecipientForQuote || undefined,
          },
          true,
        );
        setQuote(q);
        setQuoteUpdatedAt(Date.now());
      } catch (e: any) {
        // Log error for debugging
        const errorMessage = e?.message || String(e);
        console.error("Error fetching quote:", errorMessage);

        // If it's a wrap operation error, provide helpful message
        if (
          errorMessage.includes("USER_RECIPIENT_MISMATCH") ||
          errorMessage.includes("user and recipient must match")
        ) {
          console.warn(
            "Wrap operation detected: user and recipient must match. " +
              "Using wallet address as recipient.",
          );
        }

        setQuote(null);
      } finally {
        setQuoteRefreshing(false);
      }
    },
    [
      canQuote,
      fromChainId,
      toChainId,
      fromToken,
      toToken,
      amountWei,
      walletAddress,
      recipientAddress,
    ],
  );

  useEffect(() => {
    // Initial fetch when inputs change
    fetchQuote();
    // Reset refresh timer
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    if (canQuote) {
      refreshTimerRef.current = setInterval(() => {
        fetchQuote();
      }, 25000); // refresh ~25s
    }
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, [fetchQuote, canQuote]);

  useEffect(() => {
    if (fromChainId !== toChainId || String(fromChainId) !== "42101" || !amountWei || amountWei === "0" || !walletAddress) {
      setPushEstimate(null);
      return;
    }
    let cancelled = false;
    estimateSwapDetails({
      tokenIn: fromToken || "0x0000000000000000000000000000000000000000",
      tokenOut: toToken || "0x0000000000000000000000000000000000000000",
      amountIn: amountWei,
      recipient: walletAddress,
    }).then(est => { if (!cancelled) setPushEstimate(est); })
      .catch(() => { if (!cancelled) setPushEstimate(null); });
    return () => { cancelled = true; };
  }, [fromChainId, toChainId, fromToken, toToken, amountWei, walletAddress]);

  // ----- TTL (kept) -----
  useEffect(() => {
    const id = setInterval(() => {
      if (!quoteUpdatedAt) return setTtlLeft(0);
      const elapsed = Math.floor((Date.now() - quoteUpdatedAt) / 1000);
      const left = Math.max(0, 30 - elapsed);
      setTtlLeft(left);
    }, 1000);
    return () => clearInterval(id);
  }, [quoteUpdatedAt]);

  // ----- Helpers from original (kept) -----
  const formatTokenAmount = (
    wei: string | undefined,
    decimals: number | undefined,
  ) => {
    if (!wei || !decimals) return "-";
    try {
      const s = wei.toString();
      const pad = decimals - Math.min(decimals, s.length);
      const full = pad > 0 ? "0".repeat(pad) + s : s;
      const i = full.slice(0, full.length - decimals) || "0";
      const f = full.slice(-decimals).replace(/0+$/, "");
      return f ? `${i}.${f}` : i;
    } catch {
      return "-";
    }
  };

  const expectedOutWei = useMemo(() => {
    if (!quote) return undefined;
    return (
      quote.toAmount ||
      quote.expectedOutput ||
      quote.output?.amount ||
      quote.amountOut ||
      quote.details?.toAmount ||
      quote.details?.to?.amount ||
      quote.details?.currencyOut?.amount ||
      quote.steps?.[0]?.toAmount ||
      quote.steps?.[0]?.to?.amount ||
      quote.steps?.[0]?.outputAmount
    );
  }, [quote]);

  const expectedOut = useMemo(
    () => formatTokenAmount(expectedOutWei, toTokenMeta?.decimals),
    [expectedOutWei, toTokenMeta?.decimals],
  );

  const routeLabel = useMemo(() => {
    if (quote?.route?.name) return quote.route.name;
    if (Array.isArray(quote?.sources) && quote.sources.length) {
      return quote.sources.map((s: any) => s?.name || s).join(" → ");
    }
    if (Array.isArray(quote?.steps) && quote.steps.length) {
      return quote.steps
        .map((s: any) => s?.name || s?.source || "")
        .filter(Boolean)
        .join(" → ");
    }
    return undefined;
  }, [quote]);

  const feesLabel = useMemo(() => {
    if (!quote) return undefined;
    let usd =
      quote?.feesUsd ??
      quote?.totalFeesUsd ??
      quote?.fees?.totalUsd ??
      quote?.fees?.usd ??
      quote?.breakdown?.totalUsd ??
      quote?.totalUsd;
    if (!usd && quote?.fees) {
      if (Array.isArray(quote.fees.breakdown)) {
        usd = quote.fees.breakdown.reduce(
          (acc: number, f: any) => acc + Number(f?.usd || f?.usdValue || 0),
          0,
        );
      } else if (typeof quote.fees === "object") {
        for (const k of Object.keys(quote.fees)) {
          const v = (quote.fees as any)[k];
          if (k.toLowerCase().includes("usd") && typeof v === "number") {
            usd = v;
            break;
          }
        }
      }
    }
    if (!usd && Array.isArray(quote?.steps)) {
      usd = quote.steps.reduce(
        (acc: number, s: any) =>
          acc + Number(s?.fees?.usd || s?.fees?.totalUsd || 0),
        0,
      );
    }
    if (!usd && typeof quote?.details?.fees === "object") {
      usd = quote.details.fees.usd || quote.details.fees.totalUsd;
    }
    return usd ? `$${Number(usd).toFixed(2)} fees` : undefined;
  }, [quote]);
  const isPushChainSwap = fromChainId === toChainId && String(fromChainId) === "42101";

  // Detect if swap involves a thin liquidity pool — only warn when the user's
  // selected token IS the thin-liquidity token (not WPC, which appears in every pool)
  const thinPoolWarning = useMemo(() => {
    if (!fromToken || !toToken) return null;
    const actualFrom = fromToken === "0x0000000000000000000000000000000000000000" ? CONTRACTS.WPC : fromToken;
    const actualTo = toToken === "0x0000000000000000000000000000000000000000" ? CONTRACTS.WPC : toToken;
    const wpc = CONTRACTS.WPC.toLowerCase();
    // For each thin pool, check if the non-WPC token matches from or to
    const thinPool = POOLS.find(p => {
      if (!p.thinLiquidity) return false;
      const thinToken = p.token0.toLowerCase() === wpc ? p.token1.toLowerCase() : p.token0.toLowerCase();
      return thinToken === actualFrom.toLowerCase() || thinToken === actualTo.toLowerCase();
    });
    return thinPool ? `${thinPool.name} has very low liquidity — expect high slippage or failed swaps.` : null;
  }, [fromToken, toToken]);

  const feesDisplayLabel = feesLabel || (isPushChainSwap && quote
    ? (pushEstimate ? `~${(pushEstimate.totalGas / 1000).toFixed(0)}k gas • 0.25% fee` : "~0.25% fee")
    : undefined);
  const etaSeconds = useMemo(() => {
    const direct =
      quote?.estimatedTimeSeconds ??
      quote?.etaSeconds ??
      quote?.durationSeconds ??
      quote?.details?.etaSeconds;
    if (direct) return direct;
    const detailsEta = (quote as any)?.details?.eta?.seconds;
    if (detailsEta) return detailsEta;
    if (Array.isArray(quote?.steps)) {
      let eta: number | undefined;
      for (const s of quote.steps) {
        const sEta = s?.etaSeconds ?? s?.durationSeconds ?? s?.eta?.seconds;
        if (sEta && (!eta || sEta > eta)) eta = sEta;
        if (Array.isArray(s?.items)) {
          for (const it of s.items) {
            const iEta =
              it?.etaSeconds ?? it?.durationSeconds ?? it?.eta?.seconds;
            if (iEta && (!eta || iEta > eta)) eta = iEta;
          }
        }
      }
      return eta;
    }
    if (fromChainId === toChainId && String(fromChainId) === "42101" && pushEstimate) {
      return pushEstimate.etaSeconds;
    }
    return undefined;
  }, [quote, fromChainId, toChainId, pushEstimate]);
  const rateLabel = useMemo(() => {
    try {
      if (
        !expectedOutWei ||
        !amountWei ||
        !fromTokenMeta?.decimals ||
        !toTokenMeta?.decimals
      )
        return undefined;
      const fromPow = Math.pow(10, fromTokenMeta.decimals);
      const toPow = Math.pow(10, toTokenMeta.decimals);
      const outNum = Number(expectedOutWei);
      const inNum = Number(amountWei);
      if (!isFinite(outNum) || !isFinite(inNum) || inNum === 0)
        return undefined;
      const rate = outNum / toPow / (inNum / fromPow);
      if (!isFinite(rate)) return undefined;
      return `1 ${displaySymbolOf(fromTokenMeta)} = ${(rate * 1).toFixed(6)} ${displaySymbolOf(toTokenMeta)}`;
    } catch {
      return undefined;
    }
  }, [
    expectedOutWei,
    amountWei,
    fromTokenMeta?.decimals,
    toTokenMeta?.decimals,
    fromTokenMeta?.symbol,
    toTokenMeta?.symbol,
  ]);

  // Calculate USD value of balance from quote price
  const balanceUsdValue = useMemo(() => {
    if (!fromTokenBalance || !quote || !amountWei) return null;

    try {
      // Try to get USD value from various quote fields
      const inputUsd =
        quote?.fromAmountUsd ??
        quote?.inputUsd ??
        quote?.amountInUsd ??
        quote?.details?.fromAmountUsd ??
        quote?.details?.inputUsd;

      if (inputUsd && amountWei) {
        // Calculate price per token
        const fromPow = Math.pow(10, fromTokenMeta?.decimals ?? 18);
        const amountNum = Number(amountWei) / fromPow;

        if (amountNum > 0) {
          const pricePerToken = Number(inputUsd) / amountNum;
          const balanceNum = Number(fromTokenBalance);
          return balanceNum * pricePerToken;
        }
      }

      // Fallback: try to calculate from output USD if available
      const outputUsd =
        quote?.toAmountUsd ??
        quote?.outputUsd ??
        quote?.amountOutUsd ??
        quote?.details?.toAmountUsd ??
        quote?.details?.outputUsd;

      if (outputUsd && amountWei && expectedOutWei) {
        const fromPow = Math.pow(10, fromTokenMeta?.decimals ?? 18);
        const toPow = Math.pow(10, toTokenMeta?.decimals ?? 18);
        const amountNum = Number(amountWei) / fromPow;
        const outputNum = Number(expectedOutWei) / toPow;

        if (amountNum > 0 && outputNum > 0) {
          // Calculate exchange rate and infer input USD from output USD
          const exchangeRate = outputNum / amountNum;
          const inputUsdFromOutput = Number(outputUsd) / exchangeRate;
          const pricePerToken = inputUsdFromOutput / amountNum;
          const balanceNum = Number(fromTokenBalance);
          return balanceNum * pricePerToken;
        }
      }

      return null;
    } catch {
      return null;
    }
  }, [
    fromTokenBalance,
    quote,
    amountWei,
    expectedOutWei,
    fromTokenMeta?.decimals,
    toTokenMeta?.decimals,
  ]);

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

  const fromLogo = useMemo(
    () =>
      fromTokenMeta?.logoURI ||
      fromChain?.iconUrl ||
      fromChain?.logoUrl ||
      "/placeholder-logo.png",
    [fromTokenMeta?.logoURI, fromChain?.iconUrl, fromChain?.logoUrl],
  );
  const toLogo = useMemo(
    () =>
      toTokenMeta?.logoURI ||
      toChain?.iconUrl ||
      toChain?.logoUrl ||
      "/placeholder-logo.png",
    [toTokenMeta?.logoURI, toChain?.iconUrl, toChain?.logoUrl],
  );

  const handleConnectWallet = async () => {
    try {
      // PushChain universal wallet connection (primary)
      pushWallet.connect();
    } catch (e) {
      // optional toast
    }
  };

  // Helper functions to set amount based on balance percentage
  const setAmountPercentage = (percentage: number) => {
    if (!fromTokenBalance) return;
    const balanceNum = Number(fromTokenBalance);
    if (isNaN(balanceNum) || balanceNum <= 0) return;

    const calculatedAmount = (balanceNum * percentage).toString();
    // Format to avoid too many decimal places
    const decimals = fromTokenMeta?.decimals ?? 18;
    const maxDecimals = Math.min(decimals, 6);
    const formatted = Number(calculatedAmount).toFixed(maxDecimals);
    setAmount(formatted.replace(/\.?0+$/, "")); // Remove trailing zeros
  };

  const handleSet20Percent = () => setAmountPercentage(0.2);
  const handleSet50Percent = () => setAmountPercentage(0.5);
  const handleSetMax = () => {
    if (!fromTokenBalance) return;
    const balanceNum = Number(fromTokenBalance);
    if (isNaN(balanceNum) || balanceNum <= 0) return;

    const decimals = fromTokenMeta?.decimals ?? 18;
    const maxDecimals = Math.min(decimals, 6);
    const formatted = balanceNum.toFixed(maxDecimals);
    setAmount(formatted.replace(/\.?0+$/, "")); // Remove trailing zeros
  };

  const handleReviewSwap = () => {
    if (!quote) {
      // eslint-disable-next-line no-console
      console.warn("No quote available to review");
      return;
    }
    onNext("swap", {
      quote,
      fromToken: fromToken || "ETH",
      toToken: toToken || "USDC",
      amount: amount || "0",
      expectedOut: expectedOut || "0",
      fromTokenMeta,
      toTokenMeta,
      fromChain,
      toChain,
      routeLabel: routeLabel || "Auto",
      feesLabel: feesDisplayLabel || "-",
      etaSeconds: typeof etaSeconds === "number" ? etaSeconds : undefined,
      rateLabel: rateLabel || "-",
      walletAddress,
      recipientAddress: recipientAddress || walletAddress,
    });
  };

  // ----- Show Receive automatically when ready (kept) -----
  // Note: showReceive is now primarily controlled by wallet connection
  // This effect ensures receive panel shows when all conditions are met
  useEffect(() => {
    if (walletAddress && fromToken && toToken && Number(amount) > 0) {
      setShowReceive(true);
    } else if (!walletAddress) {
      setShowReceive(false);
    }
  }, [walletAddress, fromToken, toToken, amount]);

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
        // Prefer the ORIGIN-chain balance for bridgeable PRC-20s when the
        // user's connected origin chain matches the token's bridge origin —
        // that's the amount they actually hold in Phantom/MetaMask and the
        // amount that gets auto-bridged on swap. Falling back to the
        // Push-chain PRC-20 balance would show a post-bridge leftover
        // (usually 0 for first-time users) and — critically — make the
        // MAX/50%/20% buttons compute against the wrong number.
        const originPubkey = (pushWallet as any)?.origin || null;
        const userOriginChain = (pushWallet as any)?.originChain || null;
        let balance: string | null = null;
        if ((fromTokenMeta as any)?.bridgeable && originPubkey && userOriginChain) {
          balance = await fetchOriginBalance(fromToken, originPubkey, userOriginChain);
        }
        if (balance === null) {
          const chain = chains.find((c) => String(c.id) === fromChainId);
          const vmType = chain?.vmType;
          balance = await getTokenBalance(
            walletAddress as Address,
            fromToken,
            Number(fromChainId),
            fromTokenMeta?.decimals,
            vmType,
          );
        }

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
  }, [walletAddress, fromChainId, fromToken, fromTokenMeta?.decimals, (fromTokenMeta as any)?.bridgeable, chains, pushWallet.origin, pushWallet.originChain]);

  // ═══ ORIGIN-CHAIN BALANCE + PHANTOM DEVNET CHECK ═══════════════════════
  // When user is on a non-Push origin chain AND selects a bridgeable token
  // whose origin matches, fetch their actual origin-chain balance so the UI
  // can show "You have 0.93 SOL on Solana to bridge" — much clearer than
  // "Balance: 0 pSOL" (which is true but useless for a user about to bridge).
  //
  // Also detects Phantom cluster mismatch: if origin is Solana Devnet but
  // Phantom is on Mainnet, warn before the user burns a signing attempt.
  useEffect(() => {
    let cancelled = false;

    const fetchOriginContext = async () => {
      if (!pushWallet.isConnected || !pushWallet.origin || !pushWallet.originChain || !fromToken) {
        if (!cancelled) {
          setOriginBalance(null);
          setPhantomClusterWarning(null);
        }
        return;
      }

      try {
        // Dynamic import to avoid bundling the bridge map in pages that don't need it
        const { getBridgeInfoForPrc20 } = await import("@/lib/pushchain/prc20-bridge-map");
        const bridge = getBridgeInfoForPrc20(fromToken);
        if (!bridge) {
          if (!cancelled) {
            setOriginBalance(null);
            setPhantomClusterWarning(null);
          }
          return;
        }

        const originMatches =
          bridge.originChain.toLowerCase() === pushWallet.originChain!.toLowerCase();
        if (!originMatches) {
          if (!cancelled) {
            setOriginBalance(null);
            setPhantomClusterWarning(null);
          }
          return;
        }

        // ─ Solana origin path ─
        if (bridge.originChain.startsWith("solana:")) {
          // Check Phantom cluster. Phantom injects window.solana; `isConnected`
          // is true and `publicKey` matches pushWallet.origin. We check cluster
          // by querying the RPC Phantom is currently using.
          try {
            const solWin = (window as any)?.solana;
            if (solWin?.isPhantom) {
              // Phantom's injected provider doesn't expose cluster directly,
              // but we can probe: try to fetch a devnet-only program account.
              // Simpler: just hit devnet RPC ourselves for the balance. If the
              // user's pubkey resolves with a nonzero balance on devnet, they
              // likely have it there. If it's zero but they claim to have SOL,
              // they're probably on mainnet.
              const res = await fetch("https://api.devnet.solana.com", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "getBalance",
                  params: [pushWallet.origin],
                }),
              });
              const json = await res.json();
              const lamports: number | undefined = json?.result?.value;
              if (typeof lamports === "number") {
                const sol = lamports / 1e9;
                if (!cancelled) {
                  setOriginBalance(sol.toFixed(6));
                  // If devnet balance is 0, the user might be on mainnet.
                  // Not a hard error — they may just not have bridged yet —
                  // but surface a gentle warning.
                  setPhantomClusterWarning(
                    sol === 0
                      ? "⚠️ 0 SOL detected on Solana Devnet. If Phantom shows a balance, make sure Testnet Mode is ON in Phantom Settings → Developer Settings."
                      : null
                  );
                }
                return;
              }
            }
          } catch (err) {
            // Swallow — origin balance display is best-effort
            console.warn("[MoleSwap] Origin balance fetch failed:", err);
          }

          if (!cancelled) {
            setOriginBalance(null);
            setPhantomClusterWarning(null);
          }
          return;
        }

        // ─ Solana origin, ERC-20/SPL token path (e.g. USDT on Solana Devnet) ─
        // Read the SPL token balance at the associated token account.
        if (bridge.originChain.startsWith("solana:") && bridge.originSymbol !== "SOL") {
          try {
            const resp = await fetch("https://api.devnet.solana.com", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "getTokenAccountsByOwner",
                params: [
                  pushWallet.origin,
                  { mint: bridge.originAddress },
                  { encoding: "jsonParsed" },
                ],
              }),
            });
            const json = await resp.json();
            const accounts = json?.result?.value || [];
            let total = 0;
            for (const acc of accounts) {
              const amt = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
              if (typeof amt === "number") total += amt;
            }
            if (!cancelled) {
              setOriginBalance(total.toFixed(6));
              setPhantomClusterWarning(null);
            }
          } catch (err) {
            console.warn("[MoleSwap] SPL token balance fetch failed:", err);
            if (!cancelled) {
              setOriginBalance(null);
              setPhantomClusterWarning(null);
            }
          }
          return;
        }

        // ─ EVM origin path ─ (Sepolia / Arbitrum / Base / BNB Testnet)
        // Map the SDK's CAIP-style chain identifier to a public testnet RPC
        // so we can query the user's native or ERC-20 balance directly. This
        // gives real-time "+X available to bridge" info in the UI — same
        // pattern as the Solana path above.
        if (bridge.originChain.startsWith("eip155:")) {
          const EVM_RPC: Record<string, string> = {
            "eip155:11155111": "https://ethereum-sepolia-rpc.publicnode.com",
            "eip155:421614":   "https://arbitrum-sepolia-rpc.publicnode.com",
            "eip155:84532":    "https://base-sepolia-rpc.publicnode.com",
            "eip155:97":       "https://bsc-testnet-rpc.publicnode.com",
          };
          const rpcUrl = EVM_RPC[bridge.originChain.toLowerCase()];
          if (!rpcUrl) {
            if (!cancelled) {
              setOriginBalance(null);
              setPhantomClusterWarning(null);
            }
            return;
          }

          try {
            const userAddr = pushWallet.origin;
            let balance: bigint = 0n;
            if (bridge.originSymbol === "ETH") {
              // Native balance
              const resp = await fetch(rpcUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "eth_getBalance",
                  params: [userAddr, "latest"],
                }),
              });
              const json = await resp.json();
              if (json?.result) balance = BigInt(json.result);
            } else {
              // ERC-20 balanceOf(address)
              // 0x70a08231 = balanceOf(address) selector
              const data =
                "0x70a08231" +
                userAddr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
              const resp = await fetch(rpcUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "eth_call",
                  params: [{ to: bridge.originAddress, data }, "latest"],
                }),
              });
              const json = await resp.json();
              if (json?.result && json.result !== "0x") balance = BigInt(json.result);
            }

            // Format respecting the origin-chain decimals (native ETH is 18,
            // USDT on each chain is 6 per the bridge map).
            const decimals = bridge.originDecimals;
            const divisor = 10n ** BigInt(decimals);
            const whole = balance / divisor;
            const frac = balance % divisor;
            // Build a float-safe decimal string without Number overflow
            const fracStr = frac.toString().padStart(decimals, "0").slice(0, 6);
            const formatted = `${whole.toString()}.${fracStr}`;

            if (!cancelled) {
              setOriginBalance(formatted);
              setPhantomClusterWarning(null);
            }
            return;
          } catch (err) {
            console.warn("[MoleSwap] EVM origin balance fetch failed:", err);
            if (!cancelled) {
              setOriginBalance(null);
              setPhantomClusterWarning(null);
            }
            return;
          }
        }

        if (!cancelled) {
          setOriginBalance(null);
          setPhantomClusterWarning(null);
        }
      } catch (err) {
        console.warn("[MoleSwap] fetchOriginContext error:", err);
      }
    };

    fetchOriginContext();
    return () => {
      cancelled = true;
    };
  }, [pushWallet.isConnected, pushWallet.origin, pushWallet.originChain, fromToken]);


  // ----- Modal select logic -----
  // open modal: seed selectedNetwork with the chain group containing the current token
  const openSelect = (mode: SelectionMode) => {
    setSelectionMode(mode);
    setSearchQuery("");
    setSearchQueryNetwork("");
    // Destination is ALWAYS Push Chain — proceeds of every swap land as a
    // PRC-20 on Push (no outbound bridge today). Hard-code Push Chain for
    // the TO picker so users can't select Ethereum/Solana/Base/Arbitrum/BNB
    // destinations that would mislead them about where the asset ends up.
    if (mode === "to") {
      setSelectedNetwork("Push Chain");
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

  // List of networks filtered by search.
  //
  // FROM: show every chain (user may hold real assets on Ethereum / Solana /
  //       Base / Arbitrum / BNB to bridge IN, plus Push Chain natives).
  // TO:   only Push Chain. Destination of every swap is a PRC-20 sitting on
  //       Push Chain — no outbound bridge is wired today, so listing
  //       Ethereum/Solana/etc. as destinations would lie about where the
  //       asset ends up.
  const filteredNetworks = useMemo(() => {
    const src = selectionMode === "to"
      ? chains.filter((c) => c.name === "Push Chain")
      : chains;
    return src.filter((net) =>
      (net.displayName || net.name || "")
        .toLowerCase()
        .includes(searchQueryNetwork.toLowerCase()),
    );
  }, [chains, searchQueryNetwork, selectionMode]);

  // Tokens for the currently selected network in the modal.
  // For TO mode we merge every swappable token (across every source chain)
  // into the Push Chain group, because that's where they all live as PRC-20s.
  const modalChain =
    chains.find((c) => c.name === selectedNetwork) || null;
  const modalTokens = useMemo(() => {
    if (selectionMode === "to") {
      const seen = new Set<string>();
      const merged: ReturnType<typeof getTokensForChain> = [];
      for (const c of chains) {
        for (const t of getTokensForChain(c)) {
          const key = (t.address || "").toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          merged.push(t);
        }
      }
      return merged;
    }
    return modalChain ? getTokensForChain(modalChain) : [];
  }, [modalChain, chains, selectionMode]);

  const filteredModalTokens = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return modalTokens.filter(
      (t) =>
        (t.symbol || "").toLowerCase().includes(q) ||
        (t.name || "").toLowerCase().includes(q),
    );
  }, [modalTokens, searchQuery]);

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
      const chainId = modalChain?.id || 42101;
      const vmType = modalChain.vmType;

      // Filter tokens that need balance fetching (not already cached, loading, or previously fetched)
      const tokensToFetch = filteredModalTokens.filter((token) => {
        const balanceKey = `${selectedNetwork}-${token.address}`;
        // Skip if already fetched, cached, or currently loading
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
      //
      // For bridgeable PRC-20s where the user is connected via the matching
      // origin chain (Phantom user picking "SOL on Solana", Sepolia MetaMask
      // picking "ETH on Ethereum", etc.), show the ORIGIN-CHAIN balance — the
      // amount they actually hold in their wallet and can bridge in. Falling
      // back to the Push-chain PRC-20 balance would surface the post-bridge
      // amount (often 0 for first-time users) and confuse them.
      const originPubkey = (pushWallet as any)?.origin || null;
      const userOriginChain = (pushWallet as any)?.originChain || null;
      const balancePromises = tokensToFetch.map(async (token) => {
        if (cancelled) return null;

        const balanceKey = `${selectedNetwork}-${token.address}`;

        try {
          // Try origin-chain balance first when the token is bridgeable and
          // the user is connected via its origin chain. Returns null when
          // inapplicable (different origin chain, non-bridgeable token, etc.).
          let balance: string | null = null;
          if ((token as any).bridgeable && originPubkey && userOriginChain) {
            balance = await fetchOriginBalance(token.address, originPubkey, userOriginChain);
          }
          // Fall back to Push-chain PRC-20 balance — either the token isn't
          // bridgeable from this origin, or the origin probe failed.
          if (balance === null) {
            balance = await getTokenBalance(
              walletAddress as Address,
              token.address,
              chainId,
              token.decimals,
              vmType,
            );
          }

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

  const handleSelectToken = (tokenAddress: string) => {
    if (!selectedNetwork) return;
    // All tokens live on PushChain — always set chainId to 42101
    if (selectionMode === "from") {
      setFromChainId("42101");
      setFromToken(tokenAddress);
    } else if (selectionMode === "to") {
      setToChainId("42101");
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
              <div className="hide-scrollbar relative flex max-h-[450px] flex-col gap-3 overflow-y-auto">
                {selectedNetwork ? (
                  filteredModalTokens.length > 0 ? (
                    filteredModalTokens.map((token, idx) => {
                      // FROM picker shows the ORIGIN-asset framing ("SOL on
                      // Solana", "ETH on Ethereum") because the user holds
                      // those assets on the origin chain and they get
                      // bridged in. TO picker shows the PRC-20 framing
                      // ("pETH on Push Chain", "USDT.eth on Push Chain")
                      // because that's where the output actually lands.
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
                        onClick={() => handleSelectToken(token.address)}
                        className={`relative cursor-pointer px-6 py-4 text-left`}
                      >
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex items-center justify-start gap-4">
                            <div className="border-ground-button-border h-14 w-14 overflow-hidden">
                              <Image
                                src={token.logoURI || "/placeholder-logo.png"}
                                alt={token.symbol || "token"}
                                width={56}
                                height={56}
                                className="h-full w-full object-cover"
                              />
                            </div>
                            <div className="text-left">
                              <h2 className="font-family-ThaleahFat text-xl tracking-wider text-white uppercase sm:text-3xl sm:tracking-widest">
                                {symbolLabel}
                              </h2>
                              <p className="font-family-ThaleahFat -mt-1 text-sm tracking-wider text-[#B0B0B0] uppercase sm:-mt-2 sm:text-lg sm:tracking-widest">
                                {subtitleLabel}
                              </p>
                            </div>
                          </div>
                          {walletAddress && selectedNetwork && (
                            <div className="text-right">
                              {loadingBalances[
                                `${selectedNetwork}-${token.address}`
                              ] ? (
                                <span className="font-family-ThaleahFat text-base text-gray-400">
                                  Loading...
                                </span>
                              ) : (
                                <span className="font-family-ThaleahFat text-lg text-yellow-100">
                                  {tokenBalances[
                                    `${selectedNetwork}-${token.address}`
                                  ] !== null &&
                                  tokenBalances[
                                    `${selectedNetwork}-${token.address}`
                                  ] !== undefined
                                    ? Number(
                                        tokenBalances[
                                          `${selectedNetwork}-${token.address}`
                                        ] || 0,
                                      ).toLocaleString(undefined, {
                                        maximumFractionDigits: 6,
                                        minimumFractionDigits: 0,
                                      })
                                    : "-"}
                                </span>
                              )}
                            </div>
                          )}
                        </div>

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
                      No token found
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
                                    href={`https://donut.push.network/tx/${txHash}`}
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
                        {toToken ? "Push Chain" : "Select Network"}{" "}
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
                {/* Destination-clarity banner — tells the user EXACTLY what
                    asset lands where. Today the outbound bridge (Route 2 UOA
                    → CEA) isn't wired, so the proceeds of any swap stay as a
                    PRC-20 on Push Chain. Don't promise native ETH/SOL on
                    origin until the outbound is implemented (see
                    lib/pushchain/amm.ts). Always render the truth instead of
                    the aspirational bridge-out preview.
                    TODO(outbound): once buildOutboundRequest + execute is
                    wired, swap this banner to the true origin-delivery label
                    and key it on an `outboundWired` flag. */}
                {toTokenMeta && (
                  <div className="relative z-10 mx-auto -mt-2 w-full px-6 sm:w-[90%]">
                    <p className="font-family-ThaleahFat text-xs tracking-wider uppercase text-[#7DD3FC] sm:text-sm">
                      ✓ Arrives as {(toTokenMeta as any)?.symbol || displaySymbolOf(toTokenMeta)} on Push Chain
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
                            {/* Phantom cluster warning */}
                            {phantomClusterWarning && (
                              <p className="font-family-ThaleahFat mt-1 text-xs tracking-wide text-yellow-400">
                                {phantomClusterWarning}
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
                        !quote || !canQuote || !amount || Number(amount) <= 0
                      }
                      className="relative w-full cursor-pointer rounded py-4 text-base font-bold text-white transition-all sm:text-xl hover:scale-105 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span> REVIEW SWAP </span>
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
                    <div className="rounded bg-black/40 p-4 text-sm text-[#BCBCBC]">
                      No quote yet. Select chains, tokens and amount.
                    </div>
                  ) : (
                    <div className="relative z-50 p-4">
                      <div className="flex w-full flex-col justify-between gap-4 py-1 sm:px-4">
                        <div className="flex items-center justify-between">
                          <div className="border-ground-button-border h-8 w-8 overflow-hidden rounded-lg border-2 bg-black/50 sm:h-12 sm:w-12">
                            <Image
                              src={toLogo}
                              alt="Receive Logo"
                              width={48}
                              height={48}
                              className="h-full w-full object-cover"
                            />
                          </div>
                          <div className="mr-auto ml-4 min-w-0 flex-1 overflow-hidden text-left">
                            <div className="font-family-ThaleahFat text-lg text-yellow-100 truncate sm:text-3xl">
                              {expectedOut || "-"}
                            </div>
                            <div className="text-sm font-semibold text-[#BCBCBC]">
                              <span>
                                {displaySymbolOf(toTokenMeta)} on{" "}
                                {toChain?.displayName || toChain?.name}
                              </span>
                              {feesDisplayLabel ? (
                                <>
                                  {" "}
                                  • <span>{feesDisplayLabel}</span>
                                </>
                              ) : null}
                            </div>
                          </div>
                          <button className="border-ground-button-border bg-ground-button justify-center rounded border-2 p-1 text-yellow-100">
                            <ArrowDown className="z-10 h-4 w-4" />
                          </button>
                        </div>
                        <div className="bg-peach-500 h-[1px] w-full" />
                        <div className="space-y-1 text-left">
                          <div className="text-sm text-yellow-200">
                            <Fuel className="inline-block h-4 w-4" /> ETA:{" "}
                            {etaSeconds ? `${etaSeconds}s` : "-"} • Expires in:{" "}
                            {ttlLeft}s
                          </div>
                          <div className="text-xs font-semibold text-[#BCBCBC]">
                            {rateLabel ||
                              `From ${displaySymbolOf(fromTokenMeta)} to ${displaySymbolOf(toTokenMeta)}`}
                          </div>
                          {routeLabel && (
                            <div className="text-xs text-[#9a9a9a]">
                              Route: {routeLabel}
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
