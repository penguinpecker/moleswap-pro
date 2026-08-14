/**
 * multicall.ts — Multicall3 aggregate3 primitives + a batched v3 pool-state reader.
 *
 * WHY THIS EXISTS. Two code paths need the live state of many pools at once: the 1-second live-quote
 * session (live.ts) and the cold quote built right before a user signs (client.ts / executeSwap). The
 * naive reader fetches each pool with its own JSON-RPC round trips; across ~14 pools that is dozens of
 * requests and seconds of latency, and on a busy endpoint some silently drop. aggregate3 collapses the
 * whole set into ONE eth_call to Multicall3, so the state behind the quote is a single round trip and is
 * internally consistent (every pool read at the same block). This module is the one implementation of that
 * machinery; live.ts imports the encoders here rather than keeping its own copy.
 *
 * The ABI encode/decode is done by hand to keep the router package dependency-free — the same discipline
 * as indexer.ts, and checked by the same to-the-wei decoders (decodeSlot0/decodePopulatedTicks).
 */

import type { PoolState, TickData } from "./venues/v3Pool";
import {
  decodeSlot0,
  decodeUint,
  decodePopulatedTicks,
  INDEXER_SELECTORS,
  DEFAULT_WORD_RADIUS,
  wordsToFetch,
} from "./indexer";
import { PANCAKE_V3, ROBINHOOD_RPC_URL } from "../mole/chain";

export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const AGGREGATE3_SELECTOR = "0x82ad56cb";

/* ------------------------------------------------------------------ raw aggregate3 encode/decode */

function pad32(hexNo0x: string): string {
  return hexNo0x.padStart(64, "0");
}
export function encAddress(addr: string): string {
  return pad32(addr.toLowerCase().replace(/^0x/, ""));
}
export function encInt16(v: number): string {
  return pad32(BigInt.asUintN(256, BigInt(v)).toString(16));
}

export interface RawCall {
  target: string;
  callData: string; // 0x-prefixed
}

/** ABI-encode Multicall3.aggregate3((address,bool,bytes)[]) by hand — no ABI dependency. */
export function encodeAggregate3(calls: RawCall[]): string {
  const head: string[] = [];
  let dynOffset = calls.length * 32; // offsets area size within the array's data region
  const bodies: string[] = [];
  for (const c of calls) {
    const data = c.callData.replace(/^0x/, "");
    const dataLen = data.length / 2;
    const padded = data.padEnd(Math.ceil(dataLen / 32) * 64, "0");
    // tuple: target, allowFailure(true), offset-to-bytes(0x60), bytes-len, bytes
    const body =
      encAddress(c.target) +
      pad32("1") +
      pad32((0x60).toString(16)) +
      pad32(dataLen.toString(16)) +
      padded;
    bodies.push(body);
  }
  for (const body of bodies) {
    head.push(pad32(dynOffset.toString(16)));
    dynOffset += body.length / 2;
  }
  return (
    AGGREGATE3_SELECTOR +
    pad32((0x20).toString(16)) +
    pad32(calls.length.toString(16)) +
    head.join("") +
    bodies.join("")
  );
}

/** Decode aggregate3's (bool success, bytes returnData)[] result. */
export function decodeAggregate3(hex: string): { success: boolean; data: string }[] {
  const body = hex.replace(/^0x/, "");
  const word = (i: number) => body.slice(i * 64, i * 64 + 64);
  const uintAt = (i: number) => Number(BigInt("0x" + word(i)));
  const arrayBase = uintAt(0) / 32; // usually 1
  const len = uintAt(arrayBase);
  const out: { success: boolean; data: string }[] = [];
  for (let i = 0; i < len; i++) {
    const tupleOffset = arrayBase + 1 + uintAt(arrayBase + 1 + i) / 32;
    const success = BigInt("0x" + word(tupleOffset)) === 1n;
    const bytesOffset = tupleOffset + uintAt(tupleOffset + 1) / 32;
    const bytesLen = uintAt(bytesOffset);
    const data = "0x" + body.slice((bytesOffset + 1) * 64, (bytesOffset + 1) * 64 + bytesLen * 2);
    out.push({ success, data });
  }
  return out;
}

export async function rpcCall(rpc: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result as string;
}

/* ------------------------------------------------------------------ batched v3 pool-state reader */

/** A pool whose immutables are already known (from the registry / discovery), so only its DYNAMIC state
 *  (slot0, liquidity, tick window) has to be read. */
export interface V3PoolImmutables {
  address: string;
  token0: string;
  token1: string;
  fee: number;
  tickSpacing: number;
}

const DEFAULT_RPC =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) || ROBINHOOD_RPC_URL;

/**
 * The batched pool-state read FAILED — this is not "these pools have no liquidity".
 *
 * WHY THIS TYPE EXISTS. Both phases used to swallow their own RPC failure: phase 1 returned `[]` and
 * phase 2 fell back to `p2 = []`. Both are lies with real money attached:
 *   - phase 1's `[]` is indistinguishable from "this pair has no V3 pools", so a degraded or
 *     rate-limited endpoint silently collapsed the aggregator to the single hardcoded v4 pool while the
 *     caller's own error handler (client.ts) could never fire, because nothing ever threw;
 *   - phase 2's `[]` was worse — see the drop rule below.
 * Throwing keeps the caller's existing try/catch meaningful: it logs the real reason and still falls
 * through to the v4 venues, so behaviour degrades identically but VISIBLY.
 */
export class PoolStateReadError extends Error {
  /** Which aggregate3 round trip failed. */
  readonly phase: "slot0" | "ticks";
  /** The original throw, kept for logging. */
  readonly detail: unknown;
  constructor(phase: "slot0" | "ticks", message: string, detail?: unknown) {
    super(message);
    this.name = "PoolStateReadError";
    this.phase = phase;
    this.detail = detail;
  }
}

/**
 * Read the live state of many v3 pools in exactly TWO aggregate3 round trips, regardless of pool count:
 *   phase 1 — slot0 + liquidity for every pool (one eth_call), which reveals each pool's current tick;
 *   phase 2 — the tick window around each pool's freshly-read tick (one eth_call).
 *
 * The immutables come from the caller (registry/discovery rows), so no per-pool fee/spacing/token reads
 * happen here — that is the whole point. A pool whose slot0/liquidity read fails is dropped rather than
 * poisoning the batch. Pools with zero usable liquidity (no in-range liquidity and no ticks) are filtered
 * out, matching fetchV3Pool's contract so the quoter never sees a dead pool.
 *
 * A POOL WITH AN INCOMPLETE TICK WINDOW IS DROPPED, NOT QUOTED. This is the load-bearing rule here.
 * Phase 2 is ~15 sub-calls per pool against phase 1's 2, so it is by far the likelier one to fail, and
 * aggregate3 is encoded with allowFailure=true — an individual tickLens call can come back
 * `success:false` with nothing thrown at all. The old code emitted such a pool with `ticks: []`, which
 * reads as "best effort" but is not: the quoter's exhaustion guard in venues/v3Pool.ts bounds the walk by
 * `ticks[0]` / `ticks[ticks.length - 1]`, and on an EMPTY array those optional-chains fall back to
 * MIN_TICK/MAX_TICK, so the guard is trivially true at every step. The simulator then walks all of tick
 * space holding the in-range liquidity constant, never crossing a tick, and `exhaustedTickData` never
 * fires — measured on this repo's own live fixture at +112.8% over the true output at 50k USDG in, and
 * +312.9% at 1M. That inflated number becomes `minAmountOut`, so the swap reverts on-chain (or the keeper
 * burns gas on a fill that can never clear). A refusal to quote is the honest outcome, and the machinery
 * for it already exists downstream — it was simply never reached.
 */
export async function fetchV3StatesMulticall(
  pools: V3PoolImmutables[],
  rpc: string = DEFAULT_RPC,
  tickLens: string = PANCAKE_V3.tickLens,
  wordRadius: number = DEFAULT_WORD_RADIUS,
): Promise<PoolState[]> {
  if (pools.length === 0) return [];

  // ---- phase 1: slot0 + liquidity for all pools ----
  const p1Calls: RawCall[] = [];
  const p1Layout: { pool: V3PoolImmutables; slot0Idx: number; liqIdx: number }[] = [];
  for (const p of pools) {
    const slot0Idx = p1Calls.length;
    p1Calls.push({ target: p.address, callData: INDEXER_SELECTORS.slot0 });
    const liqIdx = p1Calls.length;
    p1Calls.push({ target: p.address, callData: INDEXER_SELECTORS.liquidity });
    p1Layout.push({ pool: p, slot0Idx, liqIdx });
  }

  let p1: { success: boolean; data: string }[];
  try {
    p1 = decodeAggregate3(await rpcCall(rpc, MULTICALL3, encodeAggregate3(p1Calls)));
  } catch (err) {
    // The endpoint is down / rate-limiting / returning garbage. Returning [] here would hand the caller
    // a successful-looking "no V3 pools", which is a different fact entirely.
    throw new PoolStateReadError(
      "slot0",
      `slot0/liquidity multicall failed for ${pools.length} pool(s): ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }

  interface Base {
    pool: V3PoolImmutables;
    sqrtPriceX96: bigint;
    tick: number;
    liquidity: bigint;
  }
  const bases: Base[] = [];
  for (const item of p1Layout) {
    const s = p1[item.slot0Idx];
    const l = p1[item.liqIdx];
    if (!s?.success || !l?.success) continue;
    try {
      const slot0 = decodeSlot0(s.data);
      const liquidity = decodeUint(l.data);
      bases.push({ pool: item.pool, sqrtPriceX96: slot0.sqrtPriceX96, tick: slot0.tick, liquidity });
    } catch {
      /* drop an undecodable pool */
    }
  }
  if (bases.length === 0) {
    // The call itself came back, but not one pool yielded a usable slot0+liquidity pair. With
    // allowFailure=true that is what a degraded endpoint looks like from the inside, and it is NOT the
    // same statement as "this pair has no V3 liquidity" — so say which one it is.
    throw new PoolStateReadError(
      "slot0",
      `slot0/liquidity multicall returned no usable state for any of ${pools.length} pool(s)`,
    );
  }

  // ---- phase 2: tick window around each pool's current tick ----
  const p2Calls: RawCall[] = [];
  const p2Layout: { base: Base; wordIdxs: number[] }[] = [];
  for (const b of bases) {
    const centerWord = Math.floor(Math.floor(b.tick / b.pool.tickSpacing) / 256);
    const wordIdxs: number[] = [];
    for (const w of wordsToFetch(centerWord, b.pool.tickSpacing, wordRadius)) {
      wordIdxs.push(p2Calls.length);
      p2Calls.push({
        target: tickLens,
        callData:
          "0x" +
          INDEXER_SELECTORS.getPopulatedTicksInWord.replace(/^0x/, "") +
          encAddress(b.pool.address) +
          encInt16(w),
      });
    }
    p2Layout.push({ base: b, wordIdxs });
  }

  let p2: { success: boolean; data: string }[];
  try {
    p2 = decodeAggregate3(await rpcCall(rpc, MULTICALL3, encodeAggregate3(p2Calls)));
  } catch (err) {
    // Tick reads failed for EVERY pool. There is no honest quote to be had from slot0/liquidity alone
    // (see the drop rule in this function's doc comment), so refuse rather than invent one.
    throw new PoolStateReadError(
      "ticks",
      `tick-window multicall failed for ${bases.length} pool(s) (${p2Calls.length} word reads): ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }

  const out: PoolState[] = [];
  const dropped: string[] = [];
  for (const item of p2Layout) {
    const ticks: TickData[] = [];
    // A word read that did not come back cleanly leaves a HOLE in the window. The quoter cannot see a
    // hole — it walks straight through it at constant liquidity — so one bad word disqualifies the pool.
    let badWords = 0;
    for (const wi of item.wordIdxs) {
      const r = p2[wi];
      if (!r?.success || !r.data || r.data === "0x") {
        badWords++;
        continue;
      }
      try {
        ticks.push(...decodePopulatedTicks(r.data));
      } catch {
        badWords++;
      }
    }
    const byIndex = new Map<number, TickData>();
    for (const t of ticks) byIndex.set(t.index, t);
    const b = item.base;
    const state: PoolState = {
      address: b.pool.address,
      token0: b.pool.token0,
      token1: b.pool.token1,
      fee: b.pool.fee,
      tickSpacing: b.pool.tickSpacing,
      sqrtPriceX96: b.sqrtPriceX96,
      tick: b.tick,
      liquidity: b.liquidity,
      ticks: [...byIndex.values()].sort((a, c) => a.index - c.index),
      venue: "PancakeV3",
    };
    if (badWords > 0) {
      dropped.push(`${b.pool.address} (${badWords}/${item.wordIdxs.length} words unreadable)`);
      continue;
    }
    // Every word read cleanly and still no tick anywhere in the window — including the two full-range
    // extremes wordsToFetch always asks for. A pool holding liquidity must have initialised ticks
    // SOMEWHERE, so this state cannot be priced: the exhaustion guard would have no bound to work with
    // and would silently pass at any size. Drop it; a pool with no liquidity and no ticks is simply dead
    // and was already filtered out below.
    if (state.ticks.length === 0 && state.liquidity > 0n) {
      dropped.push(`${b.pool.address} (liquidity ${state.liquidity} but no ticks in window)`);
      continue;
    }
    if (state.liquidity > 0n || state.ticks.length > 0) out.push(state);
  }
  if (dropped.length > 0) {
    // Never silent: an unpriceable pool is a missing venue, and a missing venue is a worse price.
    console.warn(
      `[aggregator] incomplete tick data — ${dropped.length}/${p2Layout.length} v3 pool(s) excluded from this quote rather than priced as constant-liquidity:`,
      dropped.join(", "),
    );
  }
  return out;
}
