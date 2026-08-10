"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { parseUnits, formatUnits } from "viem";
import { BackgroundImage, NavBar } from "../shared";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
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
      <div className="relative rounded px-3 py-4 text-center">
        <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
        <span className="font-family-ThaleahFat text-sm tracking-wider text-gray-400">Reading live pool state…</span>
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
    <div className="relative rounded px-3 py-3">
      <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
      <div className="mb-2 flex items-center justify-between">
        <span className="font-family-ThaleahFat text-base tracking-wider text-gray-200">
          {hasPos ? "YOUR RANGE" : "STRATEGY BAND"}
        </span>
        <span className={`font-family-ThaleahFat text-sm ${inRange ? "text-[#6DBB3E]" : "text-yellow-300"}`}>
          {inRange ? "● IN RANGE — EARNING" : "◆ OUT OF RANGE"}
        </span>
      </div>
      {/* Real range track with the live-price marker */}
      <div className="relative h-10 w-full overflow-hidden rounded bg-black/30">
        <div className="absolute inset-y-0 rounded bg-[#3f6b26]/50" style={{ left: "6%", right: "6%" }} />
        <div className="absolute inset-y-1 rounded bg-[#6DBB3E]/60" style={{ left: "6%", right: "6%" }} />
        <div className="absolute inset-y-0 w-[3px] bg-[#F4D03F]" style={{ left: `calc(6% + ${markerPct * 0.88}%)` }} />
      </div>
      <div className="mt-1 flex justify-between text-xs">
        <span className="font-family-ThaleahFat text-gray-400">${priceFromTick(lo).toFixed(0)}</span>
        <span className="font-family-ThaleahFat text-yellow-200">SPOT ${priceFromTick(tick).toFixed(2)}/WETH · tick {tick}</span>
        <span className="font-family-ThaleahFat text-gray-400">${priceFromTick(hi).toFixed(0)}</span>
      </div>
    </div>
  );
}

export default function VaultPage() {
  const { address, isConnected, onRH } = useWallet();
  const [tokenIdx, setTokenIdx] = useState(0); // 0 = WETH, 1 = USDG
  const [amount, setAmount] = useState("");
  const [positions, setPositions] = useState<AlmPosition[]>([]);
  const [balances, setBalances] = useState<VaultBalances>(ZERO_BAL);
  const [poolTick, setPoolTick] = useState<number | null>(null);
  const [loadingPos, setLoadingPos] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

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

  const onWithdraw = async (id: string) => {
    setBusy(true);
    setStatus(`Exiting position #${id}…`);
    const r = await almWithdraw(id);
    setStatus(r.success ? `Exited #${id} (${r.txHash?.slice(0, 10)}…)` : r.error || "Withdraw failed");
    setBusy(false);
    refresh();
  };

  const cta = !isConnected
    ? "CONNECT WALLET"
    : !onRH
      ? "SWITCH TO ROBINHOOD"
      : busy
        ? "WORKING…"
        : amountWei <= 0n
          ? "ENTER AN AMOUNT"
          : insufficient
            ? `NOT ENOUGH ${token.symbol}`
            : `DEPOSIT ${token.symbol}`;

  const statBox = (l: string, v: string, c: string) => (
    <div className="relative rounded px-3 py-3 text-center">
      <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
      <div className="font-family-ThaleahFat text-sm tracking-wider text-gray-200 sm:text-base">{l}</div>
      <div className={`font-family-ThaleahFat text-xl sm:text-2xl ${c}`}>{v}</div>
    </div>
  );

  return (
    <div className="relative flex min-h-screen w-full flex-col items-center gap-2 sm:gap-4">
      <BackgroundImage isLoading={false} />

      <div className="relative z-50 mx-auto mt-2 flex w-full flex-col-reverse gap-2 px-2 sm:mt-4 sm:flex-row sm:items-center sm:gap-4 sm:px-4">
        <div className="flex-1">
          <NavBar />
        </div>
        <div className="bg-peach-500 font-family-ThaleahFat shrink-0 rounded-lg border-3 border-[#523525] px-3 py-2 text-base tracking-wider text-black shadow-[0px_-6px_0px_0px_#C97E00_inset,0px_7.5px_0px_0px_rgba(255,212,122,0.6)_inset] sm:py-3 sm:text-2xl">
          <ConnectWalletButton />
        </div>
      </div>

      {/* Title panel */}
      <div className="relative z-20 mx-auto mt-2 w-full max-w-3xl px-3 sm:mt-4">
        <div className="relative rounded-lg px-4 py-4 text-center">
          <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full" />
          <h1 className="text-peach-300 text-shadow-header font-family-ThaleahFat text-3xl font-bold tracking-widest uppercase sm:text-5xl">
            TWAP VAULT
          </h1>
          <p className="font-family-ThaleahFat mt-1 text-sm tracking-wider text-gray-200">
            AUTO-MANAGED WETH/USDG LIQUIDITY · SINGLE-SIDED DEPOSIT · TWAP-PRICED RE-CENTERING
          </p>
        </div>
      </div>

      <div className="relative z-20 mb-[8%] flex w-full max-w-3xl flex-1 flex-col gap-3 px-3">
        {/* Header + stats */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex -space-x-2">
            <Image src={WETH.logoURI || "/tokens/weth.svg"} alt="WETH" width={34} height={34} className="rounded-full border-2 border-[#523525]" />
            <Image src={USDG.logoURI || "/tokens/rh.svg"} alt="USDG" width={34} height={34} className="rounded-full border-2 border-[#523525]" />
          </div>
          <h2 className="font-family-ThaleahFat text-2xl tracking-wider text-white sm:text-3xl">WETH/USDG</h2>
          <span className="font-family-ThaleahFat rounded-sm bg-[#3A1F0E] px-1.5 py-px text-sm text-[#C49A6C]">MOLEHOOK v4</span>
          <span className="font-family-ThaleahFat rounded-sm bg-[#3A1F0E] px-1.5 py-px text-sm text-[#C49A6C]">DYNAMIC FEE</span>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {statBox("YOUR POSITIONS", String(positions.length), "text-peach-500")}
          {statBox("STRATEGY", "AUTO", "text-[#6DBB3E]")}
          {statBox("RE-CENTER", "±15K", "text-[#6DBB3E]")}
          {statBox("STATUS", "LIVE", "text-[#6DBB3E]")}
        </div>

        <StrategyBand tick={poolTick} positions={positions} />

        {/* Deposit card — styled like the pools ADD LIQUIDITY modal */}
        <div className="overflow-hidden rounded-lg border-3 border-[#3A1F0E] bg-gradient-to-b from-[#52301A] to-[#4A2C15]">
          <div className="flex items-center justify-between border-b-2 border-[#3A1F0E] bg-black/20 px-4 py-3">
            <span className="font-family-ThaleahFat text-xl tracking-wider text-white">+ DEPOSIT</span>
            {isConnected && (
              <span className="font-family-ThaleahFat text-sm tracking-wider text-gray-300">
                BAL: {trimAmount(formatUnits(tokenBalance, token.decimals), 6)} {token.symbol}
              </span>
            )}
          </div>
          <div className="px-4 py-3">
            {/* Token toggle — ETH (auto-wrapped to WETH) or USDG */}
            <div className="mb-3 flex gap-2">
              {DEPOSIT_TOKENS.map((t, i) => (
                <button
                  key={t.symbol}
                  onClick={() => {
                    setTokenIdx(i);
                    setAmount("");
                  }}
                  className={`font-family-ThaleahFat flex-1 cursor-pointer rounded-lg border-2 px-3 py-2 text-lg tracking-wider transition-all ${
                    tokenIdx === i ? "border-[#6DBB3E] bg-[#6DBB3E]/10 text-[#6DBB3E]" : "border-[#3A1F0E] text-gray-300 hover:text-white"
                  }`}
                >
                  {t.symbol}
                </button>
              ))}
            </div>
            {isNative && (
              <p className="font-family-ThaleahFat -mt-1 mb-2 text-xs tracking-wider text-gray-400">
                Your ETH is wrapped to WETH automatically, then zapped into the pool.
              </p>
            )}

            {/* Amount input */}
            <div className={`relative mb-2 rounded px-3 py-2.5 ${insufficient ? "ring-2 ring-red-600" : ""}`}>
              <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder="0.0"
                  inputMode="decimal"
                  className="font-family-ThaleahFat w-full flex-1 bg-transparent text-2xl tracking-wider text-white placeholder:text-gray-600 focus:outline-none"
                />
                {isConnected &&
                  tokenBalance > 0n &&
                  [
                    { l: "25%", n: 1n, d: 4n },
                    { l: "50%", n: 1n, d: 2n },
                    { l: "MAX", n: 1n, d: 1n },
                  ].map((f) => (
                    <button
                      key={f.l}
                      onClick={() => setFraction(f.n, f.d)}
                      className="font-family-ThaleahFat text-peach-500 border-ground-button-border bg-ground-button-border cursor-pointer rounded-sm border px-2 py-1 text-sm"
                    >
                      {f.l}
                    </button>
                  ))}
              </div>
              {insufficient && (
                <div className="font-family-ThaleahFat mt-1 text-xs text-red-400">INSUFFICIENT {token.symbol} BALANCE</div>
              )}
            </div>

            {/* Summary rows — mirrors the pools modal (PRICE / FEE / RANGE / SLIPPAGE / ON-CHAIN LIVE) */}
            <div className="relative mb-3 rounded px-3 py-2">
              <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
              {[
                ["STRATEGY", "SWAP HALF → BOUNDED RANGE", "text-peach-300"],
                ["RANGE", "±15,000 TICKS (AUTO)", "text-[#6DBB3E]"],
                ["SLIPPAGE", "1.0%", "text-gray-200"],
                ["FEES", "AUTO-COMPOUND", "text-[#6DBB3E]"],
                ["ON-CHAIN", "LIVE ✓", "text-[#6DBB3E]"],
              ].map(([k, v, c]) => (
                <div key={k} className="flex justify-between py-0.5">
                  <span className="font-family-ThaleahFat text-base text-gray-200">{k}</span>
                  <span className={`font-family-ThaleahFat text-base ${c}`}>{v}</span>
                </div>
              ))}
            </div>

            {/* Zero-balance guidance. ETH deposits directly (wrapped); USDG can be acquired in Swap. */}
            {isConnected && onRH && zeroBalance && (
              <div className="mb-3 rounded-xl border-2 border-[#5a4a2a] bg-[#2a2213] px-4 py-3">
                <p className="font-family-ThaleahFat text-xs tracking-wider text-yellow-200">
                  You have 0 {token.symbol}
                  {isNative ? " to deposit (after gas)." : ". Get some in Swap to add USDG-side liquidity."}
                </p>
                {!isNative && (
                  <Link
                    href={`/dapp?to=${token.address}&toChainId=4663`}
                    className="font-family-ThaleahFat mt-2 inline-block cursor-pointer rounded-lg border-2 border-[#3f7d20] bg-[#4e9d2a] px-4 py-2 text-sm tracking-wider text-white transition-all hover:brightness-110"
                  >
                    GET {token.symbol} IN SWAP →
                  </Link>
                )}
              </div>
            )}

            <button
              onClick={onDeposit}
              disabled={busy || (isConnected && onRH && (amountWei <= 0n || insufficient))}
              className="font-family-ThaleahFat w-full cursor-pointer rounded-lg bg-[#6DBB3E] px-6 py-3 text-xl tracking-wider text-white shadow-[0px_-4px_0px_0px_#4A8B29_inset,0px_4px_0px_0px_rgba(255,255,255,0.3)_inset] transition-all hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
            >
              {cta}
            </button>
            {status && (
              <div className="font-family-ThaleahFat mt-3 text-center text-sm tracking-wider break-all text-peach-300">{status}</div>
            )}
          </div>
        </div>

        {/* Positions */}
        <div className="overflow-hidden rounded-lg border-3 border-[#3A1F0E] bg-gradient-to-b from-[#52301A] to-[#4A2C15]">
          <div className="flex items-center justify-between border-b-2 border-[#3A1F0E] bg-black/20 px-4 py-3">
            <span className="font-family-ThaleahFat text-xl tracking-wider text-white">YOUR POSITIONS</span>
            <button onClick={refresh} className="font-family-ThaleahFat cursor-pointer text-sm tracking-wider text-peach-300 hover:text-white">
              ⟳ REFRESH
            </button>
          </div>
          <div className="px-4 py-3">
            {!isConnected ? (
              <p className="font-family-ThaleahFat py-4 text-center text-sm tracking-wider text-gray-400">Connect a wallet to see your positions.</p>
            ) : loadingPos ? (
              <p className="font-family-ThaleahFat py-4 text-center text-sm tracking-wider text-gray-400">Loading…</p>
            ) : positions.length === 0 ? (
              <p className="font-family-ThaleahFat py-4 text-center text-sm tracking-wider text-gray-400">No positions yet. Deposit above to start.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {positions.map((p) => (
                  <div key={p.id} className="relative flex items-center justify-between gap-3 rounded px-4 py-3">
                    <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
                    <div className="font-family-ThaleahFat tracking-wider">
                      <div className="text-peach-300 text-lg">
                        #{p.id} · {p.fullRange ? "FULL RANGE" : `TICKS ${p.tickLower}…${p.tickUpper}`}
                      </div>
                      <div className="text-xs text-gray-400">
                        liquidity {formatUnits(p.liquidity, 0)} · fees auto-compound into this position
                      </div>
                    </div>
                    <button
                      onClick={() => onWithdraw(p.id)}
                      disabled={busy}
                      className="font-family-ThaleahFat cursor-pointer rounded-lg bg-red-600 px-3 py-2 text-sm tracking-wider text-white shadow-[0px_-3px_0px_0px_#991B1B_inset] transition-all hover:scale-[1.01] disabled:opacity-60"
                    >
                      EXIT
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
