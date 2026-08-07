/**
 * queue.ts — the batch auction (MoleQueue proxy 0x3dCb2494cBC9604f270177E38160ae4CA76CDEbd)
 * on Robinhood Chain 4663.
 *
 * WHAT THE QUEUE IS, because the UI has to explain it. A user submits an intent to swap rather than
 * a swap. At the cutoff, opposing intents are CROSSED against each other at the TWAP — that part
 * touches no pool, pays no LP fee and suffers no slippage — and only the net residual is pushed
 * through Uniswap as ONE aggregated swap. Everyone on a side settles at the same price, so being
 * first in the queue is worth exactly nothing.
 *
 * THE FOUR THINGS A UI MUST GET RIGHT, all of which are why this file exists:
 *
 *  1. THE CUTOFF IS A CLOCK, NOT A BUTTON. An epoch stops accepting `place` and `cancel` the moment
 *     `epochStartedAt + epochDuration` passes, whether or not anyone has called `freeze()`. A UI that
 *     only checks the stored phase will offer a Cancel button that reverts. Use `phaseAt` below.
 *
 *  2. A SETTLED ORDER CAN OWE TWO TOKENS. If the residual could not be swapped within its bound, the
 *     matched part settles at the TWAP and the unmatched part comes back IN KIND — so one claim pays
 *     out in the bought token AND the sold token. Rendering only `amountOut` under-reports what the
 *     user receives. Use `claimableOf`.
 *
 *  3. `amountIn` IS RAW TOKEN UNITS, AND THE TWO LEGS HAVE DIFFERENT DECIMALS. WETH is 18, USDG is 6.
 *     A `zeroForOne` order is denominated in currency0; the reverse in currency1. Getting this
 *     backwards is a 12-order-of-magnitude error, not a display glitch.
 *
 *  4. NOTHING IS EVER STUCK, AND THE UI SHOULD SAY SO. Every phase has an exit: cancel before the
 *     cutoff, claim after settlement, reclaim after the timeout. `exitFor` names the one that
 *     applies right now.
 *
 * Pure functions only — no network, no viem import. Everything here is derived from state the caller
 * has already read, so it can be unit-tested against the real contract's semantics.
 */

import type { Address, Hex } from "./chain";

/* -------------------------------------------------------------------------- ABI */

export const moleQueueAbi = [
  /* ------------------------------------------------------------- writes */
  {
    type: "function",
    name: "place",
    stateMutability: "nonpayable",
    inputs: [
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
    ],
    outputs: [{ name: "index", type: "uint256" }],
  },
  {
    type: "function",
    name: "cancel",
    stateMutability: "nonpayable",
    inputs: [
      { name: "e", type: "uint64" },
      { name: "index", type: "uint256" },
    ],
    outputs: [],
  },
  {
    /**
     * Pays BOTH legs when the epoch's residual was refunded in kind. The return value is only the
     * bought-token leg; read `refundOf` for the other. See note 2 in the file header.
     */
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "e", type: "uint64" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  /** Permissionless. Anyone may close an epoch that is past its cutoff. */
  { type: "function", name: "freeze", stateMutability: "nonpayable", inputs: [], outputs: [] },
  /** Permissionless. Anyone may settle a frozen epoch once its freeze window has elapsed. */
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [{ name: "e", type: "uint64" }],
    outputs: [],
  },
  /** Permissionless. The escape hatch: makes escrow reclaimable in kind, at no price. */
  {
    type: "function",
    name: "timeout",
    stateMutability: "nonpayable",
    inputs: [{ name: "e", type: "uint64" }],
    outputs: [],
  },

  /* -------------------------------------------------------------- views */
  {
    type: "function",
    name: "epochs",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint64" }],
    outputs: [
      { name: "phase", type: "uint8" },
      { name: "frozenAt", type: "uint64" },
      { name: "totalIn0", type: "uint128" },
      { name: "totalIn1", type: "uint128" },
      { name: "out0", type: "uint128" },
      { name: "out1", type: "uint128" },
      { name: "refund0", type: "uint128" },
      { name: "refund1", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "orders",
    stateMutability: "view",
    inputs: [
      { name: "", type: "uint64" },
      { name: "", type: "uint256" },
    ],
    outputs: [
      { name: "owner", type: "address" },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "withdrawn", type: "bool" },
    ],
  },
  {
    /** The in-kind leg an order is entitled to. An ENTITLEMENT, not a pending balance — it reads the
     *  same before and after the order is claimed, so pair it with `orders(...).withdrawn`. */
    type: "function",
    name: "refundOf",
    stateMutability: "view",
    inputs: [
      { name: "e", type: "uint64" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "phaseOf",
    stateMutability: "view",
    inputs: [{ name: "e", type: "uint64" }],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "orderCount",
    stateMutability: "view",
    inputs: [{ name: "e", type: "uint64" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  { type: "function", name: "currentEpoch", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "epochStartedAt", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "epochDuration", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint32" }] },
  { type: "function", name: "freezeDuration", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint32" }] },
  { type: "function", name: "maxEpochLife", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint32" }] },
  { type: "function", name: "maxResidualSlippageBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "function", name: "upgradeAdmin", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },

  /* -------------------------------------------------------------- events */
  {
    type: "event",
    name: "OrderPlaced",
    inputs: [
      { name: "epoch", type: "uint64", indexed: true },
      { name: "index", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "zeroForOne", type: "bool", indexed: false },
      { name: "amountIn", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EpochSettled",
    inputs: [
      { name: "epoch", type: "uint64", indexed: true },
      { name: "twapTick", type: "int24", indexed: false },
      { name: "crossed0", type: "uint128", indexed: false },
      { name: "crossed1", type: "uint128", indexed: false },
    ],
  },
  {
    /** Emitted when the residual could not be swapped and comes back in kind instead. */
    type: "event",
    name: "ResidualRefunded",
    inputs: [
      { name: "epoch", type: "uint64", indexed: true },
      { name: "refund0", type: "uint128", indexed: false },
      { name: "refund1", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "epoch", type: "uint64", indexed: true },
      { name: "index", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "amountOut", type: "uint256", indexed: false },
      { name: "refunded", type: "uint256", indexed: false },
    ],
  },
] as const;

/* ------------------------------------------------------------------- types */

/** Mirrors `MoleQueue.Phase`. The numeric values are the on-chain enum ordinals. */
export enum QueuePhase {
  Open = 0,
  Frozen = 1,
  Settled = 2,
  Refunding = 3,
}

export interface EpochState {
  readonly phase: QueuePhase;
  readonly frozenAt: bigint;
  readonly totalIn0: bigint;
  readonly totalIn1: bigint;
  readonly out0: bigint;
  readonly out1: bigint;
  readonly refund0: bigint;
  readonly refund1: bigint;
}

export interface OrderState {
  readonly owner: Address;
  readonly zeroForOne: bigint | boolean;
  readonly amountIn: bigint;
  readonly withdrawn: boolean;
}

export interface QueueSchedule {
  readonly currentEpoch: bigint;
  readonly epochStartedAt: bigint;
  readonly epochDuration: number;
  readonly freezeDuration: number;
  readonly maxEpochLife: number;
}

/* ---------------------------------------------------------------- the clock */

/**
 * The phase a UI should render, which is NOT always `epochs(e).phase`.
 *
 * The contract's `_phase` reports Frozen for the current epoch once its duration has elapsed, even
 * though storage still says Open, because the cutoff must not depend on somebody remembering to press
 * `freeze()`. A UI reading stored state alone will offer a Cancel button that reverts with WrongPhase.
 *
 * @param stored the `phase` field from `epochs(e)`
 * @param e the epoch being rendered
 * @param nowSeconds unix seconds — pass the CHAIN's clock where you can, not the browser's
 */
export function phaseAt(
  stored: QueuePhase,
  e: bigint,
  schedule: QueueSchedule,
  nowSeconds: bigint,
): QueuePhase {
  if (stored !== QueuePhase.Open) return stored;
  if (e !== schedule.currentEpoch) return QueuePhase.Frozen;
  const cutoff = schedule.epochStartedAt + BigInt(schedule.epochDuration);
  return nowSeconds >= cutoff ? QueuePhase.Frozen : QueuePhase.Open;
}

/** Unix seconds at which the current epoch stops accepting orders and cancels. */
export function cutoffOf(schedule: QueueSchedule): bigint {
  return schedule.epochStartedAt + BigInt(schedule.epochDuration);
}

/**
 * Seconds until the current epoch's cutoff, floored at zero.
 * Returns 0 once the cutoff has passed — never a negative countdown.
 */
export function secondsUntilCutoff(schedule: QueueSchedule, nowSeconds: bigint): number {
  const left = cutoffOf(schedule) - nowSeconds;
  return left > 0n ? Number(left) : 0;
}

/**
 * Unix seconds at which a frozen epoch's escape hatch opens.
 *
 * Anchored to `frozenAt`, which the contract stamps with the SCHEDULED cutoff rather than the moment
 * somebody called `freeze()` — a late freeze must not buy itself more time. A UI that computed this
 * from the freeze transaction's timestamp would show a deadline that drifts later the longer everyone
 * forgets, which is exactly the bug the contract fixes.
 */
export function timeoutAt(epoch: EpochState, schedule: QueueSchedule): bigint {
  return epoch.frozenAt + BigInt(schedule.maxEpochLife);
}

/** Unix seconds at which a frozen epoch becomes settleable. */
export function settleableAt(epoch: EpochState, schedule: QueueSchedule): bigint {
  return epoch.frozenAt + BigInt(schedule.freezeDuration);
}

/* ------------------------------------------------------------------ payouts */

export interface Claimable {
  /** Raw units of the token the order was BUYING. */
  readonly bought: bigint;
  /** Raw units of the token the order was SELLING, returned unswapped. Usually zero. */
  readonly refunded: bigint;
  /** True when the order sold currency0, i.e. `bought` is currency1 and `refunded` is currency0. */
  readonly zeroForOne: boolean;
}

/**
 * What one order is owed right now, both legs.
 *
 * Mirrors `claim()` exactly, including the rounding: pro-rata shares use floor division, because the
 * contract would rather keep a wei of dust than overpay the last claimer and leave them unable to
 * withdraw. A UI that rounded up here would promise a number the contract will not pay.
 *
 * Returns zeroes for an order that has already been withdrawn, so the caller can render "claimed"
 * without a second branch.
 */
export function claimableOf(order: OrderState, epoch: EpochState, phase: QueuePhase): Claimable {
  const zeroForOne = Boolean(order.zeroForOne);
  if (order.withdrawn) return { bought: 0n, refunded: 0n, zeroForOne };

  if (phase === QueuePhase.Refunding) {
    // No price was applied to a batch that never cleared: the escrow comes back at face value.
    return { bought: 0n, refunded: order.amountIn, zeroForOne };
  }

  if (phase !== QueuePhase.Settled) {
    // Still in flight. Nothing is claimable yet, but the escrow is the user's — show it as such.
    return { bought: 0n, refunded: 0n, zeroForOne };
  }

  const total = zeroForOne ? epoch.totalIn0 : epoch.totalIn1;
  if (total === 0n) return { bought: 0n, refunded: 0n, zeroForOne };

  const out = zeroForOne ? epoch.out0 : epoch.out1;
  const refundPool = zeroForOne ? epoch.refund0 : epoch.refund1;

  return {
    bought: (out * order.amountIn) / total,
    refunded: refundPool === 0n ? 0n : (refundPool * order.amountIn) / total,
    zeroForOne,
  };
}

/**
 * How much of an epoch actually crossed against opposing flow, in bps of the side's total.
 *
 * This is the number that justifies the product, so it should be shown rather than the marketing
 * claim: the crossed part paid no LP fee and no slippage. 10_000 means the whole side was netted and
 * the pool was never touched.
 */
export function crossedBpsOfSide(epoch: EpochState, zeroForOne: boolean): number {
  const total = zeroForOne ? epoch.totalIn0 : epoch.totalIn1;
  if (total === 0n) return 0;
  const refunded = zeroForOne ? epoch.refund0 : epoch.refund1;
  // Everything not returned in kind was either crossed or swapped; the refunded part is what the
  // pool could not absorb. This is a floor on how much traded, which is the safe direction to show.
  const traded = total > refunded ? total - refunded : 0n;
  return Number((traded * 10_000n) / total);
}

/* -------------------------------------------------------------------- exits */

export type Exit =
  | { readonly kind: "cancel"; readonly reason: string }
  | { readonly kind: "claim"; readonly reason: string }
  | { readonly kind: "waitForSettlement"; readonly readyAt: bigint; readonly reason: string }
  | { readonly kind: "waitForTimeout"; readonly readyAt: bigint; readonly reason: string }
  | { readonly kind: "none"; readonly reason: string };

/**
 * The exit available to this order RIGHT NOW, named.
 *
 * Every phase has one — that is a design guarantee, not an accident — and a UI that cannot say which
 * is teaching users that queued money is stuck. `waitFor*` carries the timestamp so the caller can
 * render a countdown instead of a dead button.
 */
export function exitFor(
  order: OrderState,
  epoch: EpochState,
  phase: QueuePhase,
  schedule: QueueSchedule,
  nowSeconds: bigint,
): Exit {
  if (order.withdrawn) {
    return { kind: "none", reason: "This order has already been paid out." };
  }

  if (phase === QueuePhase.Open) {
    return { kind: "cancel", reason: "The epoch is still open — cancel returns your deposit in full." };
  }

  if (phase === QueuePhase.Settled || phase === QueuePhase.Refunding) {
    return { kind: "claim", reason: "This batch has resolved — claim what it owes you." };
  }

  // Frozen: settlement first, then the escape hatch if nobody settles.
  const settleTime = settleableAt(epoch, schedule);
  if (nowSeconds < settleTime) {
    return {
      kind: "waitForSettlement",
      readyAt: settleTime,
      reason: "The batch is sealed and waiting out its freeze window before it can be priced.",
    };
  }

  return {
    kind: "waitForTimeout",
    readyAt: timeoutAt(epoch, schedule),
    reason:
      "Settlement is available to anyone now. If nobody settles, the escape hatch returns your deposit in kind.",
  };
}

/* ------------------------------------------------------------------ helpers */

/** Which token an order escrows, in currency order. */
export function escrowCurrencyIndex(zeroForOne: boolean): 0 | 1 {
  return zeroForOne ? 0 : 1;
}

/** Which token an order is paid its bought leg in, in currency order. */
export function outputCurrencyIndex(zeroForOne: boolean): 0 | 1 {
  return zeroForOne ? 1 : 0;
}

/** The queue's own view of an epoch id as the ABI wants it. */
export function epochArg(e: number | bigint): bigint {
  return typeof e === "bigint" ? e : BigInt(e);
}

export type { Address, Hex };
