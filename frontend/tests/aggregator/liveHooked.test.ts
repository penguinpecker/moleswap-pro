/**
 * liveHooked.test.ts — the 1-second live session prices return-delta-hook pools by simulation.
 *
 * The swap card's displayed quote comes from LivePairSession (live.ts), not from quoteSwap — so without
 * this, a pair whose only venue is a hooked pool would execute fine (amm.executeSwap re-quotes through
 * quoteSwap) but the card would say "no route" and the button would never light. Attacks:
 *   - a hooked-only pair: quote() is null until a refresh tick has simulated the requested amount, then it
 *     quotes from the simulation with the "[hooked]" tag in the route breakdown;
 *   - refresh() must not early-return for a pair with no tick states but a hooked pool;
 *   - a simulation for a DIFFERENT amount (or fee) must not be assembled into a quote for this one;
 *   - a STALE simulation must be dropped, not displayed; an empty batch clears the candidate;
 *   - when both a tick route and a hooked route exist, the better OUTPUT wins, and the hooked route's gas
 *     comes from the quoter's estimate;
 *   - a hooked proxy is tagged "[hooked·proxy]"; a pair with no hooked row never touches the simulator;
 *   - MoleSwap's OWN mole_v4 rows (MoleHook carries a delta bit) are never hooked candidates: no quoter
 *     call on any tick of the hub pair, poolsQuoted not inflated; a malformed registry row cannot reject
 *     init() and take the whole pair's card down.
 * The hooked batch is answered at the wire by fakeRpc; everything else the session reads is mocked.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { decodeAbiParameters, encodeAbiParameters } from "viem";
import type { PoolRow } from "../../lib/aggregator/client";
import type { PoolState } from "../../lib/aggregator/venues/v3Pool";
import { makeFakeRpc, poolIdOfRow, type FakeWorld } from "./fakeRpc";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TOKEN = "0x1cf19a265363e743c767b7962ebedaafe86edba3";
const DELTA_HOOK = "0x0000000000000000000000000000000000000004";
const MOLE_HOOK = "0xb2c9a0af48df8858f3765385e733cd8776a138c4"; // the DEX's own hook (0x04 set) — never third-party
const SQRT_1_1 = 79228162514264337593543950336n;

const hookedRow: PoolRow = { id: "0xh1", venue: "uniswap_v4", token0: WETH, token1: TOKEN, fee: 8388608, tick_spacing: 200, hooks: DELTA_HOOK, address: "", active: false };
const HP = poolIdOfRow(hookedRow);
const v3Row: PoolRow = { id: "0xpool", venue: "uniswap_v3", token0: WETH, token1: TOKEN, fee: 3000, tick_spacing: 60, hooks: null, address: "0x00000000000000000000000000000000000000a1", active: true };

/** A healthy 1:1 v3 pool the tick router can price. */
const v3State: PoolState = {
  address: v3Row.address!,
  token0: WETH,
  token1: TOKEN,
  fee: 3000,
  tickSpacing: 60,
  sqrtPriceX96: SQRT_1_1,
  tick: 0,
  liquidity: 1_000_000_000_000_000n,
  ticks: [
    { index: -60000, liquidityNet: 1_000_000_000_000_000n },
    { index: 60000, liquidityNet: -1_000_000_000_000_000n },
  ],
  venue: "PancakeV3",
};

const AMOUNT = 100_000_000_000_000n; // 1e14

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
  for (const m of ["client", "discover", "venues/v4Reader", "rpcBatch", "multicall"]) vi.doUnmock(`../../lib/aggregator/${m}`);
  vi.doUnmock("../../lib/mole/aggFee");
});

/** The hooked pool's script: quoter answer (or revert), a deep 1:1 light reference. */
const hookedPool = (quote: FakeWorld["pools"][string]["quote"]) => ({ quote, slot0: { sqrtPriceX96: SQRT_1_1, tick: 0 }, liquidity: 10n ** 30n });
/** A hook that returns 98% of the input — inside the skim policy against the 1:1 reference. */
const nearPar = (_z: boolean, amt: bigint) => ({ amountOut: (amt * 98n) / 100n, gasEstimate: 900_000n });
const NEAR_PAR_OUT = (AMOUNT * 98n) / 100n; // 98e12

async function sessionWith(opts: { states: PoolState[]; rows: PoolRow[]; world: FakeWorld; feeBps?: number; pair?: [string, string] }) {
  vi.resetModules();
  const fake = makeFakeRpc(opts.world);
  vi.doMock("../../lib/aggregator/rpcBatch", () => ({ jsonRpcBatch: fake.jsonRpcBatch, RPC_BATCH_TIMEOUT_MS: 1500 }));
  vi.doMock("../../lib/aggregator/client", async (orig) => {
    const real = (await orig()) as any;
    return { ...real, fetchRelevantPoolStates: vi.fn(async () => opts.states) };
  });
  vi.doMock("../../lib/aggregator/discover", () => ({ discoverForPair: vi.fn(async () => []) }));
  vi.doMock("../../lib/aggregator/venues/v4Reader", async (orig) => {
    const real = (await orig()) as any;
    return { ...real, fetchV4Pool: vi.fn(async () => null), fetchV4PoolByKey: vi.fn(async () => null), fetchV4TickReference: vi.fn(async () => null) };
  });
  vi.doMock("../../lib/aggregator/multicall", async (orig) => {
    const real = (await orig()) as any;
    // The v3 refresh multicall answers "every call failed" (a degraded RPC), so the session keeps its
    // stale tick states — exactly the path a real outage takes — and no network is touched.
    const rpcCall = vi.fn(async (_rpc: string, _to: string, data: string) => {
      const [calls] = decodeAbiParameters(
        [{ type: "tuple[]", components: [{ type: "address" }, { type: "bool" }, { type: "bytes" }] }],
        `0x${data.slice(10)}` as `0x${string}`,
      ) as unknown as [unknown[]];
      return encodeAbiParameters([{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }], [calls.map(() => [false, "0x"]) as any]);
    });
    return { ...real, rpcCall };
  });
  vi.doMock("../../lib/mole/aggFee", () => ({ getAggFeeBps: async () => opts.feeBps ?? 0, cachedAggFeeBps: () => opts.feeBps ?? 0 }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({}) })) as any); // eth_gasPrice etc.

  const { LivePairSession } = await import("../../lib/aggregator/live");
  const { _clearHookRiskCache } = await import("../../lib/aggregator/hookRisk");
  _clearHookRiskCache();
  const [pIn, pOut] = opts.pair ?? [WETH, TOKEN];
  const s = new LivePairSession(pIn, pOut, WETH);
  await s.init(opts.rows);
  const quoterCalls = () => fake.calls.flat().filter((c) => c.method === "eth_call" && (c.params[0] as any).to.toLowerCase() === "0x8dc178efb8111bb0973dd9d722ebeff267c98f94");
  return { s, fake, quoterCalls };
}

const hooksOk = { [DELTA_HOOK]: { code: "0x6080" } };
const quoteParams = { amountIn: AMOUNT, recipient: "0x000000000000000000000000000000000000dEaD", slippageBps: 50, decimalsIn: 18, decimalsOut: 18 };

describe("a pair whose ONLY venue is a return-delta-hook pool", () => {
  it("quotes from the simulation after a refresh tick, tagged [hooked], minOut ≤ simulated, gas from the quoter", async () => {
    const { s, quoterCalls } = await sessionWith({
      states: [],
      rows: [hookedRow],
      world: { pools: { [HP]: hookedPool(nearPar) }, hooks: hooksOk },
    });
    expect(s.hookedPoolCount).toBe(1);
    expect(s.poolCount).toBe(0);

    // Before any refresh nothing has been simulated for this amount: honest null, and the amount is noted.
    expect(s.quote(quoteParams)).toBeNull();
    expect(quoterCalls()).toHaveLength(0);

    // The refresh tick MUST run for a hooked-only pair (it used to early-return on states.length === 0).
    await s.refresh();
    expect(quoterCalls()).toHaveLength(1);

    const q = s.quote(quoteParams);
    expect(q).not.toBeNull();
    expect(q!.amountOut).toBe(NEAR_PAR_OUT);
    expect(q!.minAmountOut).toBe((NEAR_PAR_OUT * 9_950n) / 10_000n);
    expect(q!.minAmountOut <= q!.amountOut).toBe(true);
    expect(q!.routes).toHaveLength(1);
    expect(q!.routes[0]!.hops[0]!.venue).toContain("[hooked]");
    expect(q!.routes[0]!.hops[0]!.tokenIn.toLowerCase()).toBe(WETH);
    expect(q!.gasUnits).toBe(60_000n + 900_000n);
    expect(q!.encoded.paths[0]!.hops[0]!.key.hooks.toLowerCase()).toBe(DELTA_HOOK);
    expect(q!.encoded.paths[0]!.hops[0]!.key.fee).toBe(8388608);
    expect(q!.poolsQuoted).toBe(1);
    expect(q!.priceImpactPct).not.toBeNull(); // the light reference gives the hop a real spot price
  });

  it("does NOT assemble a simulation made for a different amount — it waits for the next tick", async () => {
    const seen: bigint[] = [];
    const { s } = await sessionWith({
      states: [],
      rows: [hookedRow],
      world: { pools: { [HP]: hookedPool((_z, amt) => { seen.push(amt); return { amountOut: (amt * 98n) / 100n }; }) }, hooks: hooksOk },
    });
    s.quote(quoteParams);
    await s.refresh(); // simulated for AMOUNT
    expect(s.quote({ ...quoteParams, amountIn: AMOUNT * 2n })).toBeNull(); // different amount → nothing usable
    await s.refresh(); // re-simulates for the new amount
    expect(seen).toEqual([AMOUNT, AMOUNT * 2n]);
    expect(s.quote({ ...quoteParams, amountIn: AMOUNT * 2n })).not.toBeNull();
  });

  it("simulates the NET input when the aggregator fee is non-zero", async () => {
    const seen: bigint[] = [];
    const { s } = await sessionWith({
      states: [],
      rows: [hookedRow],
      world: { pools: { [HP]: hookedPool((_z, amt) => { seen.push(amt); return { amountOut: (amt * 98n) / 100n }; }) }, hooks: hooksOk },
      feeBps: 69,
    });
    s.quote(quoteParams);
    await s.refresh();
    expect(seen).toEqual([99_310_000_000_000n]);
    const q = s.quote(quoteParams);
    expect(q!.feeBps).toBe(69);
    expect(q!.feeAmount).toBe(690_000_000_000n);
    expect(q!.encoded.paths[0]!.amountIn).toBe(AMOUNT); // plan declares the GROSS
  });

  it("drops a STALE simulation instead of displaying it", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { s } = await sessionWith({
      states: [],
      rows: [hookedRow],
      world: { pools: { [HP]: hookedPool(nearPar) }, hooks: hooksOk },
    });
    s.quote(quoteParams);
    await s.refresh();
    expect(s.quote(quoteParams)).not.toBeNull();
    vi.setSystemTime(1_800_000_000_000 + 10_001); // past HOOKED_SIM_MAX_AGE_MS
    expect(s.quote(quoteParams)).toBeNull();
  });

  it("a reverting quoter clears the candidate; a hook with no code never produces one", async () => {
    const world: FakeWorld = { pools: { [HP]: hookedPool(nearPar) }, hooks: hooksOk };
    const { s } = await sessionWith({ states: [], rows: [hookedRow], world });
    s.quote(quoteParams);
    await s.refresh();
    expect(s.quote(quoteParams)).not.toBeNull();
    world.pools[HP]!.quote = "revert"; // the pool drains / the hook starts rejecting
    await s.refresh();
    expect(s.quote(quoteParams)).toBeNull();

    const { s: s2 } = await sessionWith({ states: [], rows: [hookedRow], world: { pools: { [HP]: hookedPool(nearPar) }, hooks: { [DELTA_HOOK]: { code: "0x" } } } });
    s2.quote(quoteParams);
    await s2.refresh();
    expect(s2.quote(quoteParams)).toBeNull();
  });

  it("tags an upgradeable (proxy) hook as [hooked·proxy]", async () => {
    const { s } = await sessionWith({
      states: [],
      rows: [hookedRow],
      world: { pools: { [HP]: hookedPool(nearPar) }, hooks: { [DELTA_HOOK]: { code: "0x6080", impl: "0x000000000000000000000000abababababababababababababababababababab" } } },
    });
    s.quote(quoteParams);
    await s.refresh();
    expect(s.quote(quoteParams)!.routes[0]!.hops[0]!.venue).toContain("[hooked·proxy]");
  });
});

describe("a pair with BOTH a tick route and a hooked route", () => {
  it("prefers the hooked route only when it delivers more, and labels accordingly", async () => {
    // First measure the tick-math output alone.
    const tickOnly = await sessionWith({ states: [v3State], rows: [v3Row], world: { pools: {}, hooks: {} } });
    const tickQ = tickOnly.s.quote(quoteParams)!;
    expect(tickQ).not.toBeNull();
    expect(tickQ.routes[0]!.hops[0]!.venue).not.toContain("hooked");

    // Hooked delivers LESS → tick wins, no tag.
    const worse = await sessionWith({ states: [v3State], rows: [v3Row, hookedRow], world: { pools: { [HP]: hookedPool({ amountOut: tickQ.amountOut - 1n }) }, hooks: hooksOk } });
    worse.s.quote(quoteParams);
    await worse.s.refresh();
    const qw = worse.s.quote(quoteParams)!;
    expect(qw.amountOut).toBe(tickQ.amountOut);
    expect(qw.routes.every((r) => r.hops.every((h) => !h.venue.includes("hooked")))).toBe(true);

    // Hooked delivers MORE → hooked wins, tagged, and its plan is the single-hop hooked plan.
    const better = await sessionWith({ states: [v3State], rows: [v3Row, hookedRow], world: { pools: { [HP]: hookedPool({ amountOut: tickQ.amountOut + 1_000n, gasEstimate: 777n }) }, hooks: hooksOk } });
    better.s.quote(quoteParams);
    await better.s.refresh();
    const qb = better.s.quote(quoteParams)!;
    expect(qb.amountOut).toBe(tickQ.amountOut + 1_000n);
    expect(qb.routes[0]!.hops[0]!.venue).toContain("[hooked]");
    expect(qb.encoded.paths).toHaveLength(1);
    expect(qb.encoded.paths[0]!.hops[0]!.key.hooks.toLowerCase()).toBe(DELTA_HOOK);
    expect(qb.gasUnits).toBe(60_000n + 777n);
    expect(qb.poolsQuoted).toBe(2);
  });

  it("a pair with no hooked row never touches the simulator and keeps poolsQuoted = tick states", async () => {
    const { s, fake } = await sessionWith({ states: [v3State], rows: [v3Row], world: { pools: {}, hooks: {} } });
    s.quote(quoteParams);
    await s.refresh();
    expect(fake.calls).toHaveLength(0);
    expect(s.hookedPoolCount).toBe(0);
    expect(s.quote(quoteParams)!.poolsQuoted).toBe(1);
  });
});

describe("MoleSwap's OWN pools are never hooked candidates (the hub pair WETH/USDG)", () => {
  // The live registry's mole_v4 rows as shaped on chain: venue mole_v4, WETH/USDG, dynamic-fee sentinel,
  // MoleHook (whose address carries afterSwapReturnDelta), active=true.
  const moleRows: PoolRow[] = [
    { id: "0x9aca9d2f4bb68ef41e6928bbe080a4b076b167e2d4b7fdebf4b4fd5d6dadd029", venue: "mole_v4", token0: WETH, token1: USDG, fee: 8388608, tick_spacing: 60, hooks: MOLE_HOOK, address: "", active: true },
    { id: "0xf54b7c6690cdfb8629ea2bc66dacd29640e86b4847b13eeb019e4f033550fbe9", venue: "mole_v4", token0: WETH, token1: USDG, fee: 8388608, tick_spacing: 10, hooks: MOLE_HOOK, address: "", active: true },
  ];
  const usdgV3Row: PoolRow = { ...v3Row, id: "0xusdgpool", token1: USDG, address: "0x00000000000000000000000000000000000000a2" };
  const usdgV3State: PoolState = { ...v3State, address: usdgV3Row.address!, token1: USDG };

  it("hookedPoolCount is 0, NO quoter call on any refresh tick, and poolsQuoted counts the tick states only", async () => {
    // Even with a quoter scripted to answer handsomely for the Mole pools and the hook screen passing.
    const world: FakeWorld = {
      pools: Object.fromEntries(moleRows.map((r) => [poolIdOfRow(r), hookedPool({ amountOut: AMOUNT * 2n, gasEstimate: 900_000n })])),
      hooks: { [MOLE_HOOK]: { code: "0x6080" } },
    };
    const { s, fake, quoterCalls } = await sessionWith({ states: [usdgV3State], rows: [usdgV3Row, ...moleRows], world, pair: [WETH, USDG] });
    expect(s.hookedPoolCount).toBe(0);
    s.quote(quoteParams); // notes the amount — the only thing that could arm a simulation
    await s.refresh();
    await s.refresh();
    expect(quoterCalls()).toHaveLength(0);
    expect(fake.calls).toHaveLength(0); // no batch at all: the hub pair pays nothing for the fallback
    const q = s.quote(quoteParams);
    expect(q).not.toBeNull();
    expect(q!.poolsQuoted).toBe(1); // the v3 state; the Mole rows are not double-counted as hooked pools
    expect(q!.routes.every((r) => r.hops.every((h) => !h.venue.includes("[hooked")))).toBe(true);
  });

  it("a pair whose ONLY registry rows are the Mole pools has no hooked candidate either (no phantom route)", async () => {
    const { s, fake } = await sessionWith({ states: [], rows: moleRows, world: { pools: {}, hooks: {} }, pair: [WETH, USDG] });
    expect(s.hookedPoolCount).toBe(0);
    expect(s.quote(quoteParams)).toBeNull();
    await s.refresh();
    expect(fake.calls).toHaveLength(0);
    expect(s.quote(quoteParams)).toBeNull();
  });

  it("a MoleHook pool filed under the third-party venue (the 2026-08-15 backfill shape: uniswap_v4, inactive) is refused by the HOOK alone", async () => {
    const strayMole: PoolRow[] = moleRows.map((r) => ({ ...r, venue: "uniswap_v4", active: false }));
    const world: FakeWorld = {
      pools: Object.fromEntries(strayMole.map((r) => [poolIdOfRow(r), hookedPool({ amountOut: AMOUNT * 2n, gasEstimate: 900_000n })])),
      hooks: { [MOLE_HOOK]: { code: "0x6080" } },
    };
    const { s, fake, quoterCalls } = await sessionWith({ states: [usdgV3State], rows: [usdgV3Row, ...strayMole], world, pair: [WETH, USDG] });
    expect(s.hookedPoolCount).toBe(0);
    s.quote(quoteParams);
    await s.refresh();
    expect(quoterCalls()).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    expect(s.quote(quoteParams)!.poolsQuoted).toBe(1);
  });
});

describe("a MALFORMED registry row cannot take the pair down", () => {
  it("init() resolves, the bad row is simply not a candidate, and the pair still quotes", async () => {
    // Before the fail-closed classifier, BigInt('0x') threw out of hookedCandidateRows inside init() (outside
    // its try) and REJECTED the whole session → the card showed no route for a pair that has a fine v3 pool.
    const badRows: PoolRow[] = [
      { ...hookedRow, id: "0xbad1", hooks: "0x" },
      { ...hookedRow, id: "0xbad2", hooks: "0xzz" },
    ];
    const { s, fake } = await sessionWith({ states: [v3State], rows: [v3Row, ...badRows], world: { pools: {}, hooks: {} } });
    expect(s.hookedPoolCount).toBe(0);
    s.quote(quoteParams);
    await s.refresh();
    expect(fake.calls).toHaveLength(0);
    const q = s.quote(quoteParams);
    expect(q).not.toBeNull();
    expect(q!.poolsQuoted).toBe(1);
  });
});
