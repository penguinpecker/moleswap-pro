"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Fuel, RefreshCw } from "lucide-react";
import { formatUnits, parseUnits } from "viem";
import { DappStep } from ".";
import { getWalletClient } from "@/lib/wallet/walletClient";
import type { TokenEntry, ChainEntry } from "@/lib/chain/tokenList";
import { useWallet } from "@/lib/chain/provider";
import { prepareSwap, preflightSwap, type PreparedSwap } from "@/lib/chain/amm";
import type { PreflightVerdict } from "@/lib/aggregator/simulate";
import { decodeSwapFailure, type DecodeContext } from "@/lib/aggregator/errors";
import { diagnostics } from "@/lib/diagnostics";
import { ExchangeHero } from "./ExchangePage";

// Extract tx hash from a wallet/client response (may be an object)
const extractHash = (result: any): string => {
  if (!result) return "";
  if (typeof result === "string") return result;
  const keys = ["hash", "txHash", "transactionHash"];
  for (const k of keys) { if (result[k] && typeof result[k] === "string") return result[k]; }
  if (result.tx?.hash) return result.tx.hash;
  if (result.receipt?.transactionHash) return result.receipt.transactionHash;
  return "";
};

/** Prefer TokenEntry.displaySymbol; fallback chain mirrors ExchangePage.displaySymbolOf. */
const displaySymbolOf = (t: any, fallback?: string): string => {
  if (!t) return fallback || "";
  return t.displaySymbol || t.symbol || fallback || "";
};

/** Deterministic Burrow palette pick for tokens with no resolvable logo. */
const COIN_COLORS = ["#b5601f", "#2f7d4f", "#2384c8", "#cd5f2a", "#7a4d29", "#8a5c33"];
const coinColor = (sym: string) =>
  COIN_COLORS[sym.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % COIN_COLORS.length];

/** Real remote logo when the registry resolves one; drawn coin chip otherwise. */
const TokenCircle = ({ logo, symbol, size = 38 }: { logo?: string; symbol?: string; size?: number }) => {
  const sym = (symbol || "?").toUpperCase();
  return logo ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logo}
      alt={sym}
      width={size}
      height={size}
      style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flex: "none" }}
    />
  ) : (
    <span
      className="coin"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.33), background: coinColor(sym) }}
    >
      {sym.slice(0, 2)}
    </span>
  );
};

interface SwapPageProps {
  onNext: (step: DappStep, data?: any) => void;
  onBack: () => void;
  swapData: {
    quote: any;
    fromToken: string;
    toToken: string;
    amount: string;
    expectedOut: string;
    fromTokenMeta?: TokenEntry;
    toTokenMeta?: TokenEntry;
    fromChain?: ChainEntry;
    toChain?: ChainEntry;
    routeLabel?: string;
    feesLabel?: string;
    etaSeconds?: number;
    rateLabel?: string;
    walletAddress?: string | null;
    /** Custom destination the user entered in ExchangePage's Recipient field.
     *  Falls back to the UEA when unset. Must be a 42-char 0x EVM address. */
    recipientAddress?: string | null;
  };
  onSwapStart?: () => void; // Called when swap execution starts (after wallet approval)
  onSwapComplete?: () => void; // Called when swap completes
}

export const SwapPage = ({
  onNext,
  onBack,
  swapData,
  onSwapStart,
  onSwapComplete,
}: SwapPageProps) => {
  const walletState = useWallet();
  const [isExecuting, setIsExecuting] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [txHashes, setTxHashes] = useState<string[]>([]);
  const [currentStep, setCurrentStep] = useState<string | null>(null);

  // Step list is derived from the quote (which knows the exact route: wrap/no-wrap,
  // approve-or-skip, single-hop vs multi-hop) rather than hardcoded. This ensures
  // we only render steps that actually apply to this swap.
  const initialSwapSteps = useMemo(() => {
    // Native ETH in needs no approval; ERC-20 in may need one (executeSwap
    // checks the live allowance and skips the step when it is already set).
    const isNativeIn =
      !swapData.fromToken ||
      swapData.fromToken === "0x0000000000000000000000000000000000000000" ||
      swapData.fromToken.toLowerCase() === "eth" ||
      swapData.fromToken.toLowerCase() === "native";
    return isNativeIn
      ? [{ label: "Swap tokens", status: "pending" as const }]
      : [
          { label: "Approve token", status: "pending" as const },
          { label: "Swap tokens", status: "pending" as const },
        ];
  }, [swapData.fromToken]);

  const [swapSteps, setSwapSteps] = useState<Array<{ label: string; status: "pending" | "signing" | "confirmed" | "error" }>>(initialSwapSteps);

  // Keep the review quote LIVE — and pre-flight it. The card carries a snapshot from the exchange screen;
  // here, every REQUOTE_MS, the EXACT transaction is rebuilt (prepareSwap: quote → plan → calldata), then
  // simulated AS the connected account on current chain state (preflightSwap: balance diff, decoded reason),
  // and the same PreparedSwap object is what "Start swapping" hands to executeSwap — so what is simulated
  // and shown is byte-for-byte what is signed. The sign button stays blocked until a pre-flight is green.
  const REQUOTE_MS = 8000;
  const [liveOut, setLiveOut] = useState<string | null>(null);
  const [secsToRefresh, setSecsToRefresh] = useState(REQUOTE_MS / 1000);
  const requoteBusy = useRef(false);
  const [prepared, setPrepared] = useState<PreparedSwap | null>(null);
  const [preflight, setPreflight] = useState<PreflightVerdict | null>(null);
  // The calldata the current verdict was taken on. A verdict only opens the button for THAT swap: when the
  // cycle rebuilds the plan, the old verdict stays visible but stops gating until the new one returns.
  const [preflightFor, setPreflightFor] = useState<string | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  // A quoter/transport failure while preparing — rendered distinctly from a genuine "no route".
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [noRoute, setNoRoute] = useState(false);
  const [cycleEpoch, setCycleEpoch] = useState(0);
  // A "simulation mismatch — do not sign" verdict HALTS the automatic cycle: no re-prepare, no re-simulate,
  // until the user acts (dossier T-37 / S-68 — a mismatch is never retried automatically, because a looping
  // retry only has to catch the honest provider unreachable once to open the button). The latch clears only
  // on the explicit Re-check button below or on leaving this screen. `mismatchHalt` is what the cycle reads;
  // `halted` is the same fact for the render.
  const mismatchHalt = useRef(false);
  const [halted, setHalted] = useState(false);
  const applyVerdict = (v: PreflightVerdict, forCalldata: string | null) => {
    setPreflight(v);
    setPreflightFor(forCalldata);
    if (v.status === "blocked" && v.kind === "mismatch") {
      mismatchHalt.current = true;
      setHalted(true);
    }
  };
  const recheckAfterMismatch = () => {
    mismatchHalt.current = false;
    setHalted(false);
    setCycleEpoch((e) => e + 1);
  };

  const account = walletState.address ?? null;
  const isHexAddr = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
  // Custom recipient support: ExchangePage pipes the user's typed destination through
  // swapData.recipientAddress. `recipient` stays the caller (approvals, balance anchor); `outputRecipient`
  // is where the swap output lands when set. MoleRouter enforces the same minimum-out either way.
  const customRecipient =
    isHexAddr(swapData.recipientAddress) && (!account || swapData.recipientAddress.toLowerCase() !== account.toLowerCase())
      ? swapData.recipientAddress
      : null;
  const decIn = swapData.fromTokenMeta?.decimals ?? 18;
  const decOut = swapData.toTokenMeta?.decimals ?? 18;
  const symIn = displaySymbolOf(swapData.fromTokenMeta, swapData.fromToken);
  const symOut = displaySymbolOf(swapData.toTokenMeta, swapData.toToken);
  const decodeCtx: DecodeContext = useMemo(
    () => ({ tokenIn: { symbol: symIn, decimals: decIn }, tokenOut: { symbol: symOut, decimals: decOut } }),
    [symIn, decIn, symOut, decOut],
  );
  const fmtAmount = (v: bigint, decimals: number) =>
    Number(formatUnits(v, decimals)).toLocaleString(undefined, { maximumFractionDigits: decimals > 6 ? 6 : 4 });

  useEffect(() => {
    if (isExecuting || isCompleted) return; // freeze the quote once the swap is in flight
    if (mismatchHalt.current) return; // halted after a simulation mismatch: nothing runs until the user re-checks
    let amountInWei: bigint;
    try {
      amountInWei = parseUnits(String(swapData.amount || "0"), decIn);
    } catch {
      return;
    }
    if (amountInWei <= BigInt(0) || !swapData.toToken) return;

    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let tick: ReturnType<typeof setInterval> | null = null;
    const stopTimers = () => {
      if (poll) clearInterval(poll);
      if (tick) clearInterval(tick);
      poll = null;
      tick = null;
    };
    const cycle = async () => {
      if (requoteBusy.current) return;
      requoteBusy.current = true;
      try {
        const p = await prepareSwap({
          tokenIn: swapData.fromToken || "",
          tokenOut: swapData.toToken,
          amountIn: amountInWei.toString(),
          recipient: account ?? "0x000000000000000000000000000000000000dEaD",
          outputRecipient: customRecipient,
        });
        if (cancelled) return;
        if (!p) {
          // The honest no-route: pools were read and nothing clears. Distinct from a failure below.
          setNoRoute(true);
          setPrepared(null);
          setPreflight(null);
          return;
        }
        setNoRoute(false);
        setPrepareError(null);
        setPrepared(p);
        setLiveOut(fmtAmount(p.amountOut, decOut));
        setSecsToRefresh(REQUOTE_MS / 1000);
        if (!account) return; // the probe runs AS the signer; nothing to simulate until one is connected
        setPreflightBusy(true);
        const v = await preflightSwap(p, account, decodeCtx);
        if (!cancelled) {
          applyVerdict(v, p.calldata);
          // A mismatch halts the cycle right here: the interval stops, the countdown stops, and only the
          // Re-check button (or leaving the screen) starts it again.
          if (mismatchHalt.current) stopTimers();
        }
      } catch (err) {
        if (cancelled) return;
        // A thrown error is the quoter or the transport failing — NOT "no liquidity". Say which.
        setPrepareError(decodeSwapFailure(err).message);
        setPrepared(null);
        setPreflight(null);
      } finally {
        requoteBusy.current = false;
        if (!cancelled) setPreflightBusy(false);
      }
    };

    cycle();
    poll = setInterval(cycle, REQUOTE_MS);
    tick = setInterval(() => setSecsToRefresh((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => {
      cancelled = true;
      stopTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swapData.fromToken, swapData.toToken, swapData.amount, isExecuting, isCompleted, account, customRecipient, cycleEpoch]);

  const displayOut = liveOut ?? swapData.expectedOut ?? "0";
  // The sign button opens only on a green pre-flight of the swap that will actually be signed — the verdict
  // must belong to the CURRENT prepared calldata, not to the plan of a previous cycle.
  const preflightCurrent = !!prepared && preflightFor === prepared.calldata;
  const preflightOk = preflightCurrent && preflight?.status === "ok";

  // Compute input amount in wei for exact-amount approval when needed
  const amountWei = useMemo(() => {
    const decimals = swapData.fromTokenMeta?.decimals ?? 18;
    const amount = swapData.amount;
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
  }, [swapData.amount, swapData.fromTokenMeta?.decimals]);

  // Helper: wait for a tx receipt to be mined
  const waitForReceipt = async (txHash: string, timeoutMs = 90000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const receipt = await (window as any)?.ethereum?.request?.({
          method: "eth_getTransactionReceipt",
          params: [txHash],
        });
        if (receipt && receipt.blockNumber) return receipt;
      } catch {}
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error("Approval transaction not confirmed in time");
  };

  const handleStartSwapping = async () => {
    // Guard 1: Check quote
    if (!swapData.quote) {
      setExecutionError("No quote available");
      return;
    }

    // Guard 2: Check wallet connection
    if (!walletState.isConnected) {
      setExecutionError("Wallet not connected. Please connect your wallet first.");
      diagnostics.logSessionEvent("Swap blocked - wallet not connected");
      return;
    }

    // Guard 3: Check SDK client
    if (!walletState.chainClient) {
      setExecutionError("Wallet is still initializing. Please wait a moment and try again.");
      diagnostics.logSessionEvent("Swap blocked - chainClient not ready");
      return;
    }

    // Guard 4: the pre-flight of the exact transaction must be green. The button is disabled until it
    // is, so this is belt-and-braces against a stale click.
    if (!preflightOk) {
      setExecutionError("Pre-flight has not passed for this swap yet. Wait for it, or go back and refresh the quote.");
      diagnostics.logSessionEvent("Swap blocked - pre-flight not green");
      return;
    }

    setIsExecuting(true);
    setIsCompleted(false);
    setExecutionError(null);
    setTxHashes([]);
    setCurrentStep(null);

    const swapStartTime = Date.now();

    // ═══ DIAGNOSTICS: Log swap attempt with wallet state ═══
    diagnostics.logSwapAttempt({
      isConnected: walletState.isConnected,
      hasAddress: !!walletState.address,
      hasChainClient: !!walletState.chainClient,
    });

    try {
      // Get expected chain ID from the quote
      const expectedChainId = swapData.fromChain?.id
        ? Number(swapData.fromChain.id)
        : undefined;

      if (!expectedChainId) {
        throw new Error("Unable to determine expected chain ID from quote.");
      }

      // Skip the raw window.ethereum client when the wagmi provider owns the
      // session — reading window.ethereum directly can pick a different
      // injected wallet than the one the user connected.
      const wallet = walletState.isConnected ? null : await getWalletClient();
      if (!wallet && !walletState.address) {
        throw new Error("No wallet available. Please connect your wallet.");
      }

      // Ensure the wallet client is fully initialized before swapping.
      // The client may be null during the brief window between wallet connect
      // and SDK initialization. User sees "Cannot read property 'universal'"
      // if we proceed without this guard.
      if (walletState.isConnected && !walletState.chainClient) {
        throw new Error(
          "Wallet is still initializing. Please wait a moment and try again."
        );
      }

      // Get the current account — prefer the connected provider's address
      const currentAddress = walletState.address || (wallet ? (await wallet.getAddresses())?.[0] : null);

      if (!currentAddress) {
        throw new Error(
          "No wallet account available. Please connect your wallet.",
        );
      }

      // Check current chain ID and switch to Robinhood Chain if needed
      if (wallet && !walletState.isConnected) {
        try {
          const currentChainId = await wallet.getChainId();
          if (currentChainId !== expectedChainId) {
            console.log(`[MoleSwap] Chain mismatch: wallet on ${currentChainId}, need ${expectedChainId}. Auto-switching...`);

            // Robinhood Chain config for wallet_addEthereumChain.
            const chainConfigs: Record<number, any> = {
              4663: {
                chainId: "0x1237",
                chainName: "Robinhood Chain",
                nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
                blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
              },
            };

            // Try to switch chain
            try {
              await wallet.switchChain({ id: expectedChainId });
              await new Promise((resolve) => setTimeout(resolve, 1000));
            } catch (switchError: any) {
              // If chain not recognized, try to add it first
              if (
                switchError?.code === 4902 ||
                switchError?.message?.includes("Unrecognized chain") ||
                switchError?.message?.includes("wallet_addEthereumChain")
              ) {
                const chainConfig = chainConfigs[expectedChainId];
                if (chainConfig && window.ethereum) {
                  try {
                    console.log(`[MoleSwap] Chain ${expectedChainId} not found. Adding...`);
                    await window.ethereum.request({
                      method: "wallet_addEthereumChain",
                      params: [chainConfig],
                    });
                    // After adding, try to switch again
                    await wallet.switchChain({ id: expectedChainId });
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                  } catch (addError: any) {
                    console.error("[MoleSwap] Failed to add chain:", addError);
                    throw new Error(
                      `Could not add ${chainConfig.chainName} to your wallet. Please add it manually.`
                    );
                  }
                } else {
                  throw new Error(
                    `Please add chain ${expectedChainId} (${swapData.fromChain?.displayName || swapData.fromChain?.name || "Unknown"}) to your wallet manually.`
                  );
                }
              } else {
                throw new Error(
                  `Failed to switch to chain ${expectedChainId}: ${switchError?.message || "Unknown error"}`
                );
              }
            }
            console.log(`[MoleSwap] Successfully switched to chain ${expectedChainId}`);
          }
        } catch (chainError: any) {
          if (!walletState.isConnected) {
            throw new Error(
              `Chain switch failed: ${chainError?.message || "Unknown error"}. Please switch to ${swapData.fromChain?.displayName || swapData.fromChain?.name || `chain ${expectedChainId}`} manually.`
            );
          }
          console.log("[MoleSwap] provider-owned session — skipping chain check");
        }
      }

      // Burn addresses to check against
      const burnAddresses = [
        "0x000000000000000000000000000000000000dead",
        "0xdead000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000",
      ];
      const isBurnAddr = (addr: string) =>
        burnAddresses.some((ba) => addr?.toLowerCase() === ba.toLowerCase());

      // Validate address is not a burn address
      if (isBurnAddr(currentAddress)) {
        throw new Error(
          "Invalid wallet address. Please connect a valid wallet.",
        );
      }

      let finalTxHashes: string[] = [];
      let hasStarted = false;

      // Execute through MoleRouter (fresh quote at execution time inside executeSwap).
      onSwapStart?.();
      hasStarted = true;
      setCurrentStep("Preparing swap...");

      const { executeSwap: runSwap } = await import("@/lib/chain/amm");

      setCurrentStep("Preparing swap...");
      // Reset steps to the derived list (approve only appears for ERC-20 input).
      setSwapSteps(initialSwapSteps);

      if (customRecipient) {
        console.log("[MoleSwap] Custom recipient in use:", customRecipient);
      }

      // Hand over the swap the pre-flight simulated and this card displayed. executeSwap signs it as-is
      // while it is fresh and re-runs the pre-flight gate right before the signature either way.
      const swapResult = await runSwap({
        chainClient: walletState.chainClient,
        tokenIn: swapData.fromToken,
        tokenOut: swapData.toToken,
        amountIn: prepared?.amountIn.toString() ?? swapData.quote?.amountIn?.toString?.() ?? amountWei,
        recipient: currentAddress,            // caller
        outputRecipient: customRecipient,     // optional; null → proceeds land at caller
        prepared: prepared ?? undefined,
        decodeCtx,
        // The signing-time re-check's verdict lands on the card too — and a mismatch there latches the same
        // halt, so the cycle that resumes after the failed attempt does not quietly re-simulate.
        onPreflight: (v) => applyVerdict(v, prepared?.calldata ?? null),
        onStep: (_stepIdx, label, status) => {
          // amm.ts emits status as a plain string; narrow it to the row union
          // (type-level only — values are the same "signing"/"confirmed"/"error").
          const stepStatus = status as "pending" | "signing" | "confirmed" | "error";
          // Match emitted label to the step row in the quote-derived list.
          // Label casing from amm.ts is now normalized to match quote.steps.
          setSwapSteps(prev => {
            const normalized = label.trim();
            const idx = prev.findIndex(s => s.label.trim().toLowerCase() === normalized.toLowerCase());

            // Exact match path (sequential mode or wrap/unwrap short-circuit)
            if (idx !== -1) {
              const next = [...prev];
              next[idx] = { label: prev[idx].label, status: stepStatus };
              return next;
            }

            // Bundled labels ("Swap") cover several UI rows at once —
            // transition the remaining pending rows together.
            const isBundledLabel = normalized.toLowerCase() === "swap";

            if (isBundledLabel) {
              // Transition all remaining pending rows to the same status
              return prev.map(row =>
                row.status === "confirmed" || row.status === "error"
                  ? row
                  : { label: row.label, status: stepStatus },
              );
            }

            if (stepStatus === "error") {
              // Error label is freeform — mark the first non-confirmed row as error
              const firstPendingIdx = prev.findIndex(r => r.status !== "confirmed");
              if (firstPendingIdx === -1) return prev;
              const next = [...prev];
              next[firstPendingIdx] = { label: prev[firstPendingIdx].label, status: "error" };
              return next;
            }

            return prev; // unknown label — ignore rather than corrupt the UI
          });
          if (status === "signing") setCurrentStep(label);
        },
      });

      if (!swapResult.success || !swapResult.txHash) {
        // Log failed swap
        diagnostics.logSwapResult({
          success: false,
          error: swapResult.error || "Swap failed",
          durationMs: Date.now() - swapStartTime,
        });
        throw new Error(swapResult.error || "Swap transaction failed or was rejected");
      }

      // ═══ DIAGNOSTICS: Log successful swap ═══
      diagnostics.logSwapResult({
        success: true,
        txHash: swapResult.txHash,
        durationMs: Date.now() - swapStartTime,
      });

      setCurrentStep("Swap complete!");
      finalTxHashes = [swapResult.txHash];
      setTxHashes([swapResult.txHash]);

      // Save to swap history (sessionStorage) for the history panel
      try {
        const historyEntry = {
          id: Date.now(),
          fromSymbol: swapData.fromTokenMeta?.symbol || swapData.fromToken?.slice(0, 8) || "?",
          toSymbol: swapData.toTokenMeta?.symbol || swapData.toToken?.slice(0, 8) || "?",
          fromAmount: swapData.amount || "0",
          toAmount: swapData.expectedOut || "0",
          txHash: swapResult.txHash,
          timestamp: new Date().toISOString(),
          fromLogo: swapData.fromTokenMeta?.logoURI || "/placeholder-logo.png",
          toLogo: swapData.toTokenMeta?.logoURI || "/placeholder-logo.png",
        };
        const existing = JSON.parse(window.sessionStorage?.getItem("moleswap_history") || "[]");
        existing.unshift(historyEntry);
        window.sessionStorage?.setItem("moleswap_history", JSON.stringify(existing.slice(0, 50)));
      } catch (e) { /* ignore storage errors */ }

      // Save to Supabase for persistent history
      try {
        const { getOrCreateUser, recordSwap } = await import("@/lib/supabase/api");
        if (currentAddress) {
          const user = await getOrCreateUser(currentAddress);
          if (user?.id) {
            await recordSwap({
              userId: user.id,
              fromChainId: swapData.fromChain?.id || 4663,
              toChainId: swapData.toChain?.id || 4663,
              fromToken: swapData.fromToken || "",
              toToken: swapData.toToken || "",
              fromAmount: swapData.amount || "0",
              toAmount: swapData.expectedOut || "0",
              txHash: typeof swapResult.txHash === "string" ? swapResult.txHash : extractHash(swapResult.txHash),
              status: "success",
            });
            console.log("[MoleSwap] Swap recorded in Supabase");
          }
        }
      } catch (e) {
        console.warn("[MoleSwap] Failed to record swap in Supabase:", e);
      }

      // Execute promise has resolved - swap is complete
      // Stop animation and navigate to transaction-info immediately
      setIsExecuting(false);
      setIsCompleted(true);
      onSwapComplete?.(); // Stop background animation

      // Navigate to transaction-info page immediately after swap completes
      onNext("transaction-info", {
        transactionId:
          finalTxHashes?.[finalTxHashes.length - 1] ||
          txHashes[txHashes.length - 1] ||
          "",
        txHashes: finalTxHashes.length > 0 ? finalTxHashes : txHashes,
      });
    } catch (error: any) {
      // ═══ DIAGNOSTICS: Analyze and log error ═══
      // (analyzeError is typed 1-arg/string-return; the legacy 2-arg call and
      // .category/.suggestion reads are preserved exactly via `any`.)
      const analysis: any = (diagnostics.analyzeError as any)(error, {});
      console.error("Swap execution error:", error);
      console.log("[MoleSwap:Diagnostics] Error analysis:", analysis);

      // Log swap failure with timing
      diagnostics.logSwapResult({
        success: false,
        error: `[${analysis.category}] ${error?.message || "Unknown error"}`,
        durationMs: Date.now() - swapStartTime,
      });

      // Prefer the actionable suggestion over the raw wallet error, which is
      // unhelpful string "Signature request failed".
      const userFacing =
        analysis.category === "WRONG_NETWORK"
          ? analysis.suggestion
          : error?.message || "Failed to execute swap";
      setExecutionError(userFacing);
      setIsExecuting(false);
      setIsCompleted(false);
      onSwapComplete?.(); // Stop animation on error
    }
  };

  const fromLogo =
    swapData.fromTokenMeta?.logoURI ||
    swapData.fromChain?.iconUrl ||
    swapData.fromChain?.logoUrl ||
    "";
  const toLogo =
    swapData.toTokenMeta?.logoURI ||
    swapData.toChain?.iconUrl ||
    swapData.toChain?.logoUrl ||
    "";

  return (
    <main className="swap-main">
      <ExchangeHero />
      {/* paddingTop is zeroed because .dapp-col carries 26px that the exchange step's .swap-grid
          does not — left in, it would drop this card 26px below the one it is meant to replace. */}
      <div className="dapp-col" style={{ maxWidth: 620, margin: "0 auto", paddingTop: 0 }}>
        <div className="p-card">
          {/* The back button and title live INSIDE the card, mirroring the exchange card's own
              header row. Sitting above the card they added ~40px of chrome that the exchange step
              does not have, so the two widgets landed at different heights on the same journey. */}
          <div className="pick-head" style={{ marginBottom: 14 }}>
            <button onClick={onBack} className="tool-btn" aria-label="Back">
              <ArrowLeft size={16} />
            </button>
            <h2 style={{ margin: 0, fontSize: "1.3rem", fontWeight: 800, color: "var(--p-onbg)" }}>
              Exchange
            </h2>
          </div>

          {/* From token */}
          <div className="rv-row">
            <TokenCircle
              logo={fromLogo}
              symbol={displaySymbolOf(swapData.fromTokenMeta, swapData.fromToken)}
            />
            <div>
              <div className="rv-amt">{swapData.amount || "0"}</div>
              <div className="rv-sub">
                {displaySymbolOf(swapData.fromTokenMeta, swapData.fromToken)} on{" "}
                {swapData.fromChain?.displayName ||
                  swapData.fromChain?.name ||
                  "Unknown"}
              </div>
            </div>
            <span className="rv-eta">
              ETA:{" "}
              {(swapData.etaSeconds ?? null) !== null
                ? `${swapData.etaSeconds}s`
                : "-"}
            </span>
          </div>

          {/* Swap via */}
          <div className="rv-mid">
            <span style={{ fontSize: 16 }} aria-hidden="true">
              🔄
            </span>
            <span>{swapData.routeLabel || "Auto route"}</span>
          </div>

          {/* To token */}
          <div className="rv-row">
            <TokenCircle
              logo={toLogo}
              symbol={displaySymbolOf(swapData.toTokenMeta, swapData.toToken)}
            />
            <div>
              <div className="rv-amt">{displayOut}</div>
              {/* The asset lands on Robinhood Chain, at the caller or the
                  custom recipient. */}
              <div className="rv-sub">
                {swapData.feesLabel || ""} •{" "}
                {(swapData.toTokenMeta as any)?.symbol ||
                  displaySymbolOf(swapData.toTokenMeta, swapData.toToken)}{" "}
                on Robinhood Chain
              </div>
              {/* Live-quote freshness + expiry countdown — the number above re-quotes automatically. */}
              {!isExecuting && !isCompleted && (
                <div className="live-req">
                  {halted ? (
                    // The countdown must not promise a refresh that, by design, is not coming.
                    <span data-testid="preflight-halted">HALTED · simulation mismatch — not re-checked automatically</span>
                  ) : (
                    <>
                      <RefreshCw
                        className="spin"
                        size={12}
                        style={{ animationDuration: "3s" }}
                      />
                      <span>LIVE · quote refreshes in {secsToRefresh}s</span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Rate / fee strip */}
          <div className="rv-strip">
            <span>
              {swapData.rateLabel ||
                `1 ${displaySymbolOf(swapData.fromTokenMeta, swapData.fromToken)} = ${swapData.expectedOut || "0"} ${displaySymbolOf(swapData.toTokenMeta, swapData.toToken)}`}
            </span>
            <span>
              <Fuel size={13} style={{ display: "inline", verticalAlign: "-2px" }} />{" "}
              {swapData.feesLabel || "<$0.01"} ETA:{" "}
              {(swapData.etaSeconds ?? null) !== null
                ? `${swapData.etaSeconds}s`
                : "-"}
            </span>
          </div>

          {/* Pre-flight: the exact transaction, simulated as you on current chain state. A pre-flight is
              not a guarantee — state can move between simulation and inclusion, and the on-chain minimum
              is the only promise. It gates the button below. */}
          <div className="pf-box" data-testid="preflight">
            <div className="pf-head">
              <span>Pre-flight</span>
              <span className="pf-sub">
                {preflight && !preflightCurrent
                  ? "re-checking the fresh quote… · not a guarantee"
                  : preflight?.status === "ok"
                    ? `simulated · ${preflight.providers > 1 ? `${preflight.providers} providers agree` : "second opinion unavailable"} · not a guarantee`
                    : "simulated on current chain state · not a guarantee"}
              </span>
            </div>
            {preflight?.status === "ok" && !isExecuting && (
              <div className="p-rows" style={{ marginTop: 4 }}>
                <div className="p-row">
                  <span className="k">You send</span>
                  <span className="v">
                    −{fmtAmount(preflight.sent, decIn)} {symIn}
                  </span>
                </div>
                <div className="p-row">
                  <span className="k">You receive (simulated)</span>
                  <span className="v pos">
                    +{fmtAmount(preflight.received, decOut)} {symOut}
                  </span>
                </div>
              </div>
            )}
            {preflight?.status === "blocked" && (
              <div className="warn-red" data-testid="preflight-blocked">
                <b style={{ display: "block", marginBottom: 4 }}>{preflight.reason.title}</b>
                <span style={{ whiteSpace: "pre-line", overflowWrap: "break-word" }}>{preflight.reason.message}</span>
                {preflight.reason.raw ? (
                  <details className="pf-raw">
                    <summary>Raw error</summary>
                    <code>{preflight.reason.raw}</code>
                  </details>
                ) : null}
                {preflight.kind === "mismatch" ? (
                  // The only way back into the cycle is this explicit action (or leaving the screen).
                  <div style={{ marginTop: 6 }}>
                    Automatic re-checks are halted.{" "}
                    <button type="button" className="pf-retry" data-testid="preflight-recheck" onClick={recheckAfterMismatch}>
                      Re-check now
                    </button>
                  </div>
                ) : null}
              </div>
            )}
            {preflight?.status === "unavailable" && (
              <div className="warn-thin" data-testid="preflight-unavailable">
                Pre-flight could not run: {preflight.reason.message}{" "}
                <button type="button" className="pf-retry" onClick={() => setCycleEpoch((e) => e + 1)}>
                  Retry
                </button>
              </div>
            )}
            {!preflight && (
              <div className="pf-note">
                {prepareError
                  ? `Could not build the swap — this is not a liquidity problem: ${prepareError}`
                  : noRoute
                    ? "No route with live liquidity for this pair."
                    : !account
                      ? "Connect a wallet to run the pre-flight."
                      : preflightBusy || !prepared
                        ? "Running pre-flight…"
                        : "Running pre-flight…"}
              </div>
            )}
          </div>

          {/* Swap execution progress */}
          {isExecuting && (
            <div style={{ marginTop: 6 }}>
              {swapSteps.map((step, i) => {
                const isDone = step.status === "confirmed";
                const isActive = step.status === "signing";
                return (
                  <div
                    key={i}
                    className={`step-row${isActive ? " active" : ""}${isDone ? " done" : ""}`}
                  >
                    <span className="ind">
                      {isDone ? (
                        "✓"
                      ) : isActive ? (
                        <span className="spin">⟳</span>
                      ) : (
                        i + 1
                      )}
                    </span>
                    <span className="lbl2">{step.label}</span>
                    <span className="sub">
                      {isActive
                        ? "Waiting for signature..."
                        : isDone
                          ? "Confirmed"
                          : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Error message — actionable messages can be long; don't truncate. */}
          {executionError && (
            <div className="warn-red">
              <b style={{ display: "block", marginBottom: 4 }}>Swap failed</b>
              <span style={{ whiteSpace: "pre-line", overflowWrap: "break-word" }}>
                {executionError}
              </span>
            </div>
          )}

          {/* Start Swapping Button */}
          {/* Case 1: Wallet not connected — show connect prompt */}
          {!walletState.isConnected && !walletState.isConnecting ? (
            <button onClick={() => walletState.connect?.()} className="p-btn">
              Connect wallet
            </button>
          ) : walletState.isConnecting ? (
            /* Case 2: Wallet is connecting */
            <button
              disabled
              className="p-btn"
              style={{ opacity: 0.6, cursor: "not-allowed" }}
            >
              Connecting...
            </button>
          ) : !walletState.chainClient ? (
            /* Case 3: Connected but SDK not ready */
            <button
              disabled
              className="p-btn"
              style={{ opacity: 0.6, cursor: "not-allowed" }}
            >
              Initializing...
            </button>
          ) : (
            /* Case 4: Ready to swap */
            <button
              onClick={handleStartSwapping}
              disabled={isExecuting || !swapData.quote || !preflightOk}
              className="p-btn"
              style={
                isExecuting || !swapData.quote || !preflightOk
                  ? { opacity: 0.6, cursor: "not-allowed" }
                  : undefined
              }
            >
              {isExecuting
                ? currentStep || "Swapping..."
                : preflight?.status === "blocked"
                  ? "Blocked by pre-flight"
                  : preflightOk
                    ? "Start swapping"
                    : "Waiting for pre-flight…"}
            </button>
          )}
        </div>
      </div>
    </main>
  );
};
