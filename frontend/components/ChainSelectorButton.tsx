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
    <span className="chain-pill" title="Connected to Robinhood Chain">
      <span className={`dot ${onRH ? "on" : ""}`} />
      <span className="hide-sm">RH</span>
    </span>
  );
}
