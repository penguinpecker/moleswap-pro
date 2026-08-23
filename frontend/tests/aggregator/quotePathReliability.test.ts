/**
 * quotePathReliability.test.ts — the three ways the quote path used to lie quietly.
 *
 * 1. A failed tick read produced a pool state with `ticks: []`, and the quoter's exhaustion guard is
 *    VACUOUS on an empty tick array — so the user was shown a confident over-quote instead of a refusal.
 * 2. `fetchV3StatesMulticall` returned `[]` on a total RPC failure, which is indistinguishable from
 *    "this pair has no V3 pools" and made its caller's error handler unreachable.
 * 3. The pool-registry loaders silently truncated (PostgREST caps an unranged select at 1000 rows
 *    against ~94k active pools) and cached the truncated/errored result as authoritative for 30s.
 *
 * Each test below fails if the corresponding guard is removed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchV3StatesMulticall, PoolStateReadError } from "../../lib/aggregator/multicall";
import { quoteExactInput } from "../../lib/aggregator/venues/v3Pool";
import type { PoolState } from "../../lib/aggregator/venues/v3Pool";
import {
  poolPairTokens,
  fetchPoolRowsByPair,
  fetchPoolRowsWindow,
} from "../../lib/aggregator/serverPools";

/* ------------------------------------------------------------------ aggregate3 result encoding */

const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");

/** Encode Multicall3's `(bool success, bytes returnData)[]` exactly as decodeAggregate3 reads it. */
function encResults(items: { success: boolean; data: string }[]): string {
  const tuples = items.map((it) => {
    const d = it.data.replace(/^0x/, "");
    const len = d.length / 2;
    return w(it.success ? 1 : 0) + w(0x40) + w(len) + d.padEnd(Math.ceil(len / 32) * 64, "0");
  });
  const heads: string[] = [];
  let off = tuples.length * 32;
  for (const t of tuples) {
    heads.push(w(off));
    off += t.length / 2;
  }
  return "0x" + w(0x20) + w(items.length) + heads.join("") + tuples.join("");
}

const encSlot0 = (sqrtPriceX96: bigint, tick: number) =>
  "0x" + w(sqrtPriceX96) + w(BigInt.asUintN(256, BigInt(tick)));
const encUint = (v: bigint) => "0x" + w(v);
const encTicks = (ticks: { index: number; net: bigint }[]) =>
  "0x" +
  w(0x20) +
  w(ticks.length) +
  ticks
    .map((t) => w(BigInt.asUintN(256, BigInt(t.index))) + w(BigInt.asUintN(256, t.net)) + w(0n))
    .join("");

const POOL = {
  address: "0x00000000000000000000000000000000000000a1",
  token0: "0x00000000000000000000000000000000000000b1",
  token1: "0x00000000000000000000000000000000000000c1",
  fee: 500,
  tickSpacing: 10,
};
const TICK_LENS = "0x00000000000000000000000000000000000000ff";
const SQRT_1_1 = 79228162514264337593543950336n; // price 1.0, tick 0

/** Queue of JSON-RPC responses, one per rpcCall, in order. */
function mockRpc(responses: ({ result: string } | { error: { message: string } })[]) {
  let i = 0;
  const fetchMock = vi.fn(async () => {
    const r = responses[i++] ?? { error: { message: "unexpected extra rpc call" } };
    return { json: async () => ({ jsonrpc: "2.0", id: 1, ...r }) } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ 1. the vacuous exhaustion guard */

describe("an empty tick array cannot be priced", () => {
  it("PROOF: the exhaustion guard never fires on ticks:[] — which is why such a state must never be built", () => {
    const empty: PoolState = {
      ...POOL,
      sqrtPriceX96: SQRT_1_1,
      tick: 0,
      liquidity: 1_000_000_000n,
      ticks: [],
      venue: "PancakeV3",
    };
    // A swap far larger than the in-range liquidity can support. With no ticks, `ticks[0]?.index` and
    // `ticks[len-1]?.index` fall back to MIN_TICK/MAX_TICK, so the walk never leaves "known" territory.
    const res = quoteExactInput(empty, true, 10n ** 24n);
    expect(res.exhaustedTickData).toBe(false); // the lie
    expect(res.ticksCrossed).toBe(0); // constant liquidity across all of tick space
    expect(res.amountOut).toBeGreaterThan(0n); // a confident number, computed from liquidity that is not there
  });
});

describe("fetchV3StatesMulticall drops pools it cannot fully read", () => {
  it("drops a pool when a tick-word read comes back success:false", async () => {
    mockRpc([
      { result: encResults([{ success: true, data: encSlot0(SQRT_1_1, 0) }, { success: true, data: encUint(1_000_000_000n) }]) },
      // wordRadius 0 → centre word + the two full-range extreme words = 3 word reads; one fails.
      {
        result: encResults([
          { success: true, data: encTicks([{ index: -100, net: 1_000_000_000n }]) },
          { success: false, data: "0x" },
          { success: true, data: encTicks([{ index: 100, net: -1_000_000_000n }]) },
        ]),
      },
    ]);
    const states = await fetchV3StatesMulticall([POOL], "http://rpc.test", TICK_LENS, 0);
    expect(states).toEqual([]);
  });

  it("drops a pool that reads cleanly but has no tick anywhere in the window", async () => {
    mockRpc([
      { result: encResults([{ success: true, data: encSlot0(SQRT_1_1, 0) }, { success: true, data: encUint(1_000_000_000n) }]) },
      {
        result: encResults([
          { success: true, data: encTicks([]) },
          { success: true, data: encTicks([]) },
          { success: true, data: encTicks([]) },
        ]),
      },
    ]);
    const states = await fetchV3StatesMulticall([POOL], "http://rpc.test", TICK_LENS, 0);
    // liquidity > 0 with no ticks is exactly the state the guard cannot bound — refuse, do not quote.
    expect(states).toEqual([]);
  });

  it("keeps a pool whose whole tick window read cleanly", async () => {
    mockRpc([
      { result: encResults([{ success: true, data: encSlot0(SQRT_1_1, 0) }, { success: true, data: encUint(1_000_000_000n) }]) },
      {
        result: encResults([
          { success: true, data: encTicks([{ index: -100, net: 1_000_000_000n }]) },
          { success: true, data: encTicks([]) },
          { success: true, data: encTicks([{ index: 100, net: -1_000_000_000n }]) },
        ]),
      },
    ]);
    const states = await fetchV3StatesMulticall([POOL], "http://rpc.test", TICK_LENS, 0);
    expect(states).toHaveLength(1);
    expect(states[0]!.ticks.map((t) => t.index)).toEqual([-100, 100]);
  });

  it("no state is ever emitted with liquidity but zero ticks, whatever the words did", async () => {
    for (const words of [
      [true, true, true],
      [true, false, true],
      [false, false, false],
    ]) {
      mockRpc([
        { result: encResults([{ success: true, data: encSlot0(SQRT_1_1, 0) }, { success: true, data: encUint(1_000_000_000n) }]) },
        { result: encResults(words.map((ok) => ({ success: ok, data: ok ? encTicks([]) : "0x" }))) },
      ]);
      const states = await fetchV3StatesMulticall([POOL], "http://rpc.test", TICK_LENS, 0);
      expect(states.filter((s) => s.liquidity > 0n && s.ticks.length === 0)).toEqual([]);
      vi.unstubAllGlobals();
    }
  });
});

/* ------------------------------------------------------------------ 2. RPC failure must not look empty */

describe("fetchV3StatesMulticall reports RPC failure instead of an empty pool set", () => {
  it("throws when the slot0/liquidity call fails", async () => {
    mockRpc([{ error: { message: "429 rate limited" } }]);
    await expect(fetchV3StatesMulticall([POOL], "http://rpc.test", TICK_LENS, 0)).rejects.toBeInstanceOf(
      PoolStateReadError,
    );
  });

  it("throws when the tick-window call fails outright", async () => {
    mockRpc([
      { result: encResults([{ success: true, data: encSlot0(SQRT_1_1, 0) }, { success: true, data: encUint(1_000_000_000n) }]) },
      { error: { message: "payload too large" } },
    ]);
    const err = await fetchV3StatesMulticall([POOL], "http://rpc.test", TICK_LENS, 0).catch((e) => e);
    expect(err).toBeInstanceOf(PoolStateReadError);
    expect((err as PoolStateReadError).phase).toBe("ticks");
  });

  it("throws when every pool's slot0 sub-call fails (allowFailure hides this from the transport)", async () => {
    mockRpc([{ result: encResults([{ success: false, data: "0x" }, { success: false, data: "0x" }]) }]);
    await expect(fetchV3StatesMulticall([POOL], "http://rpc.test", TICK_LENS, 0)).rejects.toBeInstanceOf(
      PoolStateReadError,
    );
  });

  it("still returns [] for a genuinely empty pool list — that one IS 'no pools'", async () => {
    mockRpc([]);
    await expect(fetchV3StatesMulticall([], "http://rpc.test", TICK_LENS, 0)).resolves.toEqual([]);
  });
});

/* ------------------------------------------------------------------ 3. the registry loaders */

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG_LC = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TOK_A = "0x00000000000000000000000000000000000000aa";
const TOK_B = "0x00000000000000000000000000000000000000bb";

describe("the registry is queried by token pair, not downloaded whole", () => {
  it("covers the direct pair, both WETH hub legs and the USDG legs, in both column orders", async () => {
    const db = stubDb([{ data: [] }]);
    await fetchPoolRowsByPair(db.client, { tokenIn: TOK_A, tokenOut: TOK_B, weth: WETH });
    const f = db.calls[0]!.filters!;
    // BOTH columns are constrained to the same token set, which is what makes every ordering of every
    // pair drawn from it match — and nothing that merely touches one of these tokens.
    for (const col of ["token0", "token1"]) {
      expect(f[col]).toBeDefined();
      for (const t of [TOK_A, TOK_B, WETH.toLowerCase(), USDG_LC]) expect(f[col]).toContain(t);
    }
  });

  it("resolves the native markers to WETH so ETH swaps still match real pools", () => {
    for (const native of ["", "0x0000000000000000000000000000000000000000", "eth", "native", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"]) {
      expect(poolPairTokens({ tokenIn: native, tokenOut: TOK_B, weth: WETH })).toContain(WETH.toLowerCase());
    }
  });
});

/** Minimal PostgREST builder stub: one queued response per `.range()` call. */
function stubDb(pages: ({ data: any[] } | { error: { message: string } })[]) {
  const calls: { from: number; to: number; filters?: Record<string, string[]> }[] = [];
  let i = 0;
  const filters: Record<string, string[]> = {};
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    in: (column: string, values: string[]) => {
      filters[column] = values;
      return builder;
    },
    range: async (from: number, to: number) => {
      calls.push({ from, to, filters: { ...filters } });
      const p = pages[i++] ?? { data: [] };
      return { data: (p as any).data ?? null, error: (p as any).error ?? null };
    },
  };
  return { client: { from: () => builder }, calls };
}

const row = (id: number) => ({ id: `p${id}`, venue: "uniswap_v4", active: true });

describe("a registry read that did not finish is never passed off as complete", () => {
  it("pages past the 1000-row cap for a pair instead of stopping at the first page", async () => {
    const db = stubDb([
      { data: Array.from({ length: 1000 }, (_, i) => row(i)) },
      { data: [row(1000)] },
    ]);
    const rows = await fetchPoolRowsByPair(db.client, { tokenIn: TOK_A, tokenOut: TOK_B, weth: WETH });
    expect(rows).toHaveLength(1001);
    expect(db.calls.map((c) => c.from)).toEqual([0, 1000]);
    // Pair-scoped, not a whole-table select: a missing column filter is exactly that bug.
    expect(db.calls[0]!.filters!.token0).toContain(TOK_A);
    expect(db.calls[0]!.filters!.token1).toContain(TOK_B);
  });

  it("throws rather than returning a short list when the pair query errors", async () => {
    // Both the first attempt and its retry fail; supabase-js RETURNS the error, it does not throw.
    const db = stubDb([
      { error: { message: "canceling statement due to statement timeout" } },
      { error: { message: "canceling statement due to statement timeout" } },
    ]);
    await expect(
      fetchPoolRowsByPair(db.client, { tokenIn: TOK_A, tokenOut: TOK_B, weth: WETH }),
    ).rejects.toThrow(/statement timeout/);
  });

  it("retries a failed page once before giving up", async () => {
    const db = stubDb([{ error: { message: "timeout" } }, { data: [row(1)] }]);
    const rows = await fetchPoolRowsByPair(db.client, { tokenIn: TOK_A, tokenOut: TOK_B, weth: WETH });
    expect(rows).toHaveLength(1);
    expect(db.calls).toHaveLength(2);
  });

  it("marks a windowed read INCOMPLETE when a page errors, keeping error and end-of-data distinct", async () => {
    const db = stubDb([
      { data: Array.from({ length: 1000 }, (_, i) => row(i)) },
      { error: { message: "canceling statement due to statement timeout" } },
    ]);
    const res = await fetchPoolRowsWindow(db.client, 20_000);
    expect(res.complete).toBe(false);
    expect(res.error).toMatch(/statement timeout/);
    expect(res.rows).toHaveLength(1000);
  });

  it("marks a windowed read complete only when a short page proves the end of the data", async () => {
    const db = stubDb([{ data: Array.from({ length: 1000 }, (_, i) => row(i)) }, { data: [row(1000)] }]);
    const res = await fetchPoolRowsWindow(db.client, 20_000);
    expect(res.complete).toBe(true);
    expect(res.rows).toHaveLength(1001);
  });

  it("marks a windowed read INCOMPLETE when it hits its row cap", async () => {
    const db = stubDb([
      { data: Array.from({ length: 1000 }, (_, i) => row(i)) },
      { data: Array.from({ length: 1000 }, (_, i) => row(i)) },
    ]);
    const res = await fetchPoolRowsWindow(db.client, 2000);
    expect(res.complete).toBe(false);
    expect(res.rows).toHaveLength(2000);
  });
});

/* ------------------------------------------------------------------ the 30s cache must not be poisoned */

describe("the browser quote path asks for the traded pair", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/supabase/client");
    vi.doUnmock("@/lib/aggregator/client");
    vi.doUnmock("@/lib/mole/aggFee");
  });

  it("getSwapQuote scopes the registry read to the pair instead of selecting the whole table", async () => {
    vi.resetModules();
    const filters: Record<string, string[]>[] = [];
    const cols: Record<string, string[]> = {};
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      in: (column: string, values: string[]) => {
        cols[column] = values;
        return builder;
      },
      range: async () => {
        filters.push({ ...cols });
        return { data: [{ id: "p1", venue: "uniswap_v4", active: true }], error: null };
      },
    };
    vi.doMock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => builder }) }));
    vi.doMock("@/lib/aggregator/client", () => ({
      quoteSwap: async () => ({
        quote: { amountOut: 1n, netAmountOut: 1n, minAmountOut: 1n, feeBps: 0 },
        encoded: {},
        value: 0n,
      }),
    }));
    vi.doMock("@/lib/mole/aggFee", () => ({ getAggFeeBps: async () => 0 }));

    const { getSwapQuote } = await import("@/lib/chain/amm");
    await getSwapQuote({ tokenIn: TOK_A, tokenOut: TOK_B, amountIn: "1000000000000000000" });

    // Two pair-scoped reads now: the active (tick-math) rows AND the simulate-eligible return-delta-hook
    // rows. What is being locked out is a WHOLE-TABLE select, so the invariant is that EVERY query the
    // loader issues carries the pair's token0/token1 filters — not the exact count.
    expect(filters.length).toBeGreaterThanOrEqual(1);
    for (const f of filters) {
      // A whole-table select would leave these undefined — that is the exact bug being locked out.
      expect(f.token0).toBeDefined();
      expect(f.token1).toBeDefined();
      expect(f.token0).toContain(TOK_A);
      expect(f.token1).toContain(TOK_B);
    }
  });
});

describe("loadPoolRowsServer never caches an incomplete registry", () => {
  const OLD_ENV = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("says so, loudly, when the registry it read was truncated by a database error", async () => {
    const pages: any[] = [
      // page 0 ok, page 1 errors → the loop must NOT treat that as the end of the data
      { data: Array.from({ length: 1000 }, (_, i) => row(i)) },
      { error: { message: "canceling statement due to statement timeout" } },
    ];
    let i = 0;
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      or: () => builder,
      range: async () => {
        const p = pages[i++] ?? { data: [] };
        return { data: p.data ?? null, error: p.error ?? null };
      },
    };
    vi.doMock("@supabase/supabase-js", () => ({ createClient: () => ({ from: () => builder }) }));
    const { loadPoolRowsServer } = await import("../../lib/aggregator/serverPools");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const rows = await loadPoolRowsServer(1_000_000);
    expect(rows).toHaveLength(1000); // still served — a partial answer beats no answer
    // ...but the operator is told, with the Postgres error string, which used to be discarded entirely.
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]![0])).toMatch(/INCOMPLETE.*statement timeout/s);
    warn.mockRestore();
  });

  it("surfaces a missing Supabase configuration instead of reporting an empty market", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    vi.doMock("@supabase/supabase-js", () => ({ createClient: () => ({ from: () => ({}) }) }));
    const { loadPoolRowsServer } = await import("../../lib/aggregator/serverPools");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(loadPoolRowsServer(3_000_000)).rejects.toThrow(/not configured/i);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("caches a complete read and serves it inside the 30s window", async () => {
    let queries = 0;
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      or: () => builder,
      range: async () => {
        queries++;
        return { data: [row(1)], error: null };
      },
    };
    vi.doMock("@supabase/supabase-js", () => ({ createClient: () => ({ from: () => builder }) }));
    const { loadPoolRowsServer } = await import("../../lib/aggregator/serverPools");
    await loadPoolRowsServer(2_000_000);
    await loadPoolRowsServer(2_010_000);
    expect(queries).toBe(1);
  });
});
