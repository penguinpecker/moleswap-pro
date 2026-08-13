"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { parseUnits, formatUnits, type Address } from "viem";
import { BackgroundImage, NavBar, MoleMascot } from "../shared";
import { useWallet } from "@/lib/chain/provider";
import { WETH, USDG } from "@/lib/mole/chain";
import { createOrder, cancelOrder, getOrders, type MoleOrder } from "@/lib/mole/orders";

const TOKENS = [WETH, USDG];
type Mode = "dca" | "limit";

const FREQS: { label: string; secs: number }[] = [
  { label: "HOURLY", secs: 3600 },
  { label: "EVERY 6H", secs: 21600 },
  { label: "DAILY", secs: 86400 },
  { label: "WEEKLY", secs: 604800 },
];

/** Render-only coin-chip colours for the pinned pair (fallback: loam). */
const COIN_COLORS: Record<string, string> = { WETH: "#627eea", USDG: "#1c74d4" };
const coinBg = (sym: string) => COIN_COLORS[sym] ?? "#8a5c33";

function metaOf(addr: string) {
  return TOKENS.find((t) => t.address.toLowerCase() === addr.toLowerCase());
}
function fmtRaw(v: bigint, addr: string) {
  const d = metaOf(addr)?.decimals ?? 18;
  const s = formatUnits(v, d);
  return s.includes(".") ? s.replace(/(\.\d{0,6})\d*$/, "$1").replace(/\.?0+$/, "") || "0" : s;
}
function symOf(addr: string) {
  return metaOf(addr)?.symbol ?? `${addr.slice(0, 6)}…`;
}

export default function OrdersScreen({ mode }: { mode: Mode }) {
  const { address, isConnected, onRH } = useWallet();
  const isDca = mode === "dca";

  // DCA: pay `payIdx` → buy the other, total over N legs at a frequency.
  // Limit: sell `payIdx` → receive the other when 1 pay >= `price` receive.
  const [payIdx, setPayIdx] = useState(1); // default: pay USDG
  const [total, setTotal] = useState("");
  const [legs, setLegs] = useState("10");
  const [freqIdx, setFreqIdx] = useState(2); // daily
  const [price, setPrice] = useState(""); // limit: receive-per-pay
  const [orders, setOrders] = useState<MoleOrder[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const payTok = TOKENS[payIdx];
  const recvTok = TOKENS[payIdx === 0 ? 1 : 0];

  const refresh = useCallback(async () => {
    if (!address) return setOrders([]);
    try {
      setOrders(await getOrders(address));
    } catch {
      setOrders([]);
    }
  }, [address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const preview = useMemo(() => {
    try {
      if (isDca) {
        const n = Math.max(1, parseInt(legs) || 0);
        const totalWei = total ? parseUnits(total, payTok.decimals) : 0n;
        if (totalWei <= 0n) return null;
        const perLeg = totalWei / BigInt(n);
        if (perLeg <= 0n) return null;
        return { perLeg, totalWei, n, minOut: 1n, interval: FREQS[freqIdx].secs };
      }
      const amtWei = total ? parseUnits(total, payTok.decimals) : 0n;
      const px = Number(price);
      if (amtWei <= 0n || !(px > 0)) return null;
      // minOut (receive units) = amount(pay, human) * price
      const minOut = parseUnits((Number(total) * px).toFixed(recvTok.decimals), recvTok.decimals);
      return { perLeg: amtWei, totalWei: amtWei, n: 1, minOut, interval: 0 };
    } catch {
      return null;
    }
  }, [isDca, total, legs, freqIdx, price, payTok.decimals, recvTok.decimals]);

  const onCreate = async () => {
    if (!preview || busy || !isConnected || !onRH) return;
    setBusy(true);
    setStatus("");
    const r = await createOrder({
      tokenIn: payTok.address as Address,
      tokenOut: recvTok.address as Address,
      amountPerLeg: preview.perLeg,
      totalBudget: preview.totalWei,
      minOutPerLeg: preview.minOut < 1n ? 1n : preview.minOut,
      intervalSeconds: preview.interval,
      onStep: setStatus,
    });
    setStatus(r.success ? `Order #${r.orderId} created — the keeper will execute it.` : r.error || "Failed");
    if (r.success) {
      setTotal("");
      setPrice("");
      refresh();
    }
    setBusy(false);
  };

  const onCancel = async (id: string) => {
    setBusy(true);
    setStatus(`Cancelling #${id}…`);
    const r = await cancelOrder(id);
    setStatus(r.success ? `Cancelled #${id}.` : r.error || "Failed");
    setBusy(false);
    refresh();
  };

  const cta = !isConnected
    ? "Connect wallet"
    : !onRH
      ? "Switch to Robinhood"
      : busy
        ? "Working…"
        : !preview
          ? "Enter details"
          : isDca
            ? "Start DCA"
            : "Place limit order";

  return (
    <>
      <BackgroundImage isLoading={false} />
      <NavBar />

      <main>
        <header className="hero">
          <h1>{isDca ? "DCA." : "Limit orders."}</h1>
          <p className="sub">
            {isDca
              ? "Auto-buy on a schedule · non-custodial · a keeper executes, it can’t touch your funds."
              : "Swap when the price hits your target · non-custodial · your floor is enforced on-chain."}
          </p>
          <MoleMascot />
        </header>

        <section className="p-grid p-side">
          <div>
            {/* Create card */}
            <div className="p-card">
              <h3>{isDca ? "+ New DCA" : "+ New limit order"}</h3>

              {/* Pair */}
              <div style={{ marginTop: 14 }}>
                <div className="minilbl">{isDca ? "Pay with" : "Sell"}</div>
                <div className="payrow">
                  <div className="tok-toggle">
                    {TOKENS.map((t, i) => (
                      <button
                        key={t.symbol}
                        onClick={() => setPayIdx(i)}
                        data-on={payIdx === i ? "true" : "false"}
                      >
                        <span
                          className="coin"
                          style={{ background: coinBg(t.symbol), width: 22, height: 22, fontSize: 8, borderWidth: 0 }}
                        >
                          {t.symbol.slice(0, 2).toUpperCase()}
                        </span>
                        {t.symbol}
                      </button>
                    ))}
                  </div>
                  <span className="recv">
                    → {isDca ? "BUY" : "RECEIVE"} {recvTok.symbol}
                  </span>
                </div>
              </div>

              {/* Amount */}
              <div className="p-field" style={{ marginTop: 12 }}>
                <div className="lbl">
                  <span>{isDca ? `Total to spend (${payTok.symbol})` : `Amount to sell (${payTok.symbol})`}</span>
                </div>
                <div className="amt">
                  <input
                    className="big"
                    value={total}
                    onChange={(e) => setTotal(e.target.value.replace(/[^0-9.]/g, ""))}
                    placeholder="0.0"
                    inputMode="decimal"
                    aria-label={isDca ? "Total to spend" : "Amount to sell"}
                  />
                  <span className="p-mini" style={{ flex: "none", color: "var(--p-card-ink-3)", fontWeight: 700 }}>
                    {payTok.symbol}
                  </span>
                </div>
              </div>

              {isDca ? (
                <div className="p-grid p-2" style={{ marginTop: 12 }}>
                  <div className="p-field">
                    <div className="lbl">
                      <span>Number of orders</span>
                    </div>
                    <div className="amt">
                      <input
                        className="big"
                        value={legs}
                        onChange={(e) => setLegs(e.target.value.replace(/[^0-9]/g, ""))}
                        placeholder="10"
                        inputMode="numeric"
                        aria-label="Number of orders"
                      />
                    </div>
                  </div>
                  <div className="p-field">
                    <div className="lbl">
                      <span>Frequency</span>
                    </div>
                    <div className="p-chipset" style={{ marginTop: 13 }}>
                      {FREQS.map((f, i) => (
                        <button key={f.label} onClick={() => setFreqIdx(i)} data-on={freqIdx === i ? "true" : "false"}>
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-field" style={{ marginTop: 12 }}>
                  <div className="lbl">
                    <span>Target price — receive at least</span>
                  </div>
                  <div className="amt">
                    <input
                      className="big"
                      value={price}
                      onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                      placeholder="0.0"
                      inputMode="decimal"
                      aria-label="Target price"
                    />
                    <span className="p-mini" style={{ flex: "none", color: "var(--p-card-ink-3)", fontWeight: 700 }}>
                      {recvTok.symbol} per {payTok.symbol}
                    </span>
                  </div>
                </div>
              )}

              {/* Summary */}
              {preview && (
                <div className="sum-box">
                  <div className="p-rows">
                    {isDca ? (
                      <>
                        <div className="p-row">
                          <span className="k">Per order</span>
                          <span className="v">{fmtRaw(preview.perLeg, payTok.address)} {payTok.symbol}</span>
                        </div>
                        <div className="p-row">
                          <span className="k">Orders</span>
                          <span className="v">{preview.n} × {FREQS[freqIdx].label.toLowerCase()}</span>
                        </div>
                        <div className="p-row">
                          <span className="k">Price floor</span>
                          <span className="v">MARKET (keeper slippage-guards each fill)</span>
                        </div>
                        <div className="p-row">
                          <span className="k">Custody</span>
                          <span className="v pos">NON-CUSTODIAL · OUTPUT → YOU</span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="p-row">
                          <span className="k">You sell</span>
                          <span className="v">{total} {payTok.symbol}</span>
                        </div>
                        <div className="p-row">
                          <span className="k">Fills when</span>
                          <span className="v">≥ {fmtRaw(preview.minOut, recvTok.address)} {recvTok.symbol}</span>
                        </div>
                        <div className="p-row">
                          <span className="k">Floor</span>
                          <span className="v pos">ENFORCED ON-CHAIN</span>
                        </div>
                        <div className="p-row">
                          <span className="k">Custody</span>
                          <span className="v pos">NON-CUSTODIAL · OUTPUT → YOU</span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              <button className="p-btn" onClick={onCreate} disabled={busy || !isConnected || !onRH || !preview}>
                {cta}
              </button>
              {status && <div className="statline">{status}</div>}
            </div>
          </div>

          <div>
            {/* Orders list */}
            <div className="p-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                <h3>Your orders</h3>
                <button
                  className="linkish"
                  onClick={refresh}
                  style={{ textDecoration: "none", fontSize: 12.5 }}
                >
                  ⟳ REFRESH
                </button>
              </div>
              {!isConnected ? (
                <div className="p-empty" style={{ padding: "26px 10px" }}>Connect a wallet to see your orders.</div>
              ) : orders.length === 0 ? (
                <div className="p-empty" style={{ padding: "26px 10px" }}>No orders yet.</div>
              ) : (
                <div>
                  {orders.map((o) => {
                    const pct = o.totalBudget > 0n ? Number((o.spent * 100n) / o.totalBudget) : 0;
                    const isLimit = o.interval === 0;
                    return (
                      <div key={o.id} className="ord-row">
                        <div className="ord-main">
                          <div className="t1">
                            #{o.id} · {symOf(o.tokenIn)} → {symOf(o.tokenOut)} · {isLimit ? "LIMIT" : "DCA"}
                          </div>
                          <div className="t2">
                            {fmtRaw(o.spent, o.tokenIn)} / {fmtRaw(o.totalBudget, o.tokenIn)} {symOf(o.tokenIn)} filled ({pct}%)
                            {isLimit ? ` · floor ${fmtRaw(o.minOutPerLeg, o.tokenOut)} ${symOf(o.tokenOut)}` : ` · every ${Math.round(o.interval / 3600)}h`}
                          </div>
                          <div className="p-bar thin" style={{ marginTop: 9 }}>
                            <i className="pos" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                        <div className="ord-side">
                          <span className={`p-pill ${o.active ? "pos" : "mute"}`}>{o.active ? "ACTIVE" : "DONE"}</span>
                          {o.active && (
                            <button className="cancel-btn" onClick={() => onCancel(o.id)} disabled={busy}>
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="p-card" style={{ marginTop: 14 }}>
              <h3>How it works</h3>
              <p className="d">
                {isDca
                  ? "Fund a budget once; the keeper executes one leg per interval at market, with each fill slippage-guarded. The contract only lets it run your exact order — output goes straight to your wallet, and cancelling returns whatever hasn’t been spent."
                  : "Your order sits on-chain with a floor price. The keeper can only fill it at or above your floor — enforced by the contract, not by policy. Output goes straight to your wallet, and cancelling returns whatever hasn’t been spent."}
              </p>
            </div>
          </div>
        </section>
      </main>

      {/* page: orders (dca / limit twins) — from the Burrow prototype */}
      <style jsx global>{`
        .tok-toggle { display: flex; gap: 8px; }
        .tok-toggle button {
          flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
          border: 1px solid var(--p-card-line); background: var(--p-field); color: var(--p-card-ink-2);
          font: inherit; font-size: 14px; font-weight: 700; padding: 10px 12px; border-radius: 14px; cursor: pointer;
        }
        .tok-toggle button[data-on="true"] { border-color: var(--moss); background: rgba(47,125,79,.1); color: #1e6b40; }
        .minilbl { font-size: 11px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: var(--p-card-ink-3); }
        .payrow { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
        .payrow .tok-toggle { flex: 1; }
        .recv { flex: none; font-family: var(--font-num); font-size: 13px; font-weight: 700; color: var(--p-card-ink-3); letter-spacing: .02em; }
        .sum-box { margin-top: 12px; padding: 2px 14px; border-radius: var(--r-md); background: rgba(255,255,255,.55); border: 1px solid rgba(44,26,12,.08); }
        .ord-row { display: flex; align-items: flex-start; gap: 12px; padding: 13px 14px; margin-top: 8px;
          border-radius: var(--r-md); background: rgba(255,255,255,.55); border: 1px solid rgba(44,26,12,.08); }
        .ord-row .t1 { font-size: 14.5px; font-weight: 800; font-family: var(--font-num); letter-spacing: -.01em; }
        .ord-row .t2 { font-size: 11.5px; color: var(--ink-3); margin-top: 3px; }
        .ord-main { flex: 1; min-width: 0; }
        .ord-side { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; flex: none; }
        .cancel-btn { border: 0; cursor: pointer; font: inherit; font-size: 12px; font-weight: 800;
          letter-spacing: .06em; text-transform: uppercase; color: #fff; background: linear-gradient(180deg, #d9584a, var(--rust));
          padding: 7px 14px; border-radius: 12px; box-shadow: 0 2px 0 #7e2415, inset 0 1px 0 rgba(255,255,255,.35); }
        .cancel-btn:disabled { opacity: .6; cursor: default; }
        .cancel-btn:not(:disabled):active { transform: translateY(1px); box-shadow: 0 1px 0 #7e2415; }
        .p-btn:disabled { opacity: .5; cursor: default; }
        .p-btn:disabled:active { transform: none; }
      `}</style>
    </>
  );
}
