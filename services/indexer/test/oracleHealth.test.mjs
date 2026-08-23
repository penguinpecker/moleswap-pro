/**
 * oracleHealth.test.mjs — the indexer's observation-liveness helper, tested AS AN ATTACK first: every
 * way a stalled or unreadable oracle could be reported as fresh is tried, then the honest paths are
 * confirmed. Fixtures are the LIVE hook's own return data as read on 2026-08-22 (poolStates for the
 * WETH/USDG pool: index 26, newest observation 1787177840, lastTick -200461, tickCumulative
 * -231509584933) and Chainlink ETH/USD's round of the same minute ($2426.01, updatedAt 1787400148).
 *
 * Run: `npm test` (node --test) in services/indexer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAINLINK_ETH_USD,
  LIVE_POOL_ID,
  MOLE_HOOK,
  ORACLE_DEVIATION_WARN_BPS,
  ORACLE_STALE_SECONDS,
  ORACLE_TWAP_WINDOW,
  SEL,
  checkOracleLiveness,
  crossCheckUsd,
  decodeInt24,
  decodeLatestRoundData,
  decodePoolStates,
  deviationBps,
  encodeConsult,
  encodePoolStates,
  observationLiveness,
  oracleHealthView,
  tickToUsdPerWeth,
} from "../src/oracleHealth.mjs";

/* ---- live fixtures (256-bit ABI words, two's complement where negative) ---- */
const W = {
  idx26: "000000000000000000000000000000000000000000000000000000000000001a",
  ts: "000000000000000000000000000000000000000000000000000000006a862b70", // 1787177840
  tick: "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffcf0f3", // -200461
  cum: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffca18f413db", // -231509584933
  one: "0000000000000000000000000000000000000000000000000000000000000001",
  zero: "0000000000000000000000000000000000000000000000000000000000000000",
  answer: "000000000000000000000000000000000000000000000000000000387c2aed9a", // 242601356698 (8 dp)
  updatedAt: "000000000000000000000000000000000000000000000000000000006a898fd4", // 1787400148
  eight: "0000000000000000000000000000000000000000000000000000000000000008",
};
const LIVE_POOL_STATES = "0x" + W.idx26 + W.ts + W.ts + W.tick + W.cum + W.one;
const LIVE_ROUND = "0x" + W.one + W.answer + W.updatedAt + W.updatedAt + W.one;
const OBS_AT = 1787177840;

/* ------------------------------------------------------------------ decoding */

test("decodePoolStates reproduces the live head exactly, negative int24/int56 included", () => {
  const s = decodePoolStates(LIVE_POOL_STATES);
  assert.equal(s.index, 26);
  assert.equal(s.lastTimestamp, OBS_AT);
  assert.equal(s.lastObsTimestamp, OBS_AT);
  assert.equal(s.lastTick, -200461);
  assert.equal(s.tickCumulative, -231509584933n);
  assert.equal(s.initialized, true);
});

test("a short poolStates answer is an error, never a reading", () => {
  assert.throws(() => decodePoolStates("0x"), /short return data/);
  assert.throws(() => decodePoolStates("0x" + W.idx26 + W.ts), /short return data/);
});

test("consult/int24 and latestRoundData decode the live words", () => {
  assert.equal(decodeInt24("0x" + W.tick), -200461);
  const r = decodeLatestRoundData(LIVE_ROUND);
  assert.equal(r.answer, 242601356698n);
  assert.equal(r.updatedAt, 1787400148);
  assert.throws(() => decodeLatestRoundData("0x" + W.one), /short return data/);
});

test("calldata carries the verified selectors and the bytes32 id", () => {
  assert.equal(SEL.poolStates, "0xf4a9c2db"); // cast sig "poolStates(bytes32)"
  assert.equal(SEL.consult, "0x47473b00"); // cast sig "consult(bytes32,uint32)"
  assert.equal(SEL.latestRoundData, "0xfeaf968c");
  assert.equal(SEL.decimals, "0x313ce567");
  assert.equal(encodePoolStates(LIVE_POOL_ID), SEL.poolStates + LIVE_POOL_ID.slice(2));
  assert.equal(
    encodeConsult(LIVE_POOL_ID, 1800),
    SEL.consult + LIVE_POOL_ID.slice(2) + "0000000000000000000000000000000000000000000000000000000000000708",
  );
});

/* ------------------------------------------------------------------ liveness */

test("the stale boundary: threshold is fresh, threshold + 1s is stale (mutation-verified: > not >=)", () => {
  const now = OBS_AT + ORACLE_STALE_SECONDS;
  assert.equal(observationLiveness(OBS_AT, now - 1).stale, false, "threshold - 1s must be fresh");
  assert.equal(observationLiveness(OBS_AT, now).stale, false, "exactly the threshold must be fresh");
  assert.equal(observationLiveness(OBS_AT, now + 1).stale, true, "threshold + 1s must be stale");
  assert.equal(observationLiveness(OBS_AT, now + 1).ageSec, ORACLE_STALE_SECONDS + 1);
});

test("a pool that never observed is STALE with a null age — the never-ran case fails closed", () => {
  assert.deepEqual(observationLiveness(0, 1_800_000_000), { observedAt: 0, ageSec: null, stale: true });
  assert.deepEqual(observationLiveness(undefined, 1_800_000_000), { observedAt: 0, ageSec: null, stale: true });
});

test("ATTACK: a clock that is not a number must not read fresh — NaN > threshold is false, the guard must not rely on it", () => {
  assert.deepEqual(observationLiveness(OBS_AT, Number.NaN), { observedAt: OBS_AT, ageSec: null, stale: true });
  assert.deepEqual(observationLiveness(OBS_AT, undefined), { observedAt: OBS_AT, ageSec: null, stale: true });
  assert.equal(observationLiveness(OBS_AT, Number.POSITIVE_INFINITY).stale, true);
});

test("a clock behind the observation clamps to age 0 rather than going negative", () => {
  assert.deepEqual(observationLiveness(OBS_AT, OBS_AT - 30), { observedAt: OBS_AT, ageSec: 0, stale: false });
});

test("the threshold is the queue's TWAP window, and the frontend's constant (pinned there too)", () => {
  assert.equal(ORACLE_STALE_SECONDS, 1800);
  assert.equal(ORACLE_TWAP_WINDOW, 1800);
  assert.equal(ORACLE_DEVIATION_WARN_BPS, 200);
});

/* ------------------------------------------------------------------ the pass */

/** A fake chain: answers keyed by `${to}:${selector}`; unknown calls throw like a failed eth_call. */
function fakeCall(table) {
  const calls = [];
  const call = async (to, data) => {
    calls.push({ to: to.toLowerCase(), data });
    const key = `${to.toLowerCase()}:${data.slice(0, 10)}`;
    const hit = table[key];
    if (hit === undefined) throw new Error(`no answer for ${key}`);
    if (hit instanceof Error) throw hit;
    return typeof hit === "function" ? hit(data) : hit;
  };
  return { call, calls };
}

const FRESH_POOL = "0x" + "11".repeat(32);
const STALE_POOL = "0x" + "22".repeat(32);
const head = (obsAt) => "0x" + W.idx26 + W.ts + BigInt(obsAt).toString(16).padStart(64, "0") + W.tick + W.cum + W.one;

test("ATTACK: a stalled pool among fresh ones must surface — per-pool flags AND the aggregate", async () => {
  const now = 1_787_400_948;
  const { call } = fakeCall({
    [`${MOLE_HOOK}:${SEL.poolStates}`]: (data) => (data.includes("11".repeat(32)) ? head(now - 10) : head(now - ORACLE_STALE_SECONDS - 1)),
    [`${MOLE_HOOK}:${SEL.consult}`]: "0x" + W.tick,
  });
  const r = await checkOracleLiveness({ call, poolIds: [FRESH_POOL, STALE_POOL], nowSeconds: now });
  assert.equal(r.pools[FRESH_POOL].stale, false);
  assert.equal(r.pools[FRESH_POOL].ageSec, 10);
  assert.equal(r.pools[FRESH_POOL].mid, -200461);
  assert.equal(r.pools[STALE_POOL].stale, true);
  assert.equal(r.pools[STALE_POOL].ageSec, ORACLE_STALE_SECONDS + 1);
  assert.equal(r.stale, true, "one stale pool makes the subsystem stale");
  assert.equal(r.thresholdSec, ORACLE_STALE_SECONDS);
  assert.equal(r.crossCheck, null, "no USD reference for non-live pools");
});

test("ATTACK: the aggregate is ORDER-INDEPENDENT — a stale pool FIRST, then fresh ones, must still read stale", async () => {
  // index.mjs puts the live pool first in the set and the registry's mole_v4 pools after it. An aggregate
  // that let the last pool speak for the pass ("anyStale = entry.stale") would hide a stale live pool
  // behind any fresh pool checked after it — the headline /health flag reading fresh while the one pool
  // that matters is frozen.
  const now = 1_787_400_948;
  const THIRD_POOL = "0x" + "33".repeat(32);
  const { call } = fakeCall({
    [`${MOLE_HOOK}:${SEL.poolStates}`]: (data) => (data.includes("22".repeat(32)) ? head(now - ORACLE_STALE_SECONDS - 1) : head(now - 10)),
    [`${MOLE_HOOK}:${SEL.consult}`]: "0x" + W.tick,
  });
  const reversed = await checkOracleLiveness({ call, poolIds: [STALE_POOL, FRESH_POOL], nowSeconds: now });
  assert.equal(reversed.pools[STALE_POOL].stale, true);
  assert.equal(reversed.pools[FRESH_POOL].stale, false);
  assert.equal(reversed.stale, true, "stale first, fresh last: the aggregate must not be 'last pool wins'");

  const three = await checkOracleLiveness({ call, poolIds: [STALE_POOL, FRESH_POOL, THIRD_POOL], nowSeconds: now });
  assert.deepEqual(Object.keys(three.pools), [STALE_POOL, FRESH_POOL, THIRD_POOL]);
  assert.equal(three.pools[THIRD_POOL].stale, false);
  assert.equal(three.stale, true, "one stale among three, in any position, is stale");

  const middle = await checkOracleLiveness({ call, poolIds: [FRESH_POOL, STALE_POOL, THIRD_POOL], nowSeconds: now });
  assert.equal(middle.stale, true, "stale in the middle is stale");

  const allFresh = await checkOracleLiveness({ call, poolIds: [FRESH_POOL, THIRD_POOL], nowSeconds: now });
  assert.equal(allFresh.stale, false, "and the control: all fresh is fresh");
});

test("ATTACK: a pass over ZERO pools vouches for nothing — it is stale, not vacuously fresh", async () => {
  const { call, calls } = fakeCall({});
  const r = await checkOracleLiveness({ call, poolIds: [], nowSeconds: 1_787_400_948 });
  assert.deepEqual(r.pools, {});
  assert.equal(r.stale, true);
  assert.equal(r.crossCheck, null);
  assert.equal(calls.length, 0);
});

test("ATTACK: a head that cannot be read is reported STALE with the error — never fresh, never silent", async () => {
  const now = 1_787_400_948;
  const { call } = fakeCall({
    [`${MOLE_HOOK}:${SEL.poolStates}`]: new Error("http 429"),
  });
  const r = await checkOracleLiveness({ call, poolIds: [FRESH_POOL], nowSeconds: now });
  assert.equal(r.pools[FRESH_POOL].stale, true);
  assert.equal(r.pools[FRESH_POOL].ageSec, null);
  assert.match(r.pools[FRESH_POOL].error, /http 429/);
  assert.equal(r.stale, true);
});

test("ATTACK: an UNINITIALISED head (initialized=false) has no series and is stale, whatever its words say", async () => {
  const now = 1_787_400_948;
  const { call } = fakeCall({
    [`${MOLE_HOOK}:${SEL.poolStates}`]: "0x" + W.idx26 + W.ts + BigInt(now - 5).toString(16).padStart(64, "0") + W.tick + W.cum + W.zero,
    [`${MOLE_HOOK}:${SEL.consult}`]: "0x" + W.tick,
  });
  const r = await checkOracleLiveness({ call, poolIds: [FRESH_POOL], nowSeconds: now });
  assert.equal(r.pools[FRESH_POOL].initialized, false);
  assert.equal(r.pools[FRESH_POOL].stale, true);
  assert.equal(r.pools[FRESH_POOL].observedAt, 0);
});

test("consult reverting (young ring) leaves mid null but the age still governs", async () => {
  const now = 1_787_400_948;
  const { call } = fakeCall({
    [`${MOLE_HOOK}:${SEL.poolStates}`]: head(now - 3),
    [`${MOLE_HOOK}:${SEL.consult}`]: new Error("execution reverted: InsufficientObservations()"),
  });
  const r = await checkOracleLiveness({ call, poolIds: [FRESH_POOL], nowSeconds: now });
  assert.equal(r.pools[FRESH_POOL].mid, null);
  assert.equal(r.pools[FRESH_POOL].stale, false);
  assert.equal(r.pools[FRESH_POOL].error, null);
});

test("the LIVE pool, as read on 2026-08-22: 62h stale, mid = the frozen last tick, ~18.8% off Chainlink → WARN", async () => {
  const now = 1_787_400_948; // wall clock of the read; the newest observation was 1787177840
  const { call, calls } = fakeCall({
    [`${MOLE_HOOK}:${SEL.poolStates}`]: LIVE_POOL_STATES,
    [`${MOLE_HOOK}:${SEL.consult}`]: "0x" + W.tick, // consult(1800) answered lastTick exactly
    [`${CHAINLINK_ETH_USD}:${SEL.decimals}`]: "0x" + W.eight,
    [`${CHAINLINK_ETH_USD}:${SEL.latestRoundData}`]: LIVE_ROUND,
  });
  const r = await checkOracleLiveness({ call, poolIds: [LIVE_POOL_ID], nowSeconds: now });
  const p = r.pools[LIVE_POOL_ID];
  assert.equal(p.observedAt, OBS_AT);
  assert.equal(p.ageSec, now - OBS_AT); // 223,108 s
  assert.equal(p.stale, true);
  assert.equal(p.mid, -200461);
  assert.equal(p.lastTick, -200461);
  assert.equal(r.stale, true);

  const x = r.crossCheck;
  assert.equal(x.error, null);
  assert.ok(Math.abs(x.ourUsd - 1970.27) < 0.01, `ourUsd ${x.ourUsd}`);
  assert.ok(Math.abs(x.chainlinkUsd - 2426.01356698) < 1e-6, `chainlinkUsd ${x.chainlinkUsd}`);
  assert.equal(x.chainlinkUpdatedAt, 1787400148);
  assert.equal(x.chainlinkAgeSec, now - 1787400148);
  assert.ok(Math.abs(x.deviationBps - 1878.59) < 0.1, `deviationBps ${x.deviationBps}`);
  assert.equal(x.warn, true);
  // The cross-check read decimals() rather than assuming 8.
  assert.ok(calls.some((c) => c.to === CHAINLINK_ETH_USD && c.data === SEL.decimals));
});

test("ATTACK: a NULL mid on the live pool (consult reverted) must NOT be cross-checked — no reference call, crossCheck null", async () => {
  // tickToUsdPerWeth(null) is 1.0001^0 * 1e12 = $1e12/WETH: a pass that cross-checks a null mid would
  // publish a ~4e12 bps 'DEVIATION' on /health for a pool that merely has a young ring.
  const now = 1_787_400_948;
  const { call, calls } = fakeCall({
    [`${MOLE_HOOK}:${SEL.poolStates}`]: head(now - 3),
    [`${MOLE_HOOK}:${SEL.consult}`]: new Error("execution reverted: InsufficientObservations()"),
    [`${CHAINLINK_ETH_USD}:${SEL.decimals}`]: "0x" + W.eight,
    [`${CHAINLINK_ETH_USD}:${SEL.latestRoundData}`]: LIVE_ROUND,
  });
  const r = await checkOracleLiveness({ call, poolIds: [LIVE_POOL_ID], nowSeconds: now });
  assert.equal(r.pools[LIVE_POOL_ID].mid, null);
  assert.equal(r.pools[LIVE_POOL_ID].stale, false, "a young ring with a fresh head is fresh");
  assert.equal(r.crossCheck, null, "nothing to compare: no cross-check, not a warn and not an error");
  assert.equal(calls.filter((c) => c.to === CHAINLINK_ETH_USD).length, 0, "the reference must not even be read");
});

test("ATTACK: a broken reference (answer <= 0) must not become 'our mid is 100% off' — it is an error, warn=false", async () => {
  const now = 1_787_400_948;
  const { call } = fakeCall({
    [`${MOLE_HOOK}:${SEL.poolStates}`]: head(now - 3),
    [`${MOLE_HOOK}:${SEL.consult}`]: "0x" + W.tick,
    [`${CHAINLINK_ETH_USD}:${SEL.decimals}`]: "0x" + W.eight,
    [`${CHAINLINK_ETH_USD}:${SEL.latestRoundData}`]: "0x" + W.one + W.zero + W.updatedAt + W.updatedAt + W.one,
  });
  const r = await checkOracleLiveness({ call, poolIds: [LIVE_POOL_ID], nowSeconds: now });
  assert.equal(r.crossCheck.warn, false);
  assert.match(r.crossCheck.error, /not positive/);
  assert.equal(r.pools[LIVE_POOL_ID].stale, false, "the reference failing says nothing about OUR age");
});

test("the cross-check scales by the feed's decimals — an 18-decimal feed reads the same dollars", async () => {
  const now = 1_787_400_948;
  const eighteen = "0000000000000000000000000000000000000000000000000000000000000012";
  const answer18 = (242601356698n * 10n ** 10n).toString(16).padStart(64, "0");
  const { call } = fakeCall({
    [`${MOLE_HOOK}:${SEL.poolStates}`]: head(now - 3),
    [`${MOLE_HOOK}:${SEL.consult}`]: "0x" + W.tick,
    [`${CHAINLINK_ETH_USD}:${SEL.decimals}`]: "0x" + eighteen,
    [`${CHAINLINK_ETH_USD}:${SEL.latestRoundData}`]: "0x" + W.one + answer18 + W.updatedAt + W.updatedAt + W.one,
  });
  const r = await checkOracleLiveness({ call, poolIds: [LIVE_POOL_ID], nowSeconds: now });
  assert.ok(Math.abs(r.crossCheck.chainlinkUsd - 2426.01356698) < 1e-6);
});

test("deviation warn boundary: exactly the threshold does not warn, one-hundredth of a bp above does", async () => {
  const now = 1_787_400_948;
  // Choose the reference so that ourUsd is EXACTLY 2% above it: ref = ourUsd / 1.02.
  const ourUsd = tickToUsdPerWeth(-200461);
  const mk = async (refUsd) => {
    const answer = BigInt(Math.round(refUsd * 1e8)).toString(16).padStart(64, "0");
    const { call } = fakeCall({
      [`${MOLE_HOOK}:${SEL.poolStates}`]: head(now - 3),
      [`${MOLE_HOOK}:${SEL.consult}`]: "0x" + W.tick,
      [`${CHAINLINK_ETH_USD}:${SEL.decimals}`]: "0x" + W.eight,
      [`${CHAINLINK_ETH_USD}:${SEL.latestRoundData}`]: "0x" + W.one + answer + W.updatedAt + W.updatedAt + W.one,
    });
    return (await checkOracleLiveness({ call, poolIds: [LIVE_POOL_ID], nowSeconds: now })).crossCheck;
  };
  // The verdict is pure; pin the boundary on it EXACTLY (strictly above warns), then confirm the
  // pass agrees on each side of it with real round data.
  assert.equal(deviationBps(102, 100), 200);
  assert.deepEqual(crossCheckUsd(102, 100), { deviationBps: 200, warn: false });
  assert.equal(crossCheckUsd(102.0001, 100).warn, true);
  assert.equal(crossCheckUsd(97.9999, 100).warn, true);
  assert.equal(deviationBps(1, 0), Number.POSITIVE_INFINITY);
  assert.deepEqual(crossCheckUsd(1, 0), { deviationBps: null, warn: true });
  const below = await mk(ourUsd / 1.019);
  const above = await mk(ourUsd / 1.021);
  assert.equal(below.warn, false, `dev ${below.deviationBps}`);
  assert.equal(above.warn, true, `dev ${above.deviationBps}`);
});

test("ids are lowercased: the pass keys results by lowercase id, and a checksummed LIVE id still gets its cross-check", async () => {
  const now = 1_787_400_948;
  const { call, calls } = fakeCall({
    [`${MOLE_HOOK}:${SEL.poolStates}`]: head(now - 1),
    [`${MOLE_HOOK}:${SEL.consult}`]: "0x" + W.tick,
    [`${CHAINLINK_ETH_USD}:${SEL.decimals}`]: "0x" + W.eight,
    [`${CHAINLINK_ETH_USD}:${SEL.latestRoundData}`]: LIVE_ROUND,
  });
  // A fixture WITH hex letters, so the upper-cased input really differs from the lowercase key.
  const lower = "0x" + "ab".repeat(32);
  const upper = "0x" + "AB".repeat(32);
  assert.notEqual(upper, lower);
  const r = await checkOracleLiveness({ call, poolIds: [upper], nowSeconds: now });
  assert.deepEqual(Object.keys(r.pools), [lower]);
  assert.equal(r.pools[upper], undefined);
  // The live pool's USD reference is looked up by the lowercase constant: an upper-cased id must still
  // be recognised as the live pool (otherwise the cross-check silently vanishes on a checksummed input).
  const liveUpper = LIVE_POOL_ID.toUpperCase().replace("0X", "0x");
  assert.notEqual(liveUpper, LIVE_POOL_ID);
  const r2 = await checkOracleLiveness({ call, poolIds: [liveUpper], nowSeconds: now });
  assert.deepEqual(Object.keys(r2.pools), [LIVE_POOL_ID]);
  assert.notEqual(r2.crossCheck, null, "the live pool keyed by an upper-cased id must still be cross-checked");
  assert.equal(r2.crossCheck.error, null);
  assert.ok(calls.some((c) => c.to === CHAINLINK_ETH_USD));
});

/* ------------------------------------------------------------------ /health view */

test("ATTACK: a service that has NEVER completed a liveness pass must publish stale, not healthy", () => {
  const boot = { checkedAt: null, checkedAtMs: 0, thresholdSec: ORACLE_STALE_SECONDS, stale: true, pools: {}, crossCheck: null, error: null };
  const v = oracleHealthView(boot, 1_000_000, 300_000);
  assert.equal(v.checkStale, true);
  assert.equal(v.stale, true);
  // Even a boot state someone hand-edited to stale:false may not read fresh before a pass has run.
  assert.equal(oracleHealthView({ ...boot, stale: false }, 1_000_000, 300_000).stale, true);
});

test("a recent pass with fresh pools is healthy; a recent pass with a stale pool is stale but the check is not", () => {
  const now = 10_000_000;
  const fresh = oracleHealthView({ checkedAtMs: now - 1000, stale: false, pools: {} }, now, 300_000);
  assert.equal(fresh.checkStale, false);
  assert.equal(fresh.stale, false);
  const stalePool = oracleHealthView({ checkedAtMs: now - 1000, stale: true, pools: {} }, now, 300_000);
  assert.equal(stalePool.checkStale, false);
  assert.equal(stalePool.stale, true);
});

test("ATTACK: a pass older than the window cannot vouch for its pools — stale even if they were fresh then", () => {
  const now = 10_000_000;
  const old = oracleHealthView({ checkedAtMs: now - 300_001, stale: false, pools: {} }, now, 300_000);
  assert.equal(old.checkStale, true);
  assert.equal(old.stale, true);
  const edge = oracleHealthView({ checkedAtMs: now - 300_000, stale: false, pools: {} }, now, 300_000);
  assert.equal(edge.checkStale, false, "exactly the window is still in date");
});
