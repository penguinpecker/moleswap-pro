/**
 * livePoolsChainRead.test.ts — an unreadable chain is an error, never an empty pool list.
 *
 * Live on Arc while its RPC upstream was exhausted: every StateView read rejected, `loadLivePools`
 * returned [], /api/v1/pools answered `count: 0` with HTTP 200 and /pools said "No pools found" for a
 * chain with real deposits in the vault.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ethers } from "ethers";

// The registry answers "nothing here", so the chain's pinned pool is what gets read.
vi.mock("@supabase/supabase-js", () => {
  const thenable = () => {
    const q: any = {};
    for (const m of ["select", "eq", "in", "range", "order", "limit"]) q[m] = () => q;
    q.then = (res: any) => Promise.resolve({ data: [], error: null }).then(res);
    return q;
  };
  return { createClient: () => ({ from: () => thenable() }) };
});

const PIN = {
  id: "0x9aca9d2f4bb68ef41e6928bbe080a4b076b167e2d4b7fdebf4b4fd5d6dadd029",
  token0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  token1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  fee: 0x800000,
  tick_spacing: 60,
  hooks: "0xb2c9A0af48dF8858F3765385E733Cd8776a138C4",
};

describe("loadLivePools when the chain cannot be read", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.local";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("HTTP 502 upstream exhausted"); }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("throws ChainReadError instead of returning []", async () => {
    const { loadLivePools, ChainReadError } = await import("../../lib/chain/livePools");
    const provider = new ethers.JsonRpcProvider("http://127.0.0.1:1", undefined, {
      staticNetwork: ethers.Network.from(99_999),
      batchMaxCount: 1,
    });
    const scope = {
      chainId: 99_999, // a fresh cache key: nothing earlier to serve
      positions: "0x674625B6E6a2614ef6e247aF099BEA2e65e1536A",
      sourceChain: "Test Chain",
      hubStable: PIN.token1,
      hubNative: PIN.token0,
      staticPools: [PIN],
      staticTokens: [],
    } as any;
    await expect(loadLivePools(provider, 24, 0, scope)).rejects.toBeInstanceOf(ChainReadError);
    await expect(loadLivePools(provider, 24, 0, scope)).rejects.toThrow(/Test Chain could not be read/);
  });
});
