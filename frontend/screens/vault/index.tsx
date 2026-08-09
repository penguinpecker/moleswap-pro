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
  almDeposit,
  almWithdraw,
  type AlmPosition,
  type VaultBalances,
} from "@/lib/mole/vault";

const TOKENS = [WETH, USDG];
const ZERO_BAL: VaultBalances = { weth: 0n, usdg: 0n, native: 0n };

/** Trim a formatted amount to a readable number of places without rounding the value up. */
function trimAmount(raw: string, maxFrac: number): string {
  if (!raw.includes(".")) return raw;
  const [whole, frac] = raw.split(".");
  const cut = frac.slice(0, maxFrac).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : whole;
}

export default function VaultPage() {
  const { address, isConnected, onRH } = useWallet();
  const [tokenIdx, setTokenIdx] = useState(0); // 0 = WETH, 1 = USDG
  const [amount, setAmount] = useState("");
  const [positions, setPositions] = useState<AlmPosition[]>([]);
  const [balances, setBalances] = useState<VaultBalances>(ZERO_BAL);
  const [loadingPos, setLoadingPos] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const token = TOKENS[tokenIdx];
  const tokenBalance = tokenIdx === 0 ? balances.weth : balances.usdg;

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

  const amountWei = useMemo(() => {
    try {
      return amount ? parseUnits(amount, token.decimals) : 0n;
    } catch {
      return 0n;
    }
  }, [amount, token.decimals]);

  const setFraction = (num: bigint, den: bigint) => {
    // Floor to the token's decimals so a "MAX" can never exceed the on-chain balance.
    const wei = (tokenBalance * num) / den;
    setAmount(trimAmount(formatUnits(wei, token.decimals), token.decimals === 6 ? 6 : 8));
  };

  const insufficient = amountWei > tokenBalance;
  const zeroBalance = tokenBalance === 0n;

  const onDeposit = async () => {
    if (!isConnected || !onRH || amountWei <= 0n || insufficient) return;
    setBusy(true);
    setStatus(`Depositing ${amount} ${token.symbol}…`);
    const r = await almDeposit(token.address as `0x${string}`, amountWei);
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

  return (
    <div className="relative flex min-h-screen w-full flex-col items-center gap-2 sm:gap-4">
      <BackgroundImage isLoading={false} />

      <div className="relative z-50 mx-auto mt-2 flex w-full flex-col-reverse gap-2 px-2 sm:mt-4 sm:flex-row sm:items-center sm:gap-4 sm:px-4">
        <div className="flex-1">
          <NavBar />
        </div>
        <div className="bg-peach-500 font-family-ThaleahFat shrink-0 rounded-lg border-3 border-[#523525] px-3 py-2 text-base font-medium tracking-wider text-black shadow-[0px_-6px_0px_0px_#C97E00_inset,0px_7.5px_0px_0px_rgba(255,212,122,0.6)_inset] sm:py-3 sm:text-2xl">
          <ConnectWalletButton />
        </div>
      </div>

      <div className="relative z-20 mt-4 mb-[10%] flex w-full max-w-xl flex-1 flex-col items-center gap-4 px-3 sm:mt-10">
        <h1 className="text-peach-300 text-shadow-header font-family-ThaleahFat text-3xl font-bold tracking-widest uppercase sm:text-5xl">
          MOLESWAP ALM
        </h1>
        <p className="font-family-ThaleahFat text-center text-sm tracking-wider text-gray-200 sm:text-base">
          AUTO-MANAGED WETH/USDG LIQUIDITY ON ROBINHOOD CHAIN — DEPOSIT ONE SIDE, THE VAULT DOES THE REST
        </p>

        {/* Deposit card */}
        <div className="bg-ground w-full rounded-2xl border-3 border-[#523525] p-5 shadow-[6px_6px_0_#000]">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="font-family-ThaleahFat text-peach-300 text-xl tracking-widest">DEPOSIT</span>
            {isConnected && (
              <span className="font-family-ThaleahFat text-xs tracking-wider text-gray-300">
                Balance: {trimAmount(formatUnits(tokenBalance, token.decimals), 6)} {token.symbol}
              </span>
            )}
          </div>
          <div
            className={`flex items-center gap-2 rounded-xl border-2 bg-[#2a1c12] px-4 py-3 ${
              insufficient ? "border-red-600" : "border-[#523525]"
            }`}
          >
            <input
              className="font-family-ThaleahFat flex-1 bg-transparent text-2xl text-white outline-none"
              placeholder="0.0"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            />
            <div className="flex gap-1">
              {TOKENS.map((t, i) => (
                <button
                  key={t.symbol}
                  onClick={() => {
                    setTokenIdx(i);
                    setAmount("");
                  }}
                  className={`font-family-ThaleahFat rounded-lg border-2 px-3 py-1 text-lg tracking-wider transition-all ${
                    tokenIdx === i
                      ? "border-[#C97E00] bg-[#523525] text-yellow-200"
                      : "border-[#523525] text-peach-300"
                  }`}
                >
                  {t.symbol}
                </button>
              ))}
            </div>
          </div>

          {/* Quick-fill from balance */}
          {isConnected && tokenBalance > 0n && (
            <div className="mt-2 flex gap-2">
              {[
                { label: "25%", num: 1n, den: 4n },
                { label: "50%", num: 1n, den: 2n },
                { label: "75%", num: 3n, den: 4n },
                { label: "MAX", num: 1n, den: 1n },
              ].map((f) => (
                <button
                  key={f.label}
                  onClick={() => setFraction(f.num, f.den)}
                  className="font-family-ThaleahFat flex-1 cursor-pointer rounded-lg border-2 border-[#523525] py-1 text-xs tracking-wider text-peach-300 transition-all hover:border-[#C97E00] hover:text-yellow-200"
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}

          <p className="font-family-ThaleahFat mt-3 text-xs tracking-wider text-gray-400">
            Single-sided zap: deposit {token.symbol} and the vault swaps half and mints a bounded ±15k-tick
            range around spot. The swap leg is slippage-bounded (amountOutMin, 1%) and every deposit is
            simulated against the vault before it is sent.
          </p>

          {/* Zero-balance guidance — the vault can only pull WETH/USDG; native ETH just pays gas here. */}
          {isConnected && onRH && zeroBalance && (
            <div className="mt-3 rounded-xl border-2 border-[#5a4a2a] bg-[#2a2213] px-4 py-3">
              <p className="font-family-ThaleahFat text-xs tracking-wider text-yellow-200">
                You have 0 {token.symbol}. The vault holds a WETH/USDG position, so you need WETH or USDG
                {balances.native > 0n ? " (your ETH here only pays gas)" : ""}.
              </p>
              <Link
                href={`/dapp?to=${token.address}&toChainId=4663`}
                className="font-family-ThaleahFat mt-2 inline-block cursor-pointer rounded-lg border-2 border-[#3f7d20] bg-[#4e9d2a] px-4 py-2 text-sm tracking-wider text-white transition-all hover:brightness-110"
              >
                GET {token.symbol} IN SWAP →
              </Link>
            </div>
          )}

          <button
            onClick={onDeposit}
            disabled={busy || (isConnected && onRH && (amountWei <= 0n || insufficient))}
            className="font-family-ThaleahFat mt-4 w-full cursor-pointer rounded-xl border-3 border-[#3f7d20] bg-[#4e9d2a] px-4 py-3 text-xl font-bold tracking-wider text-white shadow-[0px_4px_0px_#2f6318] transition-all hover:brightness-110 active:translate-y-0.5 disabled:opacity-60"
          >
            {cta}
          </button>
          {status && (
            <div className="font-family-ThaleahFat mt-3 text-center text-sm tracking-wider break-all text-peach-300">
              {status}
            </div>
          )}
        </div>

        {/* Positions */}
        <div className="bg-ground w-full rounded-2xl border-3 border-[#523525] p-5 shadow-[6px_6px_0_#000]">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-family-ThaleahFat text-peach-300 text-xl tracking-widest">
              YOUR POSITIONS
            </span>
            <button
              onClick={refresh}
              className="font-family-ThaleahFat text-peach-300 cursor-pointer text-sm tracking-wider hover:text-white"
            >
              ⟳ REFRESH
            </button>
          </div>
          {!isConnected ? (
            <p className="font-family-ThaleahFat py-4 text-center text-sm tracking-wider text-gray-400">
              Connect a wallet to see your ALM positions.
            </p>
          ) : loadingPos ? (
            <p className="font-family-ThaleahFat py-4 text-center text-sm tracking-wider text-gray-400">
              Loading…
            </p>
          ) : positions.length === 0 ? (
            <p className="font-family-ThaleahFat py-4 text-center text-sm tracking-wider text-gray-400">
              No positions yet.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {positions.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-3 rounded-xl border-2 border-[#523525] bg-[#2a1c12] px-4 py-3"
                >
                  <div className="font-family-ThaleahFat tracking-wider">
                    <div className="text-peach-300 text-lg">
                      #{p.id} · {p.fullRange ? "FULL RANGE" : `TICKS ${p.tickLower}…${p.tickUpper}`}
                    </div>
                    <div className="text-xs text-gray-400">
                      liquidity {formatUnits(p.liquidity, 0)}
                    </div>
                  </div>
                  <button
                    onClick={() => onWithdraw(p.id)}
                    disabled={busy}
                    className="font-family-ThaleahFat cursor-pointer rounded-lg border-2 border-[#7a2f2f] bg-[#a13a3a] px-3 py-2 text-sm tracking-wider text-white transition-all hover:brightness-110 disabled:opacity-60"
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
  );
}
