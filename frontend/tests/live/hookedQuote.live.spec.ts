/**
 * hookedQuote.live.spec.ts — DIFFERENTIAL vs the live chain + honest latency numbers. OPT-IN (MOLE_LIVE=1).
 *
 * What it proves, against Robinhood Chain mainnet (4663), real RPC, real registry, no keys:
 *   1. The pinned fixture (WETH→RISK through hook 0x4e34…a544, a real return-delta pool) still reproduces:
 *      our encode → eth_call → decode returns byte-identical calldata and the quoter's live answer.
 *   2. The FULL hooked path (screen + reference + simulate + assemble) returns a quote whose amountOut
 *      equals an independent raw quoter call for the same pool/amount/direction, and whose minOut is
 *      never above it; and the hook screen's real verdict (code size, EIP-1967) matches a raw read.
 *   3. The registry holds simulate-eligible rows for the fixture pair, and `quoteSwap` (the server/API
 *      path) quotes a pair that used to be "no route", with "[hooked]" in its route breakdown.
 *   4. LATENCY, measured not assumed: tick-only quote path vs the same path with the hooked fallback, on a
 *      pair WITHOUT a hooked pool (must be unchanged) and on the hooked pair (added cost reported).
 *
 * Run: cd frontend && set -a && . ./.env.local && set +a && MOLE_LIVE=1 npx vitest run --config tests/live/vitest.live.config.ts
 */
import { describe, it, expect } from "vitest";
import fixture from "../aggregator/v4QuoterFixture.json";
import type { PoolRow } from "../../lib/aggregator/client";

const LIVE = process.env.MOLE_LIVE === "1";
const d = LIVE ? describe : describe.skip;

const RPC = process.env.NEXT_PUBLIC_RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const MOLE_HOOK = "0xb2c9a0af48df8858f3765385e733cd8776a138c4"; // the DEX's own hook — must never be a hooked candidate

async function rpcCall(to: string, data: string): Promise<string> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function timeIt<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: Math.round(performance.now() - t0), value };
}

const fixtureRow: PoolRow = {
  id: "0x95ed00b77e" /* registry id prefix; identity for the test is the key */,
  venue: "uniswap_v4",
  token0: fixture.key.currency0,
  token1: fixture.key.currency1,
  fee: fixture.key.fee,
  tick_spacing: fixture.key.tickSpacing,
  hooks: fixture.key.hooks,
  address: "",
  active: false,
};

d("LIVE — canonical V4 Quoter differential on a real return-delta pool", () => {
  it("1. the pinned fixture reproduces: identical calldata, and the live quoter agrees with our decode", async () => {
    const { encodeQuoteCalldata, decodeQuoteResult, V4_QUOTER, simulateV4ExactInputSingle } = await import(
      "../../lib/aggregator/venues/v4Simulate"
    );
    const key = { ...fixture.key } as any;
    const data = encodeQuoteCalldata(key, fixture.zeroForOne, BigInt(fixture.exactAmount));
    expect(data.toLowerCase()).toBe(fixture.calldata.toLowerCase());

    const raw = await rpcCall(V4_QUOTER, data);
    const direct = decodeQuoteResult(raw as `0x${string}`);
    const { ms, value: ours } = await timeIt(() => simulateV4ExactInputSingle(key, fixture.zeroForOne, BigInt(fixture.exactAmount), RPC));
    console.log(`[live] quoter eth_call via simulateV4ExactInputSingle: ${ms} ms; amountOut=${ours?.amountOut} gas=${ours?.gasEstimate}`);
    expect(ours).not.toBeNull();
    // Same block state is not guaranteed between two calls; the pool has been still for days, so assert
    // equality and fall back to a tolerance only if it moved (reported).
    if (ours!.amountOut !== direct.amountOut) {
      console.log(`[live] NOTE pool moved between calls: ours=${ours!.amountOut} direct=${direct.amountOut}`);
      const diffBps = Number(((ours!.amountOut > direct.amountOut ? ours!.amountOut - direct.amountOut : direct.amountOut - ours!.amountOut) * 10_000n) / direct.amountOut);
      expect(diffBps).toBeLessThan(50);
    } else {
      expect(ours!.amountOut).toBe(direct.amountOut);
    }
    console.log(`[live] fixture pinned ${fixture.amountOut}; live ${direct.amountOut} (${direct.amountOut.toString() === fixture.amountOut ? "UNCHANGED" : "moved"})`);
  });

  it("2. the full hooked path equals an independent raw quoter call, minOut ≤ simulated, hook screen matches raw reads", async () => {
    const { bestHookedSimulateQuote } = await import("../../lib/aggregator/hookedQuote");
    const { encodeQuoteCalldata, decodeQuoteResult, V4_QUOTER } = await import("../../lib/aggregator/venues/v4Simulate");
    const { screenHook } = await import("../../lib/aggregator/hookRisk");
    const { fetchV4TickReference } = await import("../../lib/aggregator/venues/v4Reader");
    const { tickReferenceOutput, screenSkim } = await import("../../lib/aggregator/venues/v4Simulate");

    const amountIn = BigInt(fixture.exactAmount);
    const { ms, value: cand } = await timeIt(() =>
      bestHookedSimulateQuote([fixtureRow], {
        tokenIn: fixture.key.currency0,
        tokenOut: fixture.key.currency1,
        amountIn,
        recipient: "0x0000000000000000000000000000000000000001",
        slippageBps: 50,
        feeBps: 0, // net == gross so the raw call below prices the same input
        weth: WETH,
        nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
        ttlSeconds: 60n,
      }, RPC),
    );
    console.log(`[live] bestHookedSimulateQuote (screen + reference + simulate + assemble): ${ms} ms`);
    expect(cand).not.toBeNull();
    const raw = await rpcCall(V4_QUOTER, encodeQuoteCalldata(fixture.key as any, true, amountIn));
    const direct = decodeQuoteResult(raw as `0x${string}`);
    expect(cand!.swapQuote.quote.amountOut).toBe(direct.amountOut);
    expect(cand!.swapQuote.quote.minAmountOut <= cand!.swapQuote.quote.amountOut).toBe(true);
    expect(cand!.swapQuote.quote.routeDescriptions[0]).toContain("[hooked");
    expect(cand!.swapQuote.encoded.paths[0]!.hops[0]!.key.fee).toBe(fixture.key.fee);
    console.log(`[live] skimBps vs tick-math reference: ${cand!.skimBps} ; hook tag: ${cand!.hookRisk.tag} ; codeSize ${cand!.hookRisk.codeSize}`);

    // Hook screen vs raw reads.
    const risk = await screenHook(fixture.key.hooks, RPC);
    const codeRes = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [fixture.key.hooks, "latest"] }) }).then((r) => r.json());
    const code = codeRes.result as string;
    expect(risk.isContract).toBe(true);
    expect(risk.codeSize).toBe((code.length - 2) / 2);
    expect(risk.ok).toBe(true);
    console.log(`[live] hook ${fixture.key.hooks}: codeSize=${risk.codeSize} proxy=${risk.isProxy} (${risk.proxyKind})`);

    // Reference read + skim computation re-derived independently.
    const ref = await fetchV4TickReference(fixture.key as any);
    expect(ref).not.toBeNull();
    const tickRef = tickReferenceOutput(ref, true, amountIn);
    const skim = screenSkim(direct.amountOut, tickRef);
    console.log(`[live] reference: tick=${ref!.tick} lpFee(eff)=${ref!.fee} liquidity=${ref!.liquidity} ticks=${ref!.ticks.length}; tickRefOut=${tickRef} ; skim=${JSON.stringify(skim)}`);
    expect(skim.ok).toBe(true);
  });
});

d("LIVE — registry rows + the server quote path + latency", () => {
  it("3. the registry serves simulate-eligible rows for the fixture pair, and quoteSwap quotes it [hooked]", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const { fetchPairRowsWithSimulate, fetchPoolRowsByPair } = await import("../../lib/aggregator/serverPools");
    const { isSimulateEligible } = await import("../../lib/aggregator/hookClass");
    const { quoteSwap } = await import("../../lib/aggregator/client");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    expect(url && anon).toBeTruthy();
    const sb = createClient(url, anon, { auth: { persistSession: false } });
    const pair = { tokenIn: fixture.key.currency0, tokenOut: fixture.key.currency1, weth: WETH };

    const active = await timeIt(() => fetchPoolRowsByPair(sb, pair));
    const merged = await timeIt(() => fetchPairRowsWithSimulate(sb, pair, 5_000));
    const sim = merged.value.filter((r) => isSimulateEligible(r));
    console.log(`[live] registry pair read: active-only ${active.ms} ms (${active.value.length} rows); active+simulate ${merged.ms} ms (${merged.value.length} rows, ${sim.length} simulate-eligible)`);
    expect(sim.length).toBeGreaterThan(0);
    expect(sim.some((r) => r.hooks?.toLowerCase() === fixture.key.hooks.toLowerCase())).toBe(true);

    const q = await timeIt(() =>
      quoteSwap(merged.value, {
        tokenIn: NATIVE,
        tokenOut: fixture.key.currency1,
        amountIn: BigInt(fixture.exactAmount),
        recipient: "0x0000000000000000000000000000000000000001",
        slippageBps: 50,
        feeBps: 69,
        weth: WETH,
      }),
    );
    console.log(`[live] quoteSwap ETH→RISK (hooked pair): ${q.ms} ms; out=${q.value?.quote.amountOut}; routes=${JSON.stringify(q.value?.quote.routeDescriptions)}`);
    expect(q.value).not.toBeNull();
    expect(q.value!.quote.routeDescriptions.some((r) => r.includes("[hooked"))).toBe(true);
    expect(q.value!.value).toBe(BigInt(fixture.exactAmount)); // native in → msg.value
  });

  it("4. latency: the hub pair (ETH→USDG, which HAS ten hooked pools) and the hooked-only pair, before vs after", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const { fetchPairRowsWithSimulate } = await import("../../lib/aggregator/serverPools");
    const { quoteSwap, fetchRelevantPoolStates } = await import("../../lib/aggregator/client");
    const { getQuote } = await import("../../lib/aggregator/quote");
    const { bestHookedSimulateQuote, hookedCandidateRows } = await import("../../lib/aggregator/hookedQuote");
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });

    const req = (rows: PoolRow[], tokenIn: string, tokenOut: string, amountIn: bigint) => ({
      tokenIn, tokenOut, amountIn, recipient: "0x0000000000000000000000000000000000000001", slippageBps: 50, feeBps: 69, weth: WETH,
    });

    // (a) ETH → USDG — the hub pair. It turned out to carry TEN third-party return-delta-hook pools in the
    // registry (one of them behind an EIP-1967 proxy), so this is the worst realistic case for the fallback:
    // the most-quoted pair, with a full batch. "before" = tick-only (states + getQuote); "after" = quoteSwap.
    const usdgRows = await fetchPairRowsWithSimulate(sb, { tokenIn: NATIVE, tokenOut: USDG, weth: WETH }, 5_000);
    const usdgHooked = hookedCandidateRows(usdgRows, WETH, USDG);
    // The hub pair's registry set carries MoleSwap's OWN mole_v4 rows (active, MoleHook — whose address has
    // the 0x04 bit). They are tick-path pools and must NOT be hooked candidates: not simulated, not taking
    // a candidate slot, not relabelled. Asserted against the LIVE registry, not a fixture.
    const moleRowsInSet = usdgRows.filter((r) => r.venue === "mole_v4" || (r.hooks ?? "").toLowerCase() === MOLE_HOOK);
    expect(moleRowsInSet.length).toBeGreaterThan(0); // non-vacuity: the live set really contains them
    expect(usdgHooked.some((r) => r.venue === "mole_v4" || (r.hooks ?? "").toLowerCase() === MOLE_HOOK)).toBe(false);
    console.log(`[live] ETH→USDG registry set: ${usdgRows.length} rows, of which ${moleRowsInSet.length} are MoleSwap's own (mole_v4/MoleHook) and ${usdgHooked.length} are third-party hooked candidates (cap ${4}); Mole rows among candidates: 0`);
    const warm = await quoteSwap(usdgRows, req(usdgRows, NATIVE, USDG, 10n ** 15n)); // warm discovery caches
    expect(warm).not.toBeNull();
    const before: number[] = [];
    const after: number[] = [];
    let hookedWon = 0;
    for (let i = 0; i < 3; i++) {
      const b = await timeIt(async () => {
        const states = await fetchRelevantPoolStates(usdgRows, NATIVE, USDG, WETH);
        return getQuote(states, { ...req(usdgRows, NATIVE, USDG, 10n ** 15n), nowSeconds: 0n, ttlSeconds: 60n });
      });
      before.push(b.ms);
      const a = await timeIt(() => quoteSwap(usdgRows, req(usdgRows, NATIVE, USDG, 10n ** 15n)));
      after.push(a.ms);
      expect(a.value).not.toBeNull();
      if (a.value!.quote.routeDescriptions.some((r) => r.includes("[hooked"))) hookedWon++;
      // (Two separate reads of a live pool can differ by a few wei as price moves — the "hooked only wins
      // when it delivers more" rule is pinned by the unit tests against one snapshot; here both are logged.)
      console.log(`[live]   run ${i}: tick-only out ${b.value.amountOut} ; with fallback out ${a.value!.quote.amountOut} via ${a.value!.quote.routeDescriptions.join(" + ")}`);
    }
    const hookedAlone = await timeIt(() => bestHookedSimulateQuote(usdgRows, { ...req(usdgRows, NATIVE, USDG, 10n ** 15n), nowSeconds: 0n, ttlSeconds: 60n }));
    console.log(
      `[live] ETH→USDG (${usdgHooked.length} hooked candidates simulated): tick-only ${JSON.stringify(before)} ms vs quoteSwap(with fallback) ${JSON.stringify(after)} ms; ` +
        `hooked batch alone ${hookedAlone.ms} ms → ${hookedAlone.value ? `out ${hookedAlone.value.swapQuote.quote.amountOut} via ${hookedAlone.value.swapQuote.quote.routeDescriptions[0]} (skim ${hookedAlone.value.skimBps} bps)` : "none"}; hooked won ${hookedWon}/3`,
    );

    // (a') A pair with NO hooked row pays nothing: the candidate filter is pure and the path returns at once.
    const noneRows = usdgRows.filter((r) => !r.hooks || r.hooks === "0x0000000000000000000000000000000000000000");
    const hookedNone = await timeIt(() => bestHookedSimulateQuote(noneRows, { ...req(noneRows, NATIVE, USDG, 10n ** 15n), nowSeconds: 0n, ttlSeconds: 60n }));
    expect(hookedNone.value).toBeNull();
    expect(hookedNone.ms).toBeLessThan(5);
    console.log(`[live] same pair with the hooked rows removed: hooked path ${hookedNone.ms} ms → null (no network)`);

    // (b) WETH → RISK: hooked-only pair. "before" = tick-only (returns no route); "after" = quoteSwap with the fallback.
    const riskRows = await fetchPairRowsWithSimulate(sb, { tokenIn: WETH, tokenOut: fixture.key.currency1, weth: WETH }, 5_000);
    const beforeH: number[] = [];
    const afterH: number[] = [];
    const simOnly: number[] = [];
    for (let i = 0; i < 3; i++) {
      const b = await timeIt(async () => {
        const states = await fetchRelevantPoolStates(riskRows, WETH, fixture.key.currency1, WETH);
        try { return getQuote(states, { ...req(riskRows, WETH, fixture.key.currency1, BigInt(fixture.exactAmount)), nowSeconds: 0n, ttlSeconds: 60n }); } catch { return null; }
      });
      beforeH.push(b.ms);
      const a = await timeIt(() => quoteSwap(riskRows, req(riskRows, WETH, fixture.key.currency1, BigInt(fixture.exactAmount))));
      afterH.push(a.ms);
      expect(a.value).not.toBeNull();
      const s = await timeIt(() => bestHookedSimulateQuote(riskRows, { ...req(riskRows, WETH, fixture.key.currency1, BigInt(fixture.exactAmount)), nowSeconds: 0n, ttlSeconds: 60n }));
      simOnly.push(s.ms);
    }
    console.log(`[live] WETH→RISK (hooked pair): tick-only(no route) ${JSON.stringify(beforeH)} ms vs quoteSwap(with fallback) ${JSON.stringify(afterH)} ms; hooked path alone ${JSON.stringify(simOnly)} ms`);
  });
});
