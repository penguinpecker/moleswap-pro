/**
 * hookClass.ts — the one rule that decides HOW a v4 pool may be quoted, given only its key.
 *
 * A v4 pool's hook address encodes its callbacks in the low 14 bits (read by the PoolManager with a bare
 * bitwise AND — no state lookup). Two of those bits let the hook change the swap amounts:
 * `beforeSwapReturnDelta` (0x0008) and `afterSwapReturnDelta` (0x0004). A pool whose hook carries either
 * moves tokens the tick math never sees, so an off-chain tick-derived quote is a fiction — it would hand
 * the user a `minOut` computed with the hook's skim already baked in.
 *
 * This module names the three quote modes and the rule that picks one, so the indexer's classification and
 * the frontend's routing agree by construction rather than by two hand-copied bit tests drifting apart:
 *
 *   - "ticks"      — a hookless pool, or one whose hook only observes: price it from tick math (the fast,
 *                    network-free path the whole aggregator is built on). MoleSwap's OWN pools are here
 *                    too — see below.
 *   - "simulate"   — a THIRD-PARTY return-delta hook on ERC-20 currencies: DO NOT tick-quote it; price it
 *                    by asking the canonical V4 Quoter to run the real swap (v4Simulate.ts), and never let
 *                    its output set a `minOut` above what the simulation returned.
 *   - "unroutable" — a native-currency (address(0)) pool: MoleRouter settles v4 currencies as ERC-20s and
 *                    cannot pay a native leg, so every route through it would revert. Not quotable at all
 *                    until a router that settles native v4 ships (a redeploy + re-approval; out of scope).
 *                    Also a row whose hook field is not a 20-byte address: a key that cannot be encoded can
 *                    be priced by neither path, and must fail closed rather than throw out of a filter.
 *
 * MOLEHOOK IS NOT A THIRD-PARTY HOOK. Its address carries `afterSwapReturnDelta` (it CAN charge a
 * `hookFeePips` on the swap output), but its pools are the DEX's own: operator-registered as venue mole_v4,
 * active=true, and read by the MoleHook reader (v4Reader.fetchV4Pool), which decides quotability from the
 * LIVE `hookFeePips` (v4Pool.assertQuotableHook — zero today, so plain fixed-fee math; nonzero → the tick
 * path excludes the pool rather than mis-quote it). The indexer never classifies MoleHook (it skips it
 * before the generic scan — services/indexer/src/index.mjs), and the frontend must not either: before this
 * rule the mirror below called the DEX's own WETH/USDG and CASHCAT/WETH pools "simulate", pushed them
 * through the third-party quoter batch on every quote and every live tick of the hub pair, let them take
 * candidate slots ahead of real hooked pools, and could have relabelled the DEX's own pool "[hooked]".
 *
 * The delta-bit constants are the same ones v4Pool.ts checks; `hookAltersSwapAmounts` is imported from
 * there rather than re-deriving the mask, so there is exactly one definition of "this hook can skim".
 */

import { hookAltersSwapAmounts } from "./venues/v4Pool";
import { MOLE_ADDRESSES } from "../mole/chain";

/** How a v4 pool may be priced. See the module header. */
export type V4QuoteMode = "ticks" | "simulate" | "unroutable";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const MOLE_HOOK_LC = MOLE_ADDRESSES.moleHook.toLowerCase();
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** True if either currency is the native sentinel address(0). v4 encodes native ETH as address(0), and
 *  MoleRouter cannot settle it (it works in WETH internally), so such a pool is unroutable by this stack. */
export function hasNativeCurrency(currency0: string, currency1: string): boolean {
  return currency0?.toLowerCase() === ZERO_ADDR || currency1?.toLowerCase() === ZERO_ADDR;
}

/** True if this is MoleSwap's own hook (any address case) — the DEX's own pools, never a third-party
 *  hooked candidate. The address is the live MoleHook proxy pinned in lib/mole/chain.ts. */
export function isMoleHook(hooks: string): boolean {
  return hooks.toLowerCase() === MOLE_HOOK_LC;
}

/**
 * Classify a v4 pool from its currencies and hook. Native wins over the hook test: a return-delta hook on
 * a native pool is still unroutable, because the block is the router's inability to settle native — not
 * the hook. Then MoleSwap's own hook is tick-path-owned (see the module header). Only a THIRD-PARTY hook
 * reaches the delta-bit test. This is the single source of the rule the indexer's `active` flag and the
 * frontend's quote branch both follow.
 */
export function classifyV4Pool(currency0: string, currency1: string, hooks: string | null | undefined): V4QuoteMode {
  if (hasNativeCurrency(currency0, currency1)) return "unroutable";
  if (!hooks) return "ticks";
  // Fail CLOSED on a hook field that is not an address ("0x", "0xzz", a short hex): such a row's key cannot
  // be encoded for either path, and a BigInt parse here would otherwise throw out of the candidate filter
  // and take a whole pair's live session down with it (LivePairSession.init runs this on every row).
  if (!HEX_ADDRESS.test(hooks)) return "unroutable";
  if (isMoleHook(hooks)) return "ticks";
  if (hookAltersSwapAmounts(hooks)) return "simulate";
  return "ticks";
}

/** A registry row shape this module can classify (a subset of `PoolRow`). */
export interface ClassifiableRow {
  token0: string;
  token1: string;
  hooks: string | null;
  /** The registry venue; MoleSwap's own class (`mole_v4`) is never simulate-eligible, whatever its hook. */
  venue?: string;
}

/** Classify a registry row. Convenience over {@link classifyV4Pool} for the `mp_pools` row shape. */
export function classifyV4Row(row: ClassifiableRow): V4QuoteMode {
  return classifyV4Pool(row.token0, row.token1, row.hooks);
}

/**
 * True when a row is a THIRD-PARTY return-delta-hook ERC-20 pool — the only class the simulate fallback
 * prices. A `mole_v4` row is excluded by its venue as well as by its hook: the DEX's own registry class is
 * owned by the tick path (client.ts reads every active mole_v4 row through the MoleHook reader), so even a
 * mole_v4 row whose hook field named some other delta hook must not be pushed through the external quoter.
 */
export function isSimulateEligible(row: ClassifiableRow): boolean {
  if (row.venue === "mole_v4") return false;
  return classifyV4Row(row) === "simulate";
}
