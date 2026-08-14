"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { parseUnits, formatUnits } from "viem";
import { BackgroundImage, NavBar, MoleMascot } from "../shared";
import { useWallet } from "@/lib/chain/provider";
import { WETH, USDG } from "@/lib/mole/chain";
import {
  getAlmPositions,
  getVaultBalances,
  getPoolState,
  almDeposit,
  almDepositNative,
  almWithdraw,
  type AlmPosition,
  type VaultBalances,
} from "@/lib/mole/vault";

// Deposit options: native ETH (auto-wrapped to WETH — the pool's WETH leg is wrapped ETH), or USDG.
const DEPOSIT_TOKENS = [
  { symbol: "ETH", address: WETH.address, decimals: 18, native: true },
  { symbol: USDG.symbol, address: USDG.address, decimals: USDG.decimals, native: false },
];
const GAS_BUFFER = 1_500_000_000_000_000n; // leave 0.0015 ETH for the wrap + approve + zap gas
const ZERO_BAL: VaultBalances = { weth: 0n, usdg: 0n, native: 0n };

// Burrow coin-chip colors (no image assets — the chip IS the token mark).
const COIN_COLOR: Record<string, string> = {
  ETH: "#6f7ce0",
  WETH: "#627eea",
  USDG: "#1c74d4",
};
const Coin = ({ sym, size }: { sym: string; size?: number }) => (
  <span
    className="coin"
    style={{
      background: COIN_COLOR[sym] || "#8a5c33",
      ...(size ? { width: size, height: size, fontSize: Math.round(size * 0.33), borderWidth: 0 } : {}),
    }}
  >
    {sym.slice(0, 2).toUpperCase()}
  </span>
);

function trimAmount(raw: string, maxFrac: number): string {
  if (!raw.includes(".")) return raw;
  const [whole, frac] = raw.split(".");
  const cut = frac.slice(0, maxFrac).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : whole;
}

/** USDG per WETH from a v4 tick (currency1/currency0, adjusted for 18/6 decimals). */
function priceFromTick(tick: number): number {
  return Math.pow(1.0001, tick) * 1e12;
}

/**
 * REAL range chart: the live pool's current tick against the vault's actual operating band. If the wallet
 * holds positions, the band is their real [tickLower, tickUpper]; otherwise it's the ±15k band the next
 * deposit would open around spot. Every number here is read on-chain — no synthetic bars.
 */
function StrategyBand({ tick, positions }: { tick: number | null; positions: AlmPosition[] }) {
  if (tick === null) {
    return (
      <div className="p-card">
        <h3>Strategy band</h3>
        <p className="d">Reading live pool state…</p>
      </div>
    );
  }
  const hasPos = positions.length > 0;
  const lo = hasPos ? Math.min(...positions.map((p) => p.tickLower)) : tick - 15000;
  const hi = hasPos ? Math.max(...positions.map((p) => p.tickUpper)) : tick + 15000;
  const span = Math.max(1, hi - lo);
  const clamp = (x: number) => Math.max(0, Math.min(100, x));
  const markerPct = clamp(((tick - lo) / span) * 100);
  const inRange = tick >= lo && tick <= hi;

  return (
    <div className="p-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <h3>{hasPos ? "Your range" : "Strategy band"}</h3>
        <span className={`p-pill ${inRange ? "pos" : "neg"}`}>
          {inRange ? "● IN RANGE — EARNING" : "◆ OUT OF RANGE"}
        </span>
      </div>
      {/* Real range track with the live-price marker */}
      <div className="band-track">
        <div className="band-fill" />
        <div className="band-core" />
        <div className="band-marker" style={{ left: `calc(6% + ${markerPct * 0.88}%)` }} />
      </div>
      <div className="band-labels">
        <span>${priceFromTick(lo).toFixed(0)}</span>
        <span className="spot">SPOT ${priceFromTick(tick).toFixed(2)}/WETH · tick {tick}</span>
        <span>${priceFromTick(hi).toFixed(0)}</span>
      </div>
    </div>
  );
}

export default function VaultPage() {
  const { address, isConnected, onRH, connect, switchToRH } = useWallet();
  const [tokenIdx, setTokenIdx] = useState(0); // 0 = WETH, 1 = USDG
  const [amount, setAmount] = useState("");
  const [positions, setPositions] = useState<AlmPosition[]>([]);
  const [balances, setBalances] = useState<VaultBalances>(ZERO_BAL);
  const [poolTick, setPoolTick] = useState<number | null>(null);
  const [loadingPos, setLoadingPos] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  // Always the freshest connection state, readable from inside an awaited handler (see onPrimary).
  const connectedRef = useRef(isConnected);
  connectedRef.current = isConnected;

  const token = DEPOSIT_TOKENS[tokenIdx];
  const isNative = token.native;
  // For ETH show the native balance (minus a gas buffer so MAX still leaves gas for the wrap+zap).
  const rawBalance = isNative ? balances.native : balances.usdg;
  const tokenBalance = isNative ? (rawBalance > GAS_BUFFER ? rawBalance - GAS_BUFFER : 0n) : rawBalance;

  const refresh = useCallback(async () => {
    if (!address) {
      setPositions([]);
      setBalances(ZERO_BAL);
      return;
    }
    setLoadingPos(true);
    try {
      const [pos, bal] = await Promise.all([getAlmPositions(address), getVaultBalances(address)]);
      setPositions(pos);
      setBalances(bal);
    } catch {
      setPositions([]);
      setBalances(ZERO_BAL);
    } finally {
      setLoadingPos(false);
    }
  }, [address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live pool tick for the range chart — refreshed on a 15s poll so the marker tracks the real price.
  useEffect(() => {
    let cancelled = false;
    const load = () => getPoolState().then((s) => { if (!cancelled && s) setPoolTick(s.tick); });
    load();
    const t = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const amountWei = useMemo(() => {
    try {
      return amount ? parseUnits(amount, token.decimals) : 0n;
    } catch {
      return 0n;
    }
  }, [amount, token.decimals]);

  const setFraction = (num: bigint, den: bigint) => {
    const wei = (tokenBalance * num) / den;
    setAmount(trimAmount(formatUnits(wei, token.decimals), token.decimals === 6 ? 6 : 8));
  };

  const insufficient = amountWei > tokenBalance;
  const zeroBalance = tokenBalance === 0n;

  const onDeposit = async () => {
    if (!isConnected || !onRH || amountWei <= 0n || insufficient) return;
    setBusy(true);
    setStatus(`Depositing ${amount} ${token.symbol}…`);
    const r = isNative
      ? await almDepositNative(amountWei, setStatus)
      : await almDeposit(token.address as `0x${string}`, amountWei);
    if (r.success) {
      setStatus(`Deposited — position #${r.positionId ?? "?"} (${r.txHash?.slice(0, 10)}…)`);
      setAmount("");
      refresh();
    } else {
      setStatus(r.error || "Deposit failed");
    }
    setBusy(false);
  };

  // Primary CTA dispatcher. The button's label already promises "Connect wallet" /
  // "Switch to Robinhood" in those states, so it has to actually do that — previously it
  // called onDeposit, whose guard returned on the first line when disconnected or on the
  // wrong chain, giving no modal and no feedback. Uses the same mechanism as the swap
  // screens: useWallet()'s connect / switchToRH.
  const onPrimary = async () => {
    if (!isConnected) {
      setStatus("Connecting wallet…");
      setBusy(true);
      try {
        await connect();
        // useWallet().connect swallows a rejected/absent connector (provider.tsx) and resolves with
        // nothing, so "did it work" can only be answered by whether an account actually arrived. Read
        // it from a ref — wagmi updates the rendered value while this call is awaited, the captured
        // `isConnected` above never changes. Without this the no-wallet case is silent, which is the
        // exact complaint this button already had.
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
    return onDeposit();
  };

  const onWithdraw = async (id: string) => {
    setBusy(true);
    setStatus(`Exiting position #${id}…`);
    const r = await almWithdraw(id);
    setStatus(r.success ? `Exited #${id} (${r.txHash?.slice(0, 10)}…)` : r.error || "Withdraw failed");
    setBusy(false);
    refresh();
  };

  const cta = !isConnected
    ? "Connect wallet"
    : !onRH
      ? "Switch to Robinhood"
      : busy
        ? "Working…"
        : amountWei <= 0n
          ? "Enter an amount"
          : insufficient
            ? `Not enough ${token.symbol}`
            : `Deposit ${token.symbol}`;

  return (
    <>
      <BackgroundImage isLoading={false} />
      <NavBar />

      <main>
        <header className="hero">
          <h1>TWAP Vault.</h1>
          <p className="sub">
            Auto-managed WETH/USDG liquidity · single-sided deposit · TWAP-priced re-centering.
          </p>
          <MoleMascot />

          <div className="pair-head">
            <span className="coins" style={{ display: "inline-flex" }}>
              <Coin sym="WETH" />
              <Coin sym="USDG" />
            </span>
            <h2>WETH/USDG</h2>
            <span className="badge2">MoleHook v4</span>
            <span className="badge2">Dynamic fee</span>
          </div>

          <div className="stats">
            <div className="chamber">
              <div className="label">Your positions</div>
              <div className="value mono">{positions.length}</div>
              <div className="foot">in the vault</div>
            </div>
            <div className="chamber">
              <div className="label">Strategy</div>
              <div className="value" style={{ color: "var(--moss)" }}>AUTO</div>
              <div className="foot">swap half → bounded range</div>
            </div>
            <div className="chamber">
              <div className="label">Re-center</div>
              <div className="value mono" style={{ color: "var(--moss)" }}>±15K</div>
              <div className="foot">ticks, TWAP-priced</div>
            </div>
            <div className="chamber">
              <div className="label">Status</div>
              <div className="value" style={{ color: "var(--moss)" }}>LIVE</div>
              <div className="foot">on Robinhood Chain</div>
            </div>
          </div>
        </header>

        <section className="p-grid p-side">
          <div>
            {/* Deposit card */}
            <div className="p-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                <h3>+ Deposit</h3>
                {isConnected && (
                  <span className="mono" style={{ fontSize: 12, color: "var(--p-card-ink-3)" }}>
                    BAL: {trimAmount(formatUnits(tokenBalance, token.decimals), 6)} {token.symbol}
                  </span>
                )}
              </div>

              {/* Token toggle — ETH (auto-wrapped to WETH) or USDG */}
              <div className="tok-toggle" style={{ marginTop: 14 }}>
                {DEPOSIT_TOKENS.map((t, i) => (
                  <button
                    key={t.symbol}
                    data-on={tokenIdx === i ? "true" : "false"}
                    onClick={() => {
                      setTokenIdx(i);
                      setAmount("");
                    }}
                  >
                    <Coin sym={t.symbol} size={22} />
                    {t.symbol}
                  </button>
                ))}
              </div>
              {isNative && (
                <p className="d" style={{ marginTop: 10 }}>
                  Your ETH is wrapped to WETH automatically, then zapped into the pool.
                </p>
              )}

              {/* Amount input */}
              <div className={`p-field ${insufficient ? "bad" : ""}`} style={{ marginTop: 12 }}>
                <div className="lbl">
                  <span>Amount</span>
                </div>
                <div className="amt">
                  <input
                    type="text"
                    className="big"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                    placeholder="0.0"
                    inputMode="decimal"
                    aria-label="Deposit amount"
                  />
                  <span className="p-mini" style={{ flex: "none", color: "var(--p-card-ink-3)", fontWeight: 700 }}>
                    {token.symbol}
                  </span>
                </div>
                {isConnected && tokenBalance > 0n && (
                  <div className="p-chipset" style={{ marginTop: 10 }}>
                    {[
                      { l: "25%", n: 1n, d: 4n },
                      { l: "50%", n: 1n, d: 2n },
                      { l: "MAX", n: 1n, d: 1n },
                    ].map((f) => (
                      <button key={f.l} onClick={() => setFraction(f.n, f.d)}>
                        {f.l}
                      </button>
                    ))}
                  </div>
                )}
                {insufficient && <div className="insuf">INSUFFICIENT {token.symbol} BALANCE</div>}
              </div>

              {/* Summary rows — strategy the deposit will follow */}
              <div className="p-rows" style={{ marginTop: 10 }}>
                <div className="p-row"><span className="k">Strategy</span><span className="v">SWAP HALF → BOUNDED RANGE</span></div>
                <div className="p-row"><span className="k">Range</span><span className="v pos">±15,000 TICKS (AUTO)</span></div>
                <div className="p-row"><span className="k">Slippage</span><span className="v">1.0%</span></div>
                <div className="p-row"><span className="k">Fees</span><span className="v pos">AUTO-COMPOUND</span></div>
                <div className="p-row"><span className="k">On-chain</span><span className="v pos">LIVE ✓</span></div>
              </div>

              {/* Zero-balance guidance. ETH deposits directly (wrapped); USDG can be acquired in Swap. */}
              {isConnected && onRH && zeroBalance && (
                <div className="help-box">
                  You have 0 {token.symbol}
                  {isNative ? " to deposit (after gas)." : ". Get some in Swap to add USDG-side liquidity."}
                  {!isNative && (
                    <>
                      {" "}
                      <Link href={`/dapp?to=${token.address}&toChainId=4663`}>
                        GET {token.symbol} IN SWAP →
                      </Link>
                    </>
                  )}
                </div>
              )}

              <button
                className="p-btn"
                onClick={onPrimary}
                disabled={busy || (isConnected && onRH && (amountWei <= 0n || insufficient))}
              >
                {cta}
              </button>
              {status && <div className="statline">{status}</div>}
            </div>
          </div>

          <div>
            <StrategyBand tick={poolTick} positions={positions} />

            {/* Positions */}
            <div className="p-card" style={{ marginTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                <h3>Your positions</h3>
                <button
                  onClick={refresh}
                  className="linkish"
                  style={{ textDecoration: "none", fontSize: "12.5px" }}
                >
                  ⟳ REFRESH
                </button>
              </div>
              {!isConnected ? (
                <div className="p-empty" style={{ padding: "26px 10px" }}>Connect a wallet to see your positions.</div>
              ) : loadingPos ? (
                <div className="p-empty" style={{ padding: "26px 10px" }}>Loading…</div>
              ) : positions.length === 0 ? (
                <div className="p-empty" style={{ padding: "26px 10px" }}>No positions yet. Deposit above to start.</div>
              ) : (
                <div>
                  {positions.map((p) => (
                    <div key={p.id} className="pos-row">
                      <div>
                        <div className="t1">
                          #{p.id} · {p.fullRange ? "FULL RANGE" : `TICKS ${p.tickLower}…${p.tickUpper}`}
                        </div>
                        <div className="t2">
                          liquidity {formatUnits(p.liquidity, 0)} · fees auto-compound into this position
                        </div>
                      </div>
                      <button className="exit-btn" onClick={() => onWithdraw(p.id)} disabled={busy}>
                        Exit
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      <style jsx global>{`
        /* page: vault */
        .pair-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 26px; }
        .pair-head h2 { margin: 0; font-size: 1.5rem; font-weight: 800; letter-spacing: -.02em; color: var(--p-onbg); }
        .band-track { position: relative; height: 40px; border-radius: 12px; background: rgba(44,26,12,.15); overflow: hidden; margin-top: 14px; }
        .band-fill { position: absolute; top: 0; bottom: 0; left: 6%; right: 6%; background: rgba(47,125,79,.18); }
        .band-core { position: absolute; top: 6px; bottom: 6px; left: 6%; right: 6%; background: rgba(47,125,79,.35); border-radius: 8px; }
        .band-marker { position: absolute; top: 0; bottom: 0; width: 3px; background: var(--amber); box-shadow: 0 0 8px rgba(240,160,60,.8); transition: left 1s ease; }
        .band-labels { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; font-family: var(--font-num); font-size: 11.5px; color: var(--ink-3); flex-wrap: wrap; }
        .band-labels .spot { color: var(--clay); font-weight: 700; }
        .tok-toggle { display: flex; gap: 8px; }
        .tok-toggle button {
          flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
          border: 1px solid var(--p-card-line); background: var(--p-field); color: var(--p-card-ink-2);
          font: inherit; font-size: 14px; font-weight: 700; padding: 10px 12px; border-radius: 14px; cursor: pointer;
        }
        .tok-toggle button[data-on="true"] { border-color: var(--moss); background: rgba(47,125,79,.1); color: #1e6b40; }
        .pos-row { display: flex; align-items: center; gap: 12px; padding: 13px 14px; margin-top: 8px;
          border-radius: var(--r-md); background: rgba(255,255,255,.55); border: 1px solid rgba(44,26,12,.08); }
        .pos-row .t1 { font-size: 14.5px; font-weight: 800; font-family: var(--font-num); }
        .pos-row .t2 { font-size: 11.5px; color: var(--ink-3); margin-top: 3px; }
        .exit-btn { margin-left: auto; flex: none; border: 0; cursor: pointer; font: inherit; font-size: 12px; font-weight: 800;
          letter-spacing: .06em; text-transform: uppercase; color: #fff; background: linear-gradient(180deg, #d9584a, var(--rust));
          padding: 9px 16px; border-radius: 12px; box-shadow: 0 2px 0 #7e2415, inset 0 1px 0 rgba(255,255,255,.35); }
        .exit-btn:disabled { opacity: .6; cursor: default; }
        .exit-btn:not(:disabled):active { transform: translateY(1px); box-shadow: 0 1px 0 #7e2415; }
        .help-box { margin-top: 12px; padding: 12px 14px; border-radius: var(--r-md); font-size: 12.5px; line-height: 1.5;
          background: rgba(240,160,60,.12); border: 1px solid rgba(240,160,60,.3); color: var(--ink-2); }
        .help-box a { color: var(--clay); font-weight: 700; }
        .insuf { margin-top: 8px; font-size: 12px; font-weight: 700; color: var(--rust); }
        .p-field.bad { box-shadow: 0 0 0 2px rgba(184,55,31,.45); }
      `}</style>
    </>
  );
}
