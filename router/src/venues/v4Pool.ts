/**
 * v4Pool.ts — quoting a Uniswap v4 pool, which on Robinhood Chain means our own MoleHook pool.
 *
 * THE ONLY THING THAT DIFFERS FROM v3 IS WHERE THE STATE LIVES AND HOW THE POOL IS NAMED. The swap math
 * is byte-for-byte the same concentrated-liquidity arithmetic — v4 did not change the curve, it moved the
 * pools into a singleton and added hooks. So this file does NOT reimplement the math: it builds the same
 * `PoolState` the v3 simulator already consumes, tags it as a v4 venue, and attaches the pool key that
 * execution needs. `quoteExactInput` then prices it exactly as it prices a Pancake pool.
 *
 * THE ASSUMPTION THAT MAKES THAT VALID, stated because a silent one would be dangerous: off-chain quoting
 * of a v4 pool is only exact if the pool's hook does NOT alter swap amounts. A hook with
 * `beforeSwapReturnDelta`/`afterSwapReturnDelta` can add or remove tokens on the swap path, and no amount
 * of tick math off-chain will see it.
 *
 * AND MOLEHOOK ITSELF NEEDS THIS CARE — verified against the live chain, not assumed. Its permission
 * bitmap 0x38C4 DOES carry `afterSwapReturnDelta` (bit 0x04), because it CAN charge a `hookFeePips` on the
 * swap output. So the bit alone does not decide quotability: what decides it is whether the hook is
 * currently TAKING a delta, which for MoleHook is exactly `hookFeePips == 0`. On the live pool the read
 * value is 0, so afterSwap returns a zero delta and the swap is ordinary fixed-fee v3 math — quotable to
 * the wei. This is therefore a STATE-DEPENDENT judgement: the indexer reads `hookFeePips` and passes it
 * in, and the moment it becomes nonzero the pool must be excluded (or its fee modelled) rather than
 * silently mis-quoted. `assertQuotableHook` encodes precisely that, so neither a foreign delta-taking hook
 * nor a MoleHook that starts charging a hook fee can slip through as if it were plain v3.
 */

import type { PoolKeyState, PoolState, TickData } from "./v3Pool.js";

/** v4 hook permission bits that let a hook change swap amounts. A pool whose hook has any of these cannot
 *  be quoted off-chain from tick state alone, because the hook moves tokens the tick math never sees. */
const BEFORE_SWAP_RETURNS_DELTA = 0x0008;
const AFTER_SWAP_RETURNS_DELTA = 0x0004;
const DELTA_TAKING_MASK = BEFORE_SWAP_RETURNS_DELTA | AFTER_SWAP_RETURNS_DELTA;

/** True if the hook address's low bits encode a swap-amount-altering callback. v4 hooks carry their
 *  permissions in the low 14 bits of their own address, read by bitwise AND — no state lookup needed. */
export function hookAltersSwapAmounts(hooks: string): boolean {
  const addr = BigInt(hooks);
  return (addr & BigInt(DELTA_TAKING_MASK)) !== 0n;
}

/**
 * Throw if this pool's hook could invalidate an off-chain quote. Call it when a v4 pool is added to the
 * routable set, so the failure is "this pool is not quotable" at indexing time — not a wrong number handed
 * to a user at swap time.
 *
 * @param hookFeePips the hook's CURRENTLY READ fee, in hundredths of a bip. Required to admit a
 *        delta-capable hook: only `0` proves the hook takes no delta right now. Omit it for a hook with no
 *        delta bits (it is ignored there).
 */
export function assertQuotableHook(poolKey: PoolKeyState, hookFeePips?: number): void {
  if (!hookAltersSwapAmounts(poolKey.hooks)) return; // no delta capability — always exact v3 math

  if (hookFeePips === undefined) {
    throw new Error(
      `v4 pool hook ${poolKey.hooks} can take a swap delta; supply the read hookFeePips to confirm it takes none`,
    );
  }
  if (hookFeePips !== 0) {
    // A nonzero hook fee genuinely changes the output. Modelling it exactly would mean reproducing
    // MoleHook's afterSwap arithmetic wei-for-wei; until that exists, exclude the pool rather than
    // under- or over-quote it.
    throw new Error(
      `v4 pool hook ${poolKey.hooks} is charging hookFeePips=${hookFeePips}; that fee is not modelled off-chain, exclude the pool`,
    );
  }
  // hookFeePips === 0: the delta callback returns zero, so this reduces to plain fixed-fee v3 math. Exact,
  // but tied to this reading — the indexer must re-run this check on every state refresh.
}

export interface V4PoolInput {
  readonly poolKey: PoolKeyState;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
  readonly ticks: readonly TickData[];
  /** The hook's currently read fee, in hundredths of a bip. Required for a delta-capable hook. */
  readonly hookFeePips?: number;
}

/**
 * Build a routable `PoolState` for a v4 pool. token0/token1 come from the pool key's currency ordering
 * (v4 sorts currencies exactly as v3 sorts tokens), and the state is tagged so the calldata builder emits
 * a v4 hop carrying the key rather than a pool address.
 */
export function v4PoolState(input: V4PoolInput): PoolState {
  assertQuotableHook(input.poolKey, input.hookFeePips);
  return {
    // v4 has no per-pool address; use the deterministic pool id slot as a stable identity string, so
    // graph dedup and "reuse a pool" checks still work across venues.
    address: `v4:${input.poolKey.currency0}:${input.poolKey.currency1}:${input.poolKey.fee}:${input.poolKey.tickSpacing}:${input.poolKey.hooks}`,
    token0: input.poolKey.currency0,
    token1: input.poolKey.currency1,
    fee: normalizeV4Fee(input.poolKey.fee),
    tickSpacing: input.poolKey.tickSpacing,
    sqrtPriceX96: input.sqrtPriceX96,
    tick: input.tick,
    liquidity: input.liquidity,
    ticks: input.ticks,
    venue: "UniswapV4",
    poolKey: input.poolKey,
  };
}

/** The dynamic-fee sentinel (0x800000) means "the hook sets the fee". For MoleHook that is a FIXED
 *  lpFeePips, and the caller must pass the actual fee in through `input.poolKey.fee` after reading the
 *  pool's live lpFee from slot0 — a pool left carrying the raw sentinel would be priced at a nonsense fee
 *  of 8,388,608 hundredths-of-a-bip, so this refuses it rather than quoting garbage. */
const DYNAMIC_FEE_FLAG = 0x800000;

function normalizeV4Fee(fee: number): number {
  if (fee === DYNAMIC_FEE_FLAG) {
    throw new Error(
      "v4 pool fee is the dynamic-fee sentinel; resolve the live lpFee from slot0 before quoting",
    );
  }
  if (fee < 0 || fee > 1_000_000) throw new Error(`v4 fee ${fee} out of range`);
  return fee;
}
