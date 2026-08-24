"use client";
/**
 * ProvenanceCard — what a pool IS, read from the chain, with an honest mutability label per line.
 *
 * The headline is arithmetic, not copy: the hook's permission bits are its address, and the three
 * remove-liquidity bits (9, 8, 0) are clear — `uint160(hook) & 0x0301 == 0` — so the PoolManager can never
 * call MoleHook on a withdrawal. That is computed here from the address, every render. Everything else
 * (PoolId, currencies + decimals, tickSpacing, the live lpFee from slot0, proxy status and upgrade keys of
 * the hook / vault / queue / router) is read live by lib/mole/provenance.ts. Nothing is labelled IMMUTABLE
 * unless it is hashed into the PoolId or its upgrade key is provably burned.
 */
import { useEffect, useRef, useState } from "react";
import type { V4PoolKey } from "@/lib/mole/poolId";
import { hookBitmapProof } from "@/lib/mole/hookBitmap";
import {
  readPoolProvenance,
  provenanceRows,
  type PoolProvenance,
  type Mutability,
} from "@/lib/mole/provenance";

const MUTABILITY_CLASS: Record<Mutability, string> = {
  IMMUTABLE: "border-[#3f7d20] text-green-400",
  UPGRADEABLE: "border-[#C97E00] text-yellow-300",
  TUNABLE: "border-[#C97E00] text-orange-300",
  UNVERIFIED: "border-[#523525] text-gray-400",
  ABSENT: "border-[#3a2a1e] text-gray-500",
};

const short = (a: string) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function ProvenanceCard({
  poolKey,
  chainId,
  defaultOpen = false,
}: {
  poolKey: V4PoolKey;
  /**
   * The chain this pool lives on. REQUIRED in practice even though it is optional in the type: the
   * reader falls back to Robinhood when it is absent, and a provenance card that silently describes
   * the wrong chain is the one failure this component must never have.
   */
  chainId?: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState<PoolProvenance | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useRef(async () => {});

  // The bitmap proof needs no network — it is the address. Shown before and regardless of the chain read.
  const proof = hookBitmapProof(poolKey.hooks);

  load.current = async () => {
    try {
      setData(await readPoolProvenance(poolKey, chainId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };

  useEffect(() => {
    if (!open) return;
    load.current();
    const t = setInterval(() => load.current(), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, chainId, poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]);

  const rows = data ? provenanceRows(data) : [];

  return (
    <div className="rounded-xl border-2 border-[#523525] bg-[#2a1c12] p-4" data-testid="provenance-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="font-display flex w-full cursor-pointer items-center justify-between gap-2 text-left tracking-widest text-peach-300"
        aria-expanded={open}
      >
        <span>PROVENANCE · hook {short(poolKey.hooks)}</span>
        <span className={`text-xs ${proof.removeBitsClear ? "text-green-400" : "text-red-400"}`}>
          & 0x0301 == 0 {proof.removeBitsClear ? "✓" : "✗"} {open ? "▴" : "▾"}
        </span>
      </button>

      {open && (
        <div className="mt-3">
          {/* the 14 permission bits, bit 13 first; the remove-liquidity bits are outlined */}
          <div className="flex flex-wrap items-end gap-1" aria-label="hook permission bits">
            {proof.bits.map((b) => (
              <span key={b.bit} className="flex flex-col items-center" title={b.name}>
                <span
                  className={`font-display flex h-6 w-6 items-center justify-center rounded text-xs ${
                    b.removePath
                      ? b.set
                        ? "border-2 border-red-400 bg-red-900/40 text-red-300"
                        : "border-2 border-green-400 bg-[#1a110a] text-green-400"
                      : b.set
                        ? "bg-[#C97E00] text-black"
                        : "bg-[#1a110a] text-gray-500"
                  }`}
                >
                  {b.set ? 1 : 0}
                </span>
                <span className="text-[9px] text-gray-500">{b.bit}</span>
              </span>
            ))}
          </div>
          <p className="font-display mt-2 text-[11px] tracking-wider text-gray-300">
            {proof.proofLine} · bits 9, 8, 0 clear → PoolManager never calls this hook on a withdrawal
          </p>
          <code className="mt-1 block break-all text-[10px] text-gray-400">
            (BigInt(&quot;{poolKey.hooks}&quot;) &amp; 0x0301n) === 0n
          </code>
          <p className="font-display mt-1 text-[10px] tracking-wider text-gray-500">
            bits prove which callbacks can fire, not who deployed the hook
          </p>

          {/* chain-read rows */}
          <div className="mt-3 divide-y divide-[#3a2518]">
            {rows.length === 0 ? (
              <div className="font-display py-2 text-[11px] tracking-wider text-gray-400">
                {failed ? "chain read failed — retrying" : "reading chain…"}
              </div>
            ) : (
              rows.map((r) => (
                <div key={r.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5" data-row={r.key}>
                  <span className="font-display w-32 shrink-0 text-[11px] tracking-wider text-gray-400">{r.label}</span>
                  <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-gray-200">
                    {r.value}
                    {r.ok !== undefined && (
                      <span className={`ml-1 ${r.ok ? "text-green-400" : "text-red-400"}`}>{r.ok ? "✓" : "✗"}</span>
                    )}
                    {r.note && <span className="ml-2 text-gray-500">{r.note}</span>}
                  </span>
                  <span
                    className={`font-display shrink-0 rounded border px-1.5 py-0.5 text-[9px] tracking-wider ${MUTABILITY_CLASS[r.mutability]}`}
                    data-mutability={r.mutability}
                  >
                    {r.mutability}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
