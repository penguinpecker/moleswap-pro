/**
 * proxy.ts — the JSON-RPC forwarder behind https://www.moleswap.com/rpc/v1/arc.
 *
 * Design rules, in priority order:
 *
 *  1. FIDELITY FIRST. When every method in a request is forwarded — the overwhelmingly
 *     common case — the upstream's response body is returned BYTE FOR BYTE. It is never
 *     parsed-and-reserialised on the way out. Re-encoding a response is how proxies lose
 *     revert `data`, reorder batch entries, and round a large integer id. The merge path
 *     exists only when the request genuinely mixes forwarded and locally-answered calls.
 *
 *  2. A REVERT IS AN ANSWER. Failover happens on infrastructure failure only. See
 *     policy.ts — this is the distinction that decides whether a working chain looks
 *     broken to the user.
 *
 *  3. EVERY EXTERNAL FETCH HAS A TIMEOUT, and the failover loop has a total deadline.
 *     A stalled socket must not hold a serverless function open until the platform
 *     kills it, because the client sees that as the endpoint being down.
 */

import {
  LAST_RESORT_CONSTANTS,
  classifyUpstreamReply,
  idKey,
  methodPolicy,
  type RpcRequest,
} from "./policy";
import type { Upstream } from "./upstreams";

/* ------------------------------------------------------------------- caps */

/** Largest request body accepted. An honest eth_sendRawTransaction is a few KB. */
export const MAX_BODY_BYTES = 1_000_000;

/** Largest batch accepted. Multicall makes big batches unnecessary; 100 is generous. */
export const MAX_BATCH = 100;

/**
 * Above this, an upstream response is streamed through without being parsed. A
 * multi-megabyte body is a large eth_getLogs result, never a JSON-RPC error object, so
 * there is nothing for classification to learn from it — and parsing it would burn
 * function memory to reach the same verdict.
 */
const MAX_PARSE_BYTES = 4_000_000;

const DEFAULT_UPSTREAM_TIMEOUT_MS = 8_000;
const DEFAULT_TOTAL_DEADLINE_MS = 25_000;

/* --------------------------------------------------------------- responses */

export interface ProxyResult {
  status: number;
  body: string;
  /** Host of the upstream that answered, for the debug header. Never includes a key. */
  servedBy?: string;
  attempts: string[];
}

function errorBody(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/* ------------------------------------------------------------------ helpers */

interface Entry {
  original: RpcRequest;
  index: number;
  /** What policy decided for this entry. */
  verdict: ReturnType<typeof methodPolicy>;
}

/** A JSON-RPC notification has no `id` and, per spec, receives no response. */
function isNotification(req: RpcRequest): boolean {
  return !Object.prototype.hasOwnProperty.call(req, "id") || req.id === undefined;
}

function responseFor(entry: Entry): object | null {
  if (isNotification(entry.original)) return null;
  const id = entry.original.id ?? null;

  if (entry.verdict.kind === "local") {
    return { jsonrpc: "2.0", id, result: entry.verdict.result };
  }
  if (entry.verdict.kind === "blocked") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: entry.verdict.code, message: entry.verdict.message },
    };
  }
  return null;
}

/* -------------------------------------------------------------------- core */

export interface ProxyOptions {
  rawBody: string;
  upstreams: Upstream[];
  fetchImpl?: typeof fetch;
  upstreamTimeoutMs?: number;
  totalDeadlineMs?: number;
  /** Injectable clock so the deadline is testable without real waiting. */
  now?: () => number;
}

export async function proxyJsonRpc(opts: ProxyOptions): Promise<ProxyResult> {
  const {
    rawBody,
    upstreams,
    fetchImpl = fetch,
    upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
    totalDeadlineMs = DEFAULT_TOTAL_DEADLINE_MS,
    now = Date.now,
  } = opts;

  const startedAt = now();

  /* ---- parse ---- */

  if (rawBody.length === 0) {
    return { status: 400, body: errorBody(null, -32600, "Invalid Request: empty body"), attempts: [] };
  }
  if (rawBody.length > MAX_BODY_BYTES) {
    return {
      status: 413,
      body: errorBody(null, -32600, `Request too large (limit ${MAX_BODY_BYTES} bytes)`),
      attempts: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 200, body: errorBody(null, -32700, "Parse error"), attempts: [] };
  }

  const isBatch = Array.isArray(parsed);
  const requests: RpcRequest[] = isBatch ? (parsed as RpcRequest[]) : [parsed as RpcRequest];

  if (isBatch && requests.length === 0) {
    return { status: 200, body: errorBody(null, -32600, "Invalid Request: empty batch"), attempts: [] };
  }
  if (requests.length > MAX_BATCH) {
    return {
      status: 200,
      body: errorBody(null, -32600, `Batch too large: ${requests.length} calls (limit ${MAX_BATCH})`),
      attempts: [],
    };
  }
  for (const r of requests) {
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      return { status: 200, body: errorBody(null, -32600, "Invalid Request"), attempts: [] };
    }
  }

  /* ---- policy ---- */

  const entries: Entry[] = requests.map((original, index) => ({
    original,
    index,
    verdict: methodPolicy(original.method),
  }));

  const forwarded = entries.filter((e) => e.verdict.kind === "forward");

  // Nothing to ask an upstream: answer entirely from here.
  if (forwarded.length === 0) {
    const local = entries.map(responseFor).filter((r): r is object => r !== null);
    if (local.length === 0) return { status: 204, body: "", attempts: [] };
    return { status: 200, body: JSON.stringify(isBatch ? local : local[0]), attempts: [] };
  }

  /*
   * Whole request forwarded, unchanged? Then send the client's ORIGINAL bytes upstream
   * and hand the upstream's original bytes back. Nothing is re-encoded in either
   * direction — ids, key order and number formatting all survive exactly.
   */
  const passthrough = forwarded.length === entries.length;

  const upstreamPayload = passthrough
    ? rawBody
    : JSON.stringify(isBatch ? forwarded.map((e) => e.original) : forwarded[0].original);

  const methodById = new Map<string, string>();
  for (const e of forwarded) {
    if (typeof e.original.method === "string" && !isNotification(e.original)) {
      methodById.set(idKey(e.original.id), e.original.method);
    }
  }

  /* ---- failover ---- */

  const attempts: string[] = [];

  for (const upstream of upstreams) {
    const elapsed = now() - startedAt;
    const budget = totalDeadlineMs - elapsed;
    if (budget <= 250) {
      attempts.push(`${upstream.label}: skipped (deadline)`);
      break;
    }

    const timeout = Math.min(upstreamTimeoutMs, budget);
    let status = 0;
    let text = "";

    try {
      const res = await fetchImpl(upstream.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: upstreamPayload,
        signal: AbortSignal.timeout(timeout),
        // A JSON-RPC answer is never reusable; never let a CDN hand back a stale head.
        cache: "no-store",
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      attempts.push(`${upstream.label}: ${(err as Error).name === "TimeoutError" ? "timeout" : "network error"}`);
      continue;
    }

    // Only parse what is worth parsing. A body this large is a big getLogs/getBlock
    // result, and the first character is enough to know it is not an HTML error page.
    let parsedReply: unknown = undefined;
    if (text.length <= MAX_PARSE_BYTES) {
      try {
        parsedReply = JSON.parse(text);
      } catch {
        parsedReply = undefined;
      }
    } else {
      const first = text.trimStart()[0];
      parsedReply = first === "{" || first === "[" ? null : undefined;
    }

    const verdict =
      parsedReply === null
        ? ({ verdict: "answer" } as const) // oversized but structurally JSON
        : classifyUpstreamReply({ status, parsed: parsedReply, methodById });

    if (verdict.verdict === "retry") {
      attempts.push(`${upstream.label}: ${verdict.reason}`);
      continue;
    }

    attempts.push(`${upstream.label}: ok`);

    if (passthrough) {
      return { status: 200, body: text, servedBy: upstream.label, attempts };
    }

    /*
     * Mixed request: splice the upstream's answers back into the client's original
     * order. Responses are consumed from a per-id queue rather than a plain map, so a
     * client that (illegally) reuses an id across a batch still gets one response per
     * call instead of the same one twice.
     */
    const byId = new Map<string, object[]>();
    const replyEntries: unknown[] = Array.isArray(parsedReply) ? parsedReply : [parsedReply];
    for (const r of replyEntries) {
      if (!r || typeof r !== "object") continue;
      const key = idKey((r as { id?: unknown }).id);
      const bucket = byId.get(key);
      if (bucket) bucket.push(r as object);
      else byId.set(key, [r as object]);
    }

    const merged: object[] = [];
    for (const e of entries) {
      if (isNotification(e.original)) continue;
      if (e.verdict.kind === "forward") {
        const bucket = byId.get(idKey(e.original.id));
        const r = bucket?.shift();
        if (r) merged.push(r);
        else
          merged.push({
            jsonrpc: "2.0",
            id: e.original.id ?? null,
            error: { code: -32603, message: "Upstream returned no response for this call" },
          });
      } else {
        const r = responseFor(e);
        if (r) merged.push(r);
      }
    }

    return {
      status: 200,
      body: JSON.stringify(isBatch ? merged : (merged[0] ?? null)),
      servedBy: upstream.label,
      attempts,
    };
  }

  /* ---- every upstream failed ---- */

  /*
   * Last resort: eth_chainId / net_version are constants of the Arc protocol, not state
   * reads. Answering them from a pinned constant when nothing is reachable lets a user
   * still ADD the network in MetaMask during an upstream outage, instead of being shown
   * a chain-ID mismatch for a chain whose id has never changed. Any request that needs
   * real state still fails honestly below.
   */
  const constantOnly = forwarded.every(
    (e) =>
      typeof e.original.method === "string" &&
      Object.prototype.hasOwnProperty.call(LAST_RESORT_CONSTANTS, e.original.method),
  );

  if (constantOnly) {
    const answers = entries
      .map((e) => {
        if (isNotification(e.original)) return null;
        if (e.verdict.kind !== "forward") return responseFor(e);
        return {
          jsonrpc: "2.0",
          id: e.original.id ?? null,
          result: LAST_RESORT_CONSTANTS[e.original.method as string],
        };
      })
      .filter((r): r is object => r !== null);

    return {
      status: 200,
      body: JSON.stringify(isBatch ? answers : answers[0]),
      servedBy: "moleswap-constant",
      attempts,
    };
  }

  const id = isBatch ? null : ((requests[0]?.id as unknown) ?? null);
  return {
    status: 502,
    body: errorBody(
      id,
      -32603,
      `No Arc upstream could serve this request (${attempts.join("; ") || "no upstreams configured"})`,
    ),
    attempts,
  };
}

/** Batch length, for rate-limit accounting. Cheap pre-parse; falls back to 1. */
export function requestCost(rawBody: string): number {
  const trimmed = rawBody.trimStart();
  if (trimmed[0] !== "[") return 1;
  try {
    const p = JSON.parse(rawBody);
    return Array.isArray(p) ? Math.max(1, p.length) : 1;
  } catch {
    return 1;
  }
}
