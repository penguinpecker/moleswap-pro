/**
 * hookClassAgreement.test.ts — the indexer's classifier and the frontend's mirror MUST agree.
 *
 * The indexer (services/indexer/src/v4Class.mjs) decides which v4 rows are written active=true (tick-math
 * routable) and which stay active=false (return-delta hook → simulate; native leg → unroutable). The
 * frontend (lib/aggregator/hookClass.ts) re-classifies the inactive rows it loads by pair to decide which
 * of them to SIMULATE. If the two rules ever drifted — one bit, one case-sensitivity difference — a pool
 * could be indexed inactive by one rule and ignored by the other, silently unquotable, or a native pool
 * could be simulated and produce a quote that reverts. This test imports BOTH modules and drives them over
 * the same table, including the real hooks seen on Robinhood Chain and a seeded sweep of random low-14-bit
 * patterns, so a drift fails here before it reaches the registry.
 *
 * MoleSwap's OWN hook is the one address that is NOT a third-party hook: both sides must say "ticks" for it
 * (never "simulate", although its address carries the 0x04 bit), and both must name the SAME address —
 * the indexer's MOLE_HOOK (which its generic scan skips before upserting) and the frontend's
 * MOLE_ADDRESSES.moleHook. A drift there would push the DEX's own pools through the third-party quoter.
 */
import { describe, it, expect } from "vitest";
import { classifyV4Pool as frontendClassify, isSimulateEligible, isMoleHook as frontendIsMoleHook } from "../../lib/aggregator/hookClass";
import { MOLE_ADDRESSES } from "../../lib/mole/chain";
// The indexer is plain ESM with no dependencies; import the very file the service runs (tsconfig has
// allowJs, so it is typed by inference — no cast needed).
import {
  classifyV4Pool as indexerClassify,
  isTickRoutable,
  isMoleHook as indexerIsMoleHook,
  MOLE_HOOK as INDEXER_MOLE_HOOK,
} from "../../../services/indexer/src/v4Class.mjs";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TOKEN = "0x1cf19a265363e743c767b7962ebedaafe86edba3";
const ZERO = "0x0000000000000000000000000000000000000000";
const MOLE_HOOK = "0xb2c9A0af48dF8858F3765385E733Cd8776a138C4"; // MoleHook proxy (checksum case), low bits 0x38C4

/** The indexer says 'native' where the frontend says 'unroutable' — same class, different word. */
const indexerToFrontend = (m: string) => (m === "native" ? "unroutable" : m);

const REAL_HOOKS = [
  "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544", // low 0x2544 — afterSwapReturnDelta (112k+ pools)
  "0x48b8f6ad3a1b4aa477314c9a23035b8f84dde8cc", // low 0x28cc — both swap deltas
  "0x14bcc18fdb0e7a427122b9c2f1a40ff7d63eaacc", // low 0x2acc — both swap deltas
  "0x8be50bbf71297cd1f328149510f9bbba61e44888", // low 0x0888 — beforeSwapReturnDelta
  "0x04fce2c5167cf6cff286795f7b1bbd782c90c888", // low 0x0888
  MOLE_HOOK, // MoleHook 0x38C4 — carries afterSwapReturnDelta but is the DEX's own → 'ticks' on BOTH sides
  "0x0000000000000000000000000000000000000040", // afterSwap only → ticks
  "0x0000000000000000000000000000000000000002", // afterAddLiquidityReturnDelta → not a swap delta → ticks
  ZERO,
];

/** Deterministic LCG so the sweep is reproducible. */
function* lcg(seed: number, n: number) {
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    yield x;
  }
}

describe("indexer v4Class.mjs ⇔ frontend hookClass.ts", () => {
  it("agree on every real hook seen on Robinhood Chain, in both currency orders, with and without a native leg", () => {
    for (const hook of REAL_HOOKS) {
      for (const [c0, c1] of [[WETH, TOKEN], [TOKEN, WETH], [ZERO, TOKEN], [TOKEN, ZERO]]) {
        const idx = indexerClassify(c0, c1, hook);
        const fe = frontendClassify(c0, c1, hook);
        expect(indexerToFrontend(idx), `${hook} ${c0}/${c1}`).toBe(fe);
        // And the indexer's active flag is exactly "the frontend would tick-quote it".
        expect(isTickRoutable(idx), `${hook} ${c0}/${c1} routable`).toBe(fe === "ticks");
      }
    }
  });

  it("MoleSwap's own hook: both sides name ONE address, both say 'ticks', neither ever 'simulate'", () => {
    // The address: the indexer's skip constant and the frontend's pinned proxy are the same hook.
    expect(INDEXER_MOLE_HOOK).toBe(MOLE_ADDRESSES.moleHook.toLowerCase());
    expect(INDEXER_MOLE_HOOK).toBe(MOLE_HOOK.toLowerCase());
    expect(BigInt(MOLE_HOOK) & 0x04n).toBe(0x04n); // non-vacuity: the delta bit IS set on it
    for (const hook of [MOLE_HOOK, MOLE_HOOK.toLowerCase(), MOLE_HOOK.toUpperCase().replace("0X", "0x")]) {
      expect(indexerIsMoleHook(hook), hook).toBe(true);
      expect(frontendIsMoleHook(hook), hook).toBe(true);
      for (const [c0, c1] of [[WETH, USDG], [USDG, WETH], [TOKEN, WETH]]) {
        expect(indexerClassify(c0, c1, hook), `indexer ${hook}`).toBe("ticks");
        expect(frontendClassify(c0, c1, hook), `frontend ${hook}`).toBe("ticks");
        expect(isSimulateEligible({ venue: "mole_v4", token0: c0, token1: c1, hooks: hook })).toBe(false);
        expect(isSimulateEligible({ venue: "uniswap_v4", token0: c0, token1: c1, hooks: hook })).toBe(false);
      }
    }
    // And a third-party hook with the very same low bits as MoleHook (0x38C4) IS simulate on both sides —
    // the exception is the address, not the bit pattern.
    const lookalike = "0x00000000000000000000000000000000000038c4";
    expect(indexerClassify(WETH, TOKEN, lookalike)).toBe("simulate");
    expect(frontendClassify(WETH, TOKEN, lookalike)).toBe("simulate");
  });

  it("agree across a seeded sweep of 2,000 random hook addresses (all 14 permission bits exercised)", () => {
    let simulate = 0;
    let ticks = 0;
    for (const r of lcg(0x5eed, 2000)) {
      // random high bits + random low 14 bits, inside 20 bytes (a VALID address — the frontend fails closed
      // on anything that is not one); ensure every bit pattern class appears
      const low = r & 0x3fff;
      const hook = "0x" + ((BigInt(r) << 128n) | BigInt(low)).toString(16).padStart(40, "0");
      expect(hook).toMatch(/^0x[0-9a-f]{40}$/);
      const idx = indexerClassify(WETH, TOKEN, hook);
      const fe = frontendClassify(WETH, TOKEN, hook);
      expect(indexerToFrontend(idx)).toBe(fe);
      if (fe === "simulate") simulate++;
      else ticks++;
    }
    // non-vacuity: both classes were actually produced by the sweep
    expect(simulate).toBeGreaterThan(100);
    expect(ticks).toBeGreaterThan(100);
  });

  it("pin the boundary: ONLY bits 0x0008 and 0x0004 make a hook 'simulate'", () => {
    for (let bit = 0; bit < 14; bit++) {
      const hook = "0x" + (1 << bit).toString(16).padStart(40, "0");
      const expectSim = bit === 2 || bit === 3;
      expect(indexerClassify(WETH, TOKEN, hook), `bit ${bit}`).toBe(expectSim ? "simulate" : "ticks");
      expect(frontendClassify(WETH, TOKEN, hook), `bit ${bit}`).toBe(expectSim ? "simulate" : "ticks");
    }
  });
});
