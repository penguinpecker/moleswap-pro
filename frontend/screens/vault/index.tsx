"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { parseUnits, formatUnits } from "viem";
import { BackgroundImage, NavBar, MoleMascot } from "../shared";
import { useWallet } from "@/lib/chain/provider";
import {
  vaultChainFor,
  vaultChains,
  type VaultChainConfig,
  type VaultDepositToken,
} from "@/lib/mole/vaultChain";
import {
  getAlmPositions,
  getVaultBalances,
  getPoolState,
  almDeposit,
  almDepositNative,
  almWithdraw,
  almWithdrawWithFloor,
  type AlmPosition,
  type VaultBalances,
} from "@/lib/mole/vault";
// The band is "TWAP-priced": the re-centre anchors on the hook's TWAP, so the band carries the TWAP's
// health through the ONE staleness helper and renders the shared stale state, same words as everywhere.
import { useOracleHealth } from "@/lib/mole/useOracleHealth";
import type { OracleHealth } from "@/lib/mole/oracle";
import { OracleStaleBadge } from "../shared/OracleStale";

const ZERO_BAL: VaultBalances = { token0: 0n, token1: 0n, native: 0n };

// Burrow coin-chip colors (no image assets — the chip IS the token mark).
const COIN_COLOR: Record<string, string> = {
  ETH: "#6f7ce0",
  WETH: "#627eea",
  USDG: "#1c74d4",
  USDC: "#2775ca",
  Architects: "#c2743a",
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

/**
 * The pool price at `tick`, expressed in whichever leg is the chain's dollar.
 *
 * Two things have to come from the chain rather than a constant. The DECIMAL adjustment: the raw v4
 * ratio is currency1-per-currency0 in raw units, so it needs 10^(decimals0 − decimals1) — 1e12 on
 * Robinhood's WETH(18)/USDG(6) and 1e-12 on Arc's USDC(6)/Architects(18), which are inverses of each
 * other, not the same number. And the DIRECTION: Robinhood's dollar is currency1, so the ratio already
 * reads "$ per WETH", while Arc's dollar is currency0, so the ratio reads "Architects per $" and the
 * price a human wants is its reciprocal. Hard-coding either would print a confidently wrong number.
 */
function usdPriceFromTick(tick: number, cfg: VaultChainConfig): number | null {
  if (cfg.usdLeg === null) return null;
  const ratio = Math.pow(1.0001, tick) * Math.pow(10, cfg.token0.decimals - cfg.token1.decimals);
  return cfg.usdLeg === 1 ? ratio : 1 / ratio;
}

/** The leg being priced — the one that is not the dollar. */
function pricedSymbol(cfg: VaultChainConfig): string {
  return cfg.usdLeg === 1 ? cfg.token0.symbol : cfg.token1.symbol;
}

/**
 * A dollar price with enough digits to mean something at any magnitude. `$3,845.00` and `$0.002119`
 * are both real prices in this app now: WETH is thousands of dollars and Architects is a fifth of a
 * cent, and a fixed two decimals renders the second as `$0.00`.
 */
function usdText(price: number | null, minFractionDigits: number): string {
  if (price === null || !Number.isFinite(price) || price <= 0) return "—";
  const digits =
    price >= 100 ? minFractionDigits
      : price >= 1 ? Math.max(minFractionDigits, 2)
        : price >= 0.01 ? Math.max(minFractionDigits, 4)
          : Math.max(minFractionDigits, 6);
  return `$${price.toFixed(digits)}`;
}

/**
 * REAL range chart: the live pool's current tick against the vault's actual operating band. If the wallet
 * holds positions, the band is their real [tickLower, tickUpper]; otherwise it's the ±15k band the next
 * deposit would open around spot. Every number here is read on-chain — no synthetic bars.
 */
function StrategyBand({
  tick,
  positions,
  oracle,
  cfg,
}: {
  tick: number | null;
  positions: AlmPosition[];
  oracle: OracleHealth | null;
  cfg: VaultChainConfig;
}) {
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
  // The cheaper END of the range is not always the lower TICK: where the dollar is currency0 (Arc),
  // price falls as the tick rises. Order the two edge labels by price so the axis never reads backwards.
  const edges = [usdPriceFromTick(lo, cfg), usdPriceFromTick(hi, cfg)].filter(
    (p): p is number => p !== null,
  );
  const [loPrice, hiPrice] =
    edges.length === 2 ? [Math.min(...edges), Math.max(...edges)] : [null, null];

  return (
    <div className="p-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <h3>{hasPos ? "Your range" : "Strategy band"}</h3>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {oracle?.stale && <OracleStaleBadge ageSec={oracle.ageSec} />}
          <span className={`p-pill ${inRange ? "pos" : "neg"}`}>
            {inRange ? "● IN RANGE — EARNING" : "◆ OUT OF RANGE"}
          </span>
        </span>
      </div>
      {/* Real range track with the live-price marker */}
      <div className="band-track">
        <div className="band-fill" />
        <div className="band-core" />
        <div className="band-marker" style={{ left: `calc(6% + ${markerPct * 0.88}%)` }} />
      </div>
      <div className="band-labels">
        <span>{usdText(loPrice, 0)}</span>
        <span className="spot">
          SPOT {usdText(usdPriceFromTick(tick, cfg), 2)}/{pricedSymbol(cfg)} · tick {tick}
        </span>
        <span>{usdText(hiPrice, 0)}</span>
      </div>
    </div>
  );
}

/**
 * What the page renders when the wallet is somewhere the ALM is not deployed.
 *
 * It is a panel and not a disabled form on purpose: a deposit box aimed at a chain with no vault has
 * nothing to submit to, and rendering one that "does nothing" teaches a user the app is broken. The
 * switch is OFFERED here rather than performed silently, which is the whole difference from what this
 * page used to do.
 */
function NoVaultHere({
  chainName,
  onSwitch,
  busy,
}: {
  chainName: string;
  onSwitch: (id: number) => void;
  busy: boolean;
}) {
  const chains = vaultChains();
  return (
    <div className="p-card">
      <h3>Not on this network</h3>
      <p className="d" style={{ marginTop: 10 }}>
        MoleSwap LP is not live on {chainName}. The vault runs on{" "}
        {chains.map((c) => c.name).join(" and ")} — switch there to deposit, or stay here and use Swap.
      </p>
      <div className="p-chipset" style={{ marginTop: 14 }}>
        {chains.map((c) => (
          <button key={c.id} onClick={() => onSwitch(c.id)} disabled={busy}>
            SWITCH TO {c.shortName.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function VaultPage() {
  const { address, isConnected, chainId, activeChain, connect, switchTo } = useWallet();
  // The vault for the chain the wallet is ACTUALLY on. `null` means this chain has no ALM, which the
  // page states plainly instead of rendering a deposit form that cannot execute.
  const cfg = useMemo(() => vaultChainFor(chainId), [chainId]);
  const [tokenIdx, setTokenIdx] = useState(0); // index into cfg.depositTokens
  const [amount, setAmount] = useState("");
  const [positions, setPositions] = useState<AlmPosition[]>([]);
  const [balances, setBalances] = useState<VaultBalances>(ZERO_BAL);
  const [poolTick, setPoolTick] = useState<number | null>(null);
  // Read the ring of the pool ON SCREEN, on the chain the wallet is on. Left at its defaults this hook
  // answers for Robinhood's WETH/USDG pool, so an Arc deposit card would have carried a staleness badge
  // describing a market it is not showing — a small lie of exactly the kind this page was rebuilt to
  // stop telling. Disabled where there is no vault, since there is then no series to be stale about.
  const { oracle } = useOracleHealth({ poolId: cfg?.poolId, chainId: cfg?.chainId, enabled: cfg !== null });
  const [loadingPos, setLoadingPos] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  // Always the freshest connection state, readable from inside an awaited handler (see onPrimary).
  const connectedRef = useRef(isConnected);
  connectedRef.current = isConnected;

  // The two chains do not offer the same tokens, so a held index would select Architects because the
  // user had picked USDG. Reset the whole form when the chain moves — a half-carried form is how a
  // 6-decimal amount ends up parsed against an 18-decimal token.
  useEffect(() => {
    setTokenIdx(0);
    setAmount("");
    setStatus("");
  }, [cfg?.chainId]);

  const token: VaultDepositToken | null = cfg ? (cfg.depositTokens[tokenIdx] ?? cfg.depositTokens[0]) : null;
  const isNative = token?.native ?? false;

  /**
   * The wallet's balance of a deposit token, in that token's own decimals.
   *
   * The native option reads the NATIVE balance because that is what gets wrapped. Everything else is
   * matched by address against the resolved pool key — the 6-decimal leg is currency1 on Robinhood and
   * currency0 on Arc, so "the second one" is not a safe way to find it.
   */
  const rawBalance = useMemo(() => {
    if (!cfg || !token) return 0n;
    if (token.native) return balances.native;
    return token.address.toLowerCase() === cfg.token0.address.toLowerCase() ? balances.token0 : balances.token1;
  }, [cfg, token, balances]);

  // Keep the gas token's buffer back so MAX still leaves enough to pay for the deposit itself. On Arc
  // this is not a nicety: gas and the USDC leg are one balance, so a true MAX would strand the user.
  const gasBuffer = token?.gasBuffer ?? 0n;
  const tokenBalance = rawBalance > gasBuffer ? rawBalance - gasBuffer : 0n;

  const refresh = useCallback(async () => {
    if (!address || !cfg) {
      setPositions([]);
      setBalances(ZERO_BAL);
      return;
    }
    setLoadingPos(true);
    try {
      const [pos, bal] = await Promise.all([
        getAlmPositions(address, cfg.chainId),
        getVaultBalances(address, cfg.chainId),
      ]);
      setPositions(pos);
      setBalances(bal);
    } catch {
      setPositions([]);
      setBalances(ZERO_BAL);
    } finally {
      setLoadingPos(false);
    }
  }, [address, cfg]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live pool tick for the range chart — refreshed on a 15s poll so the marker tracks the real price.
  useEffect(() => {
    if (!cfg) {
      setPoolTick(null);
      return;
    }
    let cancelled = false;
    const load = () => getPoolState(cfg.chainId).then((s) => { if (!cancelled && s) setPoolTick(s.tick); });
    load();
    const t = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [cfg]);

  const amountWei = useMemo(() => {
    try {
      return amount && token ? parseUnits(amount, token.decimals) : 0n;
    } catch {
      return 0n;
    }
  }, [amount, token]);

  const setFraction = (num: bigint, den: bigint) => {
    if (!token) return;
    const wei = (tokenBalance * num) / den;
    setAmount(trimAmount(formatUnits(wei, token.decimals), token.decimals === 6 ? 6 : 8));
  };

  const insufficient = amountWei > tokenBalance;
  const zeroBalance = tokenBalance === 0n;

  const onDeposit = async () => {
    if (!isConnected || !cfg || !token || amountWei <= 0n || insufficient) return;
    setBusy(true);
    setStatus(`Depositing ${amount} ${token.symbol}…`);
    const r = isNative
      ? await almDepositNative(amountWei, setStatus, cfg.chainId)
      : await almDeposit(token.address as `0x${string}`, amountWei, cfg.chainId);
    if (r.success) {
      setStatus(`Deposited — position #${r.positionId ?? "?"} (${r.txHash?.slice(0, 10)}…)`);
      setAmount("");
      refresh();
    } else {
      setStatus(r.error || "Deposit failed");
    }
    setBusy(false);
  };

  const switchToVaultChain = useCallback(
    async (id: number) => {
      const target = vaultChains().find((c) => c.id === id) ?? vaultChains()[0];
      if (!target) return;
      setStatus(`Switching to ${target.name}…`);
      setBusy(true);
      try {
        await switchTo(target.id);
        // switchTo resolves either way (provider.tsx swallows a rejection), so "did it work" is answered
        // by the chain we end up on, which re-renders this component — clear the line and let the next
        // render speak for itself.
        setStatus("");
      } catch {
        setStatus("Network switch failed");
      } finally {
        setBusy(false);
      }
    },
    [switchTo],
  );

  // Primary CTA dispatcher. The button's label already promises "Connect wallet" /
  // "Switch to Robinhood" in those states, so it has to actually do that — previously it
  // called onDeposit, whose guard returned on the first line when disconnected or on the
  // wrong chain, giving no modal and no feedback. Uses the same mechanism as the swap
  // screens: useWallet()'s connect / switchTo.
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
    if (!cfg) {
      const first = vaultChains()[0];
      if (first) await switchToVaultChain(first.id);
      return;
    }
    return onDeposit();
  };

  /**
   * EXIT WITH A FLOOR, AND FALL BACK TO THE UNFLOORED EXIT IF THE FLOOR IS THE ONLY THING STOPPING YOU.
   *
   * `withdrawWithMinimums` has been on chain for a while and nothing called it: every exit went out
   * through `withdraw`, which passes no floor at all, so a withdrawal settled at whatever the pool
   * happened to give in that block. That is the same defect that was fixed on the DEPOSIT side, and it
   * matters more here, because a user leaving is usually leaving for a reason and is least able to
   * wait for a better price.
   *
   * The floor is TWAP-derived, never spot — a floor computed from a price an attacker just moved is
   * not a floor, it is a rubber stamp on their number.
   *
   * WHY THE FALLBACK EXISTS, and this is the part to get right: a floor that is too high does not cost
   * a user slippage, it TRAPS THEM. Trapping funds is strictly worse than the slippage the floor was
   * protecting against, so a floored exit that fails ITS OWN BOUND offers the unfloored exit rather
   * than leaving the owner stuck holding a position they asked to close. Every other failure is
   * reported as itself — we only ever retry the one refusal we caused.
   */
  const onWithdraw = async (id: string) => {
    if (!cfg) return;
    setBusy(true);
    setStatus(`Exiting position #${id}…`);
    const r = await almWithdrawWithFloor(id, {}, cfg.chainId);
    if (r.success) {
      setStatus(`Exited #${id} (${r.txHash?.slice(0, 10)}…)`);
      setBusy(false);
      refresh();
      return;
    }
    if (r.floorNotMet) {
      setStatus(`${r.error} — exiting at the market price instead…`);
      const forced = await almWithdraw(id, cfg.chainId);
      setStatus(
        forced.success ? `Exited #${id} (${forced.txHash?.slice(0, 10)}…)` : forced.error || "Withdraw failed",
      );
    } else {
      setStatus(r.error || "Withdraw failed");
    }
    setBusy(false);
    refresh();
  };

  const switchLabel = vaultChains()[0]?.shortName ?? "Robinhood";
  const cta = !isConnected
    ? "Connect wallet"
    : !cfg
      ? `Switch to ${switchLabel}`
      : busy
        ? "Working…"
        : amountWei <= 0n
          ? "Enter an amount"
          : insufficient
            ? `Not enough ${token?.symbol ?? ""}`
            : `Deposit ${token?.symbol ?? ""}`;

  const chainName = activeChain?.name ?? "this network";
  const pairLabel = cfg ? `${cfg.token0.symbol}/${cfg.token1.symbol}` : "—";

  return (
    <>
      <BackgroundImage isLoading={false} />
      <NavBar />

      <main>
        <header className="hero">
          <h1>TWAP Vault.</h1>
          <p className="sub">
            Auto-managed {pairLabel} liquidity · single-sided deposit · TWAP-priced re-centering.
          </p>
          <MoleMascot />

          <div className="pair-head">
            <span className="coins" style={{ display: "inline-flex" }}>
              <Coin sym={cfg?.token0.symbol ?? "?"} />
              <Coin sym={cfg?.token1.symbol ?? "?"} />
            </span>
            <h2>{pairLabel}</h2>
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
              <div className="value" style={{ color: cfg ? "var(--moss)" : "var(--rust)" }}>
                {cfg ? "LIVE" : "OFF"}
              </div>
              <div className="foot">{cfg ? `on ${cfg.meta.name}` : `not on ${chainName}`}</div>
            </div>
          </div>
        </header>

        <section className="p-grid p-side">
          <div>
            {/* Deposit card — replaced wholesale on a chain with no vault, because a form that cannot
                submit anywhere is worse than an explanation. */}
            {!cfg || !token ? (
              <NoVaultHere chainName={chainName} onSwitch={switchToVaultChain} busy={busy} />
            ) : (
              <div className="p-card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                  <h3>+ Deposit</h3>
                  {isConnected && (
                    <span className="mono" style={{ fontSize: 12, color: "var(--p-card-ink-3)" }}>
                      BAL: {trimAmount(formatUnits(tokenBalance, token.decimals), 6)} {token.symbol}
                    </span>
                  )}
                </div>

                {/* Token toggle — this chain's two deposit routes into the pool's two legs. */}
                <div className="tok-toggle" style={{ marginTop: 14 }}>
                  {cfg.depositTokens.map((t, i) => (
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
                {/* Say WHY there is no wrap-and-deposit route here, rather than quietly showing one
                    button fewer than the other chain does. */}
                {cfg.nativeDepositUnavailable && (
                  <p className="d" style={{ marginTop: 10 }}>{cfg.nativeDepositUnavailable}</p>
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

                {/* Zero-balance guidance. The native option deposits directly (wrapped); an ERC-20 leg
                    can be acquired in Swap — on THIS chain, which is why the link carries the chain id. */}
                {isConnected && zeroBalance && (
                  <div className="help-box">
                    You have 0 {token.symbol}
                    {isNative
                      ? " to deposit (after gas)."
                      : gasBuffer > 0n
                        ? ` left over after the gas buffer. On ${cfg.meta.name} the deposit and the gas come out of the same balance.`
                        : `. Get some in Swap to add ${token.symbol}-side liquidity.`}
                    {!isNative && (
                      <>
                        {" "}
                        <Link href={`/dapp?to=${token.address}&toChainId=${cfg.chainId}`}>
                          GET {token.symbol} IN SWAP →
                        </Link>
                      </>
                    )}
                  </div>
                )}

                <button
                  className="p-btn"
                  onClick={onPrimary}
                  disabled={busy || (isConnected && (amountWei <= 0n || insufficient))}
                >
                  {cta}
                </button>
                {status && <div className="statline">{status}</div>}
              </div>
            )}
          </div>

          <div>
            {cfg && <StrategyBand tick={poolTick} positions={positions} oracle={oracle} cfg={cfg} />}

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
              ) : !cfg ? (
                <div className="p-empty" style={{ padding: "26px 10px" }}>
                  No vault on {chainName}. Positions you hold on another network are still there — switch to see them.
                </div>
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
