"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { parseUnits, formatUnits } from "viem";
import { BackgroundImage, NavBar } from "../shared";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { usePushWallet } from "@/lib/pushchain/provider";
import { WETH, USDG } from "@/lib/mole/chain";
import { getAlmPositions, almDeposit, almWithdraw, type AlmPosition } from "@/lib/mole/vault";

const TOKENS = [WETH, USDG];

export default function VaultPage() {
  const { address, isConnected, onRH } = usePushWallet();
  const [tokenIdx, setTokenIdx] = useState(0); // 0 = WETH, 1 = USDG
  const [amount, setAmount] = useState("");
  const [positions, setPositions] = useState<AlmPosition[]>([]);
  const [loadingPos, setLoadingPos] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const token = TOKENS[tokenIdx];

  const refresh = useCallback(async () => {
    if (!address) {
      setPositions([]);
      return;
    }
    setLoadingPos(true);
    try {
      setPositions(await getAlmPositions(address));
    } catch {
      setPositions([]);
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

  const onDeposit = async () => {
    if (!isConnected || !onRH || amountWei <= 0n) return;
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
        : amountWei > 0n
          ? `DEPOSIT ${token.symbol}`
          : "ENTER AN AMOUNT";

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
          <div className="font-family-ThaleahFat text-peach-300 mb-3 text-xl tracking-widest">DEPOSIT</div>
          <div className="flex items-center gap-2 rounded-xl border-2 border-[#523525] bg-[#2a1c12] px-4 py-3">
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
                  onClick={() => setTokenIdx(i)}
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
          <p className="font-family-ThaleahFat mt-2 text-xs tracking-wider text-gray-400">
            Full-range position · balanced 50/50 by the vault. minLiquidity slippage on the internal zap
            is not enforced by the contract — start with a small amount.
          </p>
          <button
            onClick={onDeposit}
            disabled={busy || (isConnected && onRH && amountWei <= 0n)}
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
