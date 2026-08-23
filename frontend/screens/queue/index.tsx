"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseUnits, formatUnits } from "viem";
import { BackgroundImage, NavBar, MoleMascot } from "../shared";
import { useWallet } from "@/lib/chain/provider";
import { WETH, USDG } from "@/lib/mole/chain";
import { QueuePhase, secondsUntilCutoff, type QueueSchedule, type EpochState } from "@/lib/mole/queue";
// The batch crosses at the TWAP, so the clock shows the TWAP it will cross at — through the ONE
// staleness helper, with the shared stale badge when the observation series has not advanced.
import { useOracleHealth } from "@/lib/mole/useOracleHealth";
import { usdPerWethFromTick } from "@/lib/mole/oracle";
import { OracleStaleBadge } from "../shared/OracleStale";
import {
  getQueueSchedule,
  getEpoch,
  getUserOrders,
  placeOrder,
  cancelOrder,
  claimOrder,
  settleEpoch,
  timeoutEpoch,
  type UserOrderView,
} from "@/lib/mole/queueClient";

const PHASE_LABEL: Record<number, string> = {
  [QueuePhase.Open]: "OPEN",
  [QueuePhase.Frozen]: "FROZEN",
  [QueuePhase.Settled]: "SETTLED",
  [QueuePhase.Refunding]: "REFUNDING",
};

function mmss(secs: number): string {
  const s = Math.max(0, secs);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

// side true = sell WETH for USDG (zeroForOne); false = sell USDG for WETH.
function escrowToken(zeroForOne: boolean) {
  return zeroForOne ? WETH : USDG;
}
function outputToken(zeroForOne: boolean) {
  return zeroForOne ? USDG : WETH;
}

export default function QueuePage() {
  const { address, isConnected, onRH, connect, switchToRH } = useWallet();
  const [schedule, setSchedule] = useState<(QueueSchedule & { maxResidualSlippageBps: number }) | null>(null);
  const [epoch, setEpochState] = useState<EpochState | null>(null);
  const [orders, setOrders] = useState<UserOrderView[]>([]);
  const [side, setSide] = useState(true); // true = WETH -> USDG
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [nowTick, setNowTick] = useState(Math.floor(Date.now() / 1000));
  const [loading, setLoading] = useState(true);
  const { oracle } = useOracleHealth();

  const nowRef = useRef(nowTick);
  nowRef.current = nowTick;

  // Always the freshest connection state, readable from inside an awaited handler (see onPrimary).
  const connectedRef = useRef(isConnected);
  connectedRef.current = isConnected;

  const load = useCallback(async () => {
    try {
      const sch = await getQueueSchedule();
      setSchedule(sch);
      setEpochState(await getEpoch(sch.currentEpoch));
      if (address) setOrders(await getUserOrders(address));
      else setOrders([]);
    } catch {
      /* leave prior state */
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    load();
    const p = setInterval(load, 15000);
    return () => clearInterval(p);
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setNowTick(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const secLeft = useMemo(
    () => (schedule ? secondsUntilCutoff(schedule, BigInt(nowTick)) : 0),
    [schedule, nowTick],
  );
  const escrow = escrowToken(side);
  const output = outputToken(side);

  const amountWei = useMemo(() => {
    try {
      return amount ? parseUnits(amount, escrow.decimals) : 0n;
    } catch {
      return 0n;
    }
  }, [amount, escrow.decimals]);

  const run = async (label: string, fn: () => Promise<any>) => {
    setBusy(true);
    setStatus(label);
    const r = await fn();
    setStatus(r?.success ? `${label.replace(/…$/, "")} — ${r.txHash?.slice(0, 10)}…` : r?.error || "Failed");
    setBusy(false);
    load();
  };

  const onPlace = () =>
    run(`Placing ${amount} ${escrow.symbol}…`, async () => {
      const r = await placeOrder(side, amountWei);
      if (r.success) setAmount("");
      return r;
    });

  // Primary CTA dispatcher. The label promises "Connect wallet" / "Switch to Robinhood" in
  // those states, so the click has to do exactly that — it used to call onPlace regardless,
  // which hit placeOrder's "Enter an amount" guard (or a raw wallet error with an amount
  // typed) and never opened a wallet. Same mechanism the swap screens use: useWallet()'s
  // connect / switchToRH.
  const onPrimary = async () => {
    if (!isConnected) {
      setStatus("Connecting wallet…");
      setBusy(true);
      try {
        await connect();
        // connect() swallows a rejected/absent connector (provider.tsx) and resolves with nothing, so
        // the only honest signal is whether an account actually arrived. Read it from a ref: wagmi
        // updates the rendered value while this call is awaited; the captured `isConnected` cannot.
        // Without this, a visitor with no wallet installed clicks and sees nothing happen at all.
        await new Promise((r) => setTimeout(r, 300));
        setStatus(
          connectedRef.current
            ? ""
            : "No wallet connected. Install or unlock a browser wallet, then try again.",
        );
      } catch {
        setStatus("Wallet connection failed");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!onRH) {
      setStatus("Switching to Robinhood Chain…");
      setBusy(true);
      try {
        const switched = await switchToRH();
        setStatus(switched ? "" : "Network switch declined");
      } catch {
        setStatus("Network switch failed");
      } finally {
        setBusy(false);
      }
      return;
    }
    return onPlace();
  };

  const cta = !isConnected
    ? "Connect wallet"
    : !onRH
      ? "Switch to Robinhood"
      : busy
        ? "Working…"
        : amountWei <= 0n
          ? "Enter an amount"
          : secLeft <= 0
            ? "Place order (starts new epoch)"
            : "Place order";

  return (
    <>
      <BackgroundImage isLoading={false} />
      <NavBar />

      <main>
        <div className="narrow">
          <header className="hero">
            <h1>Batch queue.</h1>
            <p className="sub">
              Submit an intent, not a swap. At the cutoff, opposing orders cross at the TWAP — no slippage,
              no LP fee — and only the net residual hits the pool. Being first in line is worth nothing.
            </p>
            <MoleMascot />
          </header>

          {/* Epoch status */}
          <div className="p-card epoch-card">
            <div>
              <div className="ep-num">EPOCH #{schedule ? schedule.currentEpoch.toString() : "—"}</div>
              <div style={{ marginTop: 8 }}>
                <span className={`p-pill ${epoch && epoch.phase === QueuePhase.Open ? "pos" : "mute"}`}>
                  {epoch ? PHASE_LABEL[epoch.phase] : loading ? "loading…" : "—"}
                </span>
              </div>
            </div>
            <div className="ep-right">
              <div className="ep-k">Cutoff in</div>
              <div className={`ep-clock ${secLeft <= 10 ? "urgent" : ""}`}>{mmss(secLeft)}</div>
              {/* The price this batch crosses at, with its age. A stale TWAP is the last tick, extended. */}
              <div className="ep-twap">
                <span className="ep-k">TWAP</span>
                <span className="mono">
                  {oracle?.mid != null ? `$${usdPerWethFromTick(oracle.mid).toFixed(2)}` : "—"}
                </span>
                {oracle?.stale && <OracleStaleBadge ageSec={oracle.ageSec} />}
              </div>
            </div>
          </div>

          {/* Place order */}
          <div className="p-card" style={{ marginTop: 14 }}>
            <h3>Place order</h3>
            <div className="tok-toggle" style={{ marginTop: 14 }}>
              {[true, false].map((s) => (
                <button key={String(s)} data-on={side === s ? "true" : "false"} onClick={() => setSide(s)}>
                  {s ? "WETH → USDG" : "USDG → WETH"}
                </button>
              ))}
            </div>
            <div className="p-field" style={{ marginTop: 12 }}>
              <div className="lbl">
                <span>Amount</span>
              </div>
              <div className="amt">
                <input
                  className="big"
                  placeholder="0.0"
                  inputMode="decimal"
                  aria-label="Order amount"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                />
                <span className="p-mini" style={{ flex: "none", color: "var(--p-card-ink-3)", fontWeight: 700 }}>
                  {escrow.symbol}
                </span>
              </div>
            </div>
            <p className="d" style={{ marginTop: 10 }}>
              You escrow {escrow.symbol}; you receive {output.symbol} at settlement. Cancel any time before the cutoff.
            </p>
            <button
              className="p-btn"
              onClick={onPrimary}
              disabled={busy || (isConnected && onRH && amountWei <= 0n)}
            >
              {cta}
            </button>
            {status && <div className="statline">{status}</div>}
          </div>

          {/* Your orders */}
          <div className="p-card" style={{ marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
              <h3>Your orders</h3>
              <button onClick={load} className="linkish" style={{ textDecoration: "none", fontSize: "12.5px" }}>
                ⟳ REFRESH
              </button>
            </div>
            {!isConnected ? (
              <div className="p-empty" style={{ padding: "26px 10px" }}>Connect a wallet to see your orders.</div>
            ) : orders.length === 0 ? (
              <div className="p-empty" style={{ padding: "26px 10px" }}>No orders yet.</div>
            ) : (
              <div>
                {orders.map((o, i) => {
                  const esc = escrowToken(o.zeroForOne);
                  const out = outputToken(o.zeroForOne);
                  const canSettle = o.exit.kind === "waitForSettlement" && nowTick >= Number(o.exit.readyAt);
                  const canTimeout = o.exit.kind === "waitForTimeout";
                  return (
                    <div
                      key={`${o.epoch}-${o.index}`}
                      className="ord-row"
                      style={{ animationDelay: `${Math.min(i, 6) * 45}ms` }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div className="t1">
                          #{o.epoch.toString()}·{o.index.toString()} · {o.zeroForOne ? "WETH→USDG" : "USDG→WETH"} · {PHASE_LABEL[o.phase]}
                        </div>
                        <div className="t2">
                          escrow {formatUnits(o.amountIn, esc.decimals)} {esc.symbol}
                          {o.phase === QueuePhase.Settled && o.crossedBps > 0 ? ` · ${(o.crossedBps / 100).toFixed(1)}% crossed` : ""}
                        </div>
                        {(o.claimable.bought > 0n || o.claimable.refunded > 0n) && (
                          <div className="claim-line">
                            claim {formatUnits(o.claimable.bought, out.decimals)} {out.symbol}
                            {o.claimable.refunded > 0n ? ` + ${formatUnits(o.claimable.refunded, esc.decimals)} ${esc.symbol}` : ""}
                          </div>
                        )}
                      </div>
                      <div className="act-col">
                        {o.exit.kind === "cancel" && (
                          <button className="act-btn cancel" disabled={busy} onClick={() => run(`Cancelling…`, () => cancelOrder(o.epoch, o.index))}>Cancel</button>
                        )}
                        {o.exit.kind === "claim" && (
                          <button className="act-btn claim" disabled={busy} onClick={() => run(`Claiming…`, () => claimOrder(o.epoch, o.index))}>Claim</button>
                        )}
                        {o.exit.kind === "waitForSettlement" && !canSettle && (
                          <span className="settles">settles in {mmss(Number(o.exit.readyAt) - nowTick)}</span>
                        )}
                        {canSettle && (
                          <button className="act-btn settle" disabled={busy} onClick={() => run(`Settling…`, () => settleEpoch(o.epoch))}>Settle</button>
                        )}
                        {canTimeout && (
                          <>
                            <button className="act-btn settle" disabled={busy} onClick={() => run(`Settling…`, () => settleEpoch(o.epoch))}>Settle</button>
                            <button className="act-btn reclaim" disabled={busy} onClick={() => run(`Reclaiming…`, () => timeoutEpoch(o.epoch))}>Reclaim</button>
                          </>
                        )}
                        {o.exit.kind === "none" && <span className="paid">paid out</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </main>

      <style jsx global>{`
        /* page: queue */
        .narrow { max-width: 620px; margin: 0 auto; }

        .epoch-card { display: flex; justify-content: space-between; align-items: center; gap: 14px; }
        .ep-num { font-family: var(--font-num); font-variant-numeric: tabular-nums; font-size: 1.4rem; font-weight: 700; letter-spacing: -.02em; }
        .ep-k { font-size: 11px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--p-card-ink-3); }
        .ep-right { text-align: right; }
        .ep-clock { margin-top: 4px; font-family: var(--font-num); font-variant-numeric: tabular-nums;
          font-size: 1.7rem; font-weight: 700; letter-spacing: -.02em; color: var(--clay); }
        .ep-clock.urgent { color: var(--rust); }
        .ep-twap { margin-top: 6px; display: flex; justify-content: flex-end; align-items: center; gap: 8px;
          font-family: var(--font-num); font-variant-numeric: tabular-nums; font-size: 12.5px; font-weight: 700; }

        .tok-toggle { display: flex; gap: 8px; }
        .tok-toggle button {
          flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
          border: 1px solid var(--p-card-line); background: var(--p-field); color: var(--p-card-ink-2);
          font: inherit; font-size: 14px; font-weight: 700; padding: 10px 12px; border-radius: 14px; cursor: pointer;
        }
        .tok-toggle button[data-on="true"] { border-color: var(--moss); background: rgba(47,125,79,.1); color: #1e6b40; }

        .ord-row { display: flex; align-items: center; gap: 12px; padding: 13px 14px; margin-top: 8px;
          border-radius: var(--r-md); background: rgba(255,255,255,.55); border: 1px solid rgba(44,26,12,.08);
          animation: rise .35s ease both; }
        @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        .ord-row .t1 { font-size: 14px; font-weight: 800; font-family: var(--font-num); letter-spacing: -.01em; }
        .ord-row .t2 { font-size: 11.5px; color: var(--ink-3); margin-top: 3px; font-family: var(--font-num); }
        .claim-line { margin-top: 3px; font-family: var(--font-num); font-size: 12.5px; font-weight: 700; color: var(--moss); }

        .act-col { margin-left: auto; flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
        .act-btn { flex: none; border: 0; cursor: pointer; font: inherit; font-size: 12px; font-weight: 800;
          letter-spacing: .06em; text-transform: uppercase; padding: 9px 16px; border-radius: 12px; color: #fff; }
        .act-btn:disabled { opacity: .6; cursor: default; }
        .act-btn:not(:disabled):active { transform: translateY(1px); }
        .act-btn.cancel { background: linear-gradient(180deg, #d9584a, var(--rust)); box-shadow: 0 2px 0 #7e2415, inset 0 1px 0 rgba(255,255,255,.35); }
        .act-btn.cancel:not(:disabled):active { box-shadow: 0 1px 0 #7e2415; }
        .act-btn.claim { background: linear-gradient(180deg, #43a86f, var(--moss)); box-shadow: 0 2px 0 #1c5636, inset 0 1px 0 rgba(255,255,255,.35); }
        .act-btn.claim:not(:disabled):active { box-shadow: 0 1px 0 #1c5636; }
        .act-btn.settle { background: linear-gradient(180deg, #ffcd7d, var(--amber)); color: #3d2410; box-shadow: 0 2px 0 #8c5a14, inset 0 1px 0 rgba(255,255,255,.4); }
        .act-btn.settle:not(:disabled):active { box-shadow: 0 1px 0 #8c5a14; }
        .act-btn.reclaim { background: transparent; color: var(--ink-3); border: 1px solid rgba(44,26,12,.18); box-shadow: none; }
        .paid { flex: none; font-size: 12px; font-weight: 700; color: var(--ink-3); }
        .settles { flex: none; font-family: var(--font-num); font-variant-numeric: tabular-nums;
          font-size: 12px; font-weight: 700; color: var(--ink-3); white-space: nowrap; }
      `}</style>
    </>
  );
}
