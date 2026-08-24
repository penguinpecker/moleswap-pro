/**
 * withdrawPlan.ts — the floor a depositor puts under their OWN exit, and the reason it is deliberately
 * a loose one.
 *
 * WHAT WAS MISSING. `MolePositions.withdrawWithMinimums(id, liquidityToRemove, amount0Min, amount1Min)`
 * has been live on both chains since the 2026-08-23 audit and this app had never called it. Every exit
 * went through `withdraw` / `withdrawAll`, which hand the contract (0, 0) — so a withdrawal accepted
 * whatever mix of the two tokens the pool happened to hold at the block it landed in, and the user found
 * out afterwards. The contract offers a floor; the client simply never passed one. This module computes
 * the pair of minimums that turns "whatever the pool gives" into a stated promise.
 *
 * THE ANCHOR IS THE TWAP, for the same reason `priceAnchor.ts` gives on the deposit side and no other:
 * a bound derived from `slot0` and then enforced against a burn that settles at that same `slot0`
 * compares the manipulated price against itself and passes by construction. It is worse here than on the
 * deposit, because the user is LEAVING — a floor that quietly agrees with a walked price is the last
 * thing standing between them and a composition someone else chose. Nothing in this file reads spot.
 *
 * WHAT THE FLOOR ACTUALLY PROMISES, stated exactly, because a vaguer claim would be a lie. It is not a
 * floor on value — the contract has no value oracle and two per-leg minimums cannot express one. It is a
 * floor on COMPOSITION: *this burn happened at a price within `toleranceTicks` of the pool's
 * time-averaged price, or it did not happen at all.* Everything below is that sentence in integers.
 *
 * WHY EACH LEG IS PRICED AT A DIFFERENT TICK, which looks wrong until you write out the check the
 * contract makes. `_withdraw` reverts when `amount0 < amount0Min || amount1 < amount1Min` — both legs
 * must clear, at ONE price, the price the burn settles at. Over the permitted band, `amount0` falls as
 * the price rises and `amount1` falls as it drops, so the binding case for each leg sits at the OPPOSITE
 * end of the band. Pricing both legs at one tick would over-floor whichever leg that tick happens to
 * favour and block exits that are inside the band. Pricing each leg at its own worst end is the exact
 * joint bound: at any single price in the band both minimums hold, and at any price outside it at least
 * one fails.
 *
 * AND IT FAILS LOOSE, ON PURPOSE, EVERYWHERE IT CAN. Getting this backwards is the one unrecoverable
 * mistake available here: a floor set too high does not cost the user slippage, it traps their funds.
 * So — the amounts are floored (never rounded up), a documented raw-unit slack is shaved off each leg
 * for v4's own rounding, a leg the band can empty gets a minimum of ZERO rather than a refusal, and the
 * caller is expected to keep the unfloored `withdrawAll` reachable at all times. The failure mode this
 * module is designed for is "the withdrawal reverts in simulation and the user still owns the position",
 * never "the user cannot find a way out".
 *
 * NO TRANSPORT HERE, deliberately: this is pure integer arithmetic over an anchor the caller read, so it
 * can be tested against a manipulated pool with no chain, no wallet and no browser — and imported from a
 * route handler that must not pull in a "use client" module.
 */
import { getSqrtRatioAtTick, MAX_TICK, MIN_TICK } from "@/lib/aggregator/math/tickMath";
import type { PriceAnchor } from "./priceAnchor";

const Q96 = 1n << 96n;
const MAX_UINT128 = (1n << 128n) - 1n;

/**
 * Raw units shaved off each leg's minimum, absorbing rounding and nothing else.
 *
 * v4 pays a burn with the amounts rounded DOWN in the pool's favour (`SqrtPriceMath.getAmount0Delta`
 * with `roundUp = false`, which floors twice on the token0 leg), and the arithmetic below floors too.
 * Two independent floors of the same real number can land one raw unit apart, so a floor computed at
 * exactly the band edge could miss by a wei — and a wei is enough to revert an exit. Two raw units is
 * dust on either token (2e-18 WETH, 2e-6 USDG) and it buys the tie.
 */
export const FLOOR_ROUNDING_SLACK_UNITS = 2n;

/** The two legs a burn pays out. */
export interface PositionAmounts {
  readonly amount0: bigint;
  readonly amount1: bigint;
}

/**
 * The token amounts `liquidity` holds over [sqrtLower, sqrtUpper] at price `sqrtPrice` — the inverse of
 * `seedLiquidity.getLiquidityForAmounts`, and the PRINCIPAL the burn pays.
 *
 * The price is clamped into the range first, which is the whole of the "below range / in range / above
 * range" case split: below it the position is entirely token0, above it entirely token1, and the two
 * formulas degenerate to exactly that at the clamp. Integer-only and floored throughout — see the
 * header for why every rounding decision in this file points the same way.
 */
export function amountsForLiquidity(
  sqrtPriceX96: bigint,
  sqrtLowerX96: bigint,
  sqrtUpperX96: bigint,
  liquidity: bigint,
): PositionAmounts {
  let sa = sqrtLowerX96;
  let sb = sqrtUpperX96;
  if (sa > sb) [sa, sb] = [sb, sa];
  if (typeof sqrtPriceX96 !== "bigint" || sqrtPriceX96 <= 0n) throw new Error(`sqrtPriceX96 must be positive`);
  if (sa <= 0n) throw new Error(`range bounds must be positive sqrt prices`);
  if (typeof liquidity !== "bigint" || liquidity < 0n) throw new Error(`liquidity must be a non-negative bigint`);
  if (sa === sb) return { amount0: 0n, amount1: 0n };

  const p = sqrtPriceX96 < sa ? sa : sqrtPriceX96 > sb ? sb : sqrtPriceX96;
  // Multiply before dividing: the divisions are the only place precision is lost, and they happen last.
  const amount0 = (liquidity * (sb - p) * Q96) / (p * sb);
  const amount1 = (liquidity * (p - sa)) / Q96;
  return { amount0, amount1 };
}

/**
 * The user's slippage tolerance, in bps of price, expressed as the tick band that holds it.
 *
 * A tick is a factor of 1.0001, so the band is `log(1 + bps/10_000) / log(1.0001)` — near enough to
 * "bps ticks" at these sizes (50 bps is 49.88 ticks) that the conversion looks redundant, and it stops
 * being redundant the moment someone sets 20%. ROUNDED UP: a wider band is a lower floor, and low is the
 * safe direction for an exit.
 */
export function slippageToleranceTicks(slippageBps: number): number {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new RangeError(`Invalid slippageBps: ${String(slippageBps)}`);
  }
  if (slippageBps === 0) return 0;
  return Math.ceil(Math.log(1 + slippageBps / 10_000) / Math.log(1.0001));
}

/** The `withdrawWithMinimums` arguments, plus what they were derived from. */
export interface WithdrawFloor {
  /** Liquidity this exit burns — the position's own, or the slice of it the caller asked for. */
  readonly liquidityToRemove: bigint;
  readonly amount0Min: bigint;
  readonly amount1Min: bigint;
  /** Half-width of the price band the floor permits the burn to settle in, in ticks. */
  readonly toleranceTicks: number;
  /** Top of the band — the tick that MINIMISES token0, so the tick `amount0Min` is priced at. */
  readonly amount0FloorTick: number;
  /** Bottom of the band — the tick that minimises token1, so the tick `amount1Min` is priced at. */
  readonly amount1FloorTick: number;
  /** What the burn pays at the TWAP itself. Display only: the user's "you should receive about". */
  readonly expected0: bigint;
  readonly expected1: bigint;
  /** The anchor the whole plan was derived from, carried so a caller can show its reasoning. */
  readonly anchor: PriceAnchor;
}

/**
 * Build the exit floor for `liquidityToRemove` of a position spanning [tickLower, tickUpper].
 *
 * DOES NOT REFUSE A MANIPULATED POOL, and that is the opposite of `buildZapPlan` on purpose. A deposit
 * into a walked pool is optional and can simply be declined; an EXIT is the one action a user must
 * always be able to attempt, and a client that refuses to build one is a client that has invented the
 * censorship lever `MolePositions.withdraw` explicitly refuses to be (see the comment above it: gating
 * the exit on spot hands whoever can move spot a veto over every withdrawal in the vault). So a
 * manipulated pool still gets a plan — a plan whose floor that pool cannot meet, which reverts in
 * simulation before the user is asked to sign anything, with the unfloored exit still one call away.
 *
 * A ZERO minimum on one leg is a legitimate answer, not an error. A position whose band reaches past one
 * of its own edges genuinely can pay out nothing on that side, and refusing to floor the other leg
 * because of it would leave the user with no floored exit at all.
 */
export function buildWithdrawFloor(params: {
  anchor: PriceAnchor;
  tickLower: number;
  tickUpper: number;
  liquidityToRemove: bigint;
  /** REQUIRED, with no default: a default here would be the literal this floor exists to not be. */
  slippageBps: number;
}): WithdrawFloor {
  const { anchor, tickLower, tickUpper, liquidityToRemove, slippageBps } = params;

  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper)) {
    throw new Error(`ticks must be integers, got ${String(tickLower)} and ${String(tickUpper)}`);
  }
  if (tickLower >= tickUpper) throw new Error(`tickLower ${tickLower} must be < tickUpper ${tickUpper}`);
  if (typeof liquidityToRemove !== "bigint" || liquidityToRemove <= 0n) {
    throw new Error(`liquidityToRemove must be a positive bigint`);
  }
  if (liquidityToRemove > MAX_UINT128) throw new Error(`liquidityToRemove overflows uint128`);
  if (!Number.isInteger(anchor.twapTick)) throw new Error(`anchor.twapTick must be an integer tick`);

  const toleranceTicks = slippageToleranceTicks(slippageBps);
  // Clamped to the representable tick space rather than allowed to throw: a position sitting near a tick
  // bound must still get an exit floor, and the clamp only ever WIDENS the effective band.
  const amount0FloorTick = Math.min(MAX_TICK, anchor.twapTick + toleranceTicks);
  const amount1FloorTick = Math.max(MIN_TICK, anchor.twapTick - toleranceTicks);

  const sqrtLower = getSqrtRatioAtTick(tickLower);
  const sqrtUpper = getSqrtRatioAtTick(tickUpper);
  const at = (tick: number) =>
    amountsForLiquidity(getSqrtRatioAtTick(tick), sqrtLower, sqrtUpper, liquidityToRemove);

  // Each leg at the end of the band that starves it — see the header for why this is the joint bound
  // and not two unrelated numbers.
  const { amount0 } = at(amount0FloorTick);
  const { amount1 } = at(amount1FloorTick);
  const expected = at(anchor.twapTick);

  return {
    liquidityToRemove,
    amount0Min: shave(amount0),
    amount1Min: shave(amount1),
    toleranceTicks,
    amount0FloorTick,
    amount1FloorTick,
    expected0: expected.amount0,
    expected1: expected.amount1,
    anchor,
  };
}

/** Rounding slack off a leg's minimum, never below zero. */
function shave(amount: bigint): bigint {
  return amount > FLOOR_ROUNDING_SLACK_UNITS ? amount - FLOOR_ROUNDING_SLACK_UNITS : 0n;
}

/**
 * The ONE message for a floored exit that the pool cannot currently meet.
 *
 * It has to say three things or it is not doing its job: nothing was submitted, the position is
 * untouched, and there IS a way out that carries no floor. A "withdrawal failed" that omits the last
 * one reads as trapped funds, which is precisely the impression this whole path must never leave.
 */
export function floorNotMetMessage(floor: Pick<WithdrawFloor, "toleranceTicks">): string {
  return (
    `This exit would settle outside the ${floor.toleranceTicks}-tick band around the pool's time-averaged ` +
    `price that your slippage setting allows, so the floor was not met. Nothing was submitted and your ` +
    `position is untouched. Wait for the price to settle, raise Max Slippage in Settings, or exit without ` +
    `a floor — "withdraw all" takes whatever the pool pays right now.`
  );
}

/**
 * The message for a floored exit that could not be BUILT, because the hook had no time-averaged price to
 * anchor to (`priceAnchor`'s `NoHonestAnchorError`: a ring younger than the window, or a pool it has
 * never primed).
 *
 * The anchor's own wording ends at "try again in a few minutes", and that is the correct sentence for a
 * DEPOSIT — a deposit can wait, and waiting costs the user nothing. An exit cannot be told to wait. To
 * an owner who has decided to leave, a refusal with no alternative inside it reads as trapped funds, and
 * the whole reason this module ships beside an unfloored `withdrawAll` is so that impression is never
 * true. Same refusal, different sentence, and the sentence's job is to name the exit that needs no price
 * at all.
 */
export function noAnchorFloorMessage(): string {
  return (
    `There is no time-averaged price to put a floor under this exit right now, and a floor of zero ` +
    `dressed up as a floor would be worse than none — you would believe it. Nothing was submitted and ` +
    `your position is untouched. You can still leave: "withdraw all" exits with no floor, at whatever ` +
    `the pool pays.`
  );
}
