"use client";
import {
  ArrowDown,
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  Fuel,
  RefreshCw,
} from "lucide-react";
import { DappStep } from ".";
import Image from "next/image";
import { useState } from "react";

interface TransactionInfoPageProps {
  onNext: (step: DappStep, data?: any) => void;
  onBack: () => void;
  swapData: any;
}

export const TransactionInfoPage = ({
  onNext,
  onBack,
  swapData,
}: TransactionInfoPageProps) => {
  const [copied, setCopied] = useState(false);

  const getTxId = () => {
    const raw =
      swapData.transactionId ||
      (swapData.txHashes && swapData.txHashes.length > 0
        ? swapData.txHashes[swapData.txHashes.length - 1]
        : "");
    if (raw && typeof raw === "object") {
      return raw.hash || raw.txHash || raw.transactionHash || raw.tx?.hash || raw.receipt?.transactionHash || JSON.stringify(raw);
    }
    return raw || "";
  };

  const txId = getTxId();

  const getExplorerUrl = () => {
    if (!txId) return "";
    const chainId = swapData.toChain?.id || 42101;
    if (chainId === 8453) return `https://basescan.org/tx/${txId}`;
    if (chainId === 42161) return `https://arbiscan.io/tx/${txId}`;
    if (chainId === 10) return `https://optimistic.etherscan.io/tx/${txId}`;
    if (chainId === 137) return `https://polygonscan.com/tx/${txId}`;
    if (chainId === 56) return `https://bscscan.com/tx/${txId}`;
    if (chainId === 1) return `https://etherscan.io/tx/${txId}`;
    return `https://donut.push.network/tx/${txId}`;
  };

  const copyTransactionId = () => {
    if (txId) {
      navigator.clipboard.writeText(txId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const openTransactionExplorer = () => {
    const url = getExplorerUrl();
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  // ── Bridge-out external settlement info ─────────────────────────────────
  // When the swap triggered an auto bridge-out, SwapPage forwards these three
  // fields. bridgeOutExternalTxHash is the actual destination-chain tx hash
  // (e.g. an Etherscan-viewable ETH transfer on Sepolia), which is what the
  // user cares about — it proves real funds landed on their home chain.
  const bridgeOutTxHash: string | undefined = swapData.bridgeOutTxHash;
  const bridgeOutExternalTxHash: string | undefined = swapData.bridgeOutExternalTxHash;
  const bridgeOutChainLabel: string | undefined = swapData.bridgeOutChainLabel;
  const bridgeOutOriginSymbol: string | undefined = swapData.bridgeOutOriginSymbol;

  // Map the UI label we received to the right block explorer base URL.
  // These are all testnets per the current SDK's MOVEABLE_TOKEN registry
  // (Sepolia / Arbitrum Sepolia / Base Sepolia / BNB Testnet / Solana Devnet).
  const getBridgeOutExplorerUrl = (): string | null => {
    if (!bridgeOutExternalTxHash) return null;
    const label = (bridgeOutChainLabel || "").toLowerCase();
    if (label === "ethereum")
      return `https://sepolia.etherscan.io/tx/${bridgeOutExternalTxHash}`;
    if (label === "arbitrum")
      return `https://sepolia.arbiscan.io/tx/${bridgeOutExternalTxHash}`;
    if (label === "base")
      return `https://sepolia.basescan.org/tx/${bridgeOutExternalTxHash}`;
    if (label === "bnb chain")
      return `https://testnet.bscscan.com/tx/${bridgeOutExternalTxHash}`;
    if (label === "solana")
      // Solana Devnet requires explicit ?cluster=devnet
      return `https://solscan.io/tx/${bridgeOutExternalTxHash}?cluster=devnet`;
    return null;
  };

  const copyBridgeOutHash = () => {
    if (!bridgeOutExternalTxHash) return;
    navigator.clipboard.writeText(bridgeOutExternalTxHash);
  };

  const openBridgeOutExplorer = () => {
    const url = getBridgeOutExplorerUrl();
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="flex w-full flex-1 flex-col p-2 sm:max-w-3xl sm:p-6">
      {/* Header */}
      <div className="font-family-ThaleahFat relative top-[40px] z-10 mx-auto flex w-[85%] items-center justify-center rounded-lg px-6 py-4 text-center">
        <button onClick={onBack} className="border-ground-button-border bg-ground-button absolute left-4 cursor-pointer justify-center rounded border-2 p-1 text-yellow-100 hover:scale-105">
          <ArrowLeft className="h-6 w-6 text-yellow-100" />
        </button>
        <h1 className="text-peach-300 text-shadow-header mx-auto text-3xl font-bold tracking-widest uppercase sm:text-5xl">TXN INFO</h1>
        <Image src="/quest/header-quest-bg.png" alt="BG" width={200} height={200} className="absolute inset-0 left-0 z-[-1] h-full w-full" />
      </div>

      <div className="relative mb-6 block h-full">
        <Image src="/quest/Quest-BG.png" alt="BG" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full object-fill" />
        <div className="relative z-50 mx-auto mt-12 mb-6 grid w-full grid-cols-1 gap-4 p-4 sm:w-[85%]">
          {/* Swap details card */}
          <div className="relative mb-2 space-y-4 p-4">
            <Image src="/dapp/start-swaping-info-box.png" alt="BG" width={200} height={200} className="absolute inset-0 left-0 z-[-1] h-full w-full" />
            {/* From */}
            <div className="px-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <div className="border-ground-button-border bg-ground-button mr-3 flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border-2">
                    <Image src={swapData.fromTokenMeta?.logoURI || swapData.fromChain?.iconUrl || swapData.fromChain?.logoUrl || "/placeholder-logo.png"} alt="From" width={40} height={40} className="h-full w-full object-cover" />
                  </div>
                  <div>
                    <div className="font-family-ThaleahFat text-3xl text-zinc-100">{swapData.amount || "0"}</div>
                    <div className="text-sm font-semibold text-stone-300">{swapData.fromTokenMeta?.symbol || swapData.fromToken} on {swapData.fromChain?.displayName || swapData.fromChain?.name || "Push Chain"}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-yellow-100">ETA: {swapData.etaSeconds ? `${swapData.etaSeconds}s` : "-"}</div>
                </div>
              </div>
            </div>
            {/* Swap via */}
            <div className="px-4">
              <div className="flex items-center">
                <div className="border-ground-button-border bg-ground-button mr-3 flex h-10 w-10 items-center justify-center rounded-lg border-2 p-4">
                  <span className="font-bold text-white">🔄</span>
                </div>
                <div><div className="font-family-ThaleahFat text-2xl text-zinc-100">{swapData.routeLabel || "AUTO ROUTE"}</div></div>
                <div className="ml-auto">
                  <button className="border-ground-button-border bg-ground-button cursor-pointer justify-center rounded border-2 p-1 text-yellow-100 hover:scale-105">
                    <ArrowDown className="z-10 h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
            {/* Status */}
            <div className="flex justify-between gap-4 px-4">
              <div className="flex items-center">
                <span className="mr-2"><Image src="/dapp/Check-mark.png" alt="OK" width={40} height={40} /></span>
                <span className="text-sm font-semibold text-[#9AEC32]">CHAIN SWITCHED</span>
              </div>
              <div className="flex items-center">
                <span className="mr-2"><Image src="/dapp/Check-mark.png" alt="OK" width={40} height={40} /></span>
                <span className="text-sm font-semibold text-[#9AEC32]">SWAP COMPLETED</span>
              </div>
            </div>
            {/* To */}
            <div className="px-4">
              <div className="flex items-center">
                <div className="border-ground-button-border bg-ground-button mr-3 flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border-2">
                  <Image src={swapData.toTokenMeta?.logoURI || swapData.toChain?.iconUrl || swapData.toChain?.logoUrl || "/placeholder-logo.png"} alt="To" width={40} height={40} className="h-full w-full object-cover" />
                </div>
                <div>
                  <div className="font-family-ThaleahFat text-3xl text-zinc-100">{swapData.expectedOut || "0"}</div>
                  {/* Output always lands as PRC-20 on Push Chain (no outbound
                      bridge wired). Labelled directly so the transaction-info
                      card matches what actually happens on-chain. */}
                  <div className="text-sm font-semibold text-stone-300">{swapData.feesLabel || ""} • {swapData.toTokenMeta?.symbol || swapData.toToken} on Push Chain</div>
                </div>
              </div>
            </div>
          </div>

          {/* Fee info */}
          <div className="relative z-50 mb-4 p-4">
            <div className="flex w-full justify-between gap-4 px-4 py-1 max-sm:flex-col sm:items-center">
              <div className="text-sm font-semibold text-stone-300">
                {swapData.rateLabel || `1 ${swapData.fromTokenMeta?.symbol || swapData.fromToken} = ${swapData.expectedOut || "0"} ${swapData.toTokenMeta?.symbol || swapData.toToken}`}
              </div>
              <div className="ml-auto text-sm text-yellow-200">
                <Fuel className="inline-block h-4 w-4" /> {swapData.feesLabel || "<$0.01"} ETA: {swapData.etaSeconds ? `${swapData.etaSeconds}s` : "-"}
              </div>
            </div>
            <Image src="/quest/header-quest-bg.png" alt="BG" width={200} height={200} className="absolute inset-0 left-0 z-[-1] h-full w-full" />
          </div>

          {/* Transfer ID */}
          <div className="relative z-50 mb-2 p-4">
            <div className="relative flex w-full items-center justify-between gap-4 px-4 py-1">
              <label className="bg-ground-button-border font-family-ThaleahFat text-peach-300 absolute top-[-2rem] left-4 mb-2 block px-2 text-2xl uppercase">
                TRANSFER ID
              </label>
              <div className="absolute top-[-2rem] right-4 flex items-center gap-2">
                <button onClick={copyTransactionId} className="bg-ground-button-border ml-2 cursor-pointer p-2 hover:opacity-80">
                  {copied ? <Check className="h-4 w-4 text-[#9AEC32]" /> : <Copy className="h-4 w-4 text-yellow-100" />}
                </button>
                <button onClick={openTransactionExplorer} className="bg-ground-button-border ml-2 cursor-pointer p-2 hover:opacity-80">
                  <ExternalLink className="h-4 w-4 text-yellow-100" />
                </button>
              </div>
              <div className="my-4 flex flex-1 items-center font-mono text-sm break-all text-yellow-100">
                {txId
                  ? (txId.length > 66 ? `${txId.slice(0, 20)}...${txId.slice(-20)}` : txId)
                  : "No transaction ID"}
              </div>
            </div>
            <Image src="/quest/header-quest-bg.png" alt="BG" width={200} height={200} className="absolute inset-0 left-0 z-[-1] h-full w-full" />
          </div>

          {/* Bridge-out external settlement: shown only when the swap flow
              also bridged the output to the user's home chain. This surfaces
              the REAL tx hash on Sepolia/Arbitrum/BNB/Solana so the user has
              direct proof of delivery that their native wallet will also
              show. Without this, users would only see the Push Chain tx and
              have to manually check their origin wallet to confirm receipt. */}
          {bridgeOutExternalTxHash && (
            <div className="relative z-50 mb-2 p-4">
              <div className="relative flex w-full items-center justify-between gap-4 px-4 py-1">
                <label className="bg-ground-button-border font-family-ThaleahFat text-peach-300 absolute top-[-2rem] left-4 mb-2 block px-2 text-2xl uppercase">
                  DELIVERED ON {bridgeOutChainLabel || "ORIGIN"}
                </label>
                <div className="absolute top-[-2rem] right-4 flex items-center gap-2">
                  <button onClick={copyBridgeOutHash} className="bg-ground-button-border ml-2 cursor-pointer p-2 hover:opacity-80">
                    <Copy className="h-4 w-4 text-yellow-100" />
                  </button>
                  <button onClick={openBridgeOutExplorer} className="bg-ground-button-border ml-2 cursor-pointer p-2 hover:opacity-80">
                    <ExternalLink className="h-4 w-4 text-yellow-100" />
                  </button>
                </div>
                <div className="my-4 flex flex-1 flex-col font-mono text-sm break-all text-yellow-100">
                  <span className="font-family-ThaleahFat text-xs tracking-wider text-[#7DD3FC] uppercase">
                    Arrived as {bridgeOutOriginSymbol || "asset"} on {bridgeOutChainLabel || "origin chain"}
                  </span>
                  <span className="mt-1">
                    {bridgeOutExternalTxHash.length > 66
                      ? `${bridgeOutExternalTxHash.slice(0, 20)}...${bridgeOutExternalTxHash.slice(-20)}`
                      : bridgeOutExternalTxHash}
                  </span>
                </div>
              </div>
              <Image src="/quest/header-quest-bg.png" alt="BG" width={200} height={200} className="absolute inset-0 left-0 z-[-1] h-full w-full" />
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3">
            {txId && (
              <button onClick={openTransactionExplorer} className="relative z-50 flex-1 cursor-pointer rounded py-4 text-xl font-bold text-white transition-all hover:scale-105">
                <span className="flex items-center justify-center gap-2"><ExternalLink className="h-5 w-5" /> VIEW ON EXPLORER</span>
                <Image src="/dapp/connect-wallet.png" alt="BG" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full object-fill" />
              </button>
            )}
            <button onClick={() => onNext("exchange")} className="relative z-50 flex-1 cursor-pointer rounded py-4 text-xl font-bold text-white transition-all hover:scale-105">
              <span className="flex items-center justify-center gap-2"><RefreshCw className="h-5 w-5" /> SWAP AGAIN</span>
              <Image src="/dapp/connect-wallet.png" alt="BG" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full object-fill" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
