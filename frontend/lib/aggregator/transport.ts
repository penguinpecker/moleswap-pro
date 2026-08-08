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

interface JsonRpcResponse {
  id: number;
  result?: string;
  error?: { code: number; message: string };
}

export class FetchTransport implements RpcTransport {
  constructor(private readonly url: string = ROBINHOOD_RPC_URL) {}

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

    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);

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
