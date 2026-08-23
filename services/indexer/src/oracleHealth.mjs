/**
 * oracleHealth.mjs — observation liveness for every MoleSwap (mole_v4) pool, plus the independent
 * Chainlink cross-check, as its OWN health signal.
 *
 * WHY A SEPARATE SIGNAL. The TWAP every MoleSwap price reads is first-party: MoleHook writes one ring
 * entry per swap in `afterSwap`, at most once per `minObservationInterval`. `consult()` extends the
 * cumulative past the last write with the tick in force since it, so a pool nobody has swapped on for a
 * day still answers a confident "30-minute TWAP" — which is the last tick, exactly, and not a mean of
 * anything. A stalled writer looks identical to a quiet market (learnings.txt Part 16 §3 / S-50, B-26),
 * and the dossier rates a stalled observation index sev-1. The indexer already watches the chain every
 * cycle; this module reads the hook's oracle head for each mole pool and reports its age, so /health can
 * say "the mid is N seconds old" next to "the cursor is N blocks behind" — two subsystems, two flags
 * (learnings.txt 2026-08-14 §4: a healthy sibling must not speak for a dead one).
 *
 * The staleness threshold and the cross-check deviation threshold MIRROR frontend/lib/mole/oracle.ts and
 * are pinned equal by frontend/tests/mole/oracle.test.ts. Change both or neither.
 *
 * Display / alert only. Nothing here is, or may become, a transaction input.
 */

/* ------------------------------------------------------------------------------------- constants */

/** Seconds. Newest observation older than this ⇒ the mid is stale. MIRRORS frontend ORACLE_STALE_SECONDS. */
export const ORACLE_STALE_SECONDS = 1800;
/** Bps. |ourUsd − chainlinkUsd| / chainlinkUsd above this ⇒ warn. MIRRORS frontend ORACLE_DEVIATION_WARN_BPS. */
export const ORACLE_DEVIATION_WARN_BPS = 200;
/** The TWAP window the queue prices at (DeployConfig.DEFAULT_TWAP_WINDOW); the mid is consult(id, this). */
export const ORACLE_TWAP_WINDOW = 1800;

export const MOLE_HOOK = "0xb2c9a0af48df8858f3765385e733cd8776a138c4";
/** The live WETH/USDG pool — always checked, even if the registry read fails. */
export const LIVE_POOL_ID = "0x9aca9d2f4bb68ef41e6928bbe080a4b076b167e2d4b7fdebf4b4fd5d6dadd029";
/** Chainlink ETH/USD AggregatorV3 proxy on Robinhood Chain. */
export const CHAINLINK_ETH_USD = "0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9";

/** 4-byte selectors, verified against the live contracts (cast sig). */
export const SEL = {
  poolStates: "0xf4a9c2db", // poolStates(bytes32)
  consult: "0x47473b00", // consult(bytes32,uint32)
  decimals: "0x313ce567", // decimals()
  latestRoundData: "0xfeaf968c", // latestRoundData()
};

/* --------------------------------------------------------------------------------------- encoding */

const pad32 = (h) => String(h).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const word = (body, i) => body.slice(i * 64, i * 64 + 64);

/** Two's-complement decode of a 256-bit ABI word to BigInt. */
export function decodeInt256Word(w) {
  const v = BigInt("0x" + w);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
}

export const encodePoolStates = (poolId) => SEL.poolStates + pad32(poolId);
export const encodeConsult = (poolId, windowSec) => SEL.consult + pad32(poolId) + pad32(Number(windowSec).toString(16));

/**
 * `poolStates(bytes32)` → (uint16 index, uint32 lastTimestamp, uint32 lastObsTimestamp, int24 lastTick,
 * int56 tickCumulative, bool initialized). Six words. Throws on anything shorter: a truncated answer is
 * an RPC fault, and an RPC fault must become an error, never a "fresh" reading.
 */
export function decodePoolStates(hex) {
  const body = String(hex || "").replace(/^0x/, "");
  if (body.length < 6 * 64) throw new Error(`poolStates: short return data (${body.length / 2} bytes)`);
  return {
    index: Number(BigInt("0x" + word(body, 0))),
    lastTimestamp: Number(BigInt("0x" + word(body, 1))),
    lastObsTimestamp: Number(BigInt("0x" + word(body, 2))),
    lastTick: Number(decodeInt256Word(word(body, 3))),
    tickCumulative: decodeInt256Word(word(body, 4)),
    initialized: BigInt("0x" + word(body, 5)) !== 0n,
  };
}

/** `consult(...)` → int24. */
export function decodeInt24(hex) {
  const body = String(hex || "").replace(/^0x/, "");
  if (body.length < 64) throw new Error("consult: short return data");
  return Number(decodeInt256Word(word(body, 0)));
}

/** `latestRoundData()` → (roundId, int256 answer, startedAt, updatedAt, answeredInRound). */
export function decodeLatestRoundData(hex) {
  const body = String(hex || "").replace(/^0x/, "");
  if (body.length < 5 * 64) throw new Error("latestRoundData: short return data");
  return { answer: decodeInt256Word(word(body, 1)), updatedAt: Number(BigInt("0x" + word(body, 3))) };
}

/* ---------------------------------------------------------------------------------- health view */

/**
 * What /health publishes for the oracle subsystem, pure. `checkStale` = no liveness pass has completed
 * within `staleAfterMs` — INCLUDING never: a service that has not checked yet may not say "fresh". And a
 * pass too old to vouch for its pools makes the subsystem stale regardless of what that pass recorded.
 */
export function oracleHealthView(status, nowMs, staleAfterMs) {
  const checkStale = !(status.checkedAtMs > 0) || nowMs - status.checkedAtMs > staleAfterMs;
  return { ...status, checkStale, stale: checkStale || Boolean(status.stale) };
}

/* -------------------------------------------------------------------------------------- liveness */

/**
 * The staleness half of the contract, pure and JSON-friendly. `ageSec` is null when the pool has never
 * written an observation — and that case is STALE, not fresh: "never ran" is exactly the case a
 * `last > 0 && now - last > X` check reports as healthy forever (learnings.txt 2026-08-14 §4).
 */
export function observationLiveness(observedAt, nowSeconds) {
  if (!(observedAt > 0)) return { observedAt: 0, ageSec: null, stale: true };
  // A clock that is not a finite number cannot vouch for an age — `NaN > X` is false, which would read
  // as fresh. Unknown age is stale, the same way an unreadable head is.
  if (!Number.isFinite(nowSeconds)) return { observedAt, ageSec: null, stale: true };
  const ageSec = Math.max(0, nowSeconds - observedAt);
  return { observedAt, ageSec, stale: ageSec > ORACLE_STALE_SECONDS };
}

/** USDG per WETH at a tick on the live pool (WETH 18 decimals is currency0, USDG 6 is currency1). */
export const tickToUsdPerWeth = (tick) => Math.pow(1.0001, tick) * 1e12;

/** |value − reference| / reference in bps; Infinity when the reference is not a positive number. */
export function deviationBps(value, reference) {
  if (!(reference > 0) || !Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return (Math.abs(value - reference) / reference) * 10_000;
}

/** The cross-check verdict, pure: {deviationBps, warn}. warn = strictly above the threshold. */
export function crossCheckUsd(ourUsd, chainlinkUsd) {
  const dev = deviationBps(ourUsd, chainlinkUsd);
  return { deviationBps: Number.isFinite(dev) ? dev : null, warn: dev > ORACLE_DEVIATION_WARN_BPS };
}

/**
 * One liveness pass over `poolIds`.
 *
 * @param call      (to, data) => Promise<hex>  — an eth_call; injected so the pass is testable offline.
 * @param poolIds   bytes32 ids of the mole pools to check (the live pool is always worth including).
 * @param nowSeconds the clock to age against (wall clock; the ring's timestamps are chain seconds).
 * @returns { checkedAt, thresholdSec, stale, pools, crossCheck }
 *   pools[id]  = { observedAt, ageSec|null, stale, mid|null, lastTick|null, initialized, error|null }
 *   stale      = any pool stale (a pool whose head could not be read IS stale — unknown ≠ fresh);
 *                an empty pass is stale too (nothing checked ≠ everything fresh)
 *   crossCheck = live pool only: { ourUsd, chainlinkUsd, chainlinkUpdatedAt, deviationBps, warn, error }
 */
export async function checkOracleLiveness({
  call,
  poolIds,
  nowSeconds,
  hook = MOLE_HOOK,
  windowSec = ORACLE_TWAP_WINDOW,
  chainlink = CHAINLINK_ETH_USD,
}) {
  const pools = {};
  let anyStale = false;
  let checked = 0;
  for (const rawId of poolIds) {
    const id = String(rawId).toLowerCase();
    let entry;
    try {
      const head = decodePoolStates(await call(hook, encodePoolStates(id)));
      // A pool the hook never primed has no series at all — identical to "never observed".
      const live = observationLiveness(head.initialized ? head.lastObsTimestamp : 0, nowSeconds);
      let mid = null;
      try {
        mid = decodeInt24(await call(hook, encodeConsult(id, windowSec)));
      } catch {
        /* InsufficientObservations (young ring / uncovered window) — the age still governs */
      }
      entry = { ...live, mid, lastTick: head.initialized ? head.lastTick : null, initialized: head.initialized, error: null };
    } catch (e) {
      entry = {
        observedAt: 0,
        ageSec: null,
        stale: true, // fail closed: a head we could not read is not a head we may call fresh
        mid: null,
        lastTick: null,
        initialized: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    pools[id] = entry;
    checked += 1;
    if (entry.stale) anyStale = true;
  }

  // Independent cross-check (G-1): our TWAP mid as USD/WETH against Chainlink ETH/USD. It catches a
  // WRONG mid where the age catches a STALLED one. Only the WETH/USDG pool has a USD reference.
  let crossCheck = null;
  const live = pools[LIVE_POOL_ID];
  if (live && live.mid !== null) {
    try {
      const dec = Number(BigInt(await call(chainlink, SEL.decimals)));
      const round = decodeLatestRoundData(await call(chainlink, SEL.latestRoundData));
      if (round.answer <= 0n) throw new Error(`chainlink answer ${round.answer} is not positive`);
      const chainlinkUsd = Number(round.answer) / Math.pow(10, dec);
      const ourUsd = tickToUsdPerWeth(live.mid);
      crossCheck = {
        ourUsd,
        chainlinkUsd,
        chainlinkUpdatedAt: round.updatedAt,
        chainlinkAgeSec: Math.max(0, nowSeconds - round.updatedAt),
        ...crossCheckUsd(ourUsd, chainlinkUsd),
        error: null,
      };
    } catch (e) {
      crossCheck = { ourUsd: null, chainlinkUsd: null, chainlinkUpdatedAt: null, chainlinkAgeSec: null, deviationBps: null, warn: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // A pass that checked nothing vouches for nothing: it is stale, not vacuously fresh.
  return { checkedAt: nowSeconds, thresholdSec: ORACLE_STALE_SECONDS, stale: checked === 0 || anyStale, pools, crossCheck };
}
