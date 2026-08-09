/**
 * transport.ts — a fetch-based RpcTransport for the aggregator indexer.
 *
 * The indexer (ported from the router package) is transport-agnostic on purpose: it takes an
 * `RpcTransport` so the same, chain-verified decoders run in a browser, a Next.js API route, or the
 * Railway indexer service without change. This is the browser/server implementation, backed by a JSON-RPC
 * endpoint. Batched calls go out as a single JSON-RPC batch request, which is what keeps a full-graph
 * quote to a handful of round trips instead of one per pool.
 */

import type { RpcTransport } from "./indexer";
import { ROBINHOOD_RPC_URL } from "../mole/chain";

/**
 * The RPC every aggregator read goes through. Defaults to the configured endpoint
 * (NEXT_PUBLIC_RH_RPC_URL, i.e. Alchemy) and only falls back to the public RPC when
 * unset. This MUST match the endpoint the live-quote session uses, or the route the
 * card displays (built on the configured RPC's full pool set) would differ from the
 * route that executes (executeSwap re-quotes through this transport) — the public RPC
 * rate-limits a many-pool fetch and silently drops venues, yielding a worse route.
 */
const DEFAULT_RPC_URL =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) || ROBINHOOD_RPC_URL;

interface JsonRpcResponse {
  id: number;
  result?: string;
  error?: { code: number; message: string };
}

export class FetchTransport implements RpcTransport {
  constructor(private readonly url: string = DEFAULT_RPC_URL) {}

  async call(to: string, data: string): Promise<string> {
    const [out] = await this.batchCall([{ to, data }]);
    return out!;
  }

  async batchCall(calls: { to: string; data: string }[]): Promise<string[]> {
    if (calls.length === 0) return [];
    const body = calls.map((c, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "eth_call",
      params: [{ to: c.to, data: c.data }, "latest"],
    }));

    // Retry a rate-limited or transient response a couple of times with backoff. The public RPC will 429
    // under a burst; a small retry keeps a quote from failing on a momentary limit rather than a real
    // error. The caller (fetchRelevantPoolStates) also bounds concurrency so this rarely triggers.
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) break;
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      break;
    }
    if (!res || !res.ok) throw new Error(`RPC HTTP ${res?.status ?? "no-response"}`);

    const json = (await res.json()) as JsonRpcResponse | JsonRpcResponse[];
    // A batch of one may come back as a bare object on some nodes; normalise.
    const arr = Array.isArray(json) ? json : [json];

    // Responses can arrive out of order; index by id so the caller's order is preserved exactly — a
    // mis-ordered decode would silently pair one pool's ticks with another pool's price.
    const byId = new Map<number, JsonRpcResponse>();
    for (const r of arr) byId.set(r.id, r);

    return calls.map((_, i) => {
      const r = byId.get(i);
      if (!r) throw new Error(`RPC batch missing response for id ${i}`);
      if (r.error) throw new Error(`RPC error ${r.error.code}: ${r.error.message}`);
      return r.result ?? "0x";
    });
  }
}
