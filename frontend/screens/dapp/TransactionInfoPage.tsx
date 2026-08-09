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
    return `https://robinhoodchain.blockscout.com/tx/${txId}`;
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
                    <div className="text-sm font-semibold text-stone-300">{swapData.fromTokenMeta?.symbol || swapData.fromToken} on {swapData.fromChain?.displayName || swapData.fromChain?.name || "Robinhood Chain"}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-yellow-100">ETA: {swapData.etaSeconds ? `${swapData.etaSeconds}s` : "-"}</div>
                </div>
              </div>
            </div>
            {/* Route — one clean row per split, with the token path and its venue */}
            <div className="px-4">
              <div className="mb-1 flex items-center gap-2">
                <div className="border-ground-button-border bg-ground-button flex h-8 w-8 items-center justify-center rounded-lg border-2">
                  <span className="text-sm">🔄</span>
                </div>
                <span className="font-family-ThaleahFat text-lg tracking-wider text-zinc-100 uppercase">Route</span>
              </div>
              {Array.isArray(swapData.routes) && swapData.routes.length > 0 ? (
                <div className="space-y-1 pl-1">
                  {swapData.routes.map((r: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 text-xs sm:text-sm">
                      <span className="w-9 shrink-0 font-bold text-yellow-100">{r.pct}%</span>
                      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                        {(r.pathTokens || []).map((t: any, j: number) => (
                          <span key={j} className="flex items-center gap-1">
                            {j > 0 && <span className="text-[#7a7a7a]">›</span>}
                            <img src={t.logo} alt={t.symbol} width={16} height={16} className="h-4 w-4 rounded-full" />
                            <span className="text-stone-200">{t.symbol}</span>
                          </span>
                        ))}
                      </span>
                      <span className="shrink-0 text-right text-[#9a9a9a]">{r.venues}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="font-family-ThaleahFat pl-1 text-lg text-zinc-100">{swapData.routeLabel || "AUTO ROUTE"}</div>
              )}
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

                  <div className="text-sm font-semibold text-stone-300">{swapData.feesLabel || ""} • {swapData.toTokenMeta?.symbol || swapData.toToken} on Robinhood Chain</div>
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
