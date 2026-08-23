/**
 * rpcBatch.ts — one JSON-RPC batch, one HTTP round trip, per-call results.
 *
 * The hooked-pool quote path (hookedQuote.ts) and the hook screen (hookRisk.ts) need a handful of
 * heterogeneous reads per quote — quoter eth_calls, StateView eth_calls, eth_getCode, eth_getStorageAt —
 * and the whole point of that path is to add ONE round trip to a quote, not one per read (learnings 19.2:
 * an aggregator is fast because it computes, not because it asks). FetchTransport.batchCall is eth_call-
 * only and throws on the first per-call error, which is wrong here: one reverting quoter call must not
 * discard the other candidates' answers. So this returns a result OR an error PER CALL, re-paired by id
 * (nodes may answer out of order), and throws only when the whole round trip fails (HTTP, timeout, bad JSON).
 */

export interface RpcBatchCall {
  method: string;
  params: unknown[];
}

export type RpcBatchResult = { ok: true; result: string } | { ok: false; error: string };

/** Default per-batch latency ceiling; a slow endpoint fails the whole batch closed (caller excludes). */
export const RPC_BATCH_TIMEOUT_MS = 1_500;

/**
 * Send `calls` as one JSON-RPC batch to `url`. Resolves to one entry per call, in call order. Throws on a
 * transport-level failure (network, HTTP error, timeout, unparseable body) — never on a per-call error.
 */
export async function jsonRpcBatch(
  url: string,
  calls: readonly RpcBatchCall[],
  timeoutMs: number = RPC_BATCH_TIMEOUT_MS,
): Promise<RpcBatchResult[]> {
  if (calls.length === 0) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params }))),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = (await res.json()) as
      | { id: number; result?: unknown; error?: { message?: string; code?: number } }[]
      | { id: number; result?: unknown; error?: { message?: string; code?: number } };
    // A batch of one may come back as a bare object on some nodes; normalise.
    const arr = Array.isArray(json) ? json : [json];
    const byId = new Map<number, { result?: unknown; error?: { message?: string; code?: number } }>();
    for (const r of arr) byId.set(Number(r.id), r);
    return calls.map((c, i): RpcBatchResult => {
      const r = byId.get(i);
      if (!r) return { ok: false, error: `missing response for ${c.method}` };
      if (r.error) return { ok: false, error: r.error.message || `${c.method} failed (${r.error.code ?? "?"})` };
      if (typeof r.result !== "string") return { ok: false, error: `${c.method} returned no result` };
      return { ok: true, result: r.result };
    });
  } finally {
    clearTimeout(timer);
  }
}
