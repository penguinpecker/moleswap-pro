"use client";
import React, { useState, useEffect, useRef } from "react";
import { LogOut, Copy, Check, ChevronDown, Wallet } from "lucide-react";
import { useWallet } from "@/lib/chain/provider";

export function ConnectWalletButton() {
  const { address, isConnected, isConnecting, onRH, switchToRH, connectWith, wallets, disconnect } =
    useWallet();
  const [copied, setCopied] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const shortAddress = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";

  const handleDisconnect = () => {
    disconnect();
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
      window.dispatchEvent(new CustomEvent("walletConnected", { detail: { address } }));
    }
  }, [isConnected, address]);

  // --- DISCONNECTED ---
  if (!isConnected) {
    return (
      <>
        <button
          onClick={() => setShowPicker(true)}
          disabled={isConnecting}
          className="ctl primary"
          style={isConnecting ? { opacity: 0.6 } : undefined}
        >
          {isConnecting ? "Connecting…" : "Connect wallet"}
        </button>

        {showPicker && (
          <div
            className="cm-scrim"
            style={{ opacity: 1 }}
            onClick={() => setShowPicker(false)}
          >
            <div
              className="cm-panel animate-pop-in"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="cm-head">
                <h2>Connect a wallet</h2>
                <button className="cm-x" onClick={() => setShowPicker(false)} aria-label="Close">
                  ✕
                </button>
              </div>
              <div className="cm-body">
                {wallets.length === 0 && (
                  <p className="cm-note" style={{ padding: "14px 0" }}>
                    No wallet detected. Install MetaMask, Rabby, or Coinbase Wallet.
                  </p>
                )}
                {wallets.map((c) => (
                  <button
                    key={c.uid}
                    onClick={async () => {
                      setShowPicker(false);
                      await connectWith(c);
                    }}
                    className="wal-row"
                  >
                    {c.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.icon} alt={c.name} className="h-6 w-6 rounded" />
                    ) : (
                      <span className="wal-ic">
                        <Wallet size={20} />
                      </span>
                    )}
                    <span>{c.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // --- CONNECTED, WRONG NETWORK ---
  if (!onRH) {
    return (
      <button onClick={switchToRH} className="ctl primary">
        <Wallet size={15} />
        <span>Switch to Robinhood</span>
      </button>
    );
  }

  // --- CONNECTED ---
  return (
    <div className="wal-wrap">
      {/* Wallet address + dropdown. The wrong-network case is handled above by the
          "Switch to Robinhood" state, so no separate chain pill is needed here. */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setShowMenu(!showMenu)}
          className={`wal-addr ${showMenu ? "open" : ""}`}
        >
          {shortAddress}
          <ChevronDown className="chev" size={12} />
        </button>

        {showMenu && (
          <div className="wal-drop animate-pop-in" style={{ display: "block" }}>
            <div className="wd-net">
              <span className="dot on" />
              Robinhood Chain
            </div>
            <div className="wd-full">{address}</div>

            <button onClick={copyAddress} className={`wd-row ${copied ? "copied" : ""}`}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
              <span>{copied ? "Copied!" : "Copy address"}</span>
            </button>

            <button onClick={handleDisconnect} className="wd-row danger">
              <LogOut size={13} />
              <span>Disconnect</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
