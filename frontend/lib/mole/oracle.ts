/**
 * oracle.ts — ONE staleness contract for every consumer of the MoleHook TWAP.
 *
 * Uniswap v4 ships no oracle. Every price this app treats as "the mid" on a MoleSwap pool — the queue's
 * clearing price, the engine's range marker, the swap card's impact denominator on our own venue — is
 * read from the series MoleHook writes in `afterSwap`, one ring entry per swap at most once per
 * `minObservationInterval`. `consult()` extends the cumulative past the last write with the tick in force
 * since it, so on a pool that has not traded the TWAP is not a time-weighted average of anything: it is
 * the LAST TICK, exactly, for as long as nobody swaps. A stalled writer and a quiet market are
 * indistinguishable from the number alone (learnings.txt Part 16 §3, S-50), so the number must travel
 * with its age, and a consumer must not be able to forget it.
 *
 * Hence one helper, one threshold, one piece of copy. `readOracleHealth` returns `{mid, observedAt,
 * ageSec, stale}`; `ORACLE_STALE_SECONDS` is the only threshold; `ORACLE_STALE_COPY` is the only label.
 * services/indexer mirrors the threshold (pinned equal by tests/mole/oracle.test.ts) so the alert side
 * and the display side can never disagree about what "stale" means.
 *
 * The Chainlink cross-check (G-1) is the independent half: it detects a WRONG mid, not a stalled one.
 * It is display / alert only and is never, anywhere, an input to a transaction.
 */

import { createPublicClient, http } from "viem";
import type { Address, Hex } from "./chain";
import {
  LIVE_POOL_DECIMALS,
  MOLE_ADDRESSES,
  QUEUE_CONFIG,
  ROBINHOOD_RPC_URL,
  robinhoodChain,
} from "./chain";

/* -------------------------------------------------------------------- constants */

/**
 * The staleness threshold, in seconds. A mid whose newest observation is OLDER than this is stale.
 *
 * It equals the TWAP window the queue prices at (QUEUE_CONFIG.twapWindow): once no observation has
 * landed inside the window the mean is taken over, the "30-minute TWAP" is the last tick extended over
 * 30 minutes, and nothing about it is averaged. Pinned to the window by test; change both or neither.
 *
 * MIRRORED in services/indexer/src/oracleHealth.mjs — the two must stay equal (pinned by test).
 */
export const ORACLE_STALE_SECONDS = 1800;

/** The one label every stale state renders. Consumers import it; none spells it out. */
export const ORACLE_STALE_COPY = "ORACLE STALE";

/** Chainlink ETH/USD on Robinhood Chain — the AggregatorV3 proxy. The reference for the cross-check. */
export const CHAINLINK_ETH_USD: Address = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";

/**
 * Deviation between our TWAP mid (as USD/WETH) and Chainlink ETH/USD above which the UI warns, in bps.
 * 200 bps: wider than the feed's own deviation trigger and wider than a 30-minute TWAP's honest lag on
 * a normal day, narrower than anything a corrupted or walked oracle would show.
 */
export const ORACLE_DEVIATION_WARN_BPS = 200;

/* -------------------------------------------------------------------------- ABI */

export const moleHookOracleAbi = [
  {
    /** `mapping(PoolId => PoolState) public poolStates` — the per-pool oracle head, one slot. */
    type: "function",
    name: "poolStates",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "index", type: "uint16" },
      { name: "lastTimestamp", type: "uint32" },
      { name: "lastObsTimestamp", type: "uint32" },
      { name: "lastTick", type: "int24" },
      { name: "tickCumulative", type: "int56" },
      { name: "initialized", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "consult",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "secondsAgo", type: "uint32" },
    ],
    outputs: [{ name: "arithmeticMeanTick", type: "int24" }],
  },
  { type: "function", name: "minObservationInterval", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
] as const;

export const chainlinkAggregatorAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/* ------------------------------------------------------------------------ types */

/** The staleness contract. Every price consumer of the TWAP receives exactly this. */
export interface OracleHealth {
  /** The TWAP tick over the queue's window, or null when the ring cannot answer it (consult reverted). */
  readonly mid: number | null;
  /** Unix seconds of the newest ring write (`lastObsTimestamp`). 0 means the pool has never observed. */
  readonly observedAt: number;
  /** Seconds since `observedAt`. Infinity when there has never been an observation. */
  readonly ageSec: number;
  /** `ageSec > ORACLE_STALE_SECONDS`. The mid is the last tick, not an average, once this is true. */
  readonly stale: boolean;
}

/** Anything with viem's `readContract` shape. A PublicClient satisfies it; tests pass a stub. */
export interface OracleReader {
  readContract: (args: any) => Promise<any>;
}

export function oracleClient(): OracleReader {
  const rpc = (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) || ROBINHOOD_RPC_URL;
  return createPublicClient({ chain: robinhoodChain, transport: http(rpc) });
}

/* -------------------------------------------------------------------- staleness */

/**
 * The staleness half of the contract, pure. `observedAt` is the newest ring write; `nowSeconds` is the
 * caller's clock (chain time where available, wall clock otherwise).
 *
 * FAIL-CLOSED ON "NEVER": a pool that has never written an observation has no mid at all, so it is
 * stale, not fresh — the never-ran case is the one a `now - last > X` check silently gets wrong
 * (learnings.txt 2026-08-14 §4). A clock that reads before the observation is clamped to age 0 rather
 * than going negative; a clock that is not a finite number yields no age and is stale.
 */
export function oracleStaleness(observedAt: number, nowSeconds: number): { ageSec: number; stale: boolean } {
  if (!(observedAt > 0)) return { ageSec: Number.POSITIVE_INFINITY, stale: true };
  // A clock that is not a finite number cannot vouch for an age — `NaN > X` is false, which would read
  // as fresh. No usable age is stale, the same way no observation is.
  if (!Number.isFinite(nowSeconds)) return { ageSec: Number.POSITIVE_INFINITY, stale: true };
  const ageSec = Math.max(0, nowSeconds - observedAt);
  return { ageSec, stale: ageSec > ORACLE_STALE_SECONDS };
}

/**
 * Read the contract for one pool: the oracle head (`poolStates`) for its age and `consult` for its mid.
 *
 * `consult` reverting (InsufficientObservations — a young ring, or a window longer than the ring covers)
 * yields `mid: null` and is NOT an error: the age is still known and still governs. A failed
 * `poolStates` read throws — the caller decides whether to keep its prior value; an unknown age must
 * never be rendered as a fresh one.
 */
export async function readOracleHealth(
  reader: OracleReader,
  poolId: Hex,
  nowSeconds: number,
  windowSec: number = QUEUE_CONFIG.twapWindow,
): Promise<OracleHealth> {
  const hook = MOLE_ADDRESSES.moleHook;
  const [state, mid] = await Promise.all([
    reader.readContract({ address: hook, abi: moleHookOracleAbi, functionName: "poolStates", args: [poolId] }) as Promise<
      readonly [number, number, number, number, bigint, boolean]
    >,
    (reader.readContract({ address: hook, abi: moleHookOracleAbi, functionName: "consult", args: [poolId, windowSec] }) as Promise<number>)
      .then((t) => Number(t))
      .catch(() => null),
  ]);
  // A pool the hook has never primed has no series; treat exactly like "never observed".
  const observedAt = state[5] ? Number(state[2]) : 0;
  const { ageSec, stale } = oracleStaleness(observedAt, nowSeconds);
  return { mid, observedAt, ageSec, stale };
}

/* ------------------------------------------------------------------------ price */

/** token1 per token0 (human units) at a tick: 1.0001^tick scaled by the decimals gap. */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

/** USDG per WETH at a tick on the live pool (WETH 18 is currency0, USDG 6 is currency1). */
export function usdPerWethFromTick(tick: number): number {
  return tickToPrice(tick, LIVE_POOL_DECIMALS.decimals0, LIVE_POOL_DECIMALS.decimals1);
}

/* ------------------------------------------------------------------ cross-check */

export interface ChainlinkRead {
  /** USD per ETH, scaled by the feed's own `decimals()` — read, not assumed. */
  readonly price: number;
  readonly updatedAt: number;
  readonly ageSec: number;
}

/**
 * Chainlink ETH/USD, scaled by the feed's reported decimals. Throws on a non-positive answer: a zero or
 * negative answer is a broken feed, and a broken reference must not quietly read as "$0 — 100% off".
 */
export async function readChainlinkEthUsd(reader: OracleReader, nowSeconds: number): Promise<ChainlinkRead> {
  const [decimals, round] = await Promise.all([
    reader.readContract({ address: CHAINLINK_ETH_USD, abi: chainlinkAggregatorAbi, functionName: "decimals", args: [] }) as Promise<number>,
    reader.readContract({ address: CHAINLINK_ETH_USD, abi: chainlinkAggregatorAbi, functionName: "latestRoundData", args: [] }) as Promise<
      readonly [bigint, bigint, bigint, bigint, bigint]
    >,
  ]);
  const answer = round[1];
  if (answer <= 0n) throw new Error(`chainlink ETH/USD answer ${answer} is not positive`);
  const price = Number(answer) / Math.pow(10, Number(decimals));
  const updatedAt = Number(round[3]);
  return { price, updatedAt, ageSec: Math.max(0, nowSeconds - updatedAt) };
}

/** |value − reference| / reference, in bps. Infinity when the reference is not a positive number. */
export function deviationBps(value: number, reference: number): number {
  if (!(reference > 0) || !Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return (Math.abs(value - reference) / reference) * 10_000;
}

export interface CrossCheck {
  /** Our TWAP mid as USD per WETH. */
  readonly ourUsd: number;
  readonly chainlinkUsd: number;
  readonly chainlinkUpdatedAt: number;
  readonly chainlinkAgeSec: number;
  readonly deviationBps: number;
  /** `deviationBps > ORACLE_DEVIATION_WARN_BPS`. Display / alert only — never a trade input. */
  readonly warn: boolean;
}

export function crossCheck(ourUsd: number, chainlink: ChainlinkRead): CrossCheck {
  const dev = deviationBps(ourUsd, chainlink.price);
  return {
    ourUsd,
    chainlinkUsd: chainlink.price,
    chainlinkUpdatedAt: chainlink.updatedAt,
    chainlinkAgeSec: chainlink.ageSec,
    deviationBps: dev,
    warn: dev > ORACLE_DEVIATION_WARN_BPS,
  };
}

/** The live pool's TWAP mid against Chainlink. Only the WETH/USDG pool has a USD reference. */
export async function readLivePoolCrossCheck(reader: OracleReader, mid: number, nowSeconds: number): Promise<CrossCheck> {
  return crossCheck(usdPerWethFromTick(mid), await readChainlinkEthUsd(reader, nowSeconds));
}

/* ---------------------------------------------------------------------- display */

/** "62h 5m" / "14m 3s" / "never" — for the badge tooltip; never a decision input. */
export function oracleAgeLabel(ageSec: number): string {
  if (!Number.isFinite(ageSec)) return "never";
  const s = Math.max(0, Math.floor(ageSec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
