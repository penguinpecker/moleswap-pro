/**
 * hookBitmap.ts — the hook permission bitmap, decoded from the address, and the one check that matters.
 *
 * A Uniswap v4 hook's permissions are the LOW 14 BITS OF ITS OWN ADDRESS. The PoolManager reads them by
 * bitwise AND, with no storage lookup, so which callbacks can ever fire is a property of the address
 * itself — not of the hook's source, its deployment, or anyone's honesty. The property this product is
 * built on is that all three remove-liquidity bits are clear in MoleHook's address:
 *
 *     uint160(hook) & 0x0301 == 0
 *
 * which means the PoolManager can never call our code on a withdrawal. No bug, key compromise, upgrade
 * or pause can block an exit at the pool level. This module re-derives that claim client-side so the UI
 * renders it as arithmetic rather than copy. Mirrors src/config/HookPermissions.sol; the flag values are
 * v4-core's (Hooks.sol) and are pinned by tests on both sides.
 *
 * WHAT THE BITS DO NOT PROVE. Mining an address with a given bitmap is public and cheap, so an identical
 * bitmap on a different address says nothing about who deployed it. The bits prove which callbacks can
 * fire; identity is a separate check — `isMoleHookServed` compares the ADDRESS against the pinned
 * MoleHook, and only that earns a pool the Provide / Queue actions.
 *
 * Pure, dependency-free, server- and client-safe.
 */
import { MOLE_ADDRESSES } from "./chain";

/** All 14 permission bits. */
export const HOOK_PERMISSION_MASK = 0x3fff;

/**
 * BEFORE_REMOVE_LIQUIDITY (1<<9 = 0x0200) | AFTER_REMOVE_LIQUIDITY (1<<8 = 0x0100)
 * | AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA (1<<0 = 0x0001). Must be zero in MoleHook's address, forever.
 */
export const REMOVE_LIQUIDITY_MASK = 0x0301;

/** AFTER_ADD_LIQUIDITY_RETURNS_DELTA (1<<1 = 0x0002) — the deposit-tax bit MolePositions refuses to pin. */
export const DEPOSIT_TAX_MASK = 0x0002;

/** The bitmap MoleHook was mined to: beforeInitialize | afterInitialize | beforeAddLiquidity | beforeSwap
 *  | afterSwap | afterSwapReturnDelta. Pinned on the Solidity side by test/HookPermissions.t.sol. */
export const MOLE_HOOK_BITMAP = 0x38c4;

export interface HookFlag {
  readonly bit: number;
  readonly mask: number;
  readonly name: string;
  /** One of the three bits on the remove-liquidity path. */
  readonly removePath: boolean;
}

/** v4-core Hooks.sol flag order, most significant first (bit 13 → bit 0). */
export const HOOK_FLAGS: readonly HookFlag[] = [
  { bit: 13, mask: 1 << 13, name: "beforeInitialize", removePath: false },
  { bit: 12, mask: 1 << 12, name: "afterInitialize", removePath: false },
  { bit: 11, mask: 1 << 11, name: "beforeAddLiquidity", removePath: false },
  { bit: 10, mask: 1 << 10, name: "afterAddLiquidity", removePath: false },
  { bit: 9, mask: 1 << 9, name: "beforeRemoveLiquidity", removePath: true },
  { bit: 8, mask: 1 << 8, name: "afterRemoveLiquidity", removePath: true },
  { bit: 7, mask: 1 << 7, name: "beforeSwap", removePath: false },
  { bit: 6, mask: 1 << 6, name: "afterSwap", removePath: false },
  { bit: 5, mask: 1 << 5, name: "beforeDonate", removePath: false },
  { bit: 4, mask: 1 << 4, name: "afterDonate", removePath: false },
  { bit: 3, mask: 1 << 3, name: "beforeSwapReturnDelta", removePath: false },
  { bit: 2, mask: 1 << 2, name: "afterSwapReturnDelta", removePath: false },
  { bit: 1, mask: 1 << 1, name: "afterAddLiquidityReturnDelta", removePath: false },
  { bit: 0, mask: 1 << 0, name: "afterRemoveLiquidityReturnDelta", removePath: true },
];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** uint160(hook) as a bigint. Throws on anything that is not a 20-byte hex address — fail closed. */
function uint160(hook: string): bigint {
  if (typeof hook !== "string" || !ADDRESS_RE.test(hook)) {
    throw new Error(`hookBitmap: not an address: ${String(hook)}`);
  }
  return BigInt(hook);
}

/** The low 14 bits of the hook address — its permission bitmap. */
export function hookBitmap(hook: string): number {
  return Number(uint160(hook) & BigInt(HOOK_PERMISSION_MASK));
}

/** `uint160(hook) & 0x0301 == 0` — the withdrawal path provably cannot reach this hook. */
export function removeLiquidityBitsClear(hook: string): boolean {
  return (uint160(hook) & BigInt(REMOVE_LIQUIDITY_MASK)) === 0n;
}

/** `uint160(hook) & 0x0002 == 0` — the hook cannot return a delta on the add-liquidity path. */
export function depositTaxBitClear(hook: string): boolean {
  return (uint160(hook) & BigInt(DEPOSIT_TAX_MASK)) === 0n;
}

export interface HookBit extends HookFlag {
  readonly set: boolean;
}

export interface HookBitmapProof {
  readonly hook: string;
  /** The 14-bit bitmap as a number, e.g. 0x38c4. */
  readonly bitmap: number;
  /** Zero-padded hex, e.g. "0x38c4". */
  readonly bitmapHex: string;
  /** 14 characters, bit 13 first, e.g. "11100011000100". */
  readonly binary: string;
  readonly bits: readonly HookBit[];
  /** Names of every set flag, in bit order. */
  readonly setFlags: readonly string[];
  /** The load-bearing assertion. */
  readonly removeBitsClear: boolean;
  readonly depositTaxClear: boolean;
  /** The bitmap equals MoleHook's (says nothing about the address being MoleHook — see isMoleHookServed). */
  readonly matchesMoleBitmap: boolean;
  /** The one-line proof as rendered: "uint160(hook) & 0x0301 == 0 ✓" (or ✗). */
  readonly proofLine: string;
}

/** Decode a hook address into the bitmap proof the provenance card renders. Computed, never stored. */
export function hookBitmapProof(hook: string): HookBitmapProof {
  const bitmap = hookBitmap(hook);
  const bits = HOOK_FLAGS.map((f) => ({ ...f, set: (bitmap & f.mask) !== 0 }));
  const removeBitsClear = removeLiquidityBitsClear(hook);
  return {
    hook,
    bitmap,
    bitmapHex: `0x${bitmap.toString(16).padStart(4, "0")}`,
    binary: bits.map((b) => (b.set ? "1" : "0")).join(""),
    bits,
    setFlags: bits.filter((b) => b.set).map((b) => b.name),
    removeBitsClear,
    depositTaxClear: depositTaxBitClear(hook),
    matchesMoleBitmap: bitmap === MOLE_HOOK_BITMAP,
    proofLine: `uint160(hook) & 0x0301 == 0 ${removeBitsClear ? "✓" : "✗"}`,
  };
}

/* ---------------------------------------------------------------- identity + service tag */

const MOLE_HOOK_LC = MOLE_ADDRESSES.moleHook.toLowerCase();

/**
 * True only if `hooks` IS the pinned MoleHook address (case-insensitive). This is the identity check —
 * the bitmap alone never is. Undefined / malformed / zero → false, never "probably ours".
 */
export function isMoleHookServed(hooks: string | null | undefined): boolean {
  if (typeof hooks !== "string" || !ADDRESS_RE.test(hooks)) return false;
  return hooks.toLowerCase() === MOLE_HOOK_LC;
}

/**
 * Which engine, if any, can serve a pool.
 *   molehook    — a v4 pool whose hook is MoleHook: the TWAP oracle, the vault and the queue all apply.
 *   foreign-v4  — any other v4 pool (foreign hook or hookless): the aggregator may route it, the engine
 *                 cannot serve it, and never will — the hook is part of the PoolId.
 *   v3          — an address-backed v3-style pool.
 */
export type PoolServiceTag = "molehook" | "foreign-v4" | "v3";

export interface TaggablePool {
  /** Registry venue ("mole_v4" | "uniswap_v4" | "pancake_v3" | "uniswap_v3") or simulator venue ("UniswapV4" | "PancakeV3"). */
  readonly venue?: string | null;
  /** Registry rows carry the hook address directly. */
  readonly hooks?: string | null;
  /** Simulator PoolStates carry it inside the key. */
  readonly poolKey?: { readonly hooks: string } | null;
}

const V4_VENUES = new Set(["mole_v4", "uniswap_v4", "UniswapV4"]);

/**
 * Tag a pool from what the CHAIN says about it — the hook address — not from a registry label. A row
 * filed under `mole_v4` with someone else's hook is foreign; a row filed under `uniswap_v4` that carries
 * MoleHook is ours. Only the address decides.
 */
export function poolServiceTag(p: TaggablePool): PoolServiceTag {
  const hooks = p.hooks ?? p.poolKey?.hooks ?? null;
  if (isMoleHookServed(hooks)) return "molehook";
  if (V4_VENUES.has(p.venue ?? "") || p.poolKey != null || (typeof hooks === "string" && ADDRESS_RE.test(hooks))) {
    return "foreign-v4";
  }
  return "v3";
}

/** Provide (vault) and Queue (batch auction) are bound to MoleHook pools; offer them nowhere else. */
export function engineActionsAllowed(tag: PoolServiceTag): boolean {
  return tag === "molehook";
}

/** Route-row venue label for a v4 hop. Only a MoleHook pool may be called MoleSwap's. */
export function v4VenueLabel(hooks: string | null | undefined): "MoleSwap v4" | "Uniswap v4" {
  return isMoleHookServed(hooks) ? "MoleSwap v4" : "Uniswap v4";
}

/** Badge text per tag — minimal, and honest about what a foreign pool is. */
export const SERVICE_TAG_LABEL: Record<PoolServiceTag, string> = {
  molehook: "MoleHook",
  "foreign-v4": "Foreign hook",
  v3: "v3",
};
