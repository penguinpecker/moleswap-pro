"use client";
import { ArrowLeft } from "lucide-react";
import { DappStep } from ".";
import { MoleMascot } from "../shared";
import type { TokenEntry, ChainEntry } from "@/lib/chain/tokenList";

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

interface SwapSuccessPageProps {
  onNext: (step: DappStep, data?: any) => void;
  swapData: any;
}

export const SwapSuccessPage = ({ onNext, swapData }: SwapSuccessPageProps) => {
  const handleTxnInfo = () => {
    onNext("transaction-info", swapData);
  };

  const handleDone = () => {
    onNext("exchange");
  };

  // Calculate tickets based on swap amount (4 tickets for successful swap)
  const ticketsReceived = 4;

  // Get actual values from swap data.
  // Output always lands on Robinhood Chain.
  const expectedOut = swapData.expectedOut || "0";
  const feesLabel = swapData.feesLabel || "";
  const toTokenSymbol = swapData.toTokenMeta?.symbol || swapData.toToken || "";
  const toChainName = "Robinhood Chain";

  // Calculate percentage change (placeholder for now, could be calculated from rate)
  const percentageChange = "+0.31%";

  // Calculate USD value from expectedOut (simplified - could use actual price API)
  // For now, if it's USDC/USDT, the amount is approximately the USD value
  const isStablecoin =
    toTokenSymbol?.toUpperCase() === "USDC" ||
    toTokenSymbol?.toUpperCase() === "USDT";
  const usdValue = isStablecoin
    ? expectedOut
    : parseFloat(expectedOut).toFixed(2);

  return (
    <main>
      <div className="dapp-col" style={{ maxWidth: 560 }}>
        {/* Header with back button */}
        <div className="pick-head" style={{ marginBottom: 14 }}>
          <button
            onClick={() => onNext("transaction-info")}
            className="tool-btn"
            aria-label="Back"
          >
            <ArrowLeft size={16} />
          </button>
          <h2 style={{ margin: 0, fontSize: "1.3rem", fontWeight: 800, color: "var(--p-onbg)" }}>
            Exchange
          </h2>
        </div>

        <div className="p-card center">
          {/* Success visual — the drawn mole + green check */}
          <div className="suc-visual">
            <MoleMascot className="suc-mole" />
            <div className="suc-check" style={{ marginTop: -18 }}>
              <svg
                width="34"
                height="34"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </div>
          </div>

          {/* Success Message */}
          <h2 style={{ margin: "14px 0 0", fontSize: "1.7rem", fontWeight: 800, letterSpacing: "-.02em" }}>
            Swap successful
          </h2>
          <p className="d" style={{ marginTop: 10 }}>
            This transaction has been successfully processed.
            <br />
            Please check the transaction info for more details.
            <br />
            Thanks for using Moleswap!
          </p>

          {/* Token Amount */}
          <div className="rv-row" style={{ marginTop: 18, textAlign: "left" }}>
            <TokenCircle
              logo={
                swapData.toTokenMeta?.logoURI ||
                swapData.toChain?.iconUrl ||
                swapData.toChain?.logoUrl ||
                ""
              }
              symbol={toTokenSymbol}
            />
            <div>
              <div className="rv-amt">{expectedOut}</div>
              <div className="rv-sub">
                ${usdValue} • {percentageChange} • {toTokenSymbol} on{" "}
                {toChainName}
              </div>
              <div className="rv-sub">
                ETA:{" "}
                {(swapData.etaSeconds ?? null) !== null
                  ? `${swapData.etaSeconds}s`
                  : "-"}
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="sheet-actions" style={{ marginTop: 18 }}>
            <button
              onClick={handleTxnInfo}
              className="ctl"
              style={{ justifyContent: "center" }}
            >
              Txn info
            </button>
            <button
              onClick={handleDone}
              className="ctl primary"
              style={{ justifyContent: "center" }}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </main>
  );
};
