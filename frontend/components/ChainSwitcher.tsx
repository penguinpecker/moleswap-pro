"use client";
/**
 * Chain switcher — Robinhood Chain ⇄ Arc.
 *
 * Sits in the chrome to the left of the wallet button. Three states, and the distinction matters:
 *
 *   connected + supported    the pill shows the chain the WALLET is on, and picking another asks the
 *                            wallet to switch. The wallet is the truth here, never local state.
 *   connected + unsupported  an explicit "Wrong network" pill rather than quietly rendering
 *                            Robinhood, because every contract address on screen would be wrong.
 *   disconnected             the pill shows the preferred chain, and picking one records it so the
 *                            next connect lands there instead of snapping back to Robinhood.
 *
 * Styling reuses the chrome's existing pill/dropdown idiom (.wal-addr, .wal-drop) so it reads as one
 * control group with the wallet button rather than a bolted-on widget.
 */
import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, AlertTriangle } from "lucide-react";
import { useWallet } from "@/lib/chain/provider";
import { readPreferredChainId, writePreferredChainId } from "@/lib/chain/provider";
import { SUPPORTED_CHAINS, RH_CHAIN, type ChainMeta } from "@/lib/chain/chains";

export function ChainSwitcher() {
  const { isConnected, activeChain, onSupportedChain, switchTo } = useWallet();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  // Only consulted while disconnected. Seeded after mount so the server and the first client render
  // agree — reading localStorage during render would hydrate-mismatch.
  const [preferred, setPreferred] = useState<ChainMeta>(RH_CHAIN);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = readPreferredChainId();
    const found = SUPPORTED_CHAINS.find((c) => c.id === id);
    if (found) setPreferred(found);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const wrongNetwork = isConnected && !onSupportedChain;
  // Connected: the wallet decides. Disconnected: the stored preference does.
  const shown: ChainMeta | null = wrongNetwork ? null : isConnected ? (activeChain ?? null) : preferred;

  const pick = async (c: ChainMeta) => {
    setOpen(false);
    writePreferredChainId(c.id);
    setPreferred(c);
    if (!isConnected) return; // nothing to switch yet — the preference is the whole effect
    if (activeChain?.id === c.id) return;
    setPending(c.id);
    try {
      await switchTo(c.id);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="chain-sw" ref={ref}>
      <button
        type="button"
        className={`chain-pill ${open ? "open" : ""} ${wrongNetwork ? "warn" : ""}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={wrongNetwork ? "Wrong network — choose a network" : `Network: ${shown?.name ?? ""}`}
      >
        {wrongNetwork ? (
          <>
            <AlertTriangle size={14} />
            <span className="chain-name">Wrong network</span>
          </>
        ) : (
          <>
            <span className="chain-mark" style={{ ["--mk" as string]: shown?.accent }} aria-hidden="true">
              {shown?.mark}
            </span>
            <span className="chain-name">{shown?.shortName}</span>
          </>
        )}
        <ChevronDown className="chev" size={12} />
      </button>

      {open && (
        <div className="wal-drop chain-drop animate-pop-in" role="listbox">
          <div className="wd-net">
            <span className="dot on" />
            Network
          </div>
          {SUPPORTED_CHAINS.map((c) => {
            const active = isConnected ? activeChain?.id === c.id : preferred.id === c.id;
            return (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={active}
                className={`wd-row chain-row ${active ? "active" : ""}`}
                onClick={() => pick(c)}
                disabled={pending !== null}
              >
                <span className="chain-mark" style={{ ["--mk" as string]: c.accent }} aria-hidden="true">
                  {c.mark}
                </span>
                <span className="chain-row-text">
                  <span className="chain-row-name">{c.name}</span>
                  <span className="chain-row-sub">
                    {pending === c.id ? "Confirm in wallet…" : `Gas in ${c.nativeSymbol}`}
                  </span>
                </span>
                {active && <Check size={14} className="chain-tick" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
