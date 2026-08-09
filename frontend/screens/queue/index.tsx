"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseUnits, formatUnits } from "viem";
import { BackgroundImage, NavBar } from "../shared";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { useWallet } from "@/lib/chain/provider";
import { WETH, USDG } from "@/lib/mole/chain";
import { QueuePhase, secondsUntilCutoff, type QueueSchedule, type EpochState } from "@/lib/mole/queue";
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
  const { address, isConnected, onRH } = useWallet();
  const [schedule, setSchedule] = useState<(QueueSchedule & { maxResidualSlippageBps: number }) | null>(null);
  const [epoch, setEpochState] = useState<EpochState | null>(null);
  const [orders, setOrders] = useState<UserOrderView[]>([]);
  const [side, setSide] = useState(true); // true = WETH -> USDG
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [nowTick, setNowTick] = useState(Math.floor(Date.now() / 1000));
  const [loading, setLoading] = useState(true);

  const nowRef = useRef(nowTick);
  nowRef.current = nowTick;

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

  const cta = !isConnected
    ? "CONNECT WALLET"
    : !onRH
      ? "SWITCH TO ROBINHOOD"
      : busy
        ? "WORKING…"
        : amountWei <= 0n
          ? "ENTER AN AMOUNT"
          : secLeft <= 0
            ? "PLACE ORDER (STARTS NEW EPOCH)"
            : "PLACE ORDER";

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
          BATCH QUEUE
        </h1>
        <p className="font-family-ThaleahFat text-center text-sm tracking-wider text-gray-200 sm:text-base">
          SUBMIT AN INTENT, NOT A SWAP. AT THE CUTOFF, OPPOSING ORDERS CROSS AT THE TWAP — NO SLIPPAGE,
          NO LP FEE — AND ONLY THE NET RESIDUAL HITS THE POOL. BEING FIRST IN LINE IS WORTH NOTHING.
        </p>

        {/* Epoch status */}
        <div className="bg-ground flex w-full items-center justify-between rounded-2xl border-3 border-[#523525] p-4 shadow-[6px_6px_0_#000]">
          <div className="font-family-ThaleahFat tracking-widest">
            <div className="text-peach-300 text-lg">EPOCH #{schedule ? schedule.currentEpoch.toString() : "—"}</div>
            <div className="text-xs text-gray-400">
              {epoch ? PHASE_LABEL[epoch.phase] : loading ? "loading…" : "—"}
            </div>
          </div>
          <div className="font-family-ThaleahFat text-right tracking-widest">
            <div className="text-xs text-gray-400">CUTOFF IN</div>
            <div className={`text-2xl ${secLeft <= 10 ? "text-red-400" : "text-yellow-200"}`}>{mmss(secLeft)}</div>
          </div>
        </div>

        {/* Place order */}
        <div className="bg-ground w-full rounded-2xl border-3 border-[#523525] p-5 shadow-[6px_6px_0_#000]">
          <div className="font-family-ThaleahFat text-peach-300 mb-3 text-xl tracking-widest">PLACE ORDER</div>
          <div className="mb-3 flex gap-2">
            {[true, false].map((s) => (
              <button
                key={String(s)}
                onClick={() => setSide(s)}
                className={`font-family-ThaleahFat flex-1 rounded-lg border-2 px-3 py-2 text-lg tracking-wider transition-all ${
                  side === s ? "border-[#C97E00] bg-[#523525] text-yellow-200" : "border-[#523525] text-peach-300"
                }`}
              >
                {s ? "WETH → USDG" : "USDG → WETH"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 rounded-xl border-2 border-[#523525] bg-[#2a1c12] px-4 py-3">
            <input
              className="font-family-ThaleahFat flex-1 bg-transparent text-2xl text-white outline-none"
              placeholder="0.0"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            />
            <span className="font-family-ThaleahFat text-peach-300 text-lg tracking-wider">{escrow.symbol}</span>
          </div>
          <p className="font-family-ThaleahFat mt-2 text-xs tracking-wider text-gray-400">
            You escrow {escrow.symbol}; you receive {output.symbol} at settlement. Cancel any time before the cutoff.
          </p>
          <button
            onClick={onPlace}
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

        {/* Your orders */}
        <div className="bg-ground w-full rounded-2xl border-3 border-[#523525] p-5 shadow-[6px_6px_0_#000]">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-family-ThaleahFat text-peach-300 text-xl tracking-widest">YOUR ORDERS</span>
            <button onClick={load} className="font-family-ThaleahFat text-peach-300 cursor-pointer text-sm tracking-wider hover:text-white">
              ⟳ REFRESH
            </button>
          </div>
          {!isConnected ? (
            <p className="font-family-ThaleahFat py-4 text-center text-sm tracking-wider text-gray-400">Connect a wallet to see your orders.</p>
          ) : orders.length === 0 ? (
            <p className="font-family-ThaleahFat py-4 text-center text-sm tracking-wider text-gray-400">No orders yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {orders.map((o) => {
                const esc = escrowToken(o.zeroForOne);
                const out = outputToken(o.zeroForOne);
                const canSettle = o.exit.kind === "waitForSettlement" && nowTick >= Number(o.exit.readyAt);
                const canTimeout = o.exit.kind === "waitForTimeout";
                return (
                  <div key={`${o.epoch}-${o.index}`} className="rounded-xl border-2 border-[#523525] bg-[#2a1c12] px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-family-ThaleahFat tracking-wider">
                        <div className="text-peach-300 text-lg">
                          #{o.epoch.toString()}·{o.index.toString()} · {o.zeroForOne ? "WETH→USDG" : "USDG→WETH"} · {PHASE_LABEL[o.phase]}
                        </div>
                        <div className="text-xs text-gray-400">
                          escrow {formatUnits(o.amountIn, esc.decimals)} {esc.symbol}
                          {o.phase === QueuePhase.Settled && o.crossedBps > 0 ? ` · ${(o.crossedBps / 100).toFixed(1)}% crossed` : ""}
                        </div>
                        {(o.claimable.bought > 0n || o.claimable.refunded > 0n) && (
                          <div className="text-xs text-green-400">
                            claim {formatUnits(o.claimable.bought, out.decimals)} {out.symbol}
                            {o.claimable.refunded > 0n ? ` + ${formatUnits(o.claimable.refunded, esc.decimals)} ${esc.symbol}` : ""}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        {o.exit.kind === "cancel" && (
                          <button disabled={busy} onClick={() => run(`Cancelling…`, () => cancelOrder(o.epoch, o.index))} className="font-family-ThaleahFat cursor-pointer rounded-lg border-2 border-[#7a2f2f] bg-[#a13a3a] px-3 py-2 text-sm tracking-wider text-white disabled:opacity-60">CANCEL</button>
                        )}
                        {o.exit.kind === "claim" && (
                          <button disabled={busy} onClick={() => run(`Claiming…`, () => claimOrder(o.epoch, o.index))} className="font-family-ThaleahFat cursor-pointer rounded-lg border-2 border-[#3f7d20] bg-[#4e9d2a] px-3 py-2 text-sm tracking-wider text-white disabled:opacity-60">CLAIM</button>
                        )}
                        {o.exit.kind === "waitForSettlement" && !canSettle && (
                          <span className="font-family-ThaleahFat text-xs tracking-wider text-gray-400">settles in {mmss(Number(o.exit.readyAt) - nowTick)}</span>
                        )}
                        {canSettle && (
                          <button disabled={busy} onClick={() => run(`Settling…`, () => settleEpoch(o.epoch))} className="font-family-ThaleahFat cursor-pointer rounded-lg border-2 border-[#C97E00] bg-[#523525] px-3 py-2 text-sm tracking-wider text-yellow-200 disabled:opacity-60">SETTLE</button>
                        )}
                        {canTimeout && (
                          <>
                            <button disabled={busy} onClick={() => run(`Settling…`, () => settleEpoch(o.epoch))} className="font-family-ThaleahFat cursor-pointer rounded-lg border-2 border-[#C97E00] bg-[#523525] px-3 py-2 text-sm tracking-wider text-yellow-200 disabled:opacity-60">SETTLE</button>
                            <button disabled={busy} onClick={() => run(`Reclaiming…`, () => timeoutEpoch(o.epoch))} className="font-family-ThaleahFat cursor-pointer rounded-lg border-2 border-[#523525] px-3 py-2 text-xs tracking-wider text-peach-300 disabled:opacity-60">RECLAIM</button>
                          </>
                        )}
                        {o.exit.kind === "none" && (
                          <span className="font-family-ThaleahFat text-xs tracking-wider text-gray-500">paid out</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
