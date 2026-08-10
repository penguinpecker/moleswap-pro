"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, Fuel, RefreshCw } from "lucide-react";
import { formatUnits, parseUnits } from "viem";
import { DappStep } from ".";
import Image from "next/image";
import { getWalletClient } from "@/lib/wallet/walletClient";
import type { TokenEntry, ChainEntry } from "@/lib/chain/tokenList";
import { useWallet } from "@/lib/chain/provider";
import { getSwapQuote } from "@/lib/chain/amm";
import { diagnostics } from "@/lib/diagnostics";

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

  // Keep the review quote LIVE. The card carries a snapshot from the exchange screen; here we re-quote
  // every REQUOTE_MS and count down to the next refresh, so the number can never go stale under the user
  // (and executeSwap re-quotes once more at signing time, so what they sign is always fresh).
  const REQUOTE_MS = 8000;
  const [liveOut, setLiveOut] = useState<string | null>(null);
  const [secsToRefresh, setSecsToRefresh] = useState(REQUOTE_MS / 1000);
  const requoteBusy = useRef(false);

  useEffect(() => {
    if (isExecuting || isCompleted) return; // freeze the quote once the swap is in flight
    const decIn = swapData.fromTokenMeta?.decimals ?? 18;
    const decOut = swapData.toTokenMeta?.decimals ?? 18;
    let amountInWei: bigint;
    try {
      amountInWei = parseUnits(String(swapData.amount || "0"), decIn);
    } catch {
      return;
    }
    if (amountInWei <= 0n || !swapData.toToken) return;

    let cancelled = false;
    const requote = async () => {
      if (requoteBusy.current) return;
      requoteBusy.current = true;
      try {
        const q = await getSwapQuote({
          tokenIn: swapData.fromToken || "",
          tokenOut: swapData.toToken,
          amountIn: amountInWei.toString(),
        });
        if (!cancelled && q?.amountOut) {
          const human = Number(formatUnits(BigInt(q.amountOut), decOut));
          setLiveOut(human.toLocaleString(undefined, { maximumFractionDigits: decOut > 6 ? 6 : 4 }));
          setSecsToRefresh(REQUOTE_MS / 1000);
        }
      } catch {
        /* keep the last good number */
      } finally {
        requoteBusy.current = false;
      }
    };

    requote();
    const poll = setInterval(requote, REQUOTE_MS);
    const tick = setInterval(() => setSecsToRefresh((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swapData.fromToken, swapData.toToken, swapData.amount, isExecuting, isCompleted]);

  const displayOut = liveOut ?? swapData.expectedOut ?? "0";

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

      // Custom recipient support: ExchangePage pipes the user's typed
      // destination through swapData.recipientAddress. `recipient` stays the
      // caller (approvals, balance anchor); `outputRecipient` is where the
      // swap output lands when set. MoleRouter enforces the same minimum-out
      // either way and takes no fee.
      const isHexAddr = (s: unknown): s is string =>
        typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
      const customRecipient =
        isHexAddr(swapData.recipientAddress) &&
        swapData.recipientAddress.toLowerCase() !== currentAddress.toLowerCase()
          ? swapData.recipientAddress
          : null;
      if (customRecipient) {
        console.log("[MoleSwap] Custom recipient in use:", customRecipient);
      }

      const swapResult = await runSwap({
        chainClient: walletState.chainClient,
        tokenIn: swapData.fromToken,
        tokenOut: swapData.toToken,
        amountIn: swapData.quote?.amountIn?.toString?.() || amountWei,
        recipient: currentAddress,            // caller
        outputRecipient: customRecipient,     // optional; null → proceeds land at caller
        onStep: (_stepIdx, label, status) => {
          // Match emitted label to the step row in the quote-derived list.
          // Label casing from amm.ts is now normalized to match quote.steps.
          setSwapSteps(prev => {
            const normalized = label.trim();
            const idx = prev.findIndex(s => s.label.trim().toLowerCase() === normalized.toLowerCase());

            // Exact match path (sequential mode or wrap/unwrap short-circuit)
            if (idx !== -1) {
              const next = [...prev];
              next[idx] = { label: prev[idx].label, status };
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
                  : { label: row.label, status },
              );
            }

            if (status === "error") {
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
      const analysis = diagnostics.analyzeError(error, {});
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
    "/placeholder-logo.png";
  const toLogo =
    swapData.toTokenMeta?.logoURI ||
    swapData.toChain?.iconUrl ||
    swapData.toChain?.logoUrl ||
    "/placeholder-logo.png";

  return (
    <div className="flex w-full flex-1 flex-col p-2 sm:max-w-3xl sm:p-6">
      {/* Header with Back Button */}
      <div className="font-family-ThaleahFat relative top-[40px] z-10 mx-auto flex w-[85%] items-center justify-center rounded-lg px-6 py-4 text-center">
        <button
          onClick={onBack}
          className="border-ground-button-border bg-ground-button absolute left-4 cursor-pointer justify-center rounded border-2 p-1 text-yellow-100 hover:scale-105"
        >
          <ArrowLeft className="h-6 w-6 text-yellow-100" />
        </button>

        <h1 className="text-peach-300 text-shadow-header mx-auto text-3xl font-bold tracking-widest uppercase sm:text-5xl">
          Exchange
        </h1>
        <Image
          src="/quest/header-quest-bg.png"
          alt="Profile"
          width={200}
          height={200}
          className="absolute inset-0 left-0 z-[-1] h-full w-full"
        />
      </div>
      <div className="relative mb-6 block h-full">
        <Image
          src="/quest/Quest-BG.png"
          alt="Profile"
          width={200}
          height={200}
          className="absolute inset-0 z-0 h-full w-full object-fill"
        />
        <div className="relative z-50 mx-auto mt-12 mb-6 grid w-full grid-cols-1 gap-4 p-4 sm:w-[85%]">
          {/* Swap Details */}
          <div className="relative mb-6 space-y-4 p-4">
            <Image
              src="/dapp/start-swaping-info-box.png"
              alt="Profile"
              width={200}
              height={200}
              className="absolute inset-0 left-0 z-[-1] h-full w-full"
            />
            {/* From Token */}
            <div className="px-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <div className="border-ground-button-border bg-ground-button mr-3 flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border-2">
                    <Image
                      src={fromLogo}
                      alt="From token"
                      width={40}
                      height={40}
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <div>
                    <div className="font-family-ThaleahFat text-3xl text-zinc-100">
                      {swapData.amount || "0"}
                    </div>
                    <div className="text-sm font-semibold text-stone-300">
                      {displaySymbolOf(swapData.fromTokenMeta, swapData.fromToken)} on{" "}
                      {swapData.fromChain?.displayName ||
                        swapData.fromChain?.name ||
                        "Unknown"}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-yellow-100">
                    ETA:{" "}
                    {(swapData.etaSeconds ?? null) !== null
                      ? `${swapData.etaSeconds}s`
                      : "-"}
                  </div>
                </div>
              </div>
            </div>

            {/* Swap Via */}
            <div className="px-4">
              <div className="flex items-center">
                <div className="border-ground-button-border bg-ground-button mr-3 flex h-10 w-10 items-center justify-center rounded-lg border-2 p-4">
                  <span className="font-bold text-white">🔄</span>
                </div>
                <div>
                  <div className="font-family-ThaleahFat text-2xl text-zinc-100">
                    {swapData.routeLabel || "AUTO ROUTE"}
                  </div>
                </div>
                <div className="ml-auto">
                  <button className="border-ground-button-border bg-ground-button cursor-pointer justify-center rounded border-2 p-1 text-yellow-100 hover:scale-105">
                    <ArrowDown className="z-10 h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* To Token */}
            <div className="px-4">
              <div className="flex items-center">
                <div className="border-ground-button-border bg-ground-button mr-3 flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border-2">
                  <Image
                    src={toLogo}
                    alt="To token"
                    width={40}
                    height={40}
                    className="h-full w-full object-cover"
                  />
                </div>
                <div>
                  <div className="font-family-ThaleahFat text-3xl text-zinc-100">
                    {displayOut}
                  </div>
                  {/* The asset lands on Robinhood Chain, at the caller or the
                      custom recipient. */}
                  <div className="text-sm font-semibold text-stone-300">
                    {swapData.feesLabel || ""} •{" "}
                    {(swapData.toTokenMeta as any)?.symbol || displaySymbolOf(swapData.toTokenMeta, swapData.toToken)} on Robinhood Chain
                  </div>
                  {/* Live-quote freshness + expiry countdown — the number above re-quotes automatically. */}
                  {!isExecuting && !isCompleted && (
                    <div className="mt-1 flex items-center gap-1 text-xs font-semibold text-[#6DBB3E]">
                      <RefreshCw className="h-3 w-3 animate-spin" style={{ animationDuration: "3s" }} />
                      LIVE · quote refreshes in {secsToRefresh}s
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Transaction Fee */}
          <div className="relative z-50 p-4">
            <div className="flex w-full justify-between gap-4 px-4 py-1 max-sm:flex-col sm:items-center">
              <div className="text-sm font-semibold text-stone-300">
                {swapData.rateLabel ||
                  `1 ${displaySymbolOf(swapData.fromTokenMeta, swapData.fromToken)} = ${swapData.expectedOut || "0"} ${displaySymbolOf(swapData.toTokenMeta, swapData.toToken)}`}
              </div>
              <div className="ml-auto text-sm text-yellow-200">
                <Fuel className="inline-block h-4 w-4" />{" "}
                {swapData.feesLabel || "<$0.01"} ETA:{" "}
                {(swapData.etaSeconds ?? null) !== null
                  ? `${swapData.etaSeconds}s`
                  : "-"}
              </div>
            </div>
            <Image
              src="/quest/header-quest-bg.png"
              alt="Profile"
              width={200}
              height={200}
              className="absolute inset-0 left-0 z-[-1] h-full w-full"
            />
          </div>

          {/* 3-Step Swap Progress */}
          {isExecuting && (
            <div className="relative z-50 flex flex-col gap-2 rounded-lg p-3">
              {swapSteps.map((step, i) => {
                const isDone = step.status === "confirmed";
                const isActive = step.status === "signing";
                const isPending = step.status === "pending";
                return (
                  <div
                    key={i}
                    className={`relative flex items-center gap-3 rounded-lg px-4 py-3 ${
                      isActive ? "border-2 border-yellow-400" : "border-2 border-transparent"
                    }`}
                  >
                    <Image
                      src={isActive ? "/dapp/selected-network-bg.png" : "/quest/header-quest-bg.png"}
                      alt="BG"
                      width={200}
                      height={200}
                      className="absolute inset-0 z-[-1] h-full w-full"
                    />
                    {/* Step indicator */}
                    <div
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                        isDone
                          ? "bg-[#6DBB3E] text-white"
                          : isActive
                            ? "bg-yellow-400 text-black"
                            : "bg-[#523525] text-[#8b6d4f]"
                      }`}
                    >
                      {isDone ? "✓" : isActive ? (
                        <div className="h-3 w-3 animate-spin rounded-full border-2 border-black border-t-transparent" />
                      ) : (
                        i + 1
                      )}
                    </div>
                    {/* Step label */}
                    <div className="flex-1">
                      <span
                        className={`font-family-ThaleahFat text-lg tracking-wider ${
                          isDone
                            ? "text-[#6DBB3E]"
                            : isActive
                              ? "text-peach-300"
                              : "text-[#8b6d4f]"
                        }`}
                      >
                        {step.label}
                      </span>
                      {isActive && (
                        <span className="font-family-ThaleahFat ml-2 text-sm tracking-wider text-yellow-400">
                          WAITING FOR SIGNATURE...
                        </span>
                      )}
                      {isDone && (
                        <span className="font-family-ThaleahFat ml-2 text-sm tracking-wider text-[#6DBB3E]">
                          CONFIRMED
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Error Message — actionable messages can be long; don't truncate. */}
          {executionError && (
            <div className="relative z-50 max-w-full overflow-hidden rounded-lg bg-red-900/40 p-4 text-center text-sm text-red-200">
              <p className="font-family-ThaleahFat mb-1 text-base text-red-300">SWAP FAILED</p>
              <p className="whitespace-pre-line break-words text-xs leading-relaxed">
                {executionError}
              </p>
            </div>
          )}
          {/* Start Swapping Button */}
          {/* Case 1: Wallet not connected — show connect prompt */}
          {!walletState.isConnected && !walletState.isConnecting ? (
            <button
              onClick={() => walletState.connect?.()}
              className="relative w-full cursor-pointer rounded py-4 text-xl font-bold text-white transition-all hover:scale-105"
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
          ) : walletState.isConnecting ? (
            /* Case 2: Wallet is connecting */
            <button
              disabled
              className="relative w-full cursor-not-allowed rounded py-4 text-xl font-bold text-white opacity-60"
            >
              <span>CONNECTING...</span>
              <Image
                src="/dapp/connect-wallet.png"
                alt="Connecting"
                width={200}
                height={200}
                className="absolute inset-0 z-[-1] h-full w-full object-fill"
              />
            </button>
          ) : !walletState.chainClient ? (
            /* Case 3: Connected but SDK not ready */
            <button
              disabled
              className="relative w-full cursor-not-allowed rounded py-4 text-xl font-bold text-white opacity-60"
            >
              <span>INITIALIZING...</span>
              <Image
                src="/dapp/connect-wallet.png"
                alt="Initializing"
                width={200}
                height={200}
                className="absolute inset-0 z-[-1] h-full w-full object-fill"
              />
            </button>
          ) : (
            /* Case 4: Ready to swap */
            <button
              onClick={handleStartSwapping}
              disabled={isExecuting || !swapData.quote}
              className="relative w-full cursor-pointer rounded py-4 text-xl font-bold text-white transition-all hover:scale-105 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span>
                {isExecuting ? currentStep || "SWAPPING..." : "START SWAPPING"}
              </span>
              <Image
                src="/dapp/connect-wallet.png"
                alt="Profile"
                width={200}
                height={200}
                className="absolute inset-0 z-[-1] h-full w-full object-fill"
              />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
