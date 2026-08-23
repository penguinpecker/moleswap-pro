"use client";
/**
 * MoleEngine — the creative surface for MoleSwap's internal pool machinery.
 *
 * The v4 ALM vault (managed liquidity) and the MoleQueue (batch settlement) are NOT standalone products —
 * they're how the MoleSwap pool actually works. So instead of nav pages, this panel shows them as the
 * pool's living engine on /pools: a batch "heartbeat" counting down to the next TWAP cross (the queue),
 * and a range bar showing where the vault's auto-managed liquidity sits vs. spot and the TWAP (the ALM).
 * The deposit + batch-order flows are reachable from here, as parts of the pool — not the top nav.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { fetchV4MolePool } from "@/lib/aggregator/venues/v4Reader";
import { getQueueSchedule } from "@/lib/mole/queueClient";
import { secondsUntilCutoff, type QueueSchedule } from "@/lib/mole/queue";
import { QUEUE_CONFIG } from "@/lib/mole/chain";
// The TWAP comes through the ONE staleness helper, never a bare consult(): a quiet pool and a stalled
// writer produce the same tick, and only the observation age tells them apart.
import { useOracleHealth } from "@/lib/mole/useOracleHealth";
import { OracleStaleBadge } from "../shared/OracleStale";

function mmss(s: number) {
  const x = Math.max(0, s);
  return `${Math.floor(x / 60)}:${(x % 60).toString().padStart(2, "0")}`;
}
const pct = (v: number) => `${Math.max(0, Math.min(100, v)) * 1}%`;

export function MoleEngine() {
  const [pool, setPool] = useState<{ tick: number; liquidity: bigint; fee: number; lo: number; hi: number } | null>(null);
  const [schedule, setSchedule] = useState<QueueSchedule | null>(null);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const load = useRef(async () => {});
  // {mid, observedAt, ageSec, stale} for the live pool + the Chainlink cross-check (display only).
  const { oracle, cross } = useOracleHealth({ crossCheck: true });
  const twap = oracle?.mid ?? null;

  load.current = async () => {
    try {
      const [p, sch] = await Promise.all([fetchV4MolePool().catch(() => null), getQueueSchedule().catch(() => null)]);
      if (p) {
        // TickData keys the tick by `index` (v3Pool.ts) — reading `.tick` yielded undefined for every
        // element, so lo/hi always fell through to a synthetic ±600 window that pinned spot at dead centre.
        const ticks = [...p.ticks].map((t) => t.index).sort((a, b) => a - b);
        // The band shown is the CURRENTLY ACTIVE one: the initialised ticks either side of spot. The
        // outermost ticks would just be tick space's own bounds (MoleSwap pools are seeded full-range),
        // which again pins spot at 50% and says nothing about where liquidity actually sits.
        const below = ticks.filter((t) => t <= p.tick);
        const above = ticks.filter((t) => t > p.tick);
        setPool({
          tick: p.tick,
          liquidity: p.liquidity,
          fee: p.fee,
          lo: below.length ? below[below.length - 1]! : p.tick - 600,
          hi: above.length ? above[0]! : p.tick + 600,
        });
      }
      if (sch) setSchedule(sch);
    } catch { /* keep prior */ }
  };

  useEffect(() => {
    load.current();
    const p = setInterval(() => load.current(), 15000);
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => { clearInterval(p); clearInterval(t); };
  }, []);

  const secLeft = schedule ? secondsUntilCutoff(schedule, BigInt(now)) : 0;
  const epoch = schedule ? schedule.currentEpoch.toString() : "—";

  /**
   * `inRange` is null until the pool reads — with lo/hi derived from the ticks that bracket spot, a
   * "is spot between lo and hi" test is true by construction and would claim "EARNING" on no data at
   * all. The honest signal is the pool's own in-range liquidity: > 0 means there is liquidity active
   * at the current tick, which is exactly what "in range, earning fees" means.
   */
  const { spotPos, twapPos, inRange } = useMemo(() => {
    if (!pool) return { spotPos: 50, twapPos: 50, inRange: null as boolean | null };
    const span = Math.max(1, pool.hi - pool.lo);
    const sp = ((pool.tick - pool.lo) / span) * 100;
    const tw = twap != null ? ((twap - pool.lo) / span) * 100 : sp;
    return { spotPos: sp, twapPos: tw, inRange: pool.liquidity > 0n };
  }, [pool, twap]);

  return (
    <div className="bg-ground relative mx-auto mb-5 w-full max-w-3xl overflow-hidden rounded-2xl border-3 border-[#C97E00] p-5 shadow-[6px_6px_0_#000]">
      {/* header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="font-display flex items-center gap-2 text-xl tracking-widest text-yellow-200 sm:text-2xl">
          <span className="inline-block animate-spin-slow">⚙</span> MOLESWAP ENGINE · WETH/USDG
        </div>
        <span className="font-display rounded bg-[#4e9d2a] px-2 py-1 text-xs tracking-wider text-white">v4 · ALM-MANAGED</span>
      </div>
      <p className="font-display mb-4 text-xs tracking-wider text-gray-300 sm:text-sm">
        The machinery under every MoleSwap trade: auto-managed liquidity, and a batch that crosses opposing
        orders at the TWAP before touching the pool.
      </p>

      {/* Batch heartbeat (the queue) */}
      <div className="mb-4 rounded-xl border-2 border-[#523525] bg-[#2a1c12] p-4">
        <div className="flex items-center justify-between">
          <div className="font-display flex items-center gap-2 tracking-widest text-peach-300">
            <span className={`h-3 w-3 rounded-full bg-green-400 ${secLeft > 0 ? "animate-ping-slow" : ""}`} />
            BATCH #{epoch}
          </div>
          <div className="font-display flex items-center gap-2 tracking-widest">
            {/* The batch crosses AT the TWAP — so the clock carries the TWAP's own health. */}
            {oracle?.stale && <OracleStaleBadge ageSec={oracle.ageSec} />}
            <span className="text-xs text-gray-400">CROSSES IN </span>
            <span className={`text-xl ${secLeft <= 10 ? "text-red-400" : "text-yellow-200"}`}>{mmss(secLeft)}</span>
          </div>
        </div>
        {/* progress bar toward the cross */}
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[#1a110a]">
          <div
            className="h-full bg-gradient-to-r from-[#6DBB3E] to-[#C97E00] transition-all duration-1000"
            style={{ width: pct(schedule ? (1 - secLeft / Math.max(1, schedule.epochDuration)) * 100 : 0) }}
          />
        </div>
        <p className="font-display mt-2 text-[11px] tracking-wider text-[#7a7]">
          opposing orders net at the TWAP — 0 slippage, 0 LP fee on the crossed part
        </p>
      </div>

      {/* ALM range (the vault) */}
      <div className="mb-4 rounded-xl border-2 border-[#523525] bg-[#2a1c12] p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-display tracking-widest text-peach-300">AUTO-MANAGED RANGE</span>
          {inRange !== null && (
            <span className={`font-display text-xs tracking-wider ${inRange ? "text-green-400" : "text-red-400"}`}>
              {inRange ? "● IN RANGE — EARNING" : "○ OUT OF RANGE"}
            </span>
          )}
        </div>
        <div className="relative h-8 w-full rounded-lg bg-[#1a110a]">
          {/* the vault's active band */}
          <div className="absolute inset-y-1 rounded bg-[#3a5a2a]" style={{ left: "6%", right: "6%" }} />
          {/* spot marker */}
          <div className="absolute inset-y-0 flex flex-col items-center" style={{ left: pct(6 + (spotPos / 100) * 88) }}>
            <div className="h-full w-[3px] bg-yellow-300" />
          </div>
          {/* twap marker */}
          <div className="absolute inset-y-0 flex flex-col items-center" style={{ left: pct(6 + (twapPos / 100) * 88) }}>
            <div className="h-full w-[2px] bg-[#5b9bd5] opacity-80" />
          </div>
        </div>
        <div className="font-display mt-2 flex flex-wrap items-center justify-between gap-x-2 text-[11px] tracking-wider text-gray-400">
          <span>lo tick {pool ? pool.lo : "—"}</span>
          <span className="text-yellow-300">▲ spot {pool ? pool.tick : "—"}</span>
          <span className="flex items-center gap-2 text-[#5b9bd5]">
            ▲ twap {twap ?? "—"}
            {oracle?.stale && <OracleStaleBadge ageSec={oracle.ageSec} />}
          </span>
          <span>hi tick {pool ? pool.hi : "—"}</span>
        </div>
        {/* Independent cross-check (G-1): our TWAP mid as USD/WETH against Chainlink ETH/USD. It detects a
            WRONG mid where the age detects a STALLED one. Display only — never a trade input. */}
        {cross && (
          <div className={`font-display mt-1 text-[11px] tracking-wider ${cross.warn ? "text-red-400" : "text-gray-500"}`}>
            twap ${cross.ourUsd.toFixed(2)} vs chainlink ${cross.chainlinkUsd.toFixed(2)} · Δ {(cross.deviationBps / 100).toFixed(2)}%
            {cross.warn ? " ⚠ DEVIATION" : ""}
          </div>
        )}
      </div>

      {/* stats + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="font-display text-xs tracking-wider text-gray-300">
          fee {pool ? (pool.fee / 10000).toFixed(2) : "—"}% · depth {pool ? (Number(pool.liquidity) / 1e12).toFixed(2) : "—"} · settlement every {schedule ? schedule.epochDuration : QUEUE_CONFIG.epochDuration}s
        </div>
        <div className="flex gap-2">
          <Link href="/vault" className="font-display cursor-pointer rounded-lg border-2 border-[#3f7d20] bg-[#4e9d2a] px-3 py-2 text-sm tracking-wider text-white transition-all hover:brightness-110">
            PROVIDE LIQUIDITY
          </Link>
          <Link href="/queue" className="font-display cursor-pointer rounded-lg border-2 border-[#C97E00] bg-[#523525] px-3 py-2 text-sm tracking-wider text-yellow-200 transition-all hover:brightness-110">
            QUEUE A SWAP
          </Link>
        </div>
      </div>
    </div>
  );
}
