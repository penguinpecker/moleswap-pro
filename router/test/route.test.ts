import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PoolGraph,
  bestSingleRoute,
  bestSplitRoute,
  describeRoute,
  quotePath,
  type Hop,
} from "../src/route.js";
import { quoteExactInput, type PoolState, type TickData } from "../src/venues/v3Pool.js";

/**
 * Routing tests. The pool used as the base is REAL — the live PancakeSwap V3 WETH/USDG pool on Robinhood
 * Chain, with its actual tick data — so the concavity these tests rely on is the market's, not a model's.
 * Synthetic variants are derived from it by changing ONE property at a time (liquidity, fee), which keeps
 * every comparison honest: if a split beats a single route here, it is because the real curve says so.
 */

const fx = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "test/fixtures.live.json"), "utf8"),
) as {
  pool: string;
  token0: string;
  token1: string;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  tickSpacing: number;
  fee: number;
  ticks: { index: number; liquidityNet: string }[];
};

const WETH = fx.token0;
const USDG = fx.token1;
const MEME = "0x00000000000000000000000000000000deadbeef";

const ticks: TickData[] = fx.ticks.map((t) => ({ index: t.index, liquidityNet: BigInt(t.liquidityNet) }));

const livePool: PoolState = {
  address: fx.pool,
  token0: WETH,
  token1: USDG,
  fee: fx.fee,
  tickSpacing: fx.tickSpacing,
  sqrtPriceX96: BigInt(fx.sqrtPriceX96),
  tick: fx.tick,
  liquidity: BigInt(fx.liquidity),
  ticks,
};

/** The same real curve, scaled — a second venue for the same pair, as the chain actually has. */
function variant(over: Partial<PoolState> & { address: string }): PoolState {
  return { ...livePool, ...over };
}

describe("graph construction", () => {
  it("indexes both sides of every pool", () => {
    const g = new PoolGraph([livePool]);
    expect(g.poolsFor(WETH)).toHaveLength(1);
    expect(g.poolsFor(USDG)).toHaveLength(1);
    expect(g.tokenCount).toBe(2);
  });

  it("is case-insensitive about addresses, because explorers and RPCs disagree about casing", () => {
    const g = new PoolGraph([livePool]);
    expect(g.poolsFor(WETH.toUpperCase())).toHaveLength(1);
    expect(g.poolsFor(WETH.toLowerCase())).toHaveLength(1);
  });

  it("drops pools that can never fill, instead of quoting them on every request", () => {
    const dead = variant({ address: "0xdead", liquidity: 0n, ticks: [] });
    const g = new PoolGraph([livePool, dead]);
    expect(g.pools).toHaveLength(1);
  });
});

describe("path finding", () => {
  it("finds the direct pool", () => {
    const g = new PoolGraph([livePool]);
    const paths = g.findPaths(WETH, USDG);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toHaveLength(1);
    expect(paths[0]![0]!.zeroForOne).toBe(true);
  });

  it("orients the hop correctly in the reverse direction", () => {
    const g = new PoolGraph([livePool]);
    const paths = g.findPaths(USDG, WETH);
    expect(paths[0]![0]!.zeroForOne).toBe(false);
  });

  it("finds the 2-hop route through the hub when no direct pool exists", () => {
    // This is the shape the live chain actually has: WETH is in 71 live pools, everything else in one or
    // two, so almost every real route is TOKEN -> WETH -> TOKEN.
    const memePool = variant({ address: "0xmeme", token0: WETH, token1: MEME });
    const g = new PoolGraph([livePool, memePool]);
    const paths = g.findPaths(USDG, MEME, 3);
    expect(paths.length).toBeGreaterThan(0);
    const two = paths.find((p) => p.length === 2);
    expect(two).toBeDefined();
    expect(two![0]!.tokenOut.toLowerCase()).toBe(WETH.toLowerCase());
  });

  it("respects maxHops", () => {
    const memePool = variant({ address: "0xmeme", token0: WETH, token1: MEME });
    const g = new PoolGraph([livePool, memePool]);
    expect(g.findPaths(USDG, MEME, 1)).toHaveLength(0);
    expect(g.findPaths(USDG, MEME, 2).length).toBeGreaterThan(0);
  });

  it("never revisits a token — a cycle would be an infinite free-money path", () => {
    const alt = variant({ address: "0xalt" }); // second WETH/USDG pool
    const memePool = variant({ address: "0xmeme", token0: WETH, token1: MEME });
    const g = new PoolGraph([livePool, alt, memePool]);
    for (const p of g.findPaths(USDG, MEME, 4)) {
      const tokens = [p[0]!.tokenIn, ...p.map((h) => h.tokenOut)].map((t) => t.toLowerCase());
      expect(new Set(tokens).size).toBe(tokens.length);
    }
  });

  it("returns nothing for a token it has never seen", () => {
    const g = new PoolGraph([livePool]);
    expect(g.findPaths(WETH, "0x00000000000000000000000000000000000000ff")).toHaveLength(0);
  });

  it("returns nothing when input and output are the same token", () => {
    const g = new PoolGraph([livePool]);
    expect(g.findPaths(WETH, WETH)).toHaveLength(0);
  });
});

describe("single-route selection", () => {
  it("picks the deeper pool when two venues offer the same pair", () => {
    // Same real curve, one tenth the liquidity. The deep one must win on a size that matters.
    const shallow = variant({ address: "0xshallow", liquidity: BigInt(fx.liquidity) / 10n });
    const g = new PoolGraph([livePool, shallow]);
    const best = bestSingleRoute(g, WETH, USDG, 10n ** 18n);
    expect(best).toBeDefined();
    expect(best!.hops[0]!.pool.address).toBe(livePool.address);
  });

  it("prefers the cheaper fee when depth is identical", () => {
    const dear = variant({ address: "0xdear", fee: 10_000 });
    const g = new PoolGraph([livePool, dear]);
    const best = bestSingleRoute(g, WETH, USDG, 10n ** 15n);
    expect(best!.hops[0]!.pool.fee).toBe(500);
  });

  it("agrees with a direct single-pool quote when there is only one pool", () => {
    const g = new PoolGraph([livePool]);
    const amount = 10n ** 16n;
    const best = bestSingleRoute(g, WETH, USDG, amount)!;
    const direct = quoteExactInput(livePool, true, amount);
    expect(best.amountOut).toBe(direct.amountOut);
  });
});

describe("splitting — the thing an aggregator is actually for", () => {
  it("beats the single best route on a size big enough to move one pool", () => {
    // Two comparable venues. Past some size the second pool's untouched liquidity is worth more than
    // the first pool's exhausted tail, and a router that does not split leaves that on the table.
    const second = variant({ address: "0xsecond" });
    const g = new PoolGraph([livePool, second]);
    const amount = 3n * 10n ** 18n;

    const single = bestSingleRoute(g, WETH, USDG, amount)!;
    const split = bestSplitRoute(g, WETH, USDG, amount, { parts: 10 })!;

    expect(split.amountOut).toBeGreaterThan(single.amountOut);
    expect(split.parts.length).toBeGreaterThan(1);
  });

  it("spends EXACTLY the input — a wei lost here is a wei the executor cannot transfer", () => {
    const second = variant({ address: "0xsecond" });
    const g = new PoolGraph([livePool, second]);
    // A deliberately awkward amount that does not divide evenly into the slice count.
    const amount = 3_333_333_333_333_333_333n;
    const split = bestSplitRoute(g, WETH, USDG, amount, { parts: 7 })!;
    const summed = split.parts.reduce((a, r) => a + r.amountIn, 0n);
    expect(summed).toBe(amount);
    expect(split.amountIn).toBe(amount);
  });

  it("does not split when there is nothing to split across", () => {
    const g = new PoolGraph([livePool]);
    const split = bestSplitRoute(g, WETH, USDG, 10n ** 18n, { parts: 10 })!;
    expect(split.parts).toHaveLength(1);
  });

  it("sends everything to the deep pool when the alternative is negligible", () => {
    const dust = variant({ address: "0xdust", liquidity: BigInt(fx.liquidity) / 100_000n });
    const g = new PoolGraph([livePool, dust]);
    const split = bestSplitRoute(g, WETH, USDG, 10n ** 15n, { parts: 10 })!;
    const toDust = split.parts.find((r) => r.hops[0]!.pool.address === "0xdust");
    expect(toDust).toBeUndefined();
  });

  it("never reports more output than the parts actually produce", () => {
    const second = variant({ address: "0xsecond" });
    const g = new PoolGraph([livePool, second]);
    const split = bestSplitRoute(g, WETH, USDG, 2n * 10n ** 18n, { parts: 8 })!;
    const recomputed = split.parts.reduce((a, r) => a + quotePath(r.hops, r.amountIn).amountOut, 0n);
    expect(split.amountOut).toBe(recomputed);
  });

  it("propagates incompleteness — a split containing a guess is still a guess", () => {
    const narrow = variant({ address: "0xnarrow", ticks: ticks.slice(0, 2) });
    const g = new PoolGraph([narrow]);
    const split = bestSplitRoute(g, WETH, USDG, 10n ** 24n, { parts: 4 });
    if (split) expect(split.incomplete).toBe(true);
  });

  it("rejects nonsense inputs rather than returning an empty route", () => {
    const g = new PoolGraph([livePool]);
    expect(() => bestSplitRoute(g, WETH, USDG, 0n)).toThrow();
    expect(() => bestSplitRoute(g, WETH, USDG, 10n ** 18n, { parts: 0 })).toThrow();
  });

  it("returns undefined when the pair is unreachable, rather than a zero-output route", () => {
    const g = new PoolGraph([livePool]);
    expect(bestSplitRoute(g, WETH, MEME, 10n ** 18n)).toBeUndefined();
  });
});

describe("route description", () => {
  it("names the hops and fee tiers for the UI's 'via' line", () => {
    const g = new PoolGraph([livePool]);
    const best = bestSingleRoute(g, WETH, USDG, 10n ** 15n)!;
    const text = describeRoute(best, { [WETH.toLowerCase()]: "WETH", [USDG.toLowerCase()]: "USDG" });
    expect(text).toContain("WETH");
    expect(text).toContain("USDG");
    expect(text).toContain("0.05%");
  });
});

describe("speed — the entire reason the math is off-chain", () => {
  it("quotes a realistic graph in well under a Jupiter-class budget", () => {
    // 40 pools, WETH-centred, mirroring the live chain's shape.
    const pools: PoolState[] = [livePool];
    for (let i = 0; i < 40; i++) {
      pools.push(
        variant({
          address: `0x${i.toString(16).padStart(40, "0")}`,
          token0: WETH,
          token1: `0x${(i + 1000).toString(16).padStart(40, "0")}`,
        }),
      );
    }
    const g = new PoolGraph(pools);
    const start = performance.now();
    const N = 25;
    for (let i = 0; i < N; i++) {
      bestSplitRoute(g, USDG, `0x${(1000).toString(16).padStart(40, "0")}`, 10n ** 15n, { parts: 6 });
    }
    const perQuote = (performance.now() - start) / N;
    console.log(`split-route quote over ${g.pools.length} pools: ${perQuote.toFixed(2)} ms`);
    // Jupiter's quote API answers in tens of milliseconds INCLUDING the network. Local route computation
    // must be a small fraction of that or the budget is gone before the request is even served.
    expect(perQuote).toBeLessThan(25);
  });
});
