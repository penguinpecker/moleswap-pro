import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  decodePopulatedTicks,
  decodeSlot0,
  decodeUint,
  fetchV3Pool,
  INDEXER_SELECTORS,
  type RpcTransport,
} from "../src/indexer.js";
import { quoteExactInput } from "../src/venues/v3Pool.js";

/**
 * These decoders are tested against RAW HEX the live PancakeSwap V3 pool actually returned
 * (`rpc.fixture.json`), captured at the same block family as `fixtures.live.json`. If a decoder is off by
 * a nibble it feeds the exact-to-the-wei quoter a wrong number — so the bar here is bit-exactness against
 * real chain output, not a mock we wrote to agree with ourselves.
 */

const rpc = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "test/rpc.fixture.json"), "utf8"),
) as {
  slot0: string;
  liquidity: string;
  tickLensWordMinus79: string;
  expect: { sqrtPriceX96: string; tickCount: number };
};

describe("decoders vs. real chain bytes", () => {
  it("decodes slot0 sqrtPriceX96 and tick", () => {
    const s = decodeSlot0(rpc.slot0);
    expect(s.sqrtPriceX96).toBe(BigInt(rpc.expect.sqrtPriceX96));
    // The pool sits deep in negative-tick territory (WETH/USDG, ~1e-9 raw price). The decoder MUST read
    // int24 as signed; an unsigned read would return a ~16-million tick and silently corrupt every quote.
    expect(s.tick).toBeLessThan(0);
    expect(s.tick).toBeGreaterThan(-887272);
  });

  it("decodes liquidity as a full uint128", () => {
    expect(decodeUint(rpc.liquidity)).toBeGreaterThan(0n);
    expect(decodeUint(rpc.liquidity)).toBe(BigInt("0x" + rpc.liquidity.replace(/^0x/, "").slice(-32)));
  });

  it("decodes a TickLens word into signed liquidityNet values", () => {
    const ticks = decodePopulatedTicks(rpc.tickLensWordMinus79);
    expect(ticks.length).toBe(rpc.expect.tickCount);
    // A real word straddling spot has both signs of liquidityNet; an unsigned decode would make every
    // net positive and break the crossing math. Assert both signs appear.
    expect(ticks.some((t) => t.liquidityNet < 0n)).toBe(true);
    expect(ticks.some((t) => t.liquidityNet > 0n)).toBe(true);
    for (const t of ticks) {
      expect(Number.isInteger(t.index)).toBe(true);
      expect(t.index).toBeLessThan(0); // this word is below spot
    }
  });

  it("returns an empty set for an empty word rather than throwing", () => {
    expect(decodePopulatedTicks("0x")).toEqual([]);
    const emptyArray =
      "0x0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000000000";
    expect(decodePopulatedTicks(emptyArray)).toEqual([]);
  });
});

/**
 * A mock transport that replays recorded bytes, so `fetchV3Pool` is exercised end to end — batching,
 * word selection, sorting, dedup — with zero network. The pool it assembles is then fed to the quoter and
 * must produce a sane, monotonic price curve, proving the assembled state is not merely well-typed but
 * actually usable.
 */
class ReplayTransport implements RpcTransport {
  constructor(
    private readonly pool: string,
    private readonly tickLens: string,
    private readonly r: typeof rpc,
  ) {}

  async call(): Promise<string> {
    throw new Error("unused");
  }

  async batchCall(calls: { to: string; data: string }[]): Promise<string[]> {
    return calls.map(({ to, data }) => {
      const sel = data.slice(0, 10);
      if (to === this.pool) {
        if (sel === INDEXER_SELECTORS.slot0) return this.r.slot0;
        if (sel === INDEXER_SELECTORS.liquidity) return this.r.liquidity;
        if (sel === INDEXER_SELECTORS.fee) return "0x" + (500).toString(16).padStart(64, "0");
        if (sel === INDEXER_SELECTORS.tickSpacing) return "0x" + (10).toString(16).padStart(64, "0");
        if (sel === INDEXER_SELECTORS.token0)
          return "0x" + "0Bd7D308f8E1639FAb988df18A8011f41EAcAD73".toLowerCase().padStart(64, "0");
        if (sel === INDEXER_SELECTORS.token1)
          return "0x" + "5fc5360D0400a0Fd4f2af552ADD042D716F1d168".toLowerCase().padStart(64, "0");
      }
      if (to === this.tickLens) {
        // Serve the one real word we captured for the word it belongs to; empty for the rest.
        if (data.endsWith("ffb1")) return this.r.tickLensWordMinus79;
        return "0x" +
          "0000000000000000000000000000000000000000000000000000000000000020" +
          "0000000000000000000000000000000000000000000000000000000000000000";
      }
      return "0x";
    });
  }
}

describe("fetchV3Pool assembles a usable PoolState", () => {
  const POOL = "0x88A8E96E7785d378825e8B5D7FC0e6f62487061E";
  const TICK_LENS = "0x9a489505a00cE272eAa5e07Dba6491314CaE3796";

  it("reads state and orders ticks ascending", async () => {
    const t = new ReplayTransport(POOL, TICK_LENS, rpc);
    const pool = await fetchV3Pool(t, POOL, TICK_LENS, 6);

    expect(pool.fee).toBe(500);
    expect(pool.tickSpacing).toBe(10);
    expect(pool.token0.toLowerCase()).toContain("0bd7d308");
    expect(pool.sqrtPriceX96).toBe(BigInt(rpc.expect.sqrtPriceX96));
    expect(pool.venue).toBe("PancakeV3");
    expect(pool.ticks.length).toBe(rpc.expect.tickCount);
    for (let i = 1; i < pool.ticks.length; i++) {
      expect(pool.ticks[i]!.index).toBeGreaterThan(pool.ticks[i - 1]!.index);
    }
  });

  it("produces a pool the quoter can price with a real, monotonic curve", async () => {
    const t = new ReplayTransport(POOL, TICK_LENS, rpc);
    const pool = await fetchV3Pool(t, POOL, TICK_LENS, 6);
    // Sell token1 (USDG) -> token0 (WETH): the assembled ticks are below spot, so a downward-price swap
    // has liquidity to cross. Larger trades must price strictly worse per unit.
    const small = quoteExactInput(pool, false, 10n ** 8n);
    const large = quoteExactInput(pool, false, 10n ** 10n);
    expect(small.amountOut).toBeGreaterThan(0n);
    const rSmall = (small.amountOut * 10n ** 18n) / small.amountIn;
    const rLarge = (large.amountOut * 10n ** 18n) / large.amountIn;
    expect(rLarge).toBeLessThanOrEqual(rSmall);
  });

  it("dedups ticks that appear in overlapping words", async () => {
    // Serve the SAME real word for every requested word; the dedup must collapse them to one set.
    class DupTransport extends ReplayTransport {
      override async batchCall(calls: { to: string; data: string }[]): Promise<string[]> {
        return calls.map(({ to, data }) => {
          const sel = data.slice(0, 10);
          if (to === POOL) {
            if (sel === INDEXER_SELECTORS.slot0) return rpc.slot0;
            if (sel === INDEXER_SELECTORS.liquidity) return rpc.liquidity;
            if (sel === INDEXER_SELECTORS.fee) return "0x" + (500).toString(16).padStart(64, "0");
            if (sel === INDEXER_SELECTORS.tickSpacing) return "0x" + (10).toString(16).padStart(64, "0");
            if (sel === INDEXER_SELECTORS.token0) return "0x" + "0bd7d308".padStart(64, "0");
            if (sel === INDEXER_SELECTORS.token1) return "0x" + "5fc5360d".padStart(64, "0");
          }
          if (to === TICK_LENS) return rpc.tickLensWordMinus79; // same word for all
          return "0x";
        });
      }
    }
    const pool = await fetchV3Pool(new DupTransport(POOL, TICK_LENS, rpc), POOL, TICK_LENS, 3);
    expect(pool.ticks.length).toBe(rpc.expect.tickCount); // not tickCount * (2*radius+1)
  });
});
