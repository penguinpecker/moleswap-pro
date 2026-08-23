/**
 * hookRisk.test.ts — the hook screen, as attacks: a hook with no code must be refused, an EIP-1967 proxy
 * (implementation OR beacon slot) must be tagged, a read failure must fail closed AND must not be cached
 * (a transient RPC error cannot blacklist a hook for the process), a distinct hook must be screened once,
 * and the whole screen must be ONE JSON-RPC batch round trip.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  screenHook,
  _clearHookRiskCache,
  EIP1967_IMPL_SLOT,
  EIP1967_BEACON_SLOT,
} from "../../lib/aggregator/hookRisk";

const HOOK = "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544";
const ZERO_WORD = "0x" + "0".repeat(64);
const IMPL_WORD = "0x000000000000000000000000abababababababababababababababababababab";

type Answer = { code: string; impl?: string; beacon?: string };

/** A fetch stub answering the batched eth_getCode / eth_getStorageAt by id, from a fixture. */
function stubRpc(opts: Answer & { fail?: boolean; rpcError?: boolean; shuffle?: boolean }) {
  const spy = vi.fn(async (_url: string, init: any) => {
    if (opts.fail) throw new Error("RPC down");
    const body = JSON.parse(init.body) as { id: number; method: string; params: unknown[] }[];
    expect(Array.isArray(body)).toBe(true); // ONE batch, not N requests
    let answers = body.map((c) => {
      if (opts.rpcError) return { id: c.id, error: { code: -32000, message: "boom" } };
      if (c.method === "eth_getCode") return { id: c.id, result: opts.code };
      if (c.method === "eth_getStorageAt") {
        const slot = String(c.params[1]).toLowerCase();
        if (slot === EIP1967_IMPL_SLOT) return { id: c.id, result: opts.impl ?? ZERO_WORD };
        if (slot === EIP1967_BEACON_SLOT) return { id: c.id, result: opts.beacon ?? ZERO_WORD };
      }
      return { id: c.id, result: "0x" };
    });
    if (opts.shuffle) answers = answers.reverse(); // out-of-order responses must be re-paired by id
    return { ok: true, status: 200, json: async () => answers };
  });
  vi.stubGlobal("fetch", spy as any);
  return spy;
}

beforeEach(() => _clearHookRiskCache());
afterEach(() => vi.unstubAllGlobals());

describe("screenHook", () => {
  it("a deployed, non-proxy hook is ok and tagged 'hooked', with its codehash and size", async () => {
    stubRpc({ code: "0x60806040" });
    const r = await screenHook(HOOK);
    expect(r.isContract).toBe(true);
    expect(r.isProxy).toBe(false);
    expect(r.proxyKind).toBeNull();
    expect(r.ok).toBe(true);
    expect(r.tag).toBe("hooked");
    expect(r.codeSize).toBe(4);
    expect(r.codeHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("a hook with NO code is refused (the one hard gate)", async () => {
    stubRpc({ code: "0x" });
    const r = await screenHook("0x000000000000000000000000000000000000dEaD");
    expect(r.isContract).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.codeHash).toBe("");
    expect(r.codeSize).toBe(0);
  });

  it("an EIP-1967 IMPLEMENTATION proxy hook is tagged 'hooked·proxy' but still quotable (soft signal)", async () => {
    stubRpc({ code: "0x363d3d37", impl: IMPL_WORD });
    const r = await screenHook("0x00000000000000000000000000000000000000AA");
    expect(r.isProxy).toBe(true);
    expect(r.proxyKind).toBe("implementation");
    expect(r.ok).toBe(true); // simulation-only + bounded minOut carries the risk, not exclusion
    expect(r.tag).toBe("hooked·proxy");
  });

  it("an EIP-1967 BEACON proxy hook is tagged too", async () => {
    stubRpc({ code: "0x363d3d37", beacon: IMPL_WORD });
    const r = await screenHook("0x00000000000000000000000000000000000000Ab");
    expect(r.isProxy).toBe(true);
    expect(r.proxyKind).toBe("beacon");
    expect(r.tag).toBe("hooked·proxy");
  });

  it("re-pairs out-of-order batch answers by id (a shuffled batch must not read code as a slot)", async () => {
    stubRpc({ code: "0x60806040", impl: IMPL_WORD, shuffle: true });
    const r = await screenHook("0x00000000000000000000000000000000000000Ac");
    expect(r.isContract).toBe(true);
    expect(r.proxyKind).toBe("implementation");
  });

  it("fails CLOSED on a network error — and does NOT cache the failure", async () => {
    const failing = stubRpc({ code: "0x", fail: true });
    const r1 = await screenHook("0x00000000000000000000000000000000000000Bb");
    expect(r1.ok).toBe(false);
    expect(failing).toHaveBeenCalledTimes(1);
    // RPC recovers: the very next screen must hit the network again and succeed.
    const healthy = stubRpc({ code: "0x6080" });
    const r2 = await screenHook("0x00000000000000000000000000000000000000Bb");
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(r2.ok).toBe(true);
  });

  it("fails CLOSED on a JSON-RPC error object (and does not cache that either)", async () => {
    stubRpc({ code: "0x6080", rpcError: true });
    expect((await screenHook("0x00000000000000000000000000000000000000Bc")).ok).toBe(false);
    const healthy = stubRpc({ code: "0x6080" });
    expect((await screenHook("0x00000000000000000000000000000000000000Bc")).ok).toBe(true);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("screens a distinct hook exactly once (ONE batch round trip), then serves from cache", async () => {
    const spy = stubRpc({ code: "0x6080" });
    await screenHook("0x00000000000000000000000000000000000000C1");
    await screenHook("0x00000000000000000000000000000000000000C1");
    await screenHook("0x00000000000000000000000000000000000000c1"); // case-insensitive key
    expect(spy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(spy.mock.calls[0]![1].body);
    expect(body.map((c: any) => c.method).sort()).toEqual(["eth_getCode", "eth_getStorageAt", "eth_getStorageAt"]);
  });
});
