/**
 * Adversarial tests for RPC usage counting.
 *
 * The counters themselves are ordinary. The tests that matter are the ones that try to
 * BREAK THE PRIVACY GUARANTEE — because that is the failure nobody would notice in
 * production. An RPC sees every address a wallet asks about, so the only proof that we
 * are not quietly retaining them is a test that goes looking for one and comes back
 * empty-handed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  record,
  summarise,
  shouldFlush,
  visitorHash,
  dayKey,
  __resetMetrics,
  __peekBuffer,
} from "@/lib/rpc/metrics";

const SECRET = "test-write-secret";

beforeEach(() => {
  process.env.MP_WRITE_SECRET = SECRET;
  // No Supabase URL configured ⇒ flushes are no-ops, so nothing leaves the process in tests.
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.ARC_RPC_METRICS_SALT;
  __resetMetrics();
});
afterEach(() => {
  delete process.env.MP_WRITE_SECRET;
});

/* ======================================================== 1. privacy guarantee */

describe("PRIVACY: nothing that identifies a user may reach the buffer", () => {
  // A synthetic address, deliberately. This repo is public, and a test fixture is a poor
  // place to publish a wallet that belongs to someone — which is the same instinct the code
  // under test exists to enforce.
  const WALLET = "0x1111111111111111111111111111111111111111";
  const IP = "203.0.113.44"; // TEST-NET-3, reserved for documentation (RFC 5737)

  it("ADVERSARIAL: a wallet address in params never appears anywhere in the buffer", () => {
    // This is the exact shape of a real balance lookup — the address is right there in params.
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [WALLET, "latest"] },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "eth_call",
        params: [{ to: "0x8bcb94279FC2c984EC34e0C1f2192df8c69EA4F0", data: `0x70a08231${WALLET.slice(2)}` }, "latest"],
      },
    ];
    const body = JSON.stringify([
      { jsonrpc: "2.0", id: 1, result: "0x593afc5c1851a9000" },
      { jsonrpc: "2.0", id: 2, result: "0x0" },
    ]);

    record(summarise(requests, body), IP);

    const dumped = JSON.stringify(__peekBuffer()).toLowerCase();
    expect(dumped).not.toContain(WALLET.toLowerCase());
    expect(dumped).not.toContain("70a08231"); // not even the calldata
    expect(dumped).not.toContain("0x8bcb94279fc2c984ec34e0c1f2192df8c69ea4f0"); // the contract too
  });

  it("ADVERSARIAL: the raw IP never appears in the buffer", () => {
    record([{ method: "eth_call", errored: false }], IP);
    expect(JSON.stringify(__peekBuffer())).not.toContain(IP);
  });

  it("ADVERSARIAL: a result value is never retained", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xdeadbeefcafe" });
    record(summarise([{ jsonrpc: "2.0", id: 1, method: "eth_call", params: [] }], body), IP);
    expect(JSON.stringify(__peekBuffer())).not.toContain("deadbeefcafe");
  });

  it("hashes the same visitor differently on different days — nobody is trackable over time", () => {
    const a = visitorHash(IP, "2026-08-16", SECRET);
    const b = visitorHash(IP, "2026-08-17", SECRET);
    expect(a).not.toBe(b);
    expect(a).toHaveLength(32);
  });

  it("ADVERSARIAL: without the secret the hash is different — a date-only salt is brute-forceable", () => {
    // If the salt were the date alone, anyone holding the table could hash all of IPv4 and
    // reverse every row. The secret is what makes that infeasible, so it must be load-bearing.
    expect(visitorHash(IP, "2026-08-16", SECRET)).not.toBe(visitorHash(IP, "2026-08-16", "other-secret"));
  });

  it("ADVERSARIAL: with no secret configured, visitor counting is DISABLED, not weakened", () => {
    delete process.env.MP_WRITE_SECRET;
    delete process.env.INDEXER_SECRET;
    __resetMetrics();
    record([{ method: "eth_call", errored: false }], IP);

    const b = __peekBuffer();
    expect(b.visitors).toBe(0); // counted nothing rather than storing a reversible hash
    expect(b.events).toBe(1); // method counting still works
  });
});

/* ==================================================== 2. transaction counting */

describe("transaction counting", () => {
  const TXHASH = "0x4726ecb1a0f7c3d9e8b5a2f1c0d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2b1";

  it("counts a broadcast only when a transaction hash came back", () => {
    record(
      summarise(
        [{ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x02f8..."] }],
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: TXHASH }),
      ),
      "1.2.3.4",
    );
    expect(__peekBuffer().transactions).toBe(1);
  });

  it("ADVERSARIAL: a REJECTED broadcast is not a transaction", () => {
    // "nonce too low" / "already known" / a malformed payload must not inflate the headline
    // number — otherwise a retry loop reads as organic volume.
    for (const err of ["nonce too low", "already known", "insufficient funds"]) {
      __resetMetrics();
      record(
        summarise(
          [{ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x02f8..."] }],
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: err } }),
        ),
        "1.2.3.4",
      );
      expect(__peekBuffer().transactions, err).toBe(0);
      expect(__peekBuffer().methods["eth_sendRawTransaction"].errors).toBe(1);
    }
  });

  it("ADVERSARIAL: a non-hash result does not count as a transaction", () => {
    __resetMetrics();
    record(
      summarise(
        [{ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [] }],
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }),
      ),
      "1.2.3.4",
    );
    expect(__peekBuffer().transactions).toBe(0);
  });

  it("only eth_sendRawTransaction can produce a transaction count", () => {
    record(
      summarise(
        [{ jsonrpc: "2.0", id: 1, method: "eth_call", params: [] }],
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: TXHASH }),
      ),
      "1.2.3.4",
    );
    expect(__peekBuffer().transactions).toBe(0);
  });
});

/* ============================================================ 3. bookkeeping */

describe("counters", () => {
  it("counts one visitor for many calls from the same IP on the same day", () => {
    for (let i = 0; i < 50; i++) record([{ method: "eth_blockNumber", errored: false }], "9.9.9.9");
    const b = __peekBuffer();
    expect(b.visitors).toBe(1);
    expect(b.events).toBe(50);
  });

  it("counts distinct IPs as distinct visitors", () => {
    record([{ method: "eth_call", errored: false }], "1.1.1.1");
    record([{ method: "eth_call", errored: false }], "2.2.2.2");
    expect(__peekBuffer().visitors).toBe(2);
  });

  it("splits requests and errors per method", () => {
    record(
      [
        { method: "eth_call", errored: false },
        { method: "eth_call", errored: true },
        { method: "eth_blockNumber", errored: false },
      ],
      "1.1.1.1",
    );
    const m = __peekBuffer().methods;
    expect(m["eth_call"]).toEqual({ requests: 2, errors: 1 });
    expect(m["eth_blockNumber"]).toEqual({ requests: 1, errors: 0 });
  });

  it("counts every call in a batch, not one per HTTP request", () => {
    const reqs = Array.from({ length: 12 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "eth_call", params: [] }));
    const body = JSON.stringify(reqs.map((r) => ({ jsonrpc: "2.0", id: r.id, result: "0x1" })));
    record(summarise(reqs, body), "1.1.1.1");
    expect(__peekBuffer().events).toBe(12);
  });

  it("ADVERSARIAL: junk method names cannot grow the buffer without bound", () => {
    for (let i = 0; i < 1000; i++) record([{ method: `eth_junk_${i}`, errored: false }], "1.1.1.1");
    expect(Object.keys(__peekBuffer().methods).length).toBeLessThanOrEqual(200);
  });

  it("ADVERSARIAL: many distinct IPs cannot grow the buffer without bound", () => {
    for (let i = 0; i < 6000; i++) record([{ method: "eth_call", errored: false }], `10.0.${(i / 256) | 0}.${i % 256}`);
    expect(__peekBuffer().visitors).toBeLessThanOrEqual(5000);
  });

  it("still counts an oversized or unparseable response body", () => {
    const calls = summarise([{ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [] }], "<<not json>>");
    expect(calls).toEqual([{ method: "eth_getLogs", errored: false, broadcast: false }]);
  });

  it("ignores entries with no method rather than counting a blank", () => {
    expect(summarise([{ id: 1 } as never], "{}")).toEqual([]);
  });

  it("never throws, whatever it is handed", () => {
    expect(() => record(null as never, "1.1.1.1")).not.toThrow();
    expect(() => record([{ method: "", errored: false }], "")).not.toThrow();
    expect(() => summarise([], "")).not.toThrow();
  });
});

describe("flush scheduling", () => {
  it("does not flush an empty buffer", () => {
    expect(shouldFlush()).toBe(false);
  });

  it("flushes once the event threshold is reached", () => {
    for (let i = 0; i < 200; i++) record([{ method: "eth_call", errored: false }], "1.1.1.1");
    expect(shouldFlush()).toBe(true);
  });

  it("flushes an idle buffer on age alone", () => {
    record([{ method: "eth_call", errored: false }], "1.1.1.1");
    expect(shouldFlush()).toBe(false);
    expect(shouldFlush(Date.now() + 21_000)).toBe(true);
  });

  it("uses a UTC day key so instances in different regions agree on the boundary", () => {
    expect(dayKey(new Date("2026-08-16T23:59:59Z"))).toBe("2026-08-16");
    expect(dayKey(new Date("2026-08-17T00:00:01Z"))).toBe("2026-08-17");
  });
});
