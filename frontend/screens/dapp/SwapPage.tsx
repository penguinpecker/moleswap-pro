"use client";
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowLeft, Fuel } from "lucide-react";
import { DappStep } from ".";
import Image from "next/image";
import { relayClient } from "@/lib/relay/client";
import { getWalletClient } from "@/lib/wallet/walletClient";
import type { RelayCurrency, RelayChain } from "@/lib/relay/api";
import { usePushWallet } from "@/lib/pushchain/provider";
import { diagnostics } from "@/lib/diagnostics";

// Extract tx hash from PushChain SDK response (may be Object)
const extractHash = (result: any): string => {
  if (!result) return "";
  if (typeof result === "string") return result;
  const keys = ["hash", "txHash", "transactionHash"];
  for (const k of keys) { if (result[k] && typeof result[k] === "string") return result[k]; }
  if (result.tx?.hash) return result.tx.hash;
  if (result.receipt?.transactionHash) return result.receipt.transactionHash;
  return "";
};

/**
 * Prefer the real-asset display symbol (e.g. "ETH", "SOL", "USDT") surfaced
 * through RelayCurrency.displaySymbol over the internal `pETH`/`USDT.eth`
 * style identifiers. Fallback chain mirrors ExchangePage.displaySymbolOf.
 */
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
    fromTokenMeta?: RelayCurrency;
    toTokenMeta?: RelayCurrency;
    fromChain?: RelayChain;
    toChain?: RelayChain;
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
  const pushWallet = usePushWallet();
  const [isExecuting, setIsExecuting] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [txHashes, setTxHashes] = useState<string[]>([]);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [approvalHash, setApprovalHash] = useState<string | null>(null);
  const [requireApproval, setRequireApproval] = useState<boolean | null>(null);

  // ═══ BRIDGE-IN DETECTION ═════════════════════════════════════════════════
  // When the user's wallet origin chain matches the fromToken's origin chain,
  // executeSwap will auto-prepend a bridge step that locks the real origin
  // asset (SOL on Phantom, ETH on MetaMask Sepolia, etc.) and mints PRC-20
  // into the UEA atomically with the swap. This matches RamenFi's behavior.
  //
  // This flag is only used to inform the UI — the actual bridge is decided
  // server-side in executeSwap based on the same predicate.
  const originChainForHooks =
    (pushWallet as any)?.originChain ||
    (pushWallet as any)?.universalAccount?.chain ||
    null;
  const [bridgeInInfo, setBridgeInInfo] = useState<{
    eligible: boolean;
    uiLabel: string;
    originSymbol: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!swapData.fromToken || !originChainForHooks) {
          if (!cancelled) setBridgeInInfo(null);
          return;
        }
        const { canAutoBridgeFrom, getBridgeInfoForPrc20 } = await import(
          "@/lib/pushchain/prc20-bridge-map"
        );
        if (!canAutoBridgeFrom(swapData.fromToken, originChainForHooks)) {
          if (!cancelled) setBridgeInInfo(null);
          return;
        }
        const info = getBridgeInfoForPrc20(swapData.fromToken);
        if (info && !cancelled) {
          setBridgeInInfo({
            eligible: true,
            uiLabel: info.uiLabel,
            originSymbol: info.originSymbol,
          });
        }
      } catch (err) {
        console.warn("[MoleSwap] bridge-in eligibility probe failed:", err);
        if (!cancelled) setBridgeInInfo(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [swapData.fromToken, originChainForHooks]);

  // Step list is derived from the quote (which knows the exact route: wrap/no-wrap,
  // approve-or-skip, single-hop vs multi-hop) rather than hardcoded. This ensures
  // we only render steps that actually apply to this swap.
  const initialSwapSteps = useMemo(() => {
    const quoteSteps: Array<{ label?: string }> = Array.isArray(swapData.quote?.steps)
      ? swapData.quote.steps
      : [];
    // Only keep on-chain tx steps (quote includes an "approval" helper step for
    // the relay flow that isn't part of the actual swap execution).
    const known = ["Wrap PC → WPC", "Unwrap WPC → PC", "Approve token", "Swap tokens", "Swap → WPC", "Approve WPC", "Swap WPC →"];
    const txSteps = quoteSteps.filter(s => typeof s?.label === "string" && known.includes(s.label as string));
    let base = txSteps.length > 0
      ? txSteps.map(s => ({ label: s.label as string, status: "pending" as const }))
      // Fallback for when quote.steps is missing — best-guess 2-step default.
      : [
          { label: "Approve token", status: "pending" as const },
          { label: "Swap tokens", status: "pending" as const },
        ];
    // If bridge-in is eligible, the entire flow collapses into ONE signature
    // (origin-chain lock + UEA upgrade + approve + swap all atomic). Show a
    // single combined row so the user isn't surprised by a 1-click signing
    // experience for what looks like a 3-step flow.
    if (bridgeInInfo?.eligible) {
      base = [
        { label: `Bridge ${bridgeInInfo.originSymbol} from ${bridgeInInfo.uiLabel} & swap`, status: "pending" as const },
      ];
    }
    return base;
  }, [swapData.quote, bridgeInInfo]);

  const [swapSteps, setSwapSteps] = useState<Array<{ label: string; status: "pending" | "signing" | "confirmed" | "error" }>>(initialSwapSteps);

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

  // Detect if approval is needed from quote steps
  const approvalInfo = useMemo(() => {
    const steps = swapData.quote?.steps;
    if (!Array.isArray(steps)) return null;
    // Heuristics to find an approval step
    const approveStep = steps.find((s: any) => {
      const name = (s?.name || s?.description || "").toString().toLowerCase();
      const type = (s?.type || s?.operation || "").toString().toLowerCase();
      const data =
        s?.transaction?.data || s?.tx?.data || s?.request?.data || "";
      return (
        name.includes("approv") ||
        type.includes("approv") ||
        (typeof data === "string" && data.startsWith("0x095ea7b3"))
      );
    });
    if (!approveStep) return null;
    // Try to extract spender from step; fallback to route/quote details
    const spender =
      approveStep?.spender ||
      approveStep?.to ||
      swapData.quote?.details?.spender ||
      swapData.quote?.spender;
    const token = swapData.fromTokenMeta?.address || swapData.fromToken;
    return spender && token ? { token, spender } : null;
  }, [
    swapData.quote?.steps,
    swapData.fromTokenMeta?.address,
    swapData.fromToken,
    swapData.quote?.details?.spender,
    swapData.quote?.spender,
  ]);

  const needsApproval = Boolean(approvalInfo);

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
    if (!pushWallet.isConnected) {
      setExecutionError("Wallet not connected. Please connect your wallet first.");
      diagnostics.logSessionEvent("Swap blocked - wallet not connected");
      return;
    }

    // Guard 3: Check SDK client
    if (!pushWallet.pushChainClient) {
      setExecutionError("Wallet is still initializing. Please wait a moment and try again.");
      diagnostics.logSessionEvent("Swap blocked - pushChainClient not ready");
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
      isConnected: pushWallet.isConnected,
      hasAddress: !!pushWallet.address,
      hasPushChainClient: !!pushWallet.pushChainClient,
      hasUniversal: !!(pushWallet.pushChainClient as any)?.universal,
      originChain: (pushWallet as any)?.originChain || null,
    });

    try {
      // ═══ PRE-FLIGHT: Phantom cluster check ═══════════════════════════
      // If origin is Solana Devnet AND fromToken is bridgeable from Solana,
      // the SDK will try to sign a Solana tx against Robinhood Chain's gateway
      // program at `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (Devnet).
      // If Phantom is connected to Mainnet instead, the signing throws
      // "Me: Unexpected error" — a cryptic Phantom error that obscures
      // the real issue. Check the user's Devnet balance first: if it's 0
      // but they claim to have SOL, they're on the wrong cluster.
      const originChain =
        (pushWallet as any)?.originChain ||
        (pushWallet as any)?.universalAccount?.chain ||
        null;
      const isSolanaOrigin =
        typeof originChain === "string" &&
        originChain.toLowerCase().startsWith("solana:");
      const origin = (pushWallet as any)?.origin || null;

      // Diagnostic: log the actual shapes we see from pushWallet so Solana
      // preflight issues are traceable in user-submitted logs.
      console.log("[MoleSwap] Preflight origin check:", {
        originChain,
        isSolanaOrigin,
        originType: typeof origin,
        originPreview: typeof origin === "string" ? origin.slice(0, 8) + "..." : String(origin).slice(0, 30),
      });

      if (isSolanaOrigin && typeof origin === "string" && origin.length > 0) {
        try {
          const { canAutoBridgeFrom } = await import("@/lib/pushchain/prc20-bridge-map");
          if (canAutoBridgeFrom(swapData.fromToken, originChain)) {
            // Single Devnet-balance check: the Push Solana gateway is on
            // Devnet only, so we need the user to have Devnet SOL covering
            // (bridge amount + ~5k lamport fees). Mainnet-balance fingerprinting
            // was a dead end: public Mainnet RPCs reject browser requests with
            // 403, and the real cause of the earlier "Unexpected error" was
            // actually the helper dispatch mode (see amm.ts — Solana helper
            // now routes via MULTICALL_TARGET_ADDRESS, not the raw `to`).
            const res = await fetch("https://api.devnet.solana.com", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0", id: 1, method: "getBalance", params: [origin],
              }),
            });
            const json = await res.json();
            const lamports: number | undefined = json?.result?.value;
            const amountHuman = Number(swapData.amount || "0");
            const decimalsIn = swapData.fromTokenMeta?.decimals ?? 9;
            const requiredLamports = Math.ceil(amountHuman * 10 ** decimalsIn) + 5_000;
            console.log("[MoleSwap] Devnet balance check:", {
              pubkey: origin.slice(0, 8) + "...",
              devnetLamports: lamports,
              requiredLamports,
            });

            if (typeof lamports === "number" && lamports === 0) {
              throw new Error(
                "Your Solana Devnet balance is 0. If Phantom shows a SOL balance, it's on Mainnet — " +
                  "Robinhood Chain's bridge only works with Devnet. Open Phantom → Settings → Developer " +
                  "Settings → enable Testnet Mode, then switch the network to Solana Devnet. Get " +
                  "free Devnet SOL from https://faucet.solana.com/"
              );
            }
            if (
              typeof lamports === "number" &&
              Number.isFinite(requiredLamports) &&
              lamports < requiredLamports
            ) {
              const haveSol = (lamports / 1e9).toFixed(6);
              const needSol = (requiredLamports / 1e9).toFixed(6);
              throw new Error(
                `Not enough Devnet SOL to bridge. You have ${haveSol} SOL but need ~${needSol} SOL (including fees). ` +
                  "Get free Devnet SOL from https://faucet.solana.com/"
              );
            }
          }
        } catch (preflightErr: any) {
          const m = preflightErr?.message || "";
          if (m.includes("Devnet") || m.includes("Mainnet") || m.includes("Phantom")) {
            throw preflightErr;
          }
          console.warn("[MoleSwap] Devnet balance probe failed (non-fatal):", preflightErr);
        }
      }

      // Get expected chain ID from the quote
      const expectedChainId = swapData.fromChain?.id
        ? Number(swapData.fromChain.id)
        : undefined;

      if (!expectedChainId) {
        throw new Error("Unable to determine expected chain ID from quote.");
      }

      // Skip external wallet client entirely for PushChain-connected wallets
      // (including Phantom/Solana). Calling getWalletClient() blindly uses
      // window.ethereum, which picks MetaMask when both are installed — even
      // if the user connected via Phantom.
      const wallet = pushWallet.isConnected ? null : await getWalletClient();
      if (!wallet && !pushWallet.address) {
        throw new Error("No wallet available. Please connect your wallet.");
      }

      // Ensure PushChain SDK client is fully initialized before swapping.
      // The client may be null during the brief window between wallet connect
      // and SDK initialization. User sees "Cannot read property 'universal'"
      // if we proceed without this guard.
      if (pushWallet.isConnected && !pushWallet.pushChainClient) {
        throw new Error(
          "Wallet is still initializing. Please wait a moment and try again."
        );
      }

      // Get the current account - prefer PushChain universal account
      const currentAddress = pushWallet.address || (wallet ? (await wallet.getAddresses())?.[0] : null);

      if (!currentAddress) {
        throw new Error(
          "No wallet account available. Please connect your wallet.",
        );
      }

      // Check current chain ID and switch if needed
      // Skip for PushChain universal wallet — it handles cross-chain natively
      if (wallet && !pushWallet.isConnected) {
        try {
          const currentChainId = await wallet.getChainId();
          if (currentChainId !== expectedChainId) {
            console.log(`[MoleSwap] Chain mismatch: wallet on ${currentChainId}, need ${expectedChainId}. Auto-switching...`);

            // Chain configurations for auto-add (all supported chains)
            const chainConfigs: Record<number, any> = {
              // Robinhood Chain mainnet
              4663: {
                chainId: "0x1237",
                chainName: "Robinhood Chain",
                nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
                blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
              },
              // Ethereum Sepolia
              11155111: {
                chainId: "0xaa36a7",
                chainName: "Sepolia",
                nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://rpc.sepolia.org", "https://ethereum-sepolia.publicnode.com"],
                blockExplorerUrls: ["https://sepolia.etherscan.io"],
              },
              // Arbitrum Sepolia
              421614: {
                chainId: "0x66eee",
                chainName: "Arbitrum Sepolia",
                nativeCurrency: { name: "Arbitrum ETH", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia.publicnode.com"],
                blockExplorerUrls: ["https://sepolia.arbiscan.io"],
              },
              // Base Sepolia
              84532: {
                chainId: "0x14a34",
                chainName: "Base Sepolia",
                nativeCurrency: { name: "Base ETH", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://sepolia.base.org", "https://base-sepolia.publicnode.com"],
                blockExplorerUrls: ["https://sepolia.basescan.org"],
              },
              // BNB Testnet
              97: {
                chainId: "0x61",
                chainName: "BNB Smart Chain Testnet",
                nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
                rpcUrls: ["https://data-seed-prebsc-1-s1.binance.org:8545", "https://bsc-testnet.publicnode.com"],
                blockExplorerUrls: ["https://testnet.bscscan.com"],
              },
              // Ethereum Mainnet (for reference)
              1: {
                chainId: "0x1",
                chainName: "Ethereum Mainnet",
                nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://eth.llamarpc.com", "https://ethereum.publicnode.com"],
                blockExplorerUrls: ["https://etherscan.io"],
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
          if (!pushWallet.isConnected) {
            throw new Error(
              `Chain switch failed: ${chainError?.message || "Unknown error"}. Please switch to ${swapData.fromChain?.displayName || swapData.fromChain?.name || `chain ${expectedChainId}`} manually.`
            );
          }
          // PushChain wallet connected — skip chain check
          console.log("PushChain universal wallet — skipping chain check");
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

      // Clone quote and recursively replace all burn addresses with user's address
      const quote = JSON.parse(JSON.stringify(swapData.quote)); // Deep clone

      // Recursively replace all burn addresses in the quote object
      const replaceBurnAddresses = (obj: any): any => {
        if (obj === null || obj === undefined) return obj;

        if (typeof obj === "string") {
          // Replace string if it's a burn address
          return isBurnAddr(obj) ? currentAddress : obj;
        }

        if (Array.isArray(obj)) {
          return obj.map((item) => replaceBurnAddresses(item));
        }

        if (typeof obj === "object") {
          const result: any = {};
          for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
              const value = obj[key];

              // Special handling for common address fields
              if (
                (key.toLowerCase().includes("sender") ||
                  key.toLowerCase().includes("from") ||
                  key.toLowerCase().includes("user") ||
                  key.toLowerCase().includes("account")) &&
                typeof value === "string" &&
                isBurnAddr(value)
              ) {
                result[key] = currentAddress;
              } else if (typeof value === "string" && isBurnAddr(value)) {
                // Replace any string that matches burn address
                result[key] = currentAddress;
              } else {
                result[key] = replaceBurnAddresses(value);
              }
            }
          }
          return result;
        }

        return obj;
      };

      // Replace all burn addresses recursively
      const cleanedQuote = replaceBurnAddresses(quote);
      // Remove approval step from the quote so execute doesn't prompt a second, limited approval
      const isApprovalStep = (s: any) => {
        const name = (s?.name || s?.description || "").toString().toLowerCase();
        const type = (s?.type || s?.operation || "").toString().toLowerCase();
        const data =
          s?.transaction?.data || s?.tx?.data || s?.request?.data || "";
        return (
          name.includes("approv") ||
          type.includes("approv") ||
          (typeof data === "string" && data.startsWith("0x095ea7b3"))
        );
      };
      const filteredQuote = {
        ...cleanedQuote,
        steps: Array.isArray(cleanedQuote?.steps)
          ? cleanedQuote.steps.filter((s: any) => !isApprovalStep(s))
          : cleanedQuote?.steps,
      };

      // Debug: verify no burn addresses remain
      const quoteString = JSON.stringify(cleanedQuote);
      const hasBurnAddr = burnAddresses.some((ba) =>
        quoteString.toLowerCase().includes(ba.toLowerCase()),
      );
      if (hasBurnAddr) {
        // eslint-disable-next-line no-console
        console.warn("Warning: Burn address still found in cleaned quote");
      }

      let finalTxHashes: string[] = [];
      let hasStarted = false;
      // If approval is indicated by quote, verify on-chain allowance first.
      // Skip entirely for PushChain wallets — our executeSwap checks allowance
      // internally via the public RPC (no wallet prompt needed).
      if (!pushWallet.isConnected && needsApproval && approvalInfo) {
        try {
          const walletForCheck = await getWalletClient();
          if (!walletForCheck) throw new Error("No wallet available.");
          // ERC20 allowance(owner, spender)
          const erc20AllowanceAbi = [
            {
              type: "function",
              name: "allowance",
              stateMutability: "view",
              inputs: [
                { name: "owner", type: "address" },
                { name: "spender", type: "address" },
              ],
              outputs: [{ name: "remaining", type: "uint256" }],
            },
          ] as const;
          const currentAllowance = await (walletForCheck as any).readContract({
            address: approvalInfo.token as `0x${string}`,
            abi: erc20AllowanceAbi as any,
            functionName: "allowance",
            args: [currentAddress, approvalInfo.spender],
          });
          const allowanceBn = BigInt(
            currentAllowance?.toString?.() ?? currentAllowance ?? 0,
          );
          const needed =
            amountWei && amountWei !== "" ? BigInt(amountWei) : BigInt(0);
          if (allowanceBn >= needed) {
            setRequireApproval(false);
          } else {
            setRequireApproval(true);
          }
        } catch {
          // if allowance check fails, fall back to requiring approval
          setRequireApproval(true);
        }
      }

      // If approval required, perform it first
      // Skip for PushChain wallet — our executeSwap handles approval internally
      if (
        !pushWallet.isConnected &&
        needsApproval &&
        approvalInfo &&
        (requireApproval === null || requireApproval === true)
      ) {
        try {
          setApproving(true);
          const walletForApprove = await getWalletClient();
          if (!walletForApprove)
            throw new Error("No wallet available for approval.");
          // minimal ERC20 ABI for approve
          const erc20ApproveAbi = [
            {
              type: "function",
              name: "approve",
              stateMutability: "nonpayable",
              inputs: [
                { name: "spender", type: "address" },
                { name: "amount", type: "uint256" },
              ],
              outputs: [{ name: "", type: "bool" }],
            },
          ] as const;
          // Use decimal BigInt via constructor to avoid literal/exponentiation target issues
          const MAX_UINT256 = BigInt(
            "115792089237316195423570985008687907853269984665640564039457584007913129639935",
          );
          const hash = await (walletForApprove as any).writeContract({
            address: approvalInfo.token as `0x${string}`,
            abi: erc20ApproveAbi as any,
            functionName: "approve",
            // Always approve unlimited to avoid repeated approvals on future swaps
            args: [approvalInfo.spender, MAX_UINT256],
          });
          setApprovalHash(typeof hash === "string" ? hash : hash?.hash || null);
          if (typeof hash === "string") {
            await waitForReceipt(hash);
          } else if (hash?.hash) {
            await waitForReceipt(hash.hash);
          }
        } finally {
          setApproving(false);
        }
      }

      // Execute swap via PushChain AMM (3-step: wrap → approve → swap)
      onSwapStart?.();
      hasStarted = true;
      setCurrentStep("Preparing swap...");

      const { executeSwap: pushSwap, setWalletOriginChain } = await import("@/lib/pushchain/amm");

      // Tell amm.ts which origin chain the wallet is on, so sendTx can skip
      // direct EVM signing for Solana-origin wallets (Phantom) and go straight
      // to universal TX. Phantom injects window.ethereum but can't sign for 0xa475.
      setWalletOriginChain(
        (pushWallet as any)?.originChain ||
        (pushWallet as any)?.universalAccount?.chain ||
        null,
      );

      setCurrentStep("Preparing swap...");
      // Reset steps to the quote-derived list (wrap is only present if native input,
      // approve only if allowance insufficient, multi-hop has 4 steps, etc.)
      setSwapSteps(initialSwapSteps);

      // Custom recipient support: ExchangePage lets the user enter a
      // destination address distinct from their UEA. That value is piped
      // through `swapData.recipientAddress` (see ExchangePage.tsx:978). If
      // present AND it looks like a valid EVM hex, route the swap proceeds
      // there; otherwise default to the UEA so nothing silently sends to an
      // unintended address on malformed input.
      // Custom recipient support: ExchangePage pipes the user's typed
      // destination through swapData.recipientAddress. We split it into two
      // params for executeSwap:
      //   - `recipient`       = caller / UEA (used for approvals, balance
      //                         lookups, msg.sender anchor).
      //   - `outputRecipient` = optional custom destination; when set and
      //                         different from `recipient`, executeSwap
      //                         skips FeeRouter and routes via UniV3
      //                         SwapRouter directly (which accepts a
      //                         recipient param). Custom-recipient swaps
      //                         therefore skip the 0.25% house fee — the
      //                         niche-case trade-off documented in amm.ts.
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

      const swapResult = await pushSwap({
        pushChainClient: pushWallet.pushChainClient,
        tokenIn: swapData.fromToken,
        tokenOut: swapData.toToken,
        amountIn: swapData.quote?.amountIn || amountWei,
        amountOutMin: swapData.quote?.amountOut || "0",
        recipient: currentAddress,            // caller — always the UEA
        outputRecipient: customRecipient,     // optional; null → proceeds land at UEA
        fee: swapData.quote?.fee,
        // Pass origin chain — executeSwap uses this to pick between multicall
        // (1 sig for Phantom/MM-Sepolia cross-chain) vs sequential (N sigs
        // for Push-native EOAs). See RamenFi's sE orchestrator.
        originChain:
          (pushWallet as any)?.originChain ||
          (pushWallet as any)?.universalAccount?.chain ||
          null,
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

            // Multicall mode: executeSteps emits bundled labels like "Swap",
            // "Bridge & swap", "2-hop swap", "Bridge & 4-hop swap" etc.
            // These don't match quote.steps 1:1 because the multicall bundles
            // approve+swap+approve+swap into one signature. Collapse the UI
            // to show all steps transitioning together.
            const isBundledLabel =
              /^bridge\s*&/i.test(normalized) ||
              /^\d+-hop swap$/i.test(normalized) ||
              normalized.toLowerCase() === "swap" ||
              normalized.toLowerCase() === "bridge funds";

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
      // Pass originChain so analyzeError can detect Phantom "Signature request
      // failed" (classic Solana mainnet/devnet cluster mismatch) and surface
      // the concrete Phantom Testnet-Mode fix instead of a generic message.
      const originChainForErr =
        (pushWallet as any)?.originChain ||
        (pushWallet as any)?.universalAccount?.chain ||
        null;
      const analysis = diagnostics.analyzeError(error, { originChain: originChainForErr });
      console.error("Swap execution error:", error);
      console.log("[MoleSwap:Diagnostics] Error analysis:", analysis);

      // Log swap failure with timing
      diagnostics.logSwapResult({
        success: false,
        error: `[${analysis.category}] ${error?.message || "Unknown error"}`,
        durationMs: Date.now() - swapStartTime,
      });

      // Prefer the actionable suggestion (e.g. Phantom testnet-mode instructions)
      // over the raw SDK error, which for Solana failures is almost always the
      // unhelpful string "Signature request failed".
      const userFacing =
        analysis.category === "PHANTOM_REJECTED" || analysis.category === "WRONG_NETWORK"
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
                    {swapData.expectedOut || "0"}
                  </div>
                  {/* Destination label: the asset lands as a PRC-20 on Push
                      Chain (at the UEA or the custom recipient), NOT on the
                      origin chain. Previously read `on <toChain>` which lied
                      for bridged tokens like pETH (user got pETH on Push,
                      not native ETH on Ethereum). When outbound Route 2 is
                      wired, switch this back to toChain. */}
                  <div className="text-sm font-semibold text-stone-300">
                    {swapData.feesLabel || ""} •{" "}
                    {(swapData.toTokenMeta as any)?.symbol || displaySymbolOf(swapData.toTokenMeta, swapData.toToken)} on Robinhood Chain
                  </div>
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

          {/* Error Message — actionable messages (Phantom setup, balance) can be
              ~400 chars; don't truncate them. Short raw SDK strings are displayed as-is. */}
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
          {!pushWallet.isConnected && !pushWallet.isConnecting ? (
            <button
              onClick={() => pushWallet.connect?.()}
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
          ) : pushWallet.isConnecting ? (
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
          ) : !pushWallet.pushChainClient ? (
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
                {isExecuting
                  ? currentStep || "SWAPPING..."
                  : needsApproval
                    ? "APPROVE"
                    : "START SWAPPING"}
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
