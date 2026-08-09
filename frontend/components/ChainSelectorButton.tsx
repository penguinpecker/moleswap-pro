"use client";
import React from "react";
import { useWallet } from "@/lib/chain/provider";

/**
 * Network badge. MoleSwap runs on a single chain (Robinhood Chain 4663), so this is no longer a
 * cross-chain switcher — it's a small status pill. The file kept its name/export so callers are
 * unchanged. If the wallet is on the wrong network the ConnectWalletButton surfaces the switch action.
 */
export function ChainSelectorButton() {
  const { isConnected, onRH } = useWallet();
  if (!isConnected) return null;

  return (
    <div
      className="font-family-ThaleahFat flex items-center gap-1.5 px-3 py-3 text-lg tracking-wider text-black sm:text-xl"
      title="Connected to Robinhood Chain"
    >
      <span className={`h-2 w-2 rounded-full ${onRH ? "bg-green-500" : "bg-yellow-500"}`} />
      <span className="hidden sm:inline">RH</span>
    </div>
  );
}
