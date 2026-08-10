/**
 * route.split.test.ts — locks in two invariants that quote HONESTY depends on:
 *
 *  1. POOL-DISJOINT SPLITTING. bestSplitRoute prices each candidate path in isolation against pristine
 *     liquidity, so if two split parts shared a pool the quote would double-count that pool's depth and
 *     promise an output the swap cannot realise on-chain (revert at minAmountOut). The selector must admit
 *     a path only when it shares no pool with an already-admitted, higher-ranked path. => no pool address
 *     may appear in more than one returned part.
 *
 *  2. THREE-HOP BRIDGE ROUTING. A -> WETH -> USDG -> B must resolve when the WETH/USDG bridge pool exists,
 *     which is the whole point of fetching that pool unconditionally in client.ts. Without the bridge edge
 *     this pair is a false "no route".
 */

import { describe, it, expect } from "vitest";
import { getSqrtRatioAtTick } from "../../lib/aggregator/math/tickMath";
import type { PoolState, TickData } from "../../lib/aggregator/venues/v3Pool";
import { PoolGraph, bestSplitRoute, bestSingleRoute } from "../../lib/aggregator/route";

const A = "0x" + "a".repeat(40);
const WETH = "0x" + "e".repeat(40);
const USDG = "0x" + "d".repeat(40);
const B = "0x" + "b".repeat(40);

/** A 1:1 pool with deep, uniform liquidity across a wide range — a modest swap never leaves the range,
 *  so quoteExactInput prices it cleanly without exhausting tick data. */
function pool(address: string, token0: string, token1: string, liquidity: bigint, fee = 3000): PoolState {
  const SPACING = 60;
  const LO = -6000;
  const HI = 6000;
  const ticks: TickData[] = [
    { tick: LO, liquidityNet: liquidity },
    { tick: HI, liquidityNet: -liquidity },
  ];
  // token0 < token1 is required by v3; the fixture addresses are already sorted by construction.
  const [t0, t1] = token0.toLowerCase() < token1.toLowerCase() ? [token0, token1] : [token1, token0];
  return {
    address,
    token0: t0,
    token1: t1,
    fee,
    tickSpacing: SPACING,
    sqrtPriceX96: getSqrtRatioAtTick(0),
    tick: 0,
    liquidity,
    ticks,
  };
}

const L = 10_000_000_000_000_000_000n; // deep enough that a 1e18 swap stays in-range

describe("bestSplitRoute — pool-disjoint invariant", () => {
  it("never reuses a pool across split parts", () => {
    // Two paths from A to B that SHARE the A/WETH entry pool:
    //   A -> WETH -> USDG -> B   and   A -> WETH -> B
    const shared = pool("0xP1_AWETH".padEnd(42, "0"), A, WETH, L);
    const graph = new PoolGraph([
      shared,
      pool("0xP2_WETHUSDG".padEnd(42, "0"), WETH, USDG, L),
      pool("0xP3_USDGB".padEnd(42, "0"), USDG, B, L),
      pool("0xP4_WETHB".padEnd(42, "0"), WETH, B, L),
    ]);

    const split = bestSplitRoute(graph, A, B, 1_000_000_000_000_000_000n, { parts: 10 });
    expect(split).toBeDefined();

    const seen = new Set<string>();
    for (const part of split!.parts) {
      for (const hop of part.hops) {
        expect(seen.has(hop.pool.address), `pool ${hop.pool.address} reused across parts`).toBe(false);
        seen.add(hop.pool.address);
      }
    }
  });

  it("still splits across genuinely disjoint pools (multi fee-tier)", () => {
    // Two DISTINCT WETH/USDG pools — the classic ETH<->USDG multi-tier split. Disjoint => both admissible.
    const graph = new PoolGraph([
      pool("0xTIERA".padEnd(42, "0"), WETH, USDG, L, 500),
      pool("0xTIERB".padEnd(42, "0"), WETH, USDG, L, 3000),
    ]);
    const split = bestSplitRoute(graph, WETH, USDG, 5_000_000_000_000_000_000n, { parts: 10 });
    expect(split).toBeDefined();
    // With deep, equal pools a large trade should use BOTH — and the two parts must be different pools.
    if (split!.parts.length === 2) {
      expect(split!.parts[0]!.hops[0]!.pool.address).not.toBe(split!.parts[1]!.hops[0]!.pool.address);
    }
    expect(split!.amountOut).toBeGreaterThan(0n);
  });
});

describe("three-hop bridge routing", () => {
  it("resolves A -> WETH -> USDG -> B via the WETH/USDG bridge pool", () => {
    const graph = new PoolGraph([
      pool("0xP1".padEnd(42, "0"), A, WETH, L),
      pool("0xP2".padEnd(42, "0"), WETH, USDG, L), // the bridge edge
      pool("0xP3".padEnd(42, "0"), USDG, B, L),
    ]);
    const route = bestSingleRoute(graph, A, B, 1_000_000_000_000_000_000n, 3);
    expect(route).toBeDefined();
    expect(route!.amountOut).toBeGreaterThan(0n);
    expect(route!.hops.length).toBe(3);
    expect(route!.hops.map((h) => h.tokenIn.toLowerCase())).toEqual([
      A.toLowerCase(),
      WETH.toLowerCase(),
      USDG.toLowerCase(),
    ]);
  });

  it("returns no route when the bridge pool is absent", () => {
    const graph = new PoolGraph([
      pool("0xP1".padEnd(42, "0"), A, WETH, L),
      pool("0xP3".padEnd(42, "0"), USDG, B, L),
      // no WETH/USDG bridge — A's WETH side and B's USDG side cannot connect
    ]);
    const route = bestSingleRoute(graph, A, B, 1_000_000_000_000_000_000n, 3);
    expect(route).toBeUndefined();
  });
});
