/**
 * route.ts — the aggregator: given "I have X of A and want B", find the best way through every venue.
 *
 * THE SHAPE OF THE PROBLEM ON THIS CHAIN, measured rather than assumed. A scan of the live PancakeSwap V3
 * factory on Robinhood Chain found 311 pools over 279 tokens, and the graph is a STAR: WETH appears in 71
 * pools with live liquidity, USDG in 4, and almost everything else in one or two. So the routes that
 * matter are `A -> WETH -> B` and direct `A -> B`, not deep 5-hop chains. This searches all simple paths
 * up to `maxHops` anyway, because the cost is trivial at this graph size and hard-coding "always via WETH"
 * would silently break the day a second hub appears.
 *
 * WHY SPLITTING MATTERS MORE THAN HOP DEPTH. A v3 quote is concave in size — the marginal price gets
 * worse as you consume liquidity. So sending 100% down the single best path is usually NOT optimal: past
 * some size, the second-best pool's untouched liquidity beats the best pool's exhausted tail. That is
 * most of what an aggregator's output is actually worth, and it is why `bestSplitRoute` exists rather
 * than just `bestSingleRoute`.
 *
 * NOTHING HERE TOUCHES THE NETWORK. Every quote is computed from cached pool state by `quoteExactInput`,
 * which is verified against real on-chain swaps to the wei. That is the entire reason a quote can be
 * returned in microseconds instead of a round trip per candidate.
 */

import { quoteExactInput, type PoolState } from "./venues/v3Pool";

export interface Hop {
  readonly pool: PoolState;
  readonly zeroForOne: boolean;
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export interface Route {
  readonly hops: readonly Hop[];
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  /** True if ANY hop had to price against liquidity it could not see. Never quote this to a user. */
  readonly incomplete: boolean;
}

export interface SplitRoute {
  readonly parts: readonly Route[];
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly incomplete: boolean;
}

const norm = (a: string) => a.toLowerCase();

/** Adjacency: token -> pools that contain it. Built once per state refresh, not per quote. */
export class PoolGraph {
  private readonly byToken = new Map<string, PoolState[]>();
  readonly pools: readonly PoolState[];

  constructor(pools: readonly PoolState[]) {
    // A pool with no liquidity cannot fill anything and only widens the search, so it is dropped here
    // rather than being quoted 311 times per request and returning zero.
    this.pools = pools.filter((p) => p.liquidity > 0n || p.ticks.length > 0);
    for (const p of this.pools) {
      for (const t of [norm(p.token0), norm(p.token1)]) {
        const list = this.byToken.get(t);
        if (list) list.push(p);
        else this.byToken.set(t, [p]);
      }
    }
  }

  poolsFor(token: string): readonly PoolState[] {
    return this.byToken.get(norm(token)) ?? [];
  }

  get tokenCount(): number {
    return this.byToken.size;
  }

  /** Every simple path from `tokenIn` to `tokenOut` using at most `maxHops` pools. */
  findPaths(tokenIn: string, tokenOut: string, maxHops = 3): Hop[][] {
    const from = norm(tokenIn);
    const to = norm(tokenOut);
    if (from === to) return [];

    const out: Hop[][] = [];
    const seenPools = new Set<string>();

    const walk = (current: string, path: Hop[]) => {
      if (path.length >= maxHops) return;
      for (const pool of this.poolsFor(current)) {
        if (seenPools.has(pool.address)) continue; // a simple path never reuses a pool
        const t0 = norm(pool.token0);
        const t1 = norm(pool.token1);
        const next = current === t0 ? t1 : t0;
        // Guard against a token appearing twice in one path, which would be a cycle.
        if (path.some((h) => norm(h.tokenIn) === next)) continue;

        const hop: Hop = {
          pool,
          zeroForOne: current === t0,
          tokenIn: current,
          tokenOut: next,
        };
        if (next === to) {
          out.push([...path, hop]);
          continue; // do not extend past the destination
        }
        seenPools.add(pool.address);
        walk(next, [...path, hop]);
        seenPools.delete(pool.address);
      }
    };

    walk(from, []);
    return out;
  }
}

/** Price one path end to end, feeding each hop's output into the next. */
export function quotePath(hops: readonly Hop[], amountIn: bigint): Route {
  let amount = amountIn;
  let incomplete = false;

  for (const hop of hops) {
    if (amount <= 0n) {
      // A hop produced nothing; the route is dead rather than free.
      return { hops, amountIn, amountOut: 0n, incomplete: true };
    }
    const q = quoteExactInput(hop.pool, hop.zeroForOne, amount);
    if (q.exhaustedTickData) incomplete = true;
    amount = q.amountOut;
  }

  return { hops, amountIn, amountOut: amount, incomplete };
}

/** The single best path, ignoring splits. */
export function bestSingleRoute(
  graph: PoolGraph,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  maxHops = 3,
): Route | undefined {
  const paths = graph.findPaths(tokenIn, tokenOut, maxHops);
  let best: Route | undefined;
  for (const p of paths) {
    const r = quotePath(p, amountIn);
    if (r.amountOut > 0n && (best === undefined || r.amountOut > best.amountOut)) best = r;
  }
  return best;
}

export interface SplitOptions {
  /** How many equal slices the input is divided into. More slices = finer splits = slower. */
  readonly parts?: number;
  readonly maxHops?: number;
  /** Cap on distinct paths considered, cheapest-first. Guards against a pathological graph. */
  readonly maxPaths?: number;
}

/**
 * The best allocation of `amountIn` across several paths.
 *
 * GREEDY MARGINAL ALLOCATION, and the reason it is the right algorithm here rather than an approximation
 * to apologise for: a v3 pool's output is CONCAVE in input (each additional unit buys less than the last),
 * and a sum of concave functions maximised under a budget constraint is exactly the problem greedy
 * marginal allocation solves optimally. Hand the next slice to whichever path currently offers the most
 * for it, repeat. With `parts` slices the result is within one slice of optimal.
 *
 * The cost is `parts x paths` quotes, all in memory, all pure arithmetic — which at this graph's size is
 * microseconds, and is why this can run on every keystroke.
 */
export function bestSplitRoute(
  graph: PoolGraph,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  opts: SplitOptions = {},
): SplitRoute | undefined {
  const parts = opts.parts ?? 10;
  const maxHops = opts.maxHops ?? 3;
  const maxPaths = opts.maxPaths ?? 8;
  if (parts <= 0) throw new Error("parts must be positive");
  if (amountIn <= 0n) throw new Error("amountIn must be positive");

  const all = graph.findPaths(tokenIn, tokenOut, maxHops);
  if (all.length === 0) return undefined;

  // Rank candidates on the FULL size first, then keep the top few. Ranking on a slice would favour
  // shallow pools that look good small and run dry immediately.
  const rankedAll = all
    .map((hops) => ({ hops, probe: quotePath(hops, amountIn) }))
    .filter((c) => c.probe.amountOut > 0n)
    .sort((a, b) => (b.probe.amountOut > a.probe.amountOut ? 1 : -1));

  // POOL-DISJOINT SELECTION — the correctness guard for splitting. The greedy allocator below prices each
  // path in ISOLATION against pristine pool liquidity. If two split parts shared a pool, the allocator
  // would count that pool's liquidity twice and quote an output neither part can realise on-chain (the
  // second part to touch the shared pool sees state the first already moved) — the swap then reverts at
  // minAmountOut. So we admit a path into the split set only if it shares no pool with an already-admitted,
  // higher-ranked path. Each surviving pool is consumed by at most one part, which makes the independent
  // per-path pricing EXACT rather than optimistic. Best-first order keeps the strongest path unconditionally.
  const usedPools = new Set<string>();
  const ranked: typeof rankedAll = [];
  for (const c of rankedAll) {
    if (c.hops.some((h) => usedPools.has(h.pool.address))) continue;
    for (const h of c.hops) usedPools.add(h.pool.address);
    ranked.push(c);
    if (ranked.length >= maxPaths) break;
  }

  if (ranked.length === 0) return undefined;

  const slice = amountIn / BigInt(parts);
  if (slice === 0n) {
    // Too small to split meaningfully — one path takes it all.
    const single = bestSingleRoute(graph, tokenIn, tokenOut, amountIn, maxHops);
    return single
      ? { parts: [single], amountIn, amountOut: single.amountOut, incomplete: single.incomplete }
      : undefined;
  }

  const allocated: bigint[] = ranked.map(() => 0n);
  let remaining = amountIn;

  for (let i = 0; i < parts; i++) {
    // The final slice absorbs the division remainder so the parts sum EXACTLY to amountIn. Losing a
    // wei here would make the executor's transfer disagree with the quote.
    const thisSlice = i === parts - 1 ? remaining : slice;
    if (thisSlice <= 0n) break;

    let bestIdx = -1;
    let bestMarginal = -1n;

    for (let j = 0; j < ranked.length; j++) {
      const trial = allocated[j]! + thisSlice;
      const withSlice = quotePath(ranked[j]!.hops, trial).amountOut;
      const without = allocated[j]! === 0n ? 0n : quotePath(ranked[j]!.hops, allocated[j]!).amountOut;
      const marginal = withSlice - without;
      if (marginal > bestMarginal) {
        bestMarginal = marginal;
        bestIdx = j;
      }
    }

    if (bestIdx < 0 || bestMarginal <= 0n) break;
    allocated[bestIdx] = allocated[bestIdx]! + thisSlice;
    remaining -= thisSlice;
  }

  const used: Route[] = [];
  let total = 0n;
  let incomplete = false;
  for (let j = 0; j < ranked.length; j++) {
    const amt = allocated[j]!;
    if (amt <= 0n) continue;
    const r = quotePath(ranked[j]!.hops, amt);
    used.push(r);
    total += r.amountOut;
    if (r.incomplete) incomplete = true;
  }

  if (used.length === 0) return undefined;
  const spent = used.reduce((a, r) => a + r.amountIn, 0n);
  return { parts: used, amountIn: spent, amountOut: total, incomplete };
}

/** A human-readable description of a route, for logs and for the UI's "via" line. */
export function describeRoute(route: Route, symbols: Record<string, string> = {}): string {
  const sym = (a: string) => symbols[norm(a)] ?? `${a.slice(0, 6)}..`;
  if (route.hops.length === 0) return "(empty)";
  const path = [sym(route.hops[0]!.tokenIn), ...route.hops.map((h) => sym(h.tokenOut))];
  const fees = route.hops.map((h) => `${h.pool.fee / 10_000}%`).join(" -> ");
  return `${path.join(" -> ")} [${fees}]`;
}
