"use client";
import React, { useState, useEffect, useRef } from "react";
import Image from "next/image";
import { LogOut, Copy, Check, ChevronDown } from "lucide-react";
import { usePushWalletContext, usePushChainClient, PushUI } from "@pushchain/ui-kit";
import { ChainSelectorButton } from "./ChainSelectorButton";

export function ConnectWalletButton() {
  const walletCtx = usePushWalletContext();
  const { pushChainClient } = usePushChainClient();
  const [copied, setCopied] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const connectionStatus = walletCtx?.connectionStatus;
  const isConnected = connectionStatus === PushUI.CONSTANTS.CONNECTION.STATUS.CONNECTED;
  const isConnecting = connectionStatus === PushUI.CONSTANTS.CONNECTION.STATUS.CONNECTING ||
                       connectionStatus === PushUI.CONSTANTS.CONNECTION.STATUS.AUTHENTICATING;

  const universalAccount = walletCtx?.universalAccount;
  const address = universalAccount?.address || pushChainClient?.universal?.account || null;
  const shortAddress = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";

  const handleConnect = () => {
    walletCtx?.handleConnectToPushWallet?.();
  };

  const handleDisconnect = () => {
    walletCtx?.handleUserLogOutEvent?.();
    setShowMenu(false);
  };

  const copyAddress = async () => {
    if (address) {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Close dropdown on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showMenu]);

  // Dispatch wallet event for ExchangePage compatibility
  useEffect(() => {
    if (isConnected && address && typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("walletConnected", { detail: { address } })
      );
    }
  }, [isConnected, address]);

  // --- DISCONNECTED ---
  if (!isConnected) {
    return (
      <button
        onClick={handleConnect}
        disabled={isConnecting}
        className="font-family-ThaleahFat flex cursor-pointer items-center gap-3 px-6 py-3 text-xl tracking-wider text-black transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60"
      >
        <Image
          src="/profile/Wallet.png"
          alt="Wallet"
          width={28}
          height={28}
          className="h-7 w-7"
        />
        <span>{isConnecting ? "CONNECTING..." : "CONNECT WALLET"}</span>
      </button>
    );
  }

  // --- CONNECTED ---
  return (
    <div className="flex items-center">
      {/* Chain network selector */}
      <ChainSelectorButton />

      {/* Vertical divider */}
      <div className="mx-0.5 h-6 w-px bg-[#523525]" />

      {/* Wallet address + dropdown */}
      <div className="relative" ref={menuRef}>
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="font-family-ThaleahFat flex cursor-pointer items-center gap-2 px-5 py-3 text-xl tracking-wider text-black transition-all hover:scale-[1.02]"
      >
        <Image
          src="/profile/Wallet.png"
          alt="Wallet"
          width={24}
          height={24}
          className="h-6 w-6"
        />
        <span>{shortAddress}</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${showMenu ? "rotate-180" : ""}`} />
      </button>

      {/* Dropdown */}
      {showMenu && (
        <div className="bg-ground absolute right-0 top-full z-[200] mt-2 w-72 rounded-lg border-3 border-[#523525] shadow-[4px_4px_0_#000] animate-pop-up">
          {/* Account info */}
          <div className="border-b-2 border-[#523525] px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-green-400" />
              <span className="font-family-ThaleahFat text-peach-300 text-sm tracking-wider">
                PUSHCHAIN {walletCtx?.config?.network === PushUI.CONSTANTS.PUSH_NETWORK.MAINNET ? "MAINNET" : "TESTNET"}
              </span>
            </div>
            <p className="font-family-ThaleahFat text-peach-300 mt-1 text-lg tracking-wider break-all">
              {address}
            </p>
          </div>

          {/* Copy address */}
          <button
            onClick={copyAddress}
            className="font-family-ThaleahFat text-peach-300 flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-lg tracking-wider transition-all hover:bg-[#523525]"
          >
            {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
            <span>{copied ? "COPIED!" : "COPY ADDRESS"}</span>
          </button>

          {/* Disconnect */}
          <button
            onClick={handleDisconnect}
            className="font-family-ThaleahFat flex w-full cursor-pointer items-center gap-3 rounded-b-lg px-4 py-3 text-lg tracking-wider text-red-400 transition-all hover:bg-[#523525]"
          >
            <LogOut className="h-4 w-4" />
            <span>DISCONNECT</span>
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
