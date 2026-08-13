"use client";
import React from "react";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";

const Settings = ({
  setShowSettings,
}: {
  setShowSettings: React.Dispatch<React.SetStateAction<boolean>>;
}) => {
  const showReceive = true;
  const router = useRouter();
  const onBack = () => router.back();
  const [expandedCard, setExpandedCard] = React.useState<string | null>(null);
  const [routePriority, setRoutePriority] = React.useState("BEST RETURN");
  const [maxSlippage, setMaxSlippage] = React.useState("AUTO");
  const [gasPrice, setGasPrice] = React.useState("NORMAL");

  const toggleCard = (cardId: string) => {
    setExpandedCard(expandedCard === cardId ? null : cardId);
  };

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", width: "100%" }}>
      {/* Header */}
      <div className="pick-head" style={{ marginBottom: 14 }}>
        <button
          className="tool-btn"
          onClick={() => setShowSettings(false)}
          aria-label="Back"
        >
          <ArrowLeft size={16} />
        </button>
        <h2
          style={{
            margin: 0,
            fontSize: "1.3rem",
            fontWeight: 800,
            color: "var(--p-onbg)",
          }}
        >
          Settings
        </h2>
      </div>

      {/* Settings cards */}
      <div className="p-grid">
        {/* Route Priority */}
        <div
          className="p-card tight set-card"
          onClick={() => toggleCard("route")}
        >
          <div className="sc-top">
            <span className="ic" aria-hidden="true">
              🧭
            </span>
            <h3>Route Priority</h3>
            <span className="cur">
              {expandedCard === "route" ? "" : routePriority}
            </span>
          </div>
          {expandedCard === "route" && (
            <div className="set-seg">
              <button
                data-on={routePriority === "BEST RETURN"}
                onClick={(e) => {
                  e.stopPropagation();
                  setRoutePriority("BEST RETURN");
                }}
              >
                BEST RETURN
              </button>
              <button
                data-on={routePriority === "FASTEST"}
                onClick={(e) => {
                  e.stopPropagation();
                  setRoutePriority("FASTEST");
                }}
              >
                FASTEST
              </button>
            </div>
          )}
        </div>

        {/* Max Slippage */}
        <div
          className="p-card tight set-card"
          onClick={() => toggleCard("slippage")}
        >
          <div className="sc-top">
            <span className="ic" aria-hidden="true">
              ➗
            </span>
            <h3>Max Slippage</h3>
            <span className="cur">
              {expandedCard === "slippage" ? "" : maxSlippage}
            </span>
          </div>
          {expandedCard === "slippage" && (
            <div className="set-seg">
              <button
                data-on={maxSlippage === "AUTO"}
                onClick={(e) => {
                  e.stopPropagation();
                  setMaxSlippage("AUTO");
                }}
              >
                AUTO
              </button>
              <button
                data-on={maxSlippage === "0.5"}
                onClick={(e) => {
                  e.stopPropagation();
                  setMaxSlippage("0.5");
                }}
              >
                0.5
              </button>
            </div>
          )}
        </div>

        {/* Gas Price */}
        <div
          className="p-card tight set-card"
          onClick={() => toggleCard("gas")}
        >
          <div className="sc-top">
            <span className="ic" aria-hidden="true">
              ⛽
            </span>
            <h3>Gas Price</h3>
            <span className="cur">{expandedCard === "gas" ? "" : gasPrice}</span>
          </div>
          {expandedCard === "gas" && (
            <div className="set-seg">
              <button
                data-on={gasPrice === "SLOW"}
                onClick={(e) => {
                  e.stopPropagation();
                  setGasPrice("SLOW");
                }}
              >
                SLOW
              </button>
              <button
                data-on={gasPrice === "NORMAL"}
                onClick={(e) => {
                  e.stopPropagation();
                  setGasPrice("NORMAL");
                }}
              >
                NORMAL
              </button>
              <button
                data-on={gasPrice === "FAST"}
                onClick={(e) => {
                  e.stopPropagation();
                  setGasPrice("FAST");
                }}
              >
                FAST
              </button>
            </div>
          )}
        </div>

        {/* Bridges */}
        <div className="p-card tight set-card">
          <div className="sc-top">
            <span className="ic" aria-hidden="true">
              🌉
            </span>
            <h3>Bridges</h3>
            <span className="cur">20/20</span>
          </div>
        </div>

        {/* Exchanges */}
        <div className="p-card tight set-card">
          <div className="sc-top">
            <span className="ic" aria-hidden="true">
              🔁
            </span>
            <h3>Exchanges</h3>
            <span className="cur">16/16</span>
          </div>
        </div>
      </div>

      <style>{`
        .pick-head { display: flex; align-items: center; gap: 12px; }
        .tool-btn {
          width: 34px; height: 34px; border-radius: 11px; cursor: pointer; display: grid; place-items: center;
          background: var(--p-chip); border: 1px solid var(--p-card-line); color: var(--p-card-ink-2);
          box-shadow: var(--p-card-sh);
        }
        .tool-btn:active { transform: scale(.94); }
        .set-card { cursor: pointer; }
        .set-card .sc-top { display: flex; align-items: center; gap: 12px; }
        .set-card .sc-top .ic { width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center; background: var(--p-accent-soft); font-size: 17px; flex: none; }
        .set-card .sc-top h3 { flex: 1; }
        .set-card .cur { font-size: 12px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; color: var(--p-card-ink-3); }
        .set-seg { display: flex; gap: 6px; margin-top: 14px; }
        .set-seg button {
          flex: 1; border: 1px solid var(--p-card-line); background: var(--p-field); color: var(--p-card-ink-2);
          font: inherit; font-size: 12px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase;
          padding: 9px 10px; border-radius: 12px; cursor: pointer;
        }
        .set-seg button[data-on="true"] { background: var(--amber); color: #3d2410; border-color: transparent; }
      `}</style>
    </div>
  );
};

export default Settings;
