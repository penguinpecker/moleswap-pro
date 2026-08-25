"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { NavBar, BackgroundImage, MoleMascot } from "../shared";
import { Loader2, RefreshCw, AlertTriangle } from "lucide-react";
import { useWallet } from "@/lib/chain/provider";
import { RH_CHAIN } from "@/lib/chain/chains";
import {
  LENDING,
  LENDING_ASSETS,
  readReserves,
  readUserPosition,
  borrowPermitted,
  lendingUnavailableOn,
  lendingAvailableOn,
  formatUsd,
  formatUnits,
  healthBand,
  type ReserveSnapshot,
  type UserPosition,
} from "@/lib/lending/market";
import { supply, withdraw, borrow, repay } from "@/lib/lending/actions";

const LEND_CSS = `
.lend-grid { display: grid; gap: 18px; }
.lend-row, .lend-head { min-width: 0; }
.lend-row > * { min-width: 0; }
/* The action cell holds an input plus two buttons side by side. At 132px they overflowed the
   panel and WITHDRAW/REPAY were clipped — measured on the live page. 210px is what two
   uppercase labels at 11px plus their padding and gap actually need. */
.lend-head, .lend-row {
  display: grid; grid-template-columns: minmax(110px,1.3fr) 0.8fr 0.8fr 0.8fr 210px;
  gap: 12px; align-items: center; padding: 14px 18px; }
.lend-head { font-size: 11px; font-weight: 800; letter-spacing: .1em;
  text-transform: uppercase; color: var(--ink-3); border-bottom: 1px solid rgba(44,26,12,.10); }
.lend-row + .lend-row { border-top: 1px solid rgba(44,26,12,.07); }
.lend-asset { display: flex; align-items: center; gap: 10px; }
.lend-asset b { font-size: 14.5px; font-weight: 800; color: var(--ink); letter-spacing: -.01em; }
.lend-asset span { font-size: 11.5px; color: var(--ink-3); }
/* the table's figures use the site's own .num / .apy — nothing bespoke here */
.lend-row .num, .lend-row .apy { justify-self: start; text-align: left; }
.lend-acts { display: flex; gap: 6px; }
.lend-acts .lend-mini { flex: 1 1 0; min-width: 0; }
.lend-mini { font-size: 10.5px; font-weight: 800; letter-spacing: .03em; text-transform: uppercase;
  padding: 7px 8px; border-radius: 10px; border: 0; cursor: pointer; color: #fff; white-space: nowrap;
  background: linear-gradient(180deg, #43a06a, var(--moss)); box-shadow: 0 2px 0 #1e5837; }
.lend-mini.alt { background: linear-gradient(180deg, #d98c3f, #b4671c); box-shadow: 0 2px 0 #7d4310; }
.lend-mini:disabled { opacity: .45; cursor: not-allowed; box-shadow: none; }
.hf.safe { color: var(--moss); } .hf.warn { color: #b4801c; } .hf.danger { color: var(--rust); }
.hf.none { color: var(--ink-3); }
.lend-warn { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px;
  border-radius: 12px; background: rgba(180,52,28,.10); border: 1px solid rgba(180,52,28,.28);
  font-size: 12.5px; line-height: 1.5; color: var(--clay); }
.lend-warn b, .lend-warn strong { color: #8c3418; }
.lend-warn svg { color: #b4341c; flex: 0 0 auto; margin-top: 1px; }
.lend-note { font-size: 12px; color: var(--ink-3); line-height: 1.55; }
@media (max-width: 820px) {
  .lend-head { display: none; }
  .lend-row { grid-template-columns: 1fr; gap: 10px; }
  .lend-acts { justify-content: stretch; }
  .lend-mini { flex: 1; }
}
`;

type Action = "supply" | "withdraw" | "borrow" | "repay";

export default function LendPage() {
  return (
    <>
      <BackgroundImage />
      <NavBar />
      <LendMarket />
    </>
  );
}

function LendMarket() {
  const { address, chainId, switchTo } = useWallet();

  const [reserves, setReserves] = useState<ReserveSnapshot[]>([]);
  const [pos, setPos] = useState<UserPosition | null>(null);
  const [canBorrow, setCanBorrow] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const unavailable = lendingUnavailableOn(chainId);
  const onRightChain = lendingAvailableOn(chainId);

  const load = useCallback(async () => {
    if (!onRightChain) {
      setReserves([]);
      setPos(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [r, p, b] = await Promise.all([
        readReserves(chainId),
        address ? readUserPosition(address as `0x${string}`, chainId) : Promise.resolve(null),
        borrowPermitted(chainId),
      ]);
      setReserves(r);
      setPos(p);
      setCanBorrow(b);
    } finally {
      setLoading(false);
    }
  }, [address, chainId, onRightChain]);

  useEffect(() => {
    load();
  }, [load]);

  const band = healthBand(pos?.healthFactor ?? null);

  /**
   * Every action routes through here so the chain guard, the busy lock and the reload live in ONE
   * place. A per-button copy of this logic is how a surface ends up with one path that forgot the
   * guard — which on a lending screen means sending a supply to the wrong chain's pool.
   */
  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      if (!onRightChain) {
        setMsg(unavailable);
        return;
      }
      setBusy(label);
      setMsg(null);
      try {
        await fn();
        setMsg(`${label} confirmed`);
        await load();
      } catch (e: any) {
        // Aave reverts carry a named error; show it rather than a stack trace.
        const raw = e?.shortMessage || e?.message || String(e);
        setMsg(raw.length > 160 ? `${raw.slice(0, 160)}…` : raw);
      } finally {
        setBusy(null);
      }
    },
    [onRightChain, unavailable, load],
  );

  /**
   * All four verbs live in `lib/lending/actions.ts`, which refuses on a wallet/chain mismatch and
   * SIMULATES before sending so an Aave named error arrives as a sentence rather than as a
   * reverted transaction the user already paid for.
   */
  const act = useCallback(
    async (a: Action, asset: ReserveSnapshot, amount: bigint) => {
      const fn = a === "supply" ? supply : a === "withdraw" ? withdraw : a === "borrow" ? borrow : repay;
      const res = await fn(asset, amount);
      if (!res.success) throw new Error(res.error || "Failed");
      return res;
    },
    [],
  );

  return (
    <div className="w-full">
      <style>{LEND_CSS}</style>

      <header className="hero">
        <h1>Lend &amp; borrow.</h1>
        <p className="sub">
          Supply ETH, USDG or a tokenised equity as collateral and borrow stablecoins against it.
          Aave v3.7, with a first-party oracle and a read-time borrow veto.
        </p>
        <MoleMascot />
      </header>

      {/* Wrong chain is a first-class state, not a disabled button with no explanation. */}
      {!onRightChain && (
        <div className="panel" style={{ padding: 18, marginBottom: 18 }}>
          <div className="lend-warn">
            <AlertTriangle size={18} />
            <div>
              <b style={{ display: "block", marginBottom: 4 }}>Not on this network</b>
              <div>{unavailable}</div>
              <button
                className="lend-mini"
                style={{ marginTop: 10 }}
                onClick={() => switchTo?.(RH_CHAIN.id)}
              >
                Switch to {RH_CHAIN.shortName}
              </button>
            </div>
          </div>
        </div>
      )}

      {onRightChain && (
        <>
          {/* Position, in the site's own stat tiles — same component the pools page uses, so the
              type scale and the tunnel motif carry across instead of this page inventing its own. */}
          <div className="stats">
            <div className="chamber">
              <div className="label">Collateral</div>
              <div className="value mono">{pos ? formatUsd(pos.totalCollateralBase) : "…"}</div>
            </div>
            <div className="chamber">
              <div className="label">Borrowed</div>
              <div className="value mono">{pos ? formatUsd(pos.totalDebtBase) : "…"}</div>
            </div>
            <div className="chamber">
              <div className="label">Available to borrow</div>
              <div className="value mono">{pos ? formatUsd(pos.availableBorrowsBase) : "…"}</div>
            </div>
            <div className="chamber">
              <div className="label">Health factor</div>
              <div className={`value mono hf ${band}`}>
                {pos?.healthFactor == null
                  ? pos
                    ? "∞"
                    : "…"
                  : (Number(pos.healthFactor) / 1e18).toFixed(2)}
              </div>
            </div>
          </div>

          <div style={{ marginBottom: 18 }}>

            {band === "danger" && (
              <div className="lend-warn" style={{ marginTop: 14 }}>
                <AlertTriangle size={18} />
                <div>
                  Your health factor is below 1.1. If it reaches 1.0 your collateral can be
                  liquidated and a liquidator takes a 6.5% bonus out of it. Repay or add collateral.
                </div>
              </div>
            )}
          </div>

          {/* the borrow veto, stated rather than hidden */}
          {!canBorrow && (
            <div className="panel" style={{ padding: 18, marginBottom: 18 }}>
              <div className="lend-warn">
                <AlertTriangle size={18} />
                <div>
                  <b style={{ display: "block", marginBottom: 4 }}>Borrowing is paused</b>
                  The market&apos;s liveness gate is not currently allowing new debt — usually
                  because the chain&apos;s uptime signal lapsed or a price feed went stale.
                  Supplying, withdrawing and repaying are unaffected.
                </div>
              </div>
            </div>
          )}

          <div className="panel">
            <div className="lend-head">
              <div>Asset</div>
              <div>Price</div>
              <div>Supply APY</div>
              <div>Borrow APY</div>
              <div />
            </div>

            {loading && (
              <div className="load-block" style={{ padding: 44 }}>
                <Loader2 className="animate-spin-slow" style={{ margin: "0 auto 12px" }} />
                <div className="t1">Reading on-chain data…</div>
                <div className="t2">Fetching from {RH_CHAIN.name}</div>
              </div>
            )}

            {!loading &&
              reserves.map((r) => (
                <ReserveRow
                  key={r.address}
                  r={r}
                  pos={pos}
                  canBorrow={canBorrow}
                  busy={busy}
                  connected={!!address}
                  onAct={(a, amt) => run(`${a} ${r.symbol}`, () => act(a, r, amt))}
                />
              ))}
          </div>

          {msg && (
            <div className="panel" style={{ padding: 14, marginTop: 14 }}>
              <div className="lend-note">{msg}</div>
            </div>
          )}

          <p className="lend-note" style={{ marginTop: 18 }}>
            Only the stablecoins can be borrowed; everything marked{" "}
            <em>collateral only</em> can be supplied and borrowed against, never borrowed.{" "}
            {riskBands(reserves).map((b) => (
              <span key={b.key}>
                {b.symbols} — ${b.ltv} of borrowing per $100 supplied, liquidated at {b.threshold}%.{" "}
              </span>
            ))}
            The equities are held lower because their price feeds stop updating when the US market
            closes.{" "}
            <button className="linkish" onClick={load} style={{ background: "none", border: 0, cursor: "pointer" }}>
              <RefreshCw size={12} /> Refresh
            </button>
          </p>
        </>
      )}

      {!address && onRightChain && (
        <div className="panel" style={{ padding: 18, marginTop: 18 }}>
          <div className="lend-note">Connect a wallet from the top bar to supply or borrow.</div>
        </div>
      )}
    </div>
  );
}

/**
 * The risk numbers, GROUPED FROM THE LIVE READ rather than written into the sentence.
 *
 * These were hardcoded for one release and were already wrong: the prose said ETH and USDG both
 * lend at 75% and liquidate at 80%, while USDG has been configured 72%/77% on chain the whole time.
 * A risk number a user acts on must have exactly one source, and it has to be the one the protocol
 * will actually enforce — the table above already reads `ltvBps` / `liquidationThresholdBps` per
 * reserve, so the footnote reads the same values instead of a second copy that drifts silently on
 * the next PoolConfigurator change.
 */
function riskBands(reserves: ReserveSnapshot[]) {
  const groups = new Map<string, { ltv: number; threshold: number; symbols: string[] }>();
  for (const r of reserves) {
    if (r.ltvBps === 0) continue; // not usable as collateral at all — "$0 per $100" helps nobody
    const key = `${r.ltvBps}:${r.liquidationThresholdBps}`;
    const g = groups.get(key);
    if (g) g.symbols.push(r.symbol);
    else groups.set(key, { ltv: r.ltvBps, threshold: r.liquidationThresholdBps, symbols: [r.symbol] });
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].ltv - a[1].ltv)
    .map(([key, g]) => ({
      key,
      symbols: g.symbols.join(", "),
      ltv: g.ltv / 100,
      threshold: g.threshold / 100,
    }));
}

function ReserveRow({
  r,
  pos,
  canBorrow,
  busy,
  connected,
  onAct,
}: {
  r: ReserveSnapshot;
  pos: UserPosition | null;
  canBorrow: boolean;
  busy: string | null;
  connected: boolean;
  onAct: (a: Action, amount: bigint) => void;
}) {
  const [amount, setAmount] = useState("");
  const supplied = pos?.supplied[r.symbol] ?? 0n;
  const borrowed = pos?.borrowed[r.symbol] ?? 0n;

  const parsed = useMemo(() => {
    if (!amount) return 0n;
    const [i, f = ""] = amount.split(".");
    const frac = (f + "0".repeat(r.decimals)).slice(0, r.decimals);
    try {
      return BigInt(i || "0") * 10n ** BigInt(r.decimals) + BigInt(frac || "0");
    } catch {
      return 0n;
    }
  }, [amount, r.decimals]);

  const disabled = !connected || parsed === 0n || !!busy;

  return (
    <div className="lend-row">
      <div className="lend-asset">
        <b>{r.symbol}</b>
        <span>
          {supplied > 0n && `supplied ${formatUnits(supplied, r.decimals)}`}
          {supplied > 0n && borrowed > 0n && " · "}
          {borrowed > 0n && `borrowed ${formatUnits(borrowed, r.decimals)}`}
          {supplied === 0n && borrowed === 0n && (r.borrowable ? "collateral + borrowable" : "collateral only")}
        </span>
      </div>

      <div className="num">{formatUsd(r.priceBase)}</div>
      <div className="apy">{(r.supplyApy * 100).toFixed(2)}%</div>
      <div className="apy" style={{ color: "var(--rust)" }}>
        {r.borrowable ? `${(r.borrowApy * 100).toFixed(2)}%` : "—"}
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        <input
          className="p-field"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          style={{ width: "100%", padding: "7px 9px", fontSize: 12.5 }}
        />
        <div className="lend-acts">
          <button className="lend-mini" disabled={disabled} onClick={() => onAct("supply", parsed)}>
            Supply
          </button>
          <button
            className="lend-mini alt"
            disabled={disabled || supplied === 0n}
            onClick={() => onAct("withdraw", parsed)}
          >
            Withdraw
          </button>
        </div>
        {r.borrowable && (
          <div className="lend-acts">
            <button
              className="lend-mini"
              disabled={disabled || !canBorrow}
              title={!canBorrow ? "The liveness gate is not allowing new debt right now" : undefined}
              onClick={() => onAct("borrow", parsed)}
            >
              Borrow
            </button>
            <button
              className="lend-mini alt"
              disabled={disabled || borrowed === 0n}
              onClick={() => onAct("repay", parsed)}
            >
              Repay
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
