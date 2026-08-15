/**
 * metrics.ts — how many people use the Arc RPC, and how many transactions go through it.
 *
 * TWO RULES THIS FILE EXISTS TO KEEP:
 *
 *  1. IT MUST NEVER SLOW DOWN OR BREAK AN RPC CALL. Counting is recorded into an in-memory
 *     buffer (microseconds) and flushed to Supabase from `after()`, i.e. once the response
 *     has already gone back to the wallet. Every path is wrapped so that a metrics outage
 *     is invisible to users: if Supabase is down, the RPC keeps answering.
 *
 *  2. IT MUST NOT BUILD A PROFILE. An RPC sees every address a wallet asks about, which
 *     makes it the single best place in this codebase to accidentally build surveillance.
 *     Nothing here reads `params`. No IP, wallet address, or payload is ever stored — see
 *     the schema header in 007_rpc_metrics.sql, where the guarantee is enforced by there
 *     being no column to put one in.
 *
 * ⚠️ Counts are approximate by construction. The buffer lives in one serverless instance, so
 * a flush lost to an instance being recycled loses its counters. That is the right trade for
 * "never add latency to a swap" — treat these as traffic figures, not as an accounting ledger.
 */

import { createHash } from "node:crypto";

/* ------------------------------------------------------------------ config */

/** Flush when the buffer reaches this many recorded calls… */
const FLUSH_AT_EVENTS = 200;
/** …or when it is this old, whichever comes first. */
const FLUSH_AFTER_MS = 20_000;
/** Hard cap on distinct visitor hashes held in memory between flushes. */
const MAX_BUFFERED_VISITORS = 5_000;
/** Hard cap on distinct method names held in memory (defends against junk-method spam). */
const MAX_BUFFERED_METHODS = 200;

function writeSecret(): string | undefined {
  return process.env.MP_WRITE_SECRET || process.env.INDEXER_SECRET || undefined;
}

/**
 * The secret half of the visitor salt.
 *
 * Derived from the existing write secret with a domain separator, so counting works with the
 * environment the project already has and nobody has to provision anything. Set
 * ARC_RPC_METRICS_SALT to make it independent of the write secret.
 *
 * Returns undefined when no secret exists — and in that case visitor counting is DISABLED
 * rather than falling back to a date-only salt. A date-only salt is not privacy: an attacker
 * holding the table could hash all four billion IPv4 addresses and reverse every row.
 */
function visitorSalt(): string | undefined {
  const explicit = process.env.ARC_RPC_METRICS_SALT;
  if (explicit) return explicit;
  const secret = writeSecret();
  if (!secret) return undefined;
  return createHash("sha256").update(`arc-rpc-visitor-salt:${secret}`).digest("hex");
}

/** UTC day key. Deliberately UTC so instances in different regions agree on the boundary. */
export function dayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * One-way, day-scoped visitor identifier.
 *
 * sha256(ip : day : secret), truncated to 128 bits — plenty to avoid collisions at this scale,
 * and less material to store. Because the day is inside the hash, the same person is a
 * different hash tomorrow and cannot be tracked across days.
 */
export function visitorHash(ip: string, day: string, salt: string): string {
  return createHash("sha256").update(`${ip}:${day}:${salt}`).digest("hex").slice(0, 32);
}

/* ------------------------------------------------------------------ buffer */

interface Buffer {
  day: string;
  since: number;
  events: number;
  methods: Map<string, { requests: number; errors: number }>;
  visitors: Set<string>;
  transactions: number;
}

function emptyBuffer(day: string): Buffer {
  return { day, since: Date.now(), events: 0, methods: new Map(), visitors: new Set(), transactions: 0 };
}

let buffer: Buffer = emptyBuffer(dayKey());

export interface CallRecord {
  method: string;
  /** True when this call came back as a JSON-RPC error (including honest reverts). */
  errored: boolean;
  /** True only for an eth_sendRawTransaction that returned a transaction hash. */
  broadcast?: boolean;
}

/**
 * Record one HTTP request's worth of calls. Pure in-memory bookkeeping — no I/O, no awaits.
 *
 * @param ip client address, used ONLY to derive a salted hash. It is never stored.
 */
export function record(calls: CallRecord[], ip: string): void {
  try {
    const day = dayKey();

    // Day rolled over mid-buffer: flush the old day rather than filing it under the new one.
    if (day !== buffer.day) {
      const stale = buffer;
      buffer = emptyBuffer(day);
      void flushBuffer(stale);
    }

    for (const c of calls) {
      if (!c.method) continue;
      let row = buffer.methods.get(c.method);
      if (!row) {
        if (buffer.methods.size >= MAX_BUFFERED_METHODS) continue;
        row = { requests: 0, errors: 0 };
        buffer.methods.set(c.method, row);
      }
      row.requests++;
      if (c.errored) row.errors++;
      if (c.broadcast) buffer.transactions++;
      buffer.events++;
    }

    const salt = visitorSalt();
    if (salt && ip && ip !== "unknown" && buffer.visitors.size < MAX_BUFFERED_VISITORS) {
      buffer.visitors.add(visitorHash(ip, day, salt));
    }
  } catch {
    /* metrics must never surface to the caller */
  }
}

/** True when the buffer has earned a flush. Checked after the response is already sent. */
export function shouldFlush(now = Date.now()): boolean {
  if (buffer.events === 0 && buffer.visitors.size === 0) return false;
  return buffer.events >= FLUSH_AT_EVENTS || now - buffer.since >= FLUSH_AFTER_MS;
}

/**
 * Swap the live buffer out and ship it. Swapping FIRST means calls arriving during the
 * network round trip accumulate into the fresh buffer instead of being double-counted or lost.
 */
export async function flush(): Promise<void> {
  const pending = buffer;
  buffer = emptyBuffer(dayKey());
  await flushBuffer(pending);
}

async function flushBuffer(b: Buffer): Promise<void> {
  if (b.events === 0 && b.visitors.size === 0) return;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const secret = writeSecret();
  // No destination configured is a no-op, not an error. The RPC does not depend on this.
  if (!url || !anon || !secret) return;

  const methods = [...b.methods.entries()].map(([method, v]) => ({
    method,
    requests: v.requests,
    errors: v.errors,
  }));

  try {
    await fetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/mp_rpc_record`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${anon}` },
      body: JSON.stringify({
        p_secret: secret,
        p_day: b.day,
        p_methods: methods,
        p_visitors: [...b.visitors],
        p_transactions: b.transactions,
      }),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
  } catch {
    // Dropped counters are acceptable; a broken swap is not. Deliberately not retried —
    // a retry queue in a serverless instance is a memory leak with extra steps.
  }
}

/**
 * Classify an upstream reply into per-call records, for counting only.
 *
 * Reads nothing but the method name and whether an `error` came back — never `params`,
 * never a result. `broadcast` is true only when eth_sendRawTransaction returned a hash,
 * so a rejected or malformed broadcast never inflates the transaction count.
 */
export function summarise(requests: { method?: unknown; id?: unknown }[], responseBody: string): CallRecord[] {
  const out: CallRecord[] = [];

  let byId: Map<string, { error?: unknown; result?: unknown }> | null = null;
  try {
    const parsed = JSON.parse(responseBody);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    byId = new Map();
    for (const e of entries) {
      if (e && typeof e === "object") byId.set(String((e as { id?: unknown }).id), e);
    }
  } catch {
    byId = null; // oversized or non-JSON body — count the calls, skip the outcome detail
  }

  for (const r of requests) {
    if (typeof r?.method !== "string") continue;
    const reply = byId?.get(String(r.id));
    const errored = Boolean(reply && (reply as { error?: unknown }).error);
    const result = reply ? (reply as { result?: unknown }).result : undefined;
    out.push({
      method: r.method,
      errored,
      broadcast: r.method === "eth_sendRawTransaction" && typeof result === "string" && result.startsWith("0x"),
    });
  }

  return out;
}

/** Test seam. */
export function __resetMetrics() {
  buffer = emptyBuffer(dayKey());
}
export function __peekBuffer() {
  return {
    day: buffer.day,
    events: buffer.events,
    transactions: buffer.transactions,
    visitors: buffer.visitors.size,
    methods: Object.fromEntries(buffer.methods),
  };
}
