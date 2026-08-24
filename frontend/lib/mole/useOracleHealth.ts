"use client";
/**
 * useOracleHealth — the staleness contract as a hook, so every screen that shows a TWAP-derived number
 * polls the SAME helper on the same cadence and renders the same state. One network reader, one
 * threshold, one piece of copy (see lib/mole/oracle.ts).
 *
 * Keeps the prior value on a failed read rather than flashing "unknown": an unknown age is reported as
 * stale by the helper itself, so a screen that has never read successfully shows nothing rather than a
 * fresh-looking mid, and a screen that has read once keeps that reading and its (growing) age honest by
 * re-deriving `ageSec`/`stale` from the wall clock every second.
 */
import { useEffect, useState } from "react";
import type { Hex } from "./chain";
import { LIVE_POOL_ID, QUEUE_CONFIG } from "./chain";
import { RH_CHAIN } from "@/lib/chain/chains";
import {
  oracleClient,
  oracleHookFor,
  oracleStaleness,
  readLivePoolCrossCheck,
  readOracleHealth,
  type CrossCheck,
  type OracleHealth,
} from "./oracle";

const POLL_MS = 15_000;

export interface OracleHealthView {
  /** Null until the first successful read. */
  readonly oracle: OracleHealth | null;
  /** Chainlink cross-check for the live WETH/USDG pool; null for other pools or until read. */
  readonly cross: CrossCheck | null;
}

export function useOracleHealth(
  opts: { poolId?: Hex; chainId?: number; enabled?: boolean; crossCheck?: boolean } = {},
): OracleHealthView {
  const poolId = opts.poolId ?? (LIVE_POOL_ID as Hex);
  // Omitting the chain keeps the Robinhood reading every screen had before the ALM shipped on Arc. A
  // screen that resolves its own chain (the vault card) passes it, so the badge speaks about the pool
  // on screen rather than about Robinhood's.
  const chainId = opts.chainId ?? RH_CHAIN.id;
  const enabled = opts.enabled ?? true;
  // The Chainlink reference is an ETH/USD feed deployed on Robinhood; there is no equivalent on Arc,
  // and a cross-check run against a chain that has no feed would compare a price to nothing. Gated on
  // the pool AND the chain, not on the pool alone — ids are per-chain, so pool identity is not enough.
  const wantCross =
    (opts.crossCheck ?? false) &&
    chainId === RH_CHAIN.id &&
    poolId.toLowerCase() === LIVE_POOL_ID.toLowerCase();
  const [read, setRead] = useState<OracleHealth | null>(null);
  const [cross, setCross] = useState<CrossCheck | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    // A different pool is a different series: never carry one pool's reading or cross-check to another.
    // The same goes for a different chain — the pool id alone does not identify the ring it came from.
    setRead(null);
    setCross(null);
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        // Reader and hook are resolved from the SAME chain id, together, so they cannot drift apart.
        const c = oracleClient(chainId);
        const hook = oracleHookFor(chainId);
        const nowSec = Math.floor(Date.now() / 1000);
        const h = await readOracleHealth(c, poolId, nowSec, QUEUE_CONFIG.twapWindow, hook);
        if (cancelled) return;
        setRead(h);
        if (wantCross && h.mid !== null) {
          try {
            const x = await readLivePoolCrossCheck(c, h.mid, nowSec);
            if (!cancelled) setCross(x);
          } catch {
            /* reference unavailable — keep the prior cross-check */
          }
        }
      } catch {
        /* keep prior */
      }
    };
    load();
    const p = setInterval(load, POLL_MS);
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => {
      cancelled = true;
      clearInterval(p);
      clearInterval(t);
    };
  }, [poolId, chainId, enabled, wantCross]);

  // Age keeps counting between polls; staleness flips on the boundary without waiting for a refresh.
  const oracle = read ? { ...read, ...oracleStaleness(read.observedAt, now) } : null;
  return { oracle, cross };
}
