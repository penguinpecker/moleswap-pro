"use client";
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  Fuel,
  RefreshCw,
} from "lucide-react";
import { DappStep } from ".";
import { useState } from "react";

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
    <main>
      <div className="dapp-col" style={{ maxWidth: 620 }}>
        {/* Header with back button */}
        <div className="pick-head" style={{ marginBottom: 14 }}>
          <button onClick={onBack} className="tool-btn" aria-label="Back">
            <ArrowLeft size={16} />
          </button>
          <h2 style={{ margin: 0, fontSize: "1.3rem", fontWeight: 800, color: "var(--p-onbg)" }}>
            Txn info
          </h2>
        </div>

        <div className="p-card">
          {/* From */}
          <div className="rv-row">
            <TokenCircle
              logo={
                swapData.fromTokenMeta?.logoURI ||
                swapData.fromChain?.iconUrl ||
                swapData.fromChain?.logoUrl ||
                ""
              }
              symbol={swapData.fromTokenMeta?.symbol || swapData.fromToken}
            />
            <div>
              <div className="rv-amt">{swapData.amount || "0"}</div>
              <div className="rv-sub">
                {swapData.fromTokenMeta?.symbol || swapData.fromToken} on{" "}
                {swapData.fromChain?.displayName ||
                  swapData.fromChain?.name ||
                  "Robinhood Chain"}
              </div>
            </div>
            <span className="rv-eta">
              ETA: {swapData.etaSeconds ? `${swapData.etaSeconds}s` : "-"}
            </span>
          </div>

          {/* Route — one clean row per split, with the token path and its venue */}
          <div className="route-h" style={{ marginTop: 16 }}>
            Route
          </div>
          {Array.isArray(swapData.routes) && swapData.routes.length > 0 ? (
            <div>
              {swapData.routes.map((r: any, i: number) => (
                <div key={i} className="route-row">
                  <span className="pct">{r.pct}%</span>
                  <span className="path">
                    {(r.pathTokens || []).map((t: any, j: number) => (
                      <span
                        key={j}
                        style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                      >
                        {j > 0 && <span className="sep">›</span>}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={t.logo}
                          alt={t.symbol}
                          width={16}
                          height={16}
                          style={{ width: 16, height: 16, borderRadius: "50%" }}
                        />
                        <span>{t.symbol}</span>
                      </span>
                    ))}
                  </span>
                  <span className="ven">{r.venues}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="rv-mid" style={{ padding: "7px 0" }}>
              <span style={{ fontSize: 16 }} aria-hidden="true">
                🔄
              </span>
              <span>{swapData.routeLabel || "Auto route"}</span>
            </div>
          )}

          {/* Status */}
          <div className="stat-badges">
            <span className="sb">
              <span className="ck">✓</span>CHAIN SWITCHED
            </span>
            <span className="sb">
              <span className="ck">✓</span>SWAP COMPLETED
            </span>
          </div>

          {/* To */}
          <div className="rv-row">
            <TokenCircle
              logo={
                swapData.toTokenMeta?.logoURI ||
                swapData.toChain?.iconUrl ||
                swapData.toChain?.logoUrl ||
                ""
              }
              symbol={swapData.toTokenMeta?.symbol || swapData.toToken}
            />
            <div>
              <div className="rv-amt">{swapData.expectedOut || "0"}</div>
              <div className="rv-sub">
                {swapData.feesLabel || ""} •{" "}
                {swapData.toTokenMeta?.symbol || swapData.toToken} on Robinhood
                Chain
              </div>
            </div>
          </div>

          {/* Rate / fee strip */}
          <div className="rv-strip">
            <span>
              {swapData.rateLabel ||
                `1 ${swapData.fromTokenMeta?.symbol || swapData.fromToken} = ${swapData.expectedOut || "0"} ${swapData.toTokenMeta?.symbol || swapData.toToken}`}
            </span>
            <span>
              <Fuel size={13} style={{ display: "inline", verticalAlign: "-2px" }} />{" "}
              {swapData.feesLabel || "<$0.01"} ETA:{" "}
              {swapData.etaSeconds ? `${swapData.etaSeconds}s` : "-"}
            </span>
          </div>

          {/* Transfer ID */}
          <div className="tid-panel">
            <span className="tid-tag">Transfer ID</span>
            <div className="tid-tools">
              <button
                onClick={copyTransactionId}
                className="tool-btn"
                title="Copy transfer id"
                aria-label="Copy transfer id"
              >
                {copied ? (
                  <Check size={14} style={{ color: "var(--moss)" }} />
                ) : (
                  <Copy size={14} />
                )}
              </button>
              <button
                onClick={openTransactionExplorer}
                className="tool-btn"
                title="View on explorer"
                aria-label="View on explorer"
              >
                <ExternalLink size={14} />
              </button>
            </div>
            <div className="tid-hash">
              {txId
                ? (txId.length > 66 ? `${txId.slice(0, 20)}...${txId.slice(-20)}` : txId)
                : "No transaction ID"}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="sheet-actions" style={{ marginTop: 18 }}>
            {txId && (
              <button
                onClick={openTransactionExplorer}
                className="ctl"
                style={{ justifyContent: "center" }}
              >
                <ExternalLink size={15} /> View on explorer
              </button>
            )}
            <button
              onClick={() => onNext("exchange")}
              className="ctl primary"
              style={{ justifyContent: "center" }}
            >
              <RefreshCw size={15} /> Swap again
            </button>
          </div>
        </div>
      </div>
    </main>
  );
};
