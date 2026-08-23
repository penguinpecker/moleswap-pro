/**
 * v4Class.mjs — how a discovered Uniswap-v4 pool may be quoted, decided from its key alone.
 *
 * The single source of the rule on the indexer side (the frontend mirrors it in lib/aggregator/hookClass.ts,
 * and a frontend test imports THIS file to prove the two agree). A v4 hook address encodes its callbacks in
 * its low 14 bits; two of those bits let the hook change the swap amounts, and a pool whose hook carries
 * either cannot be honestly priced from tick math — the hook moves tokens the tick math never sees.
 *
 *   - "ticks"    — hookless / observe-only hook: priced from tick math, active=true. MoleSwap's OWN hook
 *                  is here too (see MOLE_HOOK below).
 *   - "simulate" — return-delta hook on ERC-20 currencies: NOT tick-quotable; the frontend prices it by
 *                  simulating the real swap through the canonical V4 Quoter (lib/aggregator/hookedQuote.ts).
 *                  Kept active=false so it never enters the tick routing set (nor bloats the routable-row
 *                  count the DB is already strained by), and loaded on demand by pair.
 *   - "native"   — a native-currency (address(0)) leg: MoleRouter cannot settle native v4, so unroutable
 *                  by this stack entirely (needs a new router + re-approval; out of scope). Native wins
 *                  over the hook test: a return-delta hook on a native pool is still "native", because the
 *                  block is the router's inability to settle, not the hook.
 *
 * `active` in mp_pools gates TICK-MATH routing only, so only "ticks" pools are active; "simulate" and
 * "native" both stay active=false but are NOT the same thing — the frontend tells them apart by
 * re-classifying the row (hookClass.ts), never by the flag.
 *
 * MOLEHOOK IS NOT A THIRD-PARTY HOOK. Its address carries afterSwapReturnDelta (it CAN charge a
 * hookFeePips), but its pools are the DEX's own: operator-registered as venue mole_v4, active=true, read by
 * the frontend's MoleHook reader, which decides quotability from the LIVE hookFeePips. The generic scan
 * skips it before upserting anything (index.mjs discoverV4), and should the rule ever be asked, the answer
 * is "ticks" — never "simulate", so the frontend's third-party simulate fallback (which mirrors this file)
 * cannot pick the DEX's own pools up as hooked candidates. The same address is pinned on the frontend as
 * MOLE_ADDRESSES.moleHook; the agreement test asserts the two are one.
 */

export const NATIVE_ADDR = "0x0000000000000000000000000000000000000000";
/** MoleSwap's own hook (the live MoleHook proxy), lowercase. Operator-registered pools; never third-party. */
export const MOLE_HOOK = "0xb2c9a0af48df8858f3765385e733cd8776a138c4";
export const HOOK_BEFORE_SWAP_RETURNS_DELTA = 0x08;
export const HOOK_AFTER_SWAP_RETURNS_DELTA = 0x04;
const DELTA_TAKING_MASK = HOOK_BEFORE_SWAP_RETURNS_DELTA | HOOK_AFTER_SWAP_RETURNS_DELTA;

/** True if the hook address's low bits encode a swap-amount-altering callback. */
export function hookAltersSwapAmounts(hooks) {
  if (!hooks) return false;
  return (BigInt(hooks) & BigInt(DELTA_TAKING_MASK)) !== 0n;
}

/** True if this is MoleSwap's own hook, in any address case. */
export function isMoleHook(hooks) {
  return String(hooks || "").toLowerCase() === MOLE_HOOK;
}

/** @returns {"ticks"|"simulate"|"native"} */
export function classifyV4Pool(currency0, currency1, hooks) {
  const c0 = String(currency0 || "").toLowerCase();
  const c1 = String(currency1 || "").toLowerCase();
  if (c0 === NATIVE_ADDR || c1 === NATIVE_ADDR) return "native";
  if (isMoleHook(hooks)) return "ticks"; // the DEX's own pools: tick path (live hookFeePips), never simulate
  return hookAltersSwapAmounts(hooks) ? "simulate" : "ticks";
}

/** Only tick-math pools are routable by the tick path (→ mp_pools.active). */
export function isTickRoutable(quoteMode) {
  return quoteMode === "ticks";
}
