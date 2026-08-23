/**
 * serverPoolsSimulate.test.ts — the pair loader now also surfaces simulate-eligible (return-delta-hook)
 * v4 rows, WITHOUT letting a native or hookless inactive row through, without breaking normal quoting
 * when the simulate query fails, without blocking the quote on a slow simulate query — and, because the
 * live database answers that query in ~2.6s against a ~1s budget, with a per-pair cache that a LATE answer
 * still populates so the next request includes the rows (and a fresh entry never touches the database).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  fetchPairRowsWithSimulate,
  fetchSimulateV4RowsByPair,
  _clearSimulateRowsCache,
  type PoolPair,
} from "../../lib/aggregator/serverPools";
import type { PoolRow } from "../../lib/aggregator/client";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const TOKEN = "0x1cf19a265363e743c767b7962ebedaafe86edba3";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const ZERO = "0x0000000000000000000000000000000000000000";
const DELTA_HOOK = "0x0000000000000000000000000000000000000004";
const NO_HOOK = "0x0000000000000000000000000000000000000000";

const pair: PoolPair = { tokenIn: WETH, tokenOut: TOKEN, weth: WETH };
const otherPair: PoolPair = { tokenIn: WETH, tokenOut: USDG, weth: WETH };

const activeRow: PoolRow = { id: "0xa1", venue: "uniswap_v3", token0: WETH, token1: TOKEN, fee: 3000, tick_spacing: 60, hooks: null, address: "0xa1", active: true };

// The inactive rows the simulate query returns: a delta hook (eligible), a native-leg delta hook
// (unroutable → dropped), and a hookless inactive pool (a tick pool that happens to be inactive → dropped).
const inactiveDeltaHook: PoolRow = { id: "0xh1", venue: "uniswap_v4", token0: WETH, token1: TOKEN, fee: 8388608, tick_spacing: 200, hooks: DELTA_HOOK, address: "", active: false };
const inactiveNativeDelta: PoolRow = { id: "0xh2", venue: "uniswap_v4", token0: ZERO, token1: TOKEN, fee: 8388608, tick_spacing: 200, hooks: DELTA_HOOK, address: "", active: false };
const inactiveHookless: PoolRow = { id: "0xh3", venue: "uniswap_v4", token0: WETH, token1: USDG, fee: 8388608, tick_spacing: 60, hooks: NO_HOOK, address: "", active: false };

/** Minimal supabase-js query-builder stub: records the .eq() filters, resolves at .range(). */
function makeSb(resolve: (eqs: Record<string, unknown>) => { data: PoolRow[] | null; error: { message: string } | null } | Promise<{ data: PoolRow[] | null; error: { message: string } | null }>) {
  const queries: Record<string, unknown>[] = [];
  const client = {
    from() {
      const eqs: Record<string, unknown> = {};
      const b: any = {
        select: () => b,
        eq: (col: string, val: unknown) => { eqs[col] = val; return b; },
        in: () => b,
        range: () => { queries.push({ ...eqs }); return Promise.resolve(resolve(eqs)); },
      };
      return b;
    },
  };
  return { client, queries, simulateQueries: () => queries.filter((q) => q.active === false).length };
}

const later = <T,>(ms: number, v: T) => new Promise<T>((res) => setTimeout(() => res(v), ms));

beforeEach(() => _clearSimulateRowsCache());

describe("fetchSimulateV4RowsByPair", () => {
  it("keeps ONLY delta-hook, non-native rows", async () => {
    const { client } = makeSb(() => ({ data: [inactiveDeltaHook, inactiveNativeDelta, inactiveHookless], error: null }));
    const rows = await fetchSimulateV4RowsByPair(client as any, pair);
    expect(rows.map((r) => r.id)).toEqual(["0xh1"]);
  });

  it("throws on a database error (so the caller can degrade deliberately)", async () => {
    const { client } = makeSb(() => ({ data: null, error: { message: "timeout" } }));
    await expect(fetchSimulateV4RowsByPair(client as any, pair)).rejects.toThrow(/simulate query failed/);
  });
});

describe("fetchPairRowsWithSimulate merges active + simulate", () => {
  it("returns the active rows AND the simulate-eligible rows", async () => {
    const { client } = makeSb((eqs) => {
      if (eqs.active === true) return { data: [activeRow], error: null };
      // the simulate query: venue=uniswap_v4, active=false
      return { data: [inactiveDeltaHook, inactiveNativeDelta], error: null };
    });
    const rows = await fetchPairRowsWithSimulate(client as any, pair);
    expect(rows.map((r) => r.id).sort()).toEqual(["0xa1", "0xh1"]);
    // the active row keeps active=true; the simulate row is still active=false (it is NOT tick-routable).
    expect(rows.find((r) => r.id === "0xa1")!.active).toBe(true);
    expect(rows.find((r) => r.id === "0xh1")!.active).toBe(false);
  });

  it("still returns the active rows when the simulate query fails (best-effort)", async () => {
    const { client } = makeSb((eqs) => {
      if (eqs.active === true) return { data: [activeRow], error: null };
      return { data: null, error: { message: "boom" } };
    });
    const rows = await fetchPairRowsWithSimulate(client as any, pair);
    expect(rows.map((r) => r.id)).toEqual(["0xa1"]);
  });

  it("SHIPS active rows without waiting past the budget when the simulate query is slow", async () => {
    const { client } = makeSb((eqs) =>
      eqs.active === true ? { data: [activeRow], error: null } : later(100, { data: [inactiveDeltaHook], error: null }),
    );
    const rows = await fetchPairRowsWithSimulate(client as any, pair, 5); // 5ms budget < 100ms query
    expect(rows.map((r) => r.id)).toEqual(["0xa1"]);
  });

  it("INCLUDES the simulate rows when they land inside the budget", async () => {
    const { client } = makeSb((eqs) =>
      eqs.active === true ? { data: [activeRow], error: null } : later(20, { data: [inactiveDeltaHook], error: null }),
    );
    const rows = await fetchPairRowsWithSimulate(client as any, pair, 500); // 500ms budget > 20ms query
    expect(rows.map((r) => r.id).sort()).toEqual(["0xa1", "0xh1"]);
  });

  it("propagates an ACTIVE-query failure (not masked by the simulate path)", async () => {
    const { client } = makeSb((eqs) => {
      if (eqs.active === true) return { data: null, error: { message: "active down" } };
      return { data: [], error: null };
    });
    await expect(fetchPairRowsWithSimulate(client as any, pair)).rejects.toThrow(/mp_pools query failed/);
  });
});

describe("the simulate-rows cache (the live database answers in ~2.6s against a ~1s budget)", () => {
  it("a LATE simulate answer populates the cache: the next request includes the rows at once, no new query", async () => {
    const { client, simulateQueries } = makeSb((eqs) =>
      eqs.active === true ? { data: [activeRow], error: null } : later(40, { data: [inactiveDeltaHook], error: null }),
    );
    const first = await fetchPairRowsWithSimulate(client as any, pair, 5); // budget missed
    expect(first.map((r) => r.id)).toEqual(["0xa1"]);
    expect(simulateQueries()).toBe(1);
    await later(60, null); // the slow answer arrives after the request already returned
    const second = await fetchPairRowsWithSimulate(client as any, pair, 5);
    expect(second.map((r) => r.id).sort()).toEqual(["0xa1", "0xh1"]);
    expect(simulateQueries()).toBe(1); // served from the cache — the database was not asked again
  });

  it("a fresh cache entry is served without querying; an expired one re-queries", async () => {
    const { client, simulateQueries } = makeSb((eqs) =>
      eqs.active === true ? { data: [activeRow], error: null } : { data: [inactiveDeltaHook], error: null },
    );
    await fetchPairRowsWithSimulate(client as any, pair, 500, 1_000_000);
    await fetchPairRowsWithSimulate(client as any, pair, 500, 1_000_000 + 30_000); // inside the TTL
    expect(simulateQueries()).toBe(1);
    await fetchPairRowsWithSimulate(client as any, pair, 500, 1_000_000 + 61_000); // past the TTL
    expect(simulateQueries()).toBe(2);
  });

  it("while a pair's query is in flight, concurrent requests share it (one query, not one per request)", async () => {
    const { client, simulateQueries } = makeSb((eqs) =>
      eqs.active === true ? { data: [activeRow], error: null } : later(30, { data: [inactiveDeltaHook], error: null }),
    );
    const [a, b, c] = await Promise.all([
      fetchPairRowsWithSimulate(client as any, pair, 500),
      fetchPairRowsWithSimulate(client as any, pair, 500),
      fetchPairRowsWithSimulate(client as any, pair, 500),
    ]);
    expect(simulateQueries()).toBe(1);
    for (const rows of [a, b, c]) expect(rows.map((r) => r.id).sort()).toEqual(["0xa1", "0xh1"]);
  });

  it("the cache is per pair", async () => {
    const { client, simulateQueries } = makeSb((eqs) =>
      eqs.active === true ? { data: [activeRow], error: null } : { data: [inactiveDeltaHook], error: null },
    );
    await fetchPairRowsWithSimulate(client as any, pair, 500);
    await fetchPairRowsWithSimulate(client as any, otherPair, 500);
    expect(simulateQueries()).toBe(2);
  });

  it("past the budget with a STALE cached answer, the stale rows are served (better than none) and refreshed", async () => {
    let slow = false;
    const { client, simulateQueries } = makeSb((eqs) => {
      if (eqs.active === true) return { data: [activeRow], error: null };
      return slow ? later(40, { data: [inactiveDeltaHook], error: null }) : { data: [inactiveDeltaHook], error: null };
    });
    await fetchPairRowsWithSimulate(client as any, pair, 500, 1_000_000); // populate
    slow = true;
    const rows = await fetchPairRowsWithSimulate(client as any, pair, 5, 1_000_000 + 61_000); // expired + slow
    expect(rows.map((r) => r.id).sort()).toEqual(["0xa1", "0xh1"]); // stale rows served
    expect(simulateQueries()).toBe(2); // and a refresh was started
  });
});
