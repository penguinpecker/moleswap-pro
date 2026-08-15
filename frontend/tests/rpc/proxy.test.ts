/**
 * Adversarial tests for the Arc RPC proxy.
 *
 * These are written as ATTACKS on the forwarder, not as demonstrations that it works.
 * The cases that matter are the ones where a wrong decision is INVISIBLE in production:
 * a reverted call retried across every upstream, a dead provider key handed to the user
 * as if the chain had spoken, or a wrong-chain node serving balances under Arc's name.
 *
 * Several tests assert on an EXACT provider string measured against live Arc endpoints
 * on 2026-08-16 (Infura's `-32600 project ID exceeded quota`). Those strings are the
 * point of the test — loosening them to a generic match would let the regression back in.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { proxyJsonRpc, requestCost, MAX_BATCH, MAX_BODY_BYTES } from "@/lib/rpc/proxy";
import { parseUpstreams } from "@/lib/rpc/upstreams";
import { classifyRpcError, chainIdMismatch, methodPolicy } from "@/lib/rpc/policy";
import { checkRpcRateLimit, __resetRpcRateLimit } from "@/lib/rpc/rate-limit";
import { arcRpcUrl, ARC_CHAIN_ID, ARC_CHAIN_ID_HEX, ARC_NATIVE_CURRENCY } from "@/lib/rpc/arc-chain";

/* ============================================== 0. the published contract */

describe("the published endpoint contract", () => {
  // Users paste this URL into a wallet by hand. Once it is out there, changing it
  // silently breaks every wallet already pointed at it — so the path is pinned here.
  it("advertises exactly /rpc/v1/arc", () => {
    expect(arcRpcUrl("https://www.moleswap.com")).toBe("https://www.moleswap.com/rpc/v1/arc");
    expect(arcRpcUrl("https://www.moleswap.com/")).toBe("https://www.moleswap.com/rpc/v1/arc");
  });

  it("pins the values MetaMask validates on add", () => {
    expect(ARC_CHAIN_ID).toBe(5042);
    expect(ARC_CHAIN_ID_HEX).toBe("0x13b2");
    expect(Number.parseInt(ARC_CHAIN_ID_HEX, 16)).toBe(ARC_CHAIN_ID);
    // 18, not 6. The ERC-20 facade's 6 decimals here would inflate every balance by 1e12.
    expect(ARC_NATIVE_CURRENCY.decimals).toBe(18);
    expect(ARC_NATIVE_CURRENCY.symbol).toBe("USDC");
  });
});

/* ----------------------------------------------------------------- harness */

type Reply = { status?: number; body: string } | { throws: string };

/** A scripted upstream. Records every call so "was it even asked?" is assertable. */
function stubFetch(script: Record<string, Reply[]>) {
  const calls: { url: string; body: string }[] = [];
  const cursor: Record<string, number> = {};

  const impl = (async (url: string, init: RequestInit) => {
    const body = String(init.body);
    calls.push({ url, body });
    const queue = script[url];
    if (!queue) throw new Error(`unscripted upstream ${url}`);
    const i = Math.min(cursor[url] ?? 0, queue.length - 1);
    cursor[url] = (cursor[url] ?? 0) + 1;
    const reply = queue[i];
    if ("throws" in reply) {
      const e = new Error(reply.throws);
      e.name = reply.throws === "timeout" ? "TimeoutError" : "TypeError";
      throw e;
    }
    return {
      status: reply.status ?? 200,
      text: async () => reply.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { impl, calls };
}

const A = { url: "https://a.example/rpc", label: "a.example" };
const B = { url: "https://b.example/rpc", label: "b.example" };

const ok = (id: number | string, result: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, result });
const rpcErr = (id: number | string, code: number, message: string, data?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

const call = (method: string, params: unknown[] = [], id: number | string = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

/* ================================================================= 1. policy */

describe("method policy — a public URL must not become an admin console", () => {
  it.each([
    "admin_peers",
    "personal_unlockAccount",
    "miner_start",
    "txpool_content",
    "engine_forkchoiceUpdatedV1",
    "clique_propose",
    "parity_lockedHardwareAccountsInfo",
    "db_putString",
    "shh_post",
  ])("blocks %s", (method) => {
    expect(methodPolicy(method).kind).toBe("blocked");
  });

  it.each(["debug_traceTransaction", "trace_block", "ots_getApiLevel"])(
    "blocks the expensive namespace %s",
    (method) => {
      expect(methodPolicy(method).kind).toBe("blocked");
    },
  );

  it("blocks wallet-side signing methods — a node holds no keys", () => {
    for (const m of ["eth_sign", "eth_signTransaction", "eth_sendTransaction", "personal_sign"]) {
      expect(methodPolicy(m).kind, m).toBe("blocked");
    }
  });

  it("does NOT block the methods a swap actually needs", () => {
    for (const m of [
      "eth_call",
      "eth_chainId",
      "eth_blockNumber",
      "eth_getBalance",
      "eth_estimateGas",
      "eth_sendRawTransaction",
      "eth_getTransactionReceipt",
      "eth_getLogs",
      "eth_feeHistory",
      "eth_maxPriorityFeePerGas",
      "eth_getTransactionCount",
      "eth_getCode",
      "eth_getBlockByNumber",
      "net_version",
      "web3_clientVersion",
    ]) {
      expect(methodPolicy(m).kind, m).toBe("forward");
    }
  });

  it("rejects a non-string method instead of forwarding it", () => {
    expect(methodPolicy(undefined).kind).toBe("blocked");
    expect(methodPolicy(42).kind).toBe("blocked");
    expect(methodPolicy({ toString: () => "eth_call" }).kind).toBe("blocked");
  });

  it("caps method length — it is attacker-controlled and reaches logs", () => {
    expect(methodPolicy("eth_" + "x".repeat(500)).kind).toBe("blocked");
  });

  it("never reaches an upstream for a blocked method", async () => {
    const { impl, calls } = stubFetch({ [A.url]: [{ body: ok(1, "0x0") }] });
    const res = await proxyJsonRpc({ rawBody: call("debug_traceCall"), upstreams: [A], fetchImpl: impl });
    expect(calls).toHaveLength(0);
    expect(JSON.parse(res.body).error.code).toBe(-32601);
  });

  it("answers eth_accounts locally without spending an upstream request", async () => {
    const { impl, calls } = stubFetch({ [A.url]: [{ body: ok(1, "nope") }] });
    const res = await proxyJsonRpc({ rawBody: call("eth_accounts"), upstreams: [A], fetchImpl: impl });
    expect(calls).toHaveLength(0);
    expect(JSON.parse(res.body).result).toEqual([]);
  });
});

/* ============================================ 2. answer vs infrastructure failure */

describe("a revert is an ANSWER — retrying it would burn every upstream", () => {
  it("passes an execution revert straight through, never touching upstream B", async () => {
    const { impl, calls } = stubFetch({
      [A.url]: [{ body: rpcErr(1, 3, "execution reverted", "0x08c379a0") }],
      [B.url]: [{ body: ok(1, "0xdeadbeef") }],
    });
    const res = await proxyJsonRpc({ rawBody: call("eth_call"), upstreams: [A, B], fetchImpl: impl });

    expect(calls.map((c) => c.url)).toEqual([A.url]);
    expect(JSON.parse(res.body).error.data).toBe("0x08c379a0");
  });

  it("preserves revert `data` verbatim — custom-error decoding depends on it", async () => {
    const data = "0x0f398e12"; // RangeWidthOutOfBounds, a real MoleSwap selector
    const { impl } = stubFetch({ [A.url]: [{ body: rpcErr(7, 3, "execution reverted", data) }] });
    const res = await proxyJsonRpc({ rawBody: call("eth_call", [], 7), upstreams: [A], fetchImpl: impl });
    expect(JSON.parse(res.body).error.data).toBe(data);
  });

  it("ADVERSARIAL: a revert whose REASON contains an infra word is still an answer", async () => {
    // A contract can revert with any string it likes, including "quota exceeded".
    // If the message regex were consulted before the code, this would fail over and the
    // user would be told the RPC is down when their transaction simply reverted.
    const { impl, calls } = stubFetch({
      [A.url]: [{ body: rpcErr(1, 3, "execution reverted: quota exceeded, rate limit hit", "0x1234") }],
      [B.url]: [{ body: ok(1, "0x") }],
    });
    await proxyJsonRpc({ rawBody: call("eth_call"), upstreams: [A, B], fetchImpl: impl });
    expect(calls.map((c) => c.url)).toEqual([A.url]);
  });

  it.each([
    [-32000, "nonce too low"],
    [-32000, "insufficient funds for gas * price + value"],
    [-32000, "already known"],
    [-32602, "invalid argument 0"],
    [-32614, "eth_getLogs is limited to a 10,000 range"],
  ])("treats %i %s as a real answer", async (code, message) => {
    const { impl, calls } = stubFetch({
      [A.url]: [{ body: rpcErr(1, code, message) }],
      [B.url]: [{ body: ok(1, "0x0") }],
    });
    await proxyJsonRpc({ rawBody: call("eth_sendRawTransaction"), upstreams: [A, B], fetchImpl: impl });
    expect(calls.map((c) => c.url)).toEqual([A.url]);
  });
});

describe("a dead provider is a FAILURE — hand the user the healthy upstream", () => {
  it("fails over on Infura's exact measured quota string", async () => {
    // Measured live 2026-08-16 against the key published in the RadarDEX FAQ. Note the
    // code: -32600 is "Invalid Request" in the spec, i.e. the code alone says the CLIENT
    // was wrong. Classifying on the code alone would serve this to users forever.
    const { impl, calls } = stubFetch({
      [A.url]: [{ body: rpcErr(1, -32600, "project ID exceeded quota") }],
      [B.url]: [{ body: ok(1, "0x12") }],
    });
    const res = await proxyJsonRpc({ rawBody: call("eth_call"), upstreams: [A, B], fetchImpl: impl });

    expect(calls.map((c) => c.url)).toEqual([A.url, B.url]);
    expect(JSON.parse(res.body).result).toBe("0x12");
    expect(res.servedBy).toBe("b.example");
  });

  it("fails over on -32601, because upstreams genuinely differ in surface", async () => {
    // Measured: rpc.arc-scan.org refuses net_listening; Infura and labsapis answer it.
    const { impl, calls } = stubFetch({
      [A.url]: [{ body: rpcErr(1, -32601, "does not serve net_listening on this endpoint") }],
      [B.url]: [{ body: ok(1, true) }],
    });
    const res = await proxyJsonRpc({ rawBody: call("net_listening"), upstreams: [A, B], fetchImpl: impl });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(res.body).result).toBe(true);
  });

  it.each([401, 402, 403, 408, 429, 500, 502, 503, 504])("fails over on HTTP %i", async (status) => {
    const { impl, calls } = stubFetch({
      [A.url]: [{ status, body: "" }],
      [B.url]: [{ body: ok(1, "0x1") }],
    });
    await proxyJsonRpc({ rawBody: call("eth_blockNumber"), upstreams: [A, B], fetchImpl: impl });
    expect(calls).toHaveLength(2);
  });

  it("fails over on a 200 that is not JSON (WAF page, captive portal)", async () => {
    // Real case: rpc.labsapis.com answers a request with no Origin header by returning
    // HTTP 200 and a page of ASCII art. A proxy that trusted the status code would hand
    // that to the wallet as the chain's reply.
    const { impl, calls } = stubFetch({
      [A.url]: [{ status: 200, body: "<html><body>Attention Required! | Cloudflare</body></html>" }],
      [B.url]: [{ body: ok(1, "0xf06cef") }],
    });
    const res = await proxyJsonRpc({ rawBody: call("eth_blockNumber"), upstreams: [A, B], fetchImpl: impl });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(res.body).result).toBe("0xf06cef");
  });

  it("fails over on a timeout and on a network error", async () => {
    for (const failure of ["timeout", "fetch failed"]) {
      const { impl, calls } = stubFetch({
        [A.url]: [{ throws: failure }],
        [B.url]: [{ body: ok(1, "0x1") }],
      });
      const res = await proxyJsonRpc({ rawBody: call("eth_blockNumber"), upstreams: [A, B], fetchImpl: impl });
      expect(calls, failure).toHaveLength(2);
      expect(res.servedBy).toBe("b.example");
    }
  });

  it("returns 502 with the attempt trail when every upstream is down", async () => {
    const { impl } = stubFetch({
      [A.url]: [{ status: 503, body: "" }],
      [B.url]: [{ throws: "timeout" }],
    });
    const res = await proxyJsonRpc({ rawBody: call("eth_getBalance"), upstreams: [A, B], fetchImpl: impl });

    expect(res.status).toBe(502);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe(-32603);
    expect(parsed.error.message).toContain("http 503");
    expect(parsed.error.message).toContain("timeout");
  });

  it("retries the whole batch when ANY entry hit a quota — eleven of twelve is a broken page", async () => {
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_call", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_call", params: [] },
    ]);
    const { impl, calls } = stubFetch({
      [A.url]: [
        {
          body: JSON.stringify([
            { jsonrpc: "2.0", id: 1, result: "0x1" },
            { jsonrpc: "2.0", id: 2, error: { code: -32600, message: "project ID exceeded quota" } },
          ]),
        },
      ],
      [B.url]: [
        {
          body: JSON.stringify([
            { jsonrpc: "2.0", id: 1, result: "0x1" },
            { jsonrpc: "2.0", id: 2, result: "0x2" },
          ]),
        },
      ],
    });
    const res = await proxyJsonRpc({ rawBody: batch, upstreams: [A, B], fetchImpl: impl });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(res.body)).toHaveLength(2);
    expect(JSON.parse(res.body)[1].result).toBe("0x2");
  });
});

/* ======================================================= 3. the chain-ID pin */

describe("chain-ID pin — a wrong-chain upstream must never serve Arc's name", () => {
  it("refuses an upstream that reports a different chain and fails over", async () => {
    const { impl, calls } = stubFetch({
      [A.url]: [{ body: ok(1, "0x1") }], // Ethereum mainnet, not Arc
      [B.url]: [{ body: ok(1, "0x13b2") }],
    });
    const res = await proxyJsonRpc({ rawBody: call("eth_chainId"), upstreams: [A, B], fetchImpl: impl });

    expect(calls).toHaveLength(2);
    expect(JSON.parse(res.body).result).toBe("0x13b2");
    expect(res.attempts[0]).toContain("expected 0x13b2");
  });

  it("accepts equivalent hex spellings of 5042 rather than failing a healthy node", () => {
    expect(chainIdMismatch("eth_chainId", "0x13B2")).toBeNull();
    expect(chainIdMismatch("eth_chainId", "0x013b2")).toBeNull();
    expect(chainIdMismatch("eth_chainId", "0x13b2")).toBeNull();
  });

  it("catches a wrong net_version too", () => {
    expect(chainIdMismatch("net_version", "1")).toContain("expected 5042");
    expect(chainIdMismatch("net_version", "5042")).toBeNull();
  });

  it("serves the pinned constant only when NOTHING is reachable", async () => {
    const { impl } = stubFetch({ [A.url]: [{ throws: "timeout" }] });
    const res = await proxyJsonRpc({ rawBody: call("eth_chainId"), upstreams: [A], fetchImpl: impl });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).result).toBe("0x13b2");
    expect(res.servedBy).toBe("moleswap-constant");
  });

  it("ADVERSARIAL: the last-resort constant must NOT rescue a state read", async () => {
    // If the constant fallback leaked into state methods it would invent a balance.
    const { impl } = stubFetch({ [A.url]: [{ throws: "timeout" }] });
    const res = await proxyJsonRpc({ rawBody: call("eth_getBalance"), upstreams: [A], fetchImpl: impl });
    expect(res.status).toBe(502);
  });

  it("ADVERSARIAL: a batch mixing chainId with a state read must not be constant-served", async () => {
    const body = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: [] },
    ]);
    const { impl } = stubFetch({ [A.url]: [{ throws: "timeout" }] });
    const res = await proxyJsonRpc({ rawBody: body, upstreams: [A], fetchImpl: impl });
    expect(res.status).toBe(502);
  });
});

/* ==================================================== 4. fidelity of passthrough */

describe("passthrough fidelity — the proxy must not re-encode an answer", () => {
  it("returns the upstream body byte-for-byte, preserving key order and spacing", async () => {
    const exact = '{"jsonrpc":"2.0","id":1,   "result":"0x13b2","extraField":{"z":1,"a":2}}';
    const { impl } = stubFetch({ [A.url]: [{ body: exact }] });
    const res = await proxyJsonRpc({ rawBody: call("eth_blockNumber"), upstreams: [A], fetchImpl: impl });
    expect(res.body).toBe(exact);
  });

  it("sends the client's original bytes upstream when nothing was rewritten", async () => {
    const raw = '{"method":"eth_blockNumber","params":[],"id":99,"jsonrpc":"2.0"}';
    const { impl, calls } = stubFetch({ [A.url]: [{ body: ok(99, "0x1") }] });
    await proxyJsonRpc({ rawBody: raw, upstreams: [A], fetchImpl: impl });
    expect(calls[0].body).toBe(raw);
  });

  it("survives a large getLogs result without parsing it", async () => {
    const huge = '{"jsonrpc":"2.0","id":1,"result":[' + '"0x' + "a".repeat(5_000_000) + '"' + "]}";
    const { impl } = stubFetch({ [A.url]: [{ body: huge }] });
    const res = await proxyJsonRpc({ rawBody: call("eth_getLogs"), upstreams: [A], fetchImpl: impl });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(huge.length);
  });

  it("ADVERSARIAL: an oversized NON-JSON body is still rejected, not passed through", async () => {
    const huge = "<html>" + "x".repeat(5_000_000) + "</html>";
    const { impl, calls } = stubFetch({
      [A.url]: [{ body: huge }],
      [B.url]: [{ body: ok(1, "0x1") }],
    });
    const res = await proxyJsonRpc({ rawBody: call("eth_getLogs"), upstreams: [A, B], fetchImpl: impl });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(res.body).result).toBe("0x1");
  });
});

/* ================================================== 5. batch merge correctness */

describe("mixed batches — local answers spliced back into the client's order", () => {
  it("keeps the original request order when locals and forwards interleave", async () => {
    const body = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_accounts", params: [] }, // local
      { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] }, // forwarded
      { jsonrpc: "2.0", id: 3, method: "admin_peers", params: [] }, // blocked
      { jsonrpc: "2.0", id: 4, method: "eth_chainId", params: [] }, // forwarded
    ]);
    const { impl, calls } = stubFetch({
      [A.url]: [
        {
          body: JSON.stringify([
            { jsonrpc: "2.0", id: 4, result: "0x13b2" },
            { jsonrpc: "2.0", id: 2, result: "0xf0" }, // upstream may reorder
          ]),
        },
      ],
    });
    const res = await proxyJsonRpc({ rawBody: body, upstreams: [A], fetchImpl: impl });

    // Only the two forwardable calls were sent upstream.
    expect(JSON.parse(calls[0].body).map((r: any) => r.id)).toEqual([2, 4]);

    const out = JSON.parse(res.body);
    expect(out.map((r: any) => r.id)).toEqual([1, 2, 3, 4]);
    expect(out[0].result).toEqual([]);
    expect(out[1].result).toBe("0xf0");
    expect(out[2].error.code).toBe(-32601);
    expect(out[3].result).toBe("0x13b2");
  });

  it("ADVERSARIAL: duplicate ids get one response each, not the same one twice", async () => {
    const body = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
      { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_accounts", params: [] },
    ]);
    const { impl } = stubFetch({
      [A.url]: [
        {
          body: JSON.stringify([
            { jsonrpc: "2.0", id: 1, result: "0xAA" },
            { jsonrpc: "2.0", id: 1, result: "0xBB" },
          ]),
        },
      ],
    });
    const res = await proxyJsonRpc({ rawBody: body, upstreams: [A], fetchImpl: impl });
    const out = JSON.parse(res.body);
    expect(out).toHaveLength(3);
    expect([out[0].result, out[1].result]).toEqual(["0xAA", "0xBB"]);
  });

  it("fills a gap rather than dropping a call when the upstream skips a response", async () => {
    const body = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_accounts", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
    ]);
    const { impl } = stubFetch({
      [A.url]: [{ body: JSON.stringify([]) }],
    });
    // An empty batch reply is an infra failure, so this ends as 502 rather than a
    // silently short response — a client that asked twice must never get one answer.
    const res = await proxyJsonRpc({ rawBody: body, upstreams: [A], fetchImpl: impl });
    expect(res.status).toBe(502);
  });

  it("distinguishes a null id from the string \"null\"", async () => {
    const body = JSON.stringify([
      { jsonrpc: "2.0", id: null, method: "eth_blockNumber", params: [] },
      { jsonrpc: "2.0", id: "null", method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 1, method: "eth_accounts", params: [] },
    ]);
    const { impl } = stubFetch({
      [A.url]: [
        {
          body: JSON.stringify([
            { jsonrpc: "2.0", id: null, result: "0xNULLID" },
            { jsonrpc: "2.0", id: "null", result: "0x13b2" },
          ]),
        },
      ],
    });
    const res = await proxyJsonRpc({ rawBody: body, upstreams: [A], fetchImpl: impl });
    const out = JSON.parse(res.body);
    expect(out.find((r: any) => r.id === null).result).toBe("0xNULLID");
    expect(out.find((r: any) => r.id === "null").result).toBe("0x13b2");
  });
});

/* ============================================================ 6. input limits */

describe("input limits", () => {
  const noFetch = (() => {
    throw new Error("upstream must not be called");
  }) as unknown as typeof fetch;

  it("rejects an empty body", async () => {
    const res = await proxyJsonRpc({ rawBody: "", upstreams: [A], fetchImpl: noFetch });
    expect(res.status).toBe(400);
  });

  it("answers -32700 for malformed JSON", async () => {
    const res = await proxyJsonRpc({ rawBody: "{not json", upstreams: [A], fetchImpl: noFetch });
    expect(JSON.parse(res.body).error.code).toBe(-32700);
  });

  it("rejects a body over the size cap without contacting an upstream", async () => {
    const res = await proxyJsonRpc({
      rawBody: JSON.stringify({ method: "eth_call", params: ["x".repeat(MAX_BODY_BYTES)] }),
      upstreams: [A],
      fetchImpl: noFetch,
    });
    expect(res.status).toBe(413);
  });

  it("rejects an oversized batch", async () => {
    const body = JSON.stringify(
      Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "eth_chainId" })),
    );
    const res = await proxyJsonRpc({ rawBody: body, upstreams: [A], fetchImpl: noFetch });
    expect(JSON.parse(res.body).error.message).toContain("Batch too large");
  });

  it("rejects an empty batch and non-object entries", async () => {
    expect((await proxyJsonRpc({ rawBody: "[]", upstreams: [A], fetchImpl: noFetch })).body).toContain("empty batch");
    expect(
      JSON.parse((await proxyJsonRpc({ rawBody: "[1,2]", upstreams: [A], fetchImpl: noFetch })).body).error.code,
    ).toBe(-32600);
  });

  it("counts a batch as its length for rate-limiting", () => {
    expect(requestCost(call("eth_call"))).toBe(1);
    expect(requestCost(JSON.stringify([1, 2, 3, 4, 5]))).toBe(5);
    expect(requestCost("garbage")).toBe(1);
  });
});

/* ========================================================= 7. upstream config */

describe("upstream configuration", () => {
  it("falls back to the keyless default when unset or blank", () => {
    expect(parseUpstreams(undefined)[0].label).toBe("rpc.arc-scan.org");
    expect(parseUpstreams("   ")[0].label).toBe("rpc.arc-scan.org");
  });

  it("preserves the configured order — first entry is the primary", () => {
    const u = parseUpstreams("https://one.example/a, https://two.example/b");
    expect(u.map((x) => x.label)).toEqual(["one.example", "two.example"]);
  });

  it("ADVERSARIAL: de-duplicates, so an exhausted key cannot occupy the fallback slot", () => {
    const u = parseUpstreams("https://one.example/a,https://one.example/a,https://two.example/b");
    expect(u.map((x) => x.label)).toEqual(["one.example", "two.example"]);
  });

  it("drops non-http entries rather than trusting a typo as an upstream", () => {
    const u = parseUpstreams("ftp://bad.example, javascript:alert(1), https://good.example/x");
    expect(u.map((x) => x.label)).toEqual(["good.example"]);
  });

  it("never returns an empty list, even when every entry is invalid", () => {
    expect(parseUpstreams("ftp://bad.example")).toHaveLength(1);
  });
});

/* ============================================================ 8. rate limiting */

describe("rate limiting", () => {
  beforeEach(() => __resetRpcRateLimit());

  it("allows a normal wallet's polling volume", () => {
    let last = checkRpcRateLimit("1.1.1.1");
    for (let i = 0; i < 400; i++) last = checkRpcRateLimit("1.1.1.1");
    expect(last.allowed).toBe(true);
  });

  it("ADVERSARIAL: batching does not multiply a client's allowance", () => {
    // 100 requests of 100 calls each = 10,000 calls. Charging one per HTTP request
    // would wave that straight through.
    let verdict = checkRpcRateLimit("2.2.2.2", 100);
    for (let i = 0; i < 20 && verdict.allowed; i++) verdict = checkRpcRateLimit("2.2.2.2", 100);
    expect(verdict.allowed).toBe(false);
  });

  it("keeps separate budgets per IP", () => {
    for (let i = 0; i < 700; i++) checkRpcRateLimit("3.3.3.3");
    expect(checkRpcRateLimit("3.3.3.3").allowed).toBe(false);
    expect(checkRpcRateLimit("4.4.4.4").allowed).toBe(true);
  });
});

/* ================================================== 9. classifier unit checks */

describe("classifyRpcError", () => {
  it("treats any error carrying data as the chain speaking", () => {
    expect(classifyRpcError({ code: -32603, message: "internal", data: "0x1" }).verdict).toBe("answer");
  });
  it("treats a bare internal error as infrastructure", () => {
    expect(classifyRpcError({ code: -32603, message: "internal" }).verdict).toBe("retry");
  });
  it("handles a missing or malformed error object", () => {
    expect(classifyRpcError(undefined).verdict).toBe("answer");
    expect(classifyRpcError(null).verdict).toBe("answer");
  });
});
