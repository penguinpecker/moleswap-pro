/**
 * priceAnchor.ts — the ONE price a transaction bound is allowed to be built from, and the one refusal
 * for a pool that does not look honest.
 *
 * WHAT WENT WRONG, precisely. Every bound this app put on a deposit was computed from `slot0` — the
 * pool's instantaneous price. `vault.ts:buildZap` read spot, multiplied it by the swap size to get an
 * "expected output", shaved `slippageBps` off it and shipped that as `amountOutMin`; `minLiquidity`
 * was the literal `1`. A bound derived from spot and then enforced against a swap that executes at
 * that same spot compares the bad price against ITSELF and passes by construction. Skew the pool and
 * hold it for one block: a user who loads the page inside that window signs an `amountOutMin` the
 * manipulated swap clears with room to spare, and the loss lands inside the swap — before any custody
 * accounting, invisible to every balance assertion (the same blind spot ZapLogic's own `amountOutMin`
 * comment describes). On Arc the deepest pool on the entire chain is ~$74k, so holding a skewed price
 * for a block costs almost nothing. This is the shape that drained Arrakis V1 on 2026-08-23.
 *
 * THE ANCHOR IS THE TWAP, NEVER SPOT — the same sentence MoleQueue and MolePositions.rebalance already
 * enforce on chain, now said in the client that builds the numbers those contracts are handed. The
 * time-averaged tick from MoleHook's own ring cannot be moved by a swap in the transaction that reads
 * it (`_write` advances the cumulative by `elapsed * lastTick`, and `elapsed` is zero for a
 * same-timestamp swap), so an attacker who wants to move the anchor has to hold the skew for real
 * time, at real cost, against real arbitrage.
 *
 * AND SPOT IS STILL READ — as the thing being JUDGED, not as the anchor. A pool whose spot has walked
 * further than the vault's own `maxTwapDeviationTicks` from its TWAP is a pool we refuse to build a
 * transaction against at all. Bounding the trade at the honest price would be enough to stop the
 * theft, but it would also mean submitting a transaction we expect to revert and charging the user gas
 * for the privilege; saying "this pool looks manipulated" is the honest answer.
 *
 * WHY THE READS ARE INJECTED. Two callers need this rule with two different transports — the browser
 * deposit card (viem) and `/api/v1/tx/add-liquidity` (ethers, in a route that deliberately imports no
 * "use client" module) — and the tests need it with no transport at all. So this module owns the RULE
 * and the callers own the WIRE. Nothing here imports viem, ethers or a client component.
 */
import { getSqrtRatioAtTick } from "@/lib/aggregator/math/tickMath";
import { LIVE_POOL_ID, MOLE_ADDRESSES, QUEUE_CONFIG, type Address, type Hex } from "./chain";

/* ---------------------------------------------------------------------- constants */

/** v4 StateView — the read-only window onto the PoolManager's slot0. One definition, shared. */
export const STATE_VIEW: Address = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";

export const stateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }],
  },
] as const;

/**
 * `consult` alone, duplicated from oracle.ts's fuller ABI on purpose: oracle.ts owns the DISPLAY
 * contract (staleness, the Chainlink cross-check) and states that none of it is ever a transaction
 * input. This module is the transaction input. Keeping the two ABIs separate keeps that sentence true.
 */
export const moleHookConsultAbi = [
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
] as const;

/** MolePositions' own price band and window, read live rather than assumed. */
export const molePositionsAnchorAbi = [
  { type: "function", name: "maxTwapDeviationTicks", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
  { type: "function", name: "twapWindow", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
] as const;

/**
 * The band used when the vault cannot be read, or reports ZERO.
 *
 * ZERO IS NOT "UNBOUNDED" HERE, and that asymmetry is deliberate. On chain, `maxTwapDeviationTicks == 0`
 * disables the gate — an operator switch. In a client the same zero would silently restore the exact
 * defect this file exists to remove, so a disabled on-chain gate is precisely the moment the
 * client-side one has to bind. 600 ticks (±6.18%) is the live setting of both the vault and the queue.
 */
export const FALLBACK_MAX_TWAP_DEVIATION_TICKS: number = QUEUE_CONFIG.maxTwapDeviationTicks;

/** The window used when the vault cannot be read. Live vault and live queue both say 1800s. */
export const FALLBACK_TWAP_WINDOW_SECONDS: number = QUEUE_CONFIG.twapWindow;

/* -------------------------------------------------------------------------- types */

/** The judgement, separated from the reads so it can be tested without a chain. */
export interface AnchorVerdict {
  /** |spot − TWAP|, in ticks. */
  readonly deviationTicks: number;
  /** The band actually applied — the vault's, or the fallback above. */
  readonly maxDeviationTicks: number;
  /** `deviationTicks > maxDeviationTicks`. A manipulated pool is refused, not merely bounded. */
  readonly manipulated: boolean;
}

/** Everything a bound may be built from, plus the spot it was judged against. */
export interface PriceAnchor extends AnchorVerdict {
  /** The time-averaged tick from MoleHook — THE anchor. Every bound is derived from this. */
  readonly twapTick: number;
  /** sqrt(1.0001^twapTick) · 2^96, exactly as the EVM computes it. */
  readonly twapSqrtPriceX96: bigint;
  /** slot0's tick. Read to be JUDGED; never to price anything. */
  readonly spotTick: number;
  /** slot0's sqrt price. Same status as `spotTick`. */
  readonly spotSqrtPriceX96: bigint;
  /** The window the TWAP was taken over, in seconds. */
  readonly twapWindowSeconds: number;
}

/** The reads this module needs, in whatever transport the caller already has. */
export interface AnchorReads {
  /** MoleHook.consult(poolId, secondsAgo). MUST reject rather than fall back if the ring cannot answer. */
  twapTick(windowSeconds: number): Promise<number>;
  /** StateView.getSlot0(poolId), narrowed to the two fields that matter. */
  spot(): Promise<{ tick: number; sqrtPriceX96: bigint }>;
  /** MolePositions' live band and window. Optional: omitted means "use the fallbacks". */
  bounds?(): Promise<{ maxTwapDeviationTicks: number; twapWindowSeconds: number }>;
}

/* ------------------------------------------------------------------------- errors */

/**
 * The pool's spot has walked outside the vault's own band. Thrown INSTEAD of returning a transaction:
 * a bound is not the answer when the price the swap will execute at is the price we distrust.
 */
export class PoolLooksManipulatedError extends Error {
  readonly verdict: AnchorVerdict;
  constructor(verdict: AnchorVerdict) {
    super(manipulatedMessage(verdict));
    this.name = "PoolLooksManipulatedError";
    this.verdict = verdict;
  }
}

/**
 * There is no time-averaged tick to anchor to — `consult` reverted (a ring younger than the window, or
 * a pool the hook has never primed). Refusing to act beats acting blind, which is the same call
 * MolePositions.rebalance makes on the same read.
 */
export class NoHonestAnchorError extends Error {
  constructor(cause?: unknown) {
    super(
      "Could not read the pool's time-averaged price, so there is nothing honest to price this against. " +
        "Nothing was submitted. Try again in a few minutes.",
    );
    this.name = "NoHonestAnchorError";
    (this as any).cause = cause;
  }
}

/** The bound could not be made meaningful at this size — refuse rather than ship a placeholder. */
export class BoundTooSmallError extends Error {
  constructor(what: string) {
    super(`${what} is too small to place a real floor under — increase the amount. Nothing was submitted.`);
    this.name = "BoundTooSmallError";
  }
}

/* ---------------------------------------------------------------------- pure rule */

/** |a − b| in ticks. Throws on a non-integer: a NaN here would compare false and read as "fine". */
export function tickDeviation(a: number, b: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new Error(`tick deviation needs two integer ticks, got ${String(a)} and ${String(b)}`);
  }
  return Math.abs(a - b);
}

/**
 * The rule, on its own: how far has spot walked from the anchor, and is that further than allowed?
 *
 * `maxDeviationTicks` of 0 (or anything not a positive integer) falls back to the live band — see
 * FALLBACK_MAX_TWAP_DEVIATION_TICKS for why zero must not mean "no limit" on this side of the wire.
 */
export function judgeAnchor(spotTick: number, twapTick: number, maxDeviationTicks?: number): AnchorVerdict {
  const max =
    Number.isInteger(maxDeviationTicks) && (maxDeviationTicks as number) > 0
      ? (maxDeviationTicks as number)
      : FALLBACK_MAX_TWAP_DEVIATION_TICKS;
  const deviationTicks = tickDeviation(spotTick, twapTick);
  return { deviationTicks, maxDeviationTicks: max, manipulated: deviationTicks > max };
}

/** Roughly how far apart two ticks are in percent — for the refusal copy only, never for a bound. */
function driftPercent(ticks: number): number {
  return (Math.pow(1.0001, ticks) - 1) * 100;
}

/** The ONE refusal message. Every surface that declines a manipulated pool says exactly this. */
export function manipulatedMessage(verdict: AnchorVerdict): string {
  return (
    `This pool looks manipulated: its current price is ${verdict.deviationTicks} ticks ` +
    `(~${driftPercent(verdict.deviationTicks).toFixed(2)}%) away from its time-averaged price, past the ` +
    `${verdict.maxDeviationTicks}-tick limit the vault itself enforces. Nothing was submitted — depositing now ` +
    `would price your funds at a price someone else set. Try again once the price settles.`
  );
}

/** Throws `PoolLooksManipulatedError` when the verdict says so. The single enforcement point. */
export function assertAnchorUsable(verdict: AnchorVerdict): void {
  if (verdict.manipulated) throw new PoolLooksManipulatedError(verdict);
}

/**
 * Output of swapping `amountIn` raw units at the price `sqrtPriceX96`, ignoring depth and LP fee.
 *
 * price = (sqrtP / 2^96)^2 = currency1 raw units per currency0 raw unit. Integer-only and floored, so
 * the number a bound is built from never rounds in the user's disfavour.
 */
export function expectedOutAtSqrtPrice(sqrtPriceX96: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  if (typeof sqrtPriceX96 !== "bigint" || sqrtPriceX96 <= 0n) throw new Error(`sqrtPriceX96 must be positive`);
  if (typeof amountIn !== "bigint" || amountIn < 0n) throw new Error(`amountIn must be a non-negative bigint`);
  const Q192 = 1n << 192n;
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  return zeroForOne ? (amountIn * priceX192) / Q192 : (amountIn * Q192) / priceX192;
}

/* ------------------------------------------------------------------------- reader */

/**
 * Read the anchor: the TWAP first (it is the number everything is derived from), spot second (it is
 * only ever judged), and the vault's own band if the caller can supply it.
 *
 * Does NOT throw on a manipulated pool — it reports. `assertAnchorUsable` is the refusal, so a caller
 * that only wants to DISPLAY the state (a warning badge) can have it without a try/catch, and a caller
 * that is about to build calldata cannot forget the check, because every builder in this codebase
 * takes the verdict as an argument.
 */
export async function readPriceAnchor(reads: AnchorReads): Promise<PriceAnchor> {
  let maxDeviationTicks = FALLBACK_MAX_TWAP_DEVIATION_TICKS;
  let twapWindowSeconds = FALLBACK_TWAP_WINDOW_SECONDS;
  if (reads.bounds) {
    try {
      const b = await reads.bounds();
      // Taken RAW, zero included. `judgeAnchor` is the single place that decides what a zero band means
      // (see FALLBACK_MAX_TWAP_DEVIATION_TICKS), and a second copy of that rule here would be a guard no
      // test could tell apart from the first — which is the same as not having it.
      if (Number.isInteger(b.maxTwapDeviationTicks)) maxDeviationTicks = b.maxTwapDeviationTicks;
      // The WINDOW is different: it is not a bound, it is the argument `consult` is called with, and a
      // zero-second window averages nothing. That one does need its own floor.
      if (Number.isInteger(b.twapWindowSeconds) && b.twapWindowSeconds > 0) {
        twapWindowSeconds = b.twapWindowSeconds;
      }
    } catch {
      /* the vault's own numbers are a refinement; the fallbacks are the live values, not a guess */
    }
  }

  let twapTick: number;
  try {
    twapTick = Number(await reads.twapTick(twapWindowSeconds));
    if (!Number.isInteger(twapTick)) throw new Error(`consult returned ${String(twapTick)}`);
  } catch (e) {
    // NO FALLBACK TO SPOT. A missing anchor is the one case where reaching for slot0 would recreate
    // exactly the defect this module removes.
    throw new NoHonestAnchorError(e);
  }

  const spot = await reads.spot();
  const verdict = judgeAnchor(spot.tick, twapTick, maxDeviationTicks);
  return {
    ...verdict,
    twapTick,
    twapSqrtPriceX96: getSqrtRatioAtTick(twapTick),
    spotTick: spot.tick,
    spotSqrtPriceX96: spot.sqrtPriceX96,
    twapWindowSeconds,
  };
}

/* ------------------------------------------------------------------ viem transport */

/** Anything with viem's `readContract` shape. A PublicClient satisfies it; tests pass a stub. */
export interface ContractReader {
  readContract: (args: any) => Promise<any>;
}

/**
 * The two contracts an anchor is read from, so a caller on a chain other than Robinhood can name its own.
 *
 * They travel together for a reason: the TWAP and the band that judges it must come from the SAME
 * deployment as the vault the transaction is going to. Reading Robinhood's band while depositing into
 * Arc's vault would enforce a limit no contract on the receiving end is ever going to check.
 */
export interface AnchorContracts {
  readonly moleHook: Address;
  readonly molePositions: Address;
}

/**
 * The browser's wiring: MoleHook for the TWAP, StateView for spot, MolePositions for the band.
 *
 * The defaults are Robinhood's live WETH/USDG pool and Robinhood's contracts — the historical answer, kept
 * so existing callers read the same. A chain-aware caller passes both: `lib/mole/vaultChain` resolves them
 * from whichever chain the wallet is actually on. StateView is not a parameter because the v4 deployment is
 * the same CREATE2 artifact at the same address on both chains (read back on Arc, 2026-08-23).
 */
export function viemAnchorReads(
  client: ContractReader,
  poolId: Hex = LIVE_POOL_ID,
  contracts: AnchorContracts = MOLE_ADDRESSES,
): AnchorReads {
  return {
    twapTick: async (windowSeconds: number) =>
      Number(
        await client.readContract({
          address: contracts.moleHook,
          abi: moleHookConsultAbi,
          functionName: "consult",
          args: [poolId, windowSeconds],
        }),
      ),
    spot: async () => {
      const s = (await client.readContract({
        address: STATE_VIEW,
        abi: stateViewAbi,
        functionName: "getSlot0",
        args: [poolId],
      })) as readonly [bigint, number, number, number];
      return { sqrtPriceX96: BigInt(s[0]), tick: Number(s[1]) };
    },
    bounds: async () => {
      const [dev, win] = await Promise.all([
        client.readContract({
          address: contracts.molePositions,
          abi: molePositionsAnchorAbi,
          functionName: "maxTwapDeviationTicks",
          args: [],
        }),
        client.readContract({
          address: contracts.molePositions,
          abi: molePositionsAnchorAbi,
          functionName: "twapWindow",
          args: [],
        }),
      ]);
      return { maxTwapDeviationTicks: Number(dev), twapWindowSeconds: Number(win) };
    },
  };
}
