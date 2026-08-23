/**
 * oracle.test.ts — the ONE staleness contract, tested as an attack first: every way a frozen mid could
 * reach a screen looking fresh is tried, then the honest paths are confirmed. Fixtures are the LIVE
 * hook's own words as read on 2026-08-22 — newest observation 1787177840 on the WETH/USDG pool, lastTick
 * -200461, consult(1800) answering that same tick (the frozen price), Chainlink ETH/USD $2426.01.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { toFunctionSelector } from "viem";
import {
  CHAINLINK_ETH_USD,
  ORACLE_DEVIATION_WARN_BPS,
  ORACLE_STALE_COPY,
  ORACLE_STALE_SECONDS,
  chainlinkAggregatorAbi,
  crossCheck,
  deviationBps,
  moleHookOracleAbi,
  oracleAgeLabel,
  oracleStaleness,
  readChainlinkEthUsd,
  readLivePoolCrossCheck,
  readOracleHealth,
  tickToPrice,
  usdPerWethFromTick,
  type OracleReader,
} from "../../lib/mole/oracle";
import { LIVE_POOL_ID, MOLE_ADDRESSES, QUEUE_CONFIG } from "../../lib/mole/chain";

const OBS_AT = 1_787_177_840; // newest ring write on the live pool, 2026-08-22
const NOW = 1_787_400_948; // the wall clock of that read — 223,108 s later
const LIVE_TICK = -200_461;

/** A fake viem client answering by function name; unknown calls reject like a failed eth_call. */
function reader(table: Record<string, unknown | ((args: any) => unknown)>): OracleReader & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    readContract: async (args: any) => {
      calls.push(args);
      if (!(args.functionName in table)) throw new Error(`no answer for ${args.functionName}`);
      const v = table[args.functionName];
      if (v instanceof Error) throw v;
      return typeof v === "function" ? (v as any)(args) : v;
    },
  };
}
const headWords = (lastObs: number, opts: { lastTs?: number; initialized?: boolean } = {}) =>
  [26, opts.lastTs ?? lastObs, lastObs, LIVE_TICK, -231_509_584_933n, opts.initialized ?? true] as const;

/* ------------------------------------------------------------------ threshold */

describe("the threshold is one number, shared", () => {
  it("equals the queue's TWAP window — past it the '30-minute TWAP' is the last tick, not a mean", () => {
    expect(ORACLE_STALE_SECONDS).toBe(1800);
    expect(ORACLE_STALE_SECONDS).toBe(QUEUE_CONFIG.twapWindow);
  });

  it("is mirrored EXACTLY by the indexer's helper, so alert and display can never disagree", () => {
    // vite will not import a module outside the frontend root, so the indexer's ESM is evaluated by a
    // child node process — the real module, not a regex over its source.
    const modPath = path.resolve(__dirname, "../../../services/indexer/src/oracleHealth.mjs");
    const script = `
      import * as m from ${JSON.stringify(pathToFileURL(modPath).href)};
      const OBS = ${OBS_AT}; const T = m.ORACLE_STALE_SECONDS;
      console.log(JSON.stringify({
        threshold: m.ORACLE_STALE_SECONDS, warnBps: m.ORACLE_DEVIATION_WARN_BPS, window: m.ORACLE_TWAP_WINDOW,
        chainlink: m.CHAINLINK_ETH_USD, hook: m.MOLE_HOOK, live: m.LIVE_POOL_ID,
        stale: [T - 1, T, T + 1].map((a) => m.observationLiveness(OBS, OBS + a).stale),
        never: m.observationLiveness(0, OBS).stale,
      }));`;
    const indexer = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
    expect(indexer.threshold).toBe(ORACLE_STALE_SECONDS);
    expect(indexer.warnBps).toBe(ORACLE_DEVIATION_WARN_BPS);
    expect(indexer.window).toBe(QUEUE_CONFIG.twapWindow);
    expect(indexer.chainlink.toLowerCase()).toBe(CHAINLINK_ETH_USD.toLowerCase());
    expect(indexer.hook.toLowerCase()).toBe(MOLE_ADDRESSES.moleHook.toLowerCase());
    expect(indexer.live.toLowerCase()).toBe(LIVE_POOL_ID.toLowerCase());
    // And the two staleness functions agree on both sides of the boundary, and on "never".
    expect(indexer.stale).toEqual(
      [ORACLE_STALE_SECONDS - 1, ORACLE_STALE_SECONDS, ORACLE_STALE_SECONDS + 1].map((a) => oracleStaleness(OBS_AT, OBS_AT + a).stale),
    );
    expect(indexer.stale).toEqual([false, false, true]);
    expect(indexer.never).toBe(oracleStaleness(0, OBS_AT).stale);
  });
});

/* ------------------------------------------------------------------ staleness */

describe("oracleStaleness — the boundary, mutation-verified (> not >=)", () => {
  it("threshold − 1s is fresh, threshold is fresh, threshold + 1s is stale", () => {
    const at = OBS_AT + ORACLE_STALE_SECONDS;
    expect(oracleStaleness(OBS_AT, at - 1)).toEqual({ ageSec: ORACLE_STALE_SECONDS - 1, stale: false });
    expect(oracleStaleness(OBS_AT, at)).toEqual({ ageSec: ORACLE_STALE_SECONDS, stale: false });
    expect(oracleStaleness(OBS_AT, at + 1)).toEqual({ ageSec: ORACLE_STALE_SECONDS + 1, stale: true });
  });

  it("ATTACK: a pool that NEVER observed must be stale, not fresh — the never-ran case fails closed", () => {
    expect(oracleStaleness(0, NOW)).toEqual({ ageSec: Number.POSITIVE_INFINITY, stale: true });
    expect(oracleStaleness(Number.NaN, NOW).stale).toBe(true);
    expect(oracleStaleness(-1, NOW).stale).toBe(true);
  });

  it("ATTACK: a clock that is not a number must not read fresh — NaN > threshold is false, the guard may not rely on it", () => {
    expect(oracleStaleness(OBS_AT, Number.NaN)).toEqual({ ageSec: Number.POSITIVE_INFINITY, stale: true });
    expect(oracleStaleness(OBS_AT, Number.POSITIVE_INFINITY).stale).toBe(true);
    expect(oracleStaleness(OBS_AT, undefined as unknown as number).stale).toBe(true);
  });

  it("a clock behind the observation clamps to age 0 rather than a negative age", () => {
    expect(oracleStaleness(OBS_AT, OBS_AT - 30)).toEqual({ ageSec: 0, stale: false });
  });

  it("the live pool as read on 2026-08-22 was 62h stale", () => {
    const s = oracleStaleness(OBS_AT, NOW);
    expect(s.ageSec).toBe(223_108);
    expect(s.stale).toBe(true);
    expect(oracleAgeLabel(s.ageSec)).toBe("61h 58m");
  });
});

/* ------------------------------------------------------------------ the read */

describe("readOracleHealth — {mid, observedAt, ageSec, stale} from the hook", () => {
  it("reads the age from the RING's timestamp (lastObsTimestamp), never from the last swap", async () => {
    // lastTimestamp (a swap 5s ago) is NEWER than lastObsTimestamp (the ring, 2h ago): the ring governs.
    const r = reader({ poolStates: headWords(NOW - 7200, { lastTs: NOW - 5 }), consult: LIVE_TICK });
    const h = await readOracleHealth(r, LIVE_POOL_ID, NOW);
    expect(h.observedAt).toBe(NOW - 7200);
    expect(h.ageSec).toBe(7200);
    expect(h.stale).toBe(true);
    expect(h.mid).toBe(LIVE_TICK);
    // Both reads hit the hook proxy, for this pool, with the queue's window.
    expect(r.calls.every((c) => c.address === MOLE_ADDRESSES.moleHook)).toBe(true);
    expect(r.calls.find((c) => c.functionName === "consult").args).toEqual([LIVE_POOL_ID, QUEUE_CONFIG.twapWindow]);
  });

  it("a fresh pool: stale=false, mid = consult", async () => {
    const r = reader({ poolStates: headWords(NOW - 40), consult: -200_000 });
    expect(await readOracleHealth(r, LIVE_POOL_ID, NOW)).toEqual({ mid: -200_000, observedAt: NOW - 40, ageSec: 40, stale: false });
  });

  it("consult reverting (young ring / uncovered window) gives mid=null but the age still governs", async () => {
    const r = reader({ poolStates: headWords(NOW - 40), consult: new Error("InsufficientObservations()") });
    expect(await readOracleHealth(r, LIVE_POOL_ID, NOW)).toEqual({ mid: null, observedAt: NOW - 40, ageSec: 40, stale: false });
  });

  it("ATTACK: an uninitialised head is 'never observed' — stale, observedAt 0 — whatever its words say", async () => {
    const r = reader({ poolStates: headWords(NOW - 1, { initialized: false }), consult: LIVE_TICK });
    const h = await readOracleHealth(r, LIVE_POOL_ID, NOW);
    expect(h.observedAt).toBe(0);
    expect(h.stale).toBe(true);
    expect(h.ageSec).toBe(Number.POSITIVE_INFINITY);
  });

  it("ATTACK: a failed head read THROWS — an unknown age is never returned looking like a fresh one", async () => {
    const r = reader({ poolStates: new Error("http 429"), consult: LIVE_TICK });
    await expect(readOracleHealth(r, LIVE_POOL_ID, NOW)).rejects.toThrow(/429/);
  });

  it("the live pool on 2026-08-22: 62h stale and consult(1800) == lastTick — the frozen price", async () => {
    const r = reader({ poolStates: headWords(OBS_AT), consult: LIVE_TICK });
    const h = await readOracleHealth(r, LIVE_POOL_ID, NOW);
    expect(h).toEqual({ mid: LIVE_TICK, observedAt: OBS_AT, ageSec: 223_108, stale: true });
  });
});

/* ------------------------------------------------------------------ the ABI */

describe("the ABI describes the deployed hook and the Chainlink proxy", () => {
  it("selectors match the live contracts (cast sig)", () => {
    const sel = (abi: readonly any[], name: string) => toFunctionSelector(abi.find((f) => f.name === name));
    expect(sel(moleHookOracleAbi, "poolStates")).toBe("0xf4a9c2db");
    expect(sel(moleHookOracleAbi, "consult")).toBe("0x47473b00");
    expect(sel(moleHookOracleAbi, "minObservationInterval")).toBe("0x91efb6fa");
    expect(sel(chainlinkAggregatorAbi, "latestRoundData")).toBe("0xfeaf968c");
    expect(sel(chainlinkAggregatorAbi, "decimals")).toBe("0x313ce567");
  });

  it("poolStates outputs are the PoolState struct in declaration order (the ring timestamp is slot 3 of 6)", () => {
    const ps = moleHookOracleAbi.find((f) => f.name === "poolStates")!;
    expect(ps.outputs.map((o) => `${o.name}:${o.type}`)).toEqual([
      "index:uint16",
      "lastTimestamp:uint32",
      "lastObsTimestamp:uint32",
      "lastTick:int24",
      "tickCumulative:int56",
      "initialized:bool",
    ]);
  });
});

/* ------------------------------------------------------------------ price + cross-check */

describe("tick → price and the Chainlink cross-check (display only)", () => {
  it("tick -200461 on WETH(18)/USDG(6) is ≈ $1970.27 per WETH", () => {
    expect(usdPerWethFromTick(LIVE_TICK)).toBeCloseTo(1970.27, 1);
    expect(tickToPrice(0, 18, 6)).toBe(1e12);
    expect(tickToPrice(0, 6, 18)).toBe(1e-12);
  });

  it("Chainlink is scaled by the feed's OWN decimals, and a non-positive answer is refused", async () => {
    const round = (answer: bigint, decimals = 8) =>
      reader({ decimals, latestRoundData: [1n, answer, 1_787_400_148n, 1_787_400_148n, 1n] });
    const cl = await readChainlinkEthUsd(round(242_601_356_698n), NOW);
    expect(cl.price).toBeCloseTo(2426.01356698, 8);
    expect(cl.updatedAt).toBe(1_787_400_148);
    expect(cl.ageSec).toBe(NOW - 1_787_400_148);
    expect((await readChainlinkEthUsd(round(242_601_356_698n * 10n ** 10n, 18), NOW)).price).toBeCloseTo(2426.01356698, 8);
    await expect(readChainlinkEthUsd(round(0n), NOW)).rejects.toThrow(/not positive/);
    await expect(readChainlinkEthUsd(round(-1n), NOW)).rejects.toThrow(/not positive/);
    // It asks the proxy, not a hard-coded aggregator.
    const r = round(1n);
    await readChainlinkEthUsd(r, NOW).catch(() => {});
    expect(r.calls.every((c) => c.address === CHAINLINK_ETH_USD)).toBe(true);
  });

  it("deviation warn boundary: exactly 200 bps does not warn, a hair above does (mutation-verified)", () => {
    expect(deviationBps(102, 100)).toBeCloseTo(200, 9);
    expect(crossCheck(102, { price: 100, updatedAt: NOW, ageSec: 0 }).warn).toBe(false);
    expect(crossCheck(102.0001, { price: 100, updatedAt: NOW, ageSec: 0 }).warn).toBe(true);
    expect(crossCheck(97.9999, { price: 100, updatedAt: NOW, ageSec: 0 }).warn).toBe(true);
    expect(deviationBps(1, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(crossCheck(1, { price: 0, updatedAt: NOW, ageSec: 0 }).warn).toBe(true);
  });

  it("the live pool on 2026-08-22: our frozen $1970 vs Chainlink $2426 = 18.8% → WARN", async () => {
    const r = reader({ decimals: 8, latestRoundData: [1n, 242_601_356_698n, 1_787_400_148n, 1_787_400_148n, 1n] });
    const x = await readLivePoolCrossCheck(r, LIVE_TICK, NOW);
    expect(x.ourUsd).toBeCloseTo(1970.27, 1);
    expect(x.chainlinkUsd).toBeCloseTo(2426.01, 2);
    expect(x.deviationBps).toBeCloseTo(1878.59, 0);
    expect(x.warn).toBe(true);
    expect(x.chainlinkAgeSec).toBe(800);
  });

  it("oracleAgeLabel", () => {
    expect(oracleAgeLabel(Number.POSITIVE_INFINITY)).toBe("never");
    expect(oracleAgeLabel(42)).toBe("42s");
    expect(oracleAgeLabel(843)).toBe("14m 3s");
    expect(oracleAgeLabel(223_108)).toBe("61h 58m");
  });
});

/* ------------------------------------------------------------------ one copy everywhere */

/** Every .ts/.tsx under these roots, minus node_modules / .next. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("one stale state, identical copy everywhere", () => {
  const root = path.resolve(__dirname, "../..");
  const files = ["screens", "lib", "app", "components", "hooks"].flatMap((d) => {
    try {
      return walk(path.join(root, d));
    } catch {
      return [];
    }
  });

  it("no screen or module spells out the stale label — it comes from ORACLE_STALE_COPY only", () => {
    const offenders = files.filter((f) => {
      if (f.endsWith(path.join("lib", "mole", "oracle.ts"))) return false;
      return readFileSync(f, "utf8").includes(ORACLE_STALE_COPY);
    });
    expect(offenders).toEqual([]);
  });

  it("every surface the contract names renders the shared badge, and the badge renders the shared copy", () => {
    const badge = readFileSync(path.join(root, "screens/shared/OracleStale.tsx"), "utf8");
    expect(badge).toMatch(/\{ORACLE_STALE_COPY\}/);
    const consumers = [
      "screens/dapp/ExchangePage.tsx", // swap card: impact denominator on our venue
      "screens/queue/index.tsx", // queue countdown / TWAP
      "screens/pools/index.tsx", // deposit panel reachable from /pools
      "screens/vault/index.tsx", // deposit page reachable from /pools
    ];
    for (const c of consumers) {
      const src = readFileSync(path.join(root, c), "utf8");
      expect(src, c).toMatch(/<OracleStaleBadge[\s/]/); // rendered, not merely imported
    }
    // And nobody reads the TWAP behind the helper's back any more: no surface may call consult()
    // directly. (The /pools engine panel that used to do so was removed with the panel itself.)
    for (const c of consumers) {
      const src = readFileSync(path.join(root, c), "utf8");
      expect(src, c).not.toMatch(/functionName:\s*"consult"/);
    }
  });

  it("the vitest harness cannot reach an RPC, so readOracleHealth is only ever exercised through a stub here", () => {
    expect(vi.isMockFunction(global.fetch)).toBe(true);
  });
});
