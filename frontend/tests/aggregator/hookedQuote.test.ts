/**
 * hookedQuote.test.ts — assembling an executable quote for a return-delta-hook pool from a simulation.
 *
 * Written as attacks, at the WIRE level (fakeRpc answers the real batch; the real encoders/decoders run):
 *   - the hook must never set minOut above what was simulated (and the assembler must REFUSE a plan that
 *     would); a hook that skims past the policy, fails its screen (no code), or reverts must produce NO
 *     quote; only pools that serve the pair directly are eligible; the simulation must price the NET input
 *     (after the router's input fee) and a simulation for a different net input must not be assembled; no
 *     more than the cap may be simulated per quote; the whole path is ONE batch round trip; a transport
 *     failure yields nothing (never a guess); the light reference's verdict is CONFIRMED on the full tick
 *     window before a pool is excluded; a hook screened once is not re-read; MoleSwap's OWN mole_v4 pools
 *     (MoleHook carries a delta bit) are NEVER candidates and cost no network; a malformed registry row
 *     never throws out of the candidate filter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PoolRow } from "../../lib/aggregator/client";
import type { PoolState } from "../../lib/aggregator/venues/v3Pool";
import { NATIVE } from "../../lib/aggregator/quote";
import { makeFakeRpc, poolIdOfRow, type FakeWorld } from "./fakeRpc";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TOKEN = "0x1cf19a265363e743c767b7962ebedaafe86edba3";
const TOKEN2 = "0xe21bb3c99166c5f5df0f3e356a955bec1597c97f";
const MOLE_HOOK = "0xb2c9a0af48df8858f3765385e733cd8776a138c4"; // the DEX's own hook — carries 0x04, NOT third-party
const DELTA_HOOK = "0x0000000000000000000000000000000000000004"; // afterSwapReturnDelta
const HOOK2 = "0x0000000000000000000000000000000000000008"; // beforeSwapReturnDelta
const NO_HOOK = "0x0000000000000000000000000000000000000000";
const SQRT_1_1 = 79228162514264337593543950336n; // 1:1

function row(token0: string, token1: string, hooks: string, id = "0x01"): PoolRow {
  return { id, venue: "uniswap_v4", token0, token1, fee: 8388608, tick_spacing: 200, hooks, address: "", active: false };
}

const R1 = row(WETH, TOKEN, DELTA_HOOK, "0x01");
const R2 = row(WETH, TOKEN, HOOK2, "0x02");
const P1 = poolIdOfRow(R1);
const P2 = poolIdOfRow(R2);
/** The live registry's mole_v4 rows, as shaped on chain (venue mole_v4, dynamic-fee sentinel, MoleHook, active). */
const MOLE_ROWS: PoolRow[] = [
  { id: "0x9aca9d2f4bb68ef41e6928bbe080a4b076b167e2d4b7fdebf4b4fd5d6dadd029", venue: "mole_v4", token0: WETH, token1: USDG, fee: 8388608, tick_spacing: 60, hooks: MOLE_HOOK, address: "", active: true },
  { id: "0xf54b7c6690cdfb8629ea2bc66dacd29640e86b4847b13eeb019e4f033550fbe9", venue: "mole_v4", token0: WETH, token1: USDG, fee: 8388608, tick_spacing: 10, hooks: MOLE_HOOK, address: "", active: true },
];

const baseReq = {
  tokenIn: WETH,
  tokenOut: TOKEN,
  amountIn: 100_000_000_000_000n, // 1e14
  recipient: "0x000000000000000000000000000000000000dEaD",
  slippageBps: 50,
  feeBps: 69,
  weth: WETH,
  nowSeconds: 1_800_000_000n,
  ttlSeconds: 60n,
};
const NET = 99_310_000_000_000n; // 1e14 − 69 bps

/** A deep 1:1 pool so the light reference prices ~1:1 minus fee; liquidity huge → no crossing. */
const deepPool = (amountOut: bigint | "revert", lpFee = 0) => ({
  quote: amountOut === "revert" ? ("revert" as const) : { amountOut, gasEstimate: 900_000n },
  slot0: { sqrtPriceX96: SQRT_1_1, tick: 0, lpFee },
  liquidity: 10n ** 30n,
});

let fake: ReturnType<typeof makeFakeRpc>;
const confirmCalls: unknown[] = [];

async function load(world: FakeWorld) {
  vi.resetModules();
  fake = makeFakeRpc(world);
  vi.doMock("../../lib/aggregator/rpcBatch", () => ({ jsonRpcBatch: fake.jsonRpcBatch, RPC_BATCH_TIMEOUT_MS: 1500 }));
  // The full-window confirmation read is a viem client read — stubbed; it records each call.
  vi.doMock("../../lib/aggregator/venues/v4Reader", async (orig) => {
    const real = (await orig()) as any;
    return {
      ...real,
      fetchV4TickReference: vi.fn(async (key: any) => {
        confirmCalls.push(key);
        return (world as any).__confirm ?? null;
      }),
    };
  });
  const hooked = await import("../../lib/aggregator/hookedQuote");
  const risk = await import("../../lib/aggregator/hookRisk");
  risk._clearHookRiskCache();
  hooked._clearHookedReferenceCache();
  return hooked;
}

beforeEach(() => {
  confirmCalls.length = 0;
});
afterEach(() => {
  vi.doUnmock("../../lib/aggregator/rpcBatch");
  vi.doUnmock("../../lib/aggregator/venues/v4Reader");
  vi.resetModules();
});

const worldWith = (pools: FakeWorld["pools"], hooks: FakeWorld["hooks"] = { [DELTA_HOOK]: { code: "0x6080" }, [HOOK2]: { code: "0x6080" } }): FakeWorld => ({ pools, hooks });

describe("hookedCandidateRows (pure)", () => {
  it("keeps ONLY simulate-eligible rows that serve the pair directly, deduped by id, capped", async () => {
    const { hookedCandidateRows, MAX_SIMULATED_POOLS } = await load(worldWith({}));
    const rows = [
      row(WETH, TOKEN, DELTA_HOOK, "0x01"),
      row(WETH, TOKEN, DELTA_HOOK, "0x01"), // duplicate id
      row(TOKEN, TOKEN2, DELTA_HOOK, "0x02"), // wrong pair
      row(WETH, TOKEN, NO_HOOK, "0x03"), // not a delta hook (a tick pool)
      row("0x0000000000000000000000000000000000000000", TOKEN, DELTA_HOOK, "0x04"), // native leg
      row(TOKEN, WETH, HOOK2, "0x05"), // reversed column order, before-delta hook
      row(WETH, TOKEN, "0x000000000000000000000000000000000000000c", "0x06"),
      row(WETH, TOKEN, "0x000000000000000000000000000000000000000c", "0x07"),
      row(WETH, TOKEN, "0x000000000000000000000000000000000000000c", "0x08"), // over the cap
    ];
    const out = hookedCandidateRows(rows, WETH, TOKEN);
    expect(out.map((r) => r.id)).toEqual(["0x01", "0x05", "0x06", "0x07"].slice(0, MAX_SIMULATED_POOLS));
    expect(out.length).toBeLessThanOrEqual(MAX_SIMULATED_POOLS);
    expect(hookedCandidateRows([R1], WETH, WETH)).toEqual([]); // same-token pair → nothing
  });

  it("EXCLUDES MoleSwap's OWN mole_v4 rows (real-shaped WETH/USDG, MoleHook, active) — tick-path pools, not hooked candidates", async () => {
    const { hookedCandidateRows } = await load(worldWith({}));
    // MoleHook's address carries afterSwapReturnDelta, so the bare bit test would admit the DEX's own pools
    // here: they would be simulated through the external quoter on every quote, take candidate slots ahead
    // of real third-party hooked pools, and could be relabelled "[hooked]". They must never be candidates.
    expect(hookedCandidateRows(MOLE_ROWS, WETH, USDG)).toEqual([]);
    expect(hookedCandidateRows(MOLE_ROWS, USDG, WETH)).toEqual([]);
    // …and they must not take slots: with the cap's worth of real hooked pools listed AFTER them, every
    // slot goes to a third-party pool.
    const thirdParty = Array.from({ length: 4 }, (_, i) => row(WETH, USDG, DELTA_HOOK, `0xtp${i}`));
    thirdParty.forEach((r, i) => (r.tick_spacing = 10 * (i + 1)));
    expect(hookedCandidateRows([...MOLE_ROWS, ...thirdParty], WETH, USDG).map((r) => r.id)).toEqual(thirdParty.map((r) => r.id));
    // The venue alone excludes a mole_v4 row too, whatever hook it names.
    expect(hookedCandidateRows([{ ...MOLE_ROWS[0]!, hooks: DELTA_HOOK }], WETH, USDG)).toEqual([]);
    // And the HOOK alone excludes a MoleHook pool that reached the registry under the third-party venue —
    // the exact shape the 2026-08-15 backfill incident wrote (uniswap_v4, active=false, MoleHook).
    const strayMole: PoolRow[] = MOLE_ROWS.map((r) => ({ ...r, venue: "uniswap_v4", active: false }));
    expect(hookedCandidateRows(strayMole, WETH, USDG)).toEqual([]);
  });

  it("never throws on a MALFORMED registry row — it is simply not a candidate", async () => {
    const { hookedCandidateRows } = await load(worldWith({}));
    const bad = [row(WETH, TOKEN, "0x", "0xb1"), row(WETH, TOKEN, "0xzz", "0xb2"), row(WETH, TOKEN, "0x04", "0xb3")];
    expect(() => hookedCandidateRows(bad, WETH, TOKEN)).not.toThrow();
    expect(hookedCandidateRows(bad, WETH, TOKEN)).toEqual([]);
    expect(hookedCandidateRows([...bad, R1], WETH, TOKEN).map((r) => r.id)).toEqual(["0x01"]); // the good row still quotes
  });
});

describe("netInputAfterFee mirrors the router's input-side fee", () => {
  it("floors the fee and clamps at 100 bps", async () => {
    const { netInputAfterFee } = await load(worldWith({}));
    expect(netInputAfterFee(100_000_000_000_000n, 69)).toEqual({ netAmountIn: NET, feeAmount: 690_000_000_000n });
    expect(netInputAfterFee(10_000n, 500).feeAmount).toBe(100n); // clamped to 1%
    expect(netInputAfterFee(10_000n, -5).feeAmount).toBe(0n);
  });
});

describe("bestHookedSimulateQuote — ONE batch, real wire encoding", () => {
  it("prices a hooked pool from the simulation and never sets minOut above it; routes via [hooked]", async () => {
    const { bestHookedSimulateQuote } = await load(worldWith({ [P1]: deepPool(2_000_000n) }));
    const cand = await bestHookedSimulateQuote([R1], baseReq);
    expect(cand).not.toBeNull();
    expect(cand!.swapQuote.quote.amountOut).toBe(2_000_000n);
    expect(cand!.swapQuote.quote.minAmountOut).toBe(1_990_000n); // floor(2e6 * 0.995)
    expect(cand!.swapQuote.quote.minAmountOut <= cand!.swapQuote.quote.amountOut).toBe(true);
    expect(cand!.swapQuote.quote.routeDescriptions[0]).toContain("[hooked]");
    expect(cand!.sim.gasEstimate).toBe(900_000n);
    // ONE batch: quoter + slot0 + liquidity + 3 screen calls for the one (uncached) hook.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.map((c) => c.method)).toEqual(["eth_call", "eth_call", "eth_call", "eth_getCode", "eth_getStorageAt", "eth_getStorageAt"]);
  });

  it("simulates the NET input (gross minus the router's input fee) — pinned on the wire", async () => {
    const seen: bigint[] = [];
    const { bestHookedSimulateQuote } = await load(
      worldWith({ [P1]: { ...deepPool(1n), quote: (_z, amt) => { seen.push(amt); return { amountOut: 2_000_000n }; } } }),
    );
    await bestHookedSimulateQuote([R1], baseReq);
    expect(seen).toEqual([NET]);
  });

  it("builds a v4 hop plan whose execution key is the pool key as initialised (sentinel fee kept)", async () => {
    const { bestHookedSimulateQuote } = await load(worldWith({ [P1]: deepPool(2_000_000n) }));
    const cand = await bestHookedSimulateQuote([R1], baseReq);
    const hop = cand!.swapQuote.encoded.paths[0]!.hops[0]!;
    expect(hop.venue).toBe(1); // UniswapV4
    expect(hop.key.fee).toBe(8388608);
    expect(hop.key.hooks.toLowerCase()).toBe(DELTA_HOOK);
    expect(hop.zeroForOne).toBe(true); // WETH is token0
    expect(cand!.swapQuote.encoded.paths[0]!.amountIn).toBe(baseReq.amountIn); // GROSS on the plan
    expect(cand!.swapQuote.value).toBe(0n);
  });

  it("sells TOKEN → WETH with zeroForOne=false (direction follows the pair, not the row order)", async () => {
    const dirs: boolean[] = [];
    const { bestHookedSimulateQuote } = await load(
      worldWith({ [P1]: { ...deepPool(1n), quote: (z) => { dirs.push(z); return { amountOut: 5n }; } } }),
    );
    const cand = await bestHookedSimulateQuote([R1], { ...baseReq, tokenIn: TOKEN, tokenOut: WETH });
    expect(dirs).toEqual([false]);
    expect(cand!.swapQuote.encoded.paths[0]!.hops[0]!.zeroForOne).toBe(false);
    expect(cand!.swapQuote.encoded.paths[0]!.hops[0]!.tokenIn.toLowerCase()).toBe(TOKEN);
  });

  it("EXCLUDES a hook that skims more than the policy — confirmed on the FULL window first", async () => {
    // Light reference (1:1, no fee) says ~NET out; simulated 80% of that → 20% skim → would exclude.
    const world = worldWith({ [P1]: deepPool((NET * 8n) / 10n) });
    (world as any).__confirm = null; // full window unreadable → abstain → ALLOWED (fund safety is minOut)
    const { bestHookedSimulateQuote } = await load(world);
    const allowed = await bestHookedSimulateQuote([R1], baseReq);
    expect(confirmCalls).toHaveLength(1); // the light verdict was NOT trusted on its own
    expect(allowed).not.toBeNull();
    expect(allowed!.skimBps).toBeNull();

    // Now the full window CONFIRMS the curve gives ~NET: exclusion stands.
    const fullRef: PoolState = {
      address: "ref", token0: WETH, token1: TOKEN, fee: 0, tickSpacing: 200, sqrtPriceX96: SQRT_1_1, tick: 0,
      liquidity: 10n ** 30n, ticks: [{ index: -887200, liquidityNet: 10n ** 30n }, { index: 887200, liquidityNet: -(10n ** 30n) }],
      venue: "UniswapV4", poolKey: { currency0: WETH, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: DELTA_HOOK },
    };
    const world2 = worldWith({ [P1]: deepPool((NET * 8n) / 10n) });
    (world2 as any).__confirm = fullRef;
    const { bestHookedSimulateQuote: b2 } = await load(world2);
    expect(await b2([R1], baseReq)).toBeNull();
    expect(confirmCalls).toHaveLength(2);
  });

  it("ALLOWS a hook whose skim is within the policy without touching the full window, and reports it", async () => {
    const { bestHookedSimulateQuote } = await load(worldWith({ [P1]: deepPool((NET * 96n) / 100n) })); // 4% below
    const cand = await bestHookedSimulateQuote([R1], baseReq);
    expect(cand).not.toBeNull();
    expect(cand!.skimBps).toBeGreaterThanOrEqual(399);
    expect(cand!.skimBps).toBeLessThanOrEqual(401);
    expect(confirmCalls).toHaveLength(0);
  });

  it("EXCLUDES when the hook has NO code (the hard gate) — even though the quoter answered", async () => {
    const { bestHookedSimulateQuote } = await load(worldWith({ [P1]: deepPool(2_000_000n) }, { [DELTA_HOOK]: { code: "0x" } }));
    expect(await bestHookedSimulateQuote([R1], baseReq)).toBeNull();
  });

  it("EXCLUDES when the quoter reverts", async () => {
    const { bestHookedSimulateQuote } = await load(worldWith({ [P1]: deepPool("revert") }));
    expect(await bestHookedSimulateQuote([R1], baseReq)).toBeNull();
  });

  it("a reverting slot0 read consults the full window; if that is unreadable too it abstains (quote kept)", async () => {
    const { bestHookedSimulateQuote } = await load(worldWith({ [P1]: { ...deepPool(2_000_000n), slot0: "revert" } }));
    const cand = await bestHookedSimulateQuote([R1], baseReq);
    expect(confirmCalls).toHaveLength(1);
    expect(cand).not.toBeNull();
    expect(cand!.skimBps).toBeNull();
    expect(cand!.sim.reference).toBeNull();
  });

  // The launchpad shape: ONE position whose lower tick is the spot tick. In-range liquidity is ZERO and
  // every unit of liquidity sits one tick ABOVE spot, so the light (slot0+liquidity, no ticks) reference
  // prices nothing for a swap that moves price UP into the position (here TOKEN → WETH, oneForZero, WETH
  // being token0), and the real window is what decides.
  const launchpadRef: PoolState = {
    address: "ref", token0: WETH, token1: TOKEN, fee: 0, tickSpacing: 200, sqrtPriceX96: SQRT_1_1, tick: 0,
    liquidity: 0n, ticks: [{ index: 200, liquidityNet: 10n ** 30n }, { index: 887200, liquidityNet: -(10n ** 30n) }],
    venue: "UniswapV4", poolKey: { currency0: WETH, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: DELTA_HOOK },
  };
  const launchpadPool = (amountOut: bigint) => ({ quote: { amountOut }, slot0: { sqrtPriceX96: SQRT_1_1, tick: 0 }, liquidity: 0n });
  const buyReq = { ...baseReq, tokenIn: TOKEN, tokenOut: WETH }; // price moves up into the position

  it("LAUNCHPAD SHAPE: the light reference prices nothing — the real window decides, and a skimming hook IS excluded", async () => {
    // Curve on the real window: up through the empty gap to tick 200 for free, then NET into 1e30 at ~1.0202
    // → ≈ 0.98·NET. The hook delivers 50% → ~49% skim → excluded. Without confirm-on-abstain it sailed through.
    const world = worldWith({ [P1]: launchpadPool(NET / 2n) });
    (world as any).__confirm = launchpadRef;
    const { bestHookedSimulateQuote } = await load(world);
    expect(await bestHookedSimulateQuote([R1], buyReq)).toBeNull();
    expect(confirmCalls).toHaveLength(1);

    // Same shape, honest hook (98% of NET ≈ the curve itself) → allowed, screened against the REAL window.
    const world2 = worldWith({ [P1]: launchpadPool((NET * 98n) / 100n) });
    (world2 as any).__confirm = launchpadRef;
    const { bestHookedSimulateQuote: b2 } = await load(world2);
    const cand = await b2([R1], buyReq);
    expect(cand).not.toBeNull();
    expect(cand!.skimBps).not.toBeNull(); // screened on the real window, not waved through
    expect(cand!.skimBps!).toBeLessThan(50);
    expect(cand!.sim.reference!.ticks.length).toBe(2); // the hop carries the real window + fresh slot0
  });

  it("caches the tick window per pool: a second quote reuses it with the batch's fresh slot0 (no second full read)", async () => {
    const world = worldWith({ [P1]: launchpadPool((NET * 98n) / 100n) });
    (world as any).__confirm = launchpadRef;
    const { bestHookedSimulateQuote } = await load(world);
    expect(await bestHookedSimulateQuote([R1], buyReq)).not.toBeNull();
    expect(await bestHookedSimulateQuote([R1], buyReq)).not.toBeNull();
    expect(confirmCalls).toHaveLength(1); // window cached; slot0/liquidity still came fresh from each batch
    expect(fake.calls).toHaveLength(2);
  });

  it("a TRANSPORT failure yields no quote (never a guess)", async () => {
    const { bestHookedSimulateQuote } = await load({ ...worldWith({ [P1]: deepPool(2_000_000n) }), failBatches: 1 });
    expect(await bestHookedSimulateQuote([R1], baseReq)).toBeNull();
    expect(await bestHookedSimulateQuote([R1], baseReq)).not.toBeNull(); // recovered on the next batch
  });

  it("ignores pools that do not serve the pair directly, and non-simulate pools — with NO network", async () => {
    const { bestHookedSimulateQuote } = await load(worldWith({}));
    const rows = [row(TOKEN, TOKEN2, DELTA_HOOK, "0x02"), row(WETH, TOKEN, NO_HOOK, "0x03")];
    expect(await bestHookedSimulateQuote(rows, baseReq)).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it("MoleSwap's OWN pools (the flagship WETH/USDG mole_v4 rows) yield no hooked quote and touch NO network", async () => {
    // Even with a quoter that WOULD answer for them, the DEX's own pools are not third-party hooked
    // candidates: the path returns at once, so the hub pair pays nothing for this fallback.
    const { bestHookedSimulateQuote } = await load(
      worldWith(Object.fromEntries(MOLE_ROWS.map((r) => [poolIdOfRow(r), deepPool(5_000_000n)])), { [MOLE_HOOK]: { code: "0x6080" } }),
    );
    expect(await bestHookedSimulateQuote(MOLE_ROWS, { ...baseReq, tokenIn: WETH, tokenOut: USDG })).toBeNull();
    expect(await bestHookedSimulateQuote(MOLE_ROWS, { ...baseReq, tokenIn: NATIVE, tokenOut: USDG })).toBeNull();
    // A MoleHook pool filed under the third-party venue (the backfill-incident shape) is refused by the hook alone.
    const strayMole: PoolRow[] = MOLE_ROWS.map((r) => ({ ...r, venue: "uniswap_v4", active: false }));
    expect(await bestHookedSimulateQuote(strayMole, { ...baseReq, tokenIn: WETH, tokenOut: USDG })).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it("picks the hooked pool with the higher output, in ONE batch for both", async () => {
    const { bestHookedSimulateQuote } = await load(worldWith({ [P1]: deepPool(2_000_000n), [P2]: deepPool(3_000_000n) }));
    const cand = await bestHookedSimulateQuote([R1, R2], baseReq);
    expect(cand!.swapQuote.quote.amountOut).toBe(3_000_000n);
    expect(cand!.swapQuote.encoded.paths[0]!.hops[0]!.key.hooks.toLowerCase()).toBe(HOOK2);
    expect(fake.calls).toHaveLength(1);
  });

  it("screens each distinct hook once across quotes (cached), never per pool", async () => {
    const R3 = row(WETH, TOKEN, DELTA_HOOK, "0x03"); // same hook as R1, different pool (spacing differs)
    R3.tick_spacing = 60;
    const { bestHookedSimulateQuote } = await load(worldWith({ [P1]: deepPool(1_000n), [poolIdOfRow(R3)]: deepPool(2_000n) }));
    await bestHookedSimulateQuote([R1, R3], baseReq);
    const first = fake.calls[0]!;
    expect(first.filter((c) => c.method === "eth_getCode")).toHaveLength(1); // one hook → one screen
    await bestHookedSimulateQuote([R1, R3], baseReq);
    const second = fake.calls[1]!;
    expect(second.filter((c) => c.method === "eth_getCode")).toHaveLength(0); // cached → no screen calls
    expect(second).toHaveLength(6); // 2 pools × (quoter + slot0 + liquidity)
  });

  it("caps the number of pools it will simulate per quote", async () => {
    const { bestHookedSimulateQuote, MAX_SIMULATED_POOLS } = await load(worldWith({}));
    const rows = Array.from({ length: MAX_SIMULATED_POOLS + 2 }, (_, i) => row(WETH, TOKEN, `0x000000000000000000000000000000000000000${(i % 8) + 4}`, `0x1${i}`));
    await bestHookedSimulateQuote(rows, baseReq);
    const quoterCalls = fake.calls[0]!.filter((c) => c.method === "eth_call" && (c.params[0] as any).to.toLowerCase() === "0x8dc178efb8111bb0973dd9d722ebeff267c98f94");
    expect(quoterCalls).toHaveLength(MAX_SIMULATED_POOLS);
  });

  it("native-ETH input: routes over WETH, attaches msg.value, keeps NATIVE on the plan's outer tokenIn", async () => {
    const { bestHookedSimulateQuote } = await load(worldWith({ [P1]: deepPool(2_000_000n) }));
    const cand = await bestHookedSimulateQuote([R1], { ...baseReq, tokenIn: NATIVE });
    expect(cand).not.toBeNull();
    expect(cand!.swapQuote.value).toBe(baseReq.amountIn);
    expect(cand!.swapQuote.encoded.tokenIn.toLowerCase()).toBe(NATIVE.toLowerCase());
    expect(cand!.swapQuote.encoded.paths[0]!.hops[0]!.tokenIn.toLowerCase()).toBe(WETH);
  });

  it("a zero input yields no quote and no network", async () => {
    const { bestHookedSimulateQuote } = await load(worldWith({ [P1]: deepPool(2_000_000n) }));
    expect(await bestHookedSimulateQuote([R1], { ...baseReq, amountIn: 0n })).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });
});

describe("the light reference rides on the hop (display), never into the quote", () => {
  it("carries slot0's real price/tick/liquidity and the composed LP+protocol fee; execution key untouched", async () => {
    const { bestHookedSimulateQuote } = await load(
      worldWith({ [P1]: { quote: { amountOut: 123n }, slot0: { sqrtPriceX96: SQRT_1_1, tick: 0, lpFee: 30_000, protocolFee: 1000 | (1000 << 12) }, liquidity: 7n } }),
    );
    const cand = await bestHookedSimulateQuote([R1], { ...baseReq, feeBps: 0, slippageBps: 0, amountIn: 1000n });
    const hop = cand!.swapQuote.quote.split.parts[0]!.hops[0]!;
    expect(hop.pool.fee).toBe(Math.round(1e6 - ((1e6 - 1000) * (1e6 - 30_000)) / 1e6)); // 1-(1-p)(1-l)
    expect(hop.pool.liquidity).toBe(7n);
    expect(hop.pool.sqrtPriceX96).toBe(SQRT_1_1);
    expect(hop.pool.poolKey!.fee).toBe(8388608);
    expect(cand!.swapQuote.quote.amountOut).toBe(123n); // the SIMULATED output, not tick math
  });
});

describe("assembleHookedQuote guards", () => {
  const OK_RISK = { hook: DELTA_HOOK, isContract: true, codeHash: "0xabc", codeSize: 4, isProxy: false, proxyKind: null, ok: true, tag: "hooked" };
  const simFor = (HookedPoolSimCtor: any = null) => ({
    row: R1,
    poolKey: { currency0: WETH, currency1: TOKEN, fee: 8388608, tickSpacing: 200, hooks: DELTA_HOOK },
    zeroForOne: true,
    netAmountIn: NET,
    amountOut: 2_000_000n,
    gasEstimate: 1n,
    hookRisk: OK_RISK,
    skimBps: null,
    reference: null,
    at: 0,
    ...(HookedPoolSimCtor ?? {}),
  });
  const ctx = { tokenIn: WETH, tokenOut: TOKEN, grossAmountIn: 100_000_000_000_000n, feeBps: 69, recipient: baseReq.recipient, deadline: 1n, slippageBps: 50 };

  it("refuses to assemble a simulation priced for a DIFFERENT net input (fee or amount drifted)", async () => {
    const { assembleHookedQuote } = await load(worldWith({}));
    const sim = simFor() as any;
    expect(() => assembleHookedQuote(sim, { ...ctx, feeBps: 0 })).toThrow(/re-simulate/);
    expect(() => assembleHookedQuote(sim, { ...ctx, grossAmountIn: ctx.grossAmountIn + 1n })).toThrow(/re-simulate/);
    expect(() => assembleHookedQuote(sim, ctx)).not.toThrow();
  });

  it("minOut at zero slippage equals the simulated output exactly — never a wei above", async () => {
    const { assembleHookedQuote } = await load(worldWith({}));
    const q = assembleHookedQuote(simFor() as any, { ...ctx, slippageBps: 0 });
    expect(q.quote.minAmountOut).toBe(2_000_000n);
  });

  it("REFUSES a plan whose minOut exceeds the simulated output (the policy is enforced, not assumed)", async () => {
    vi.resetModules();
    vi.doMock("../../lib/aggregator/plan", async (orig) => {
      const real = (await orig()) as any;
      return {
        ...real,
        planFromSplit: (...args: any[]) => {
          const p = real.planFromSplit(...args);
          return { ...p, minAmountOut: 2_000_001n }; // one wei above the simulated 2_000_000
        },
      };
    });
    const { assembleHookedQuote } = await import("../../lib/aggregator/hookedQuote");
    expect(() => assembleHookedQuote(simFor() as any, ctx)).toThrow(/exceeds the simulated output/);
    vi.doUnmock("../../lib/aggregator/plan");
    vi.resetModules();
  });
});
