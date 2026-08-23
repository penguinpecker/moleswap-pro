/**
 * hookRisk.ts — a first-pass risk screen on a third-party v4 hook, read from chain.
 *
 * A return-delta hook is a piece of someone else's code that sits inside every swap through its pool and
 * can move tokens (Part 2 §8: Cork lost ~$11M to a hook that trusted its caller; the dossier's rule is
 * "treat any non-immutable hook as hostile"). Before the aggregator will price such a pool by simulation
 * (v4Simulate.ts), it screens the hook itself:
 *
 *   - extcodesize / extcodehash — the hook MUST be deployed code. A hook address with no code cannot be a
 *     real hook; it is either an EOA or a not-yet-deployed CREATE2 slot, and a pool "using" it is a trap.
 *     This is the one HARD gate here: no code → do not quote.
 *   - EIP-1967 proxy detection — a nonzero implementation OR beacon slot means the hook is UPGRADEABLE:
 *     it can behave today and skim tomorrow. This is SURFACED as risk metadata (the route's tag says so)
 *     rather than hard-excluded, because the fund-safety guarantees do not depend on the hook being
 *     immutable: the quote is taken by simulating the REAL swap, `minOut` is never set above what that
 *     simulation returned, and `executeSwap` re-simulates at signing time — so an upgrade between quote
 *     and signing costs the user a revert, never a silent loss. Excluding every upgradeable hook outright
 *     would drop legitimate pools; the policy is deliberately "simulation-only + bounded minOut", not
 *     "immutable-only".
 *
 * The codehash is captured so a caller could pin or compare it later; nothing here trusts the hook's
 * permission BITS as an authenticity signal — mining a hook with any given bits is cheap (Part 2 §6).
 *
 * Successful screens are cached per hook address for the life of the process. A hook's own bytecode is
 * immutable (a proxy's bytecode is the proxy, not its implementation) and hooks are shared across many
 * pools — one hook backs >100k pools in the live registry — so this is one screen per distinct hook, not
 * per pool or per quote. A FAILED read is NOT cached: it fails closed for this quote only, so a transient
 * RPC error cannot blacklist a hook for the rest of the process.
 *
 * The three reads are exposed as batchable calls (`hookScreenCalls` + `parseHookScreen`) so the hooked
 * quote path can fold them into its ONE JSON-RPC round trip; `screenHook` is the standalone form.
 *
 * NOT detected here, stated plainly: a hook that delegates through a non-standard slot (no EIP-1967
 * storage), a hook whose behaviour is governed by mutable storage behind an owner key, and a
 * selfdestruct+CREATE2 redeploy (post-EIP-6780 only possible in the creating transaction). The codehash
 * is the hook's code TODAY; the simulation-only policy is what bounds the damage from any of these.
 */

import { keccak256 } from "viem";
import { ROBINHOOD_RPC_URL } from "../mole/chain";
import { jsonRpcBatch, type RpcBatchCall, type RpcBatchResult } from "./rpcBatch";

/** EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1. */
export const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/** EIP-1967 beacon slot: keccak256("eip1967.proxy.beacon") - 1. */
export const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const ZERO_WORD = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Per-screen latency ceiling; a slow read fails closed for this quote (and is not cached). */
export const HOOK_SCREEN_TIMEOUT_MS = 1_500;

export interface HookRisk {
  hook: string;
  /** The hook address holds deployed bytecode. False = EOA / undeployed CREATE2 slot → do not quote. */
  isContract: boolean;
  /** keccak256 of the hook's bytecode, for pinning / comparison. Empty string when there is no code. */
  codeHash: string;
  /** Deployed bytecode length in bytes (extcodesize). 0 when there is no code. */
  codeSize: number;
  /** An EIP-1967 implementation or beacon slot is nonzero — the hook is an upgradeable proxy. */
  isProxy: boolean;
  /** Which EIP-1967 slot flagged it, when `isProxy`. */
  proxyKind: "implementation" | "beacon" | null;
  /** The one hard gate: may this hook be quoted at all? (Currently: it must be a contract.) */
  ok: boolean;
  /** Short human tag for the route breakdown: "hooked", or "hooked·proxy" for an upgradeable hook. */
  tag: string;
}

const _cache = new Map<string, HookRisk>();

function rpc(rpcUrl?: string): string {
  return (
    rpcUrl ||
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) ||
    ROBINHOOD_RPC_URL
  );
}

/** The three reads a screen needs, in the order `parseHookScreen` expects their answers. */
export function hookScreenCalls(hook: string): RpcBatchCall[] {
  const key = hook.toLowerCase();
  return [
    { method: "eth_getCode", params: [key, "latest"] },
    { method: "eth_getStorageAt", params: [key, EIP1967_IMPL_SLOT, "latest"] },
    { method: "eth_getStorageAt", params: [key, EIP1967_BEACON_SLOT, "latest"] },
  ];
}

/** A failed (unreadable) screen — fails CLOSED, never cached. */
function unreadable(hook: string): HookRisk {
  return { hook, isContract: false, codeHash: "", codeSize: 0, isProxy: false, proxyKind: null, ok: false, tag: "hooked" };
}

/**
 * Turn the three batch answers (code, impl slot, beacon slot) into a verdict. Any per-call error →
 * unreadable (ok:false, NOT cached). A readable verdict is cached.
 */
export function parseHookScreen(hook: string, answers: readonly RpcBatchResult[]): HookRisk {
  const key = hook.toLowerCase();
  const [code, implWord, beaconWord] = answers;
  if (!code?.ok || !implWord?.ok || !beaconWord?.ok) return unreadable(key);

  const hasCode = !!code.result && code.result !== "0x" && code.result !== "0x0";
  const nonzeroWord = (w: string) => {
    if (!w || w === "0x" || w === ZERO_WORD) return false;
    try {
      return BigInt(w) !== 0n;
    } catch {
      return false;
    }
  };
  const proxyKind: HookRisk["proxyKind"] = nonzeroWord(implWord.result)
    ? "implementation"
    : nonzeroWord(beaconWord.result)
      ? "beacon"
      : null;
  const isProxy = proxyKind !== null;
  const result: HookRisk = {
    hook: key,
    isContract: hasCode,
    codeHash: hasCode ? keccak256(code.result as `0x${string}`) : "",
    codeSize: hasCode ? (code.result.length - 2) / 2 : 0,
    isProxy,
    proxyKind,
    ok: hasCode,
    tag: isProxy ? "hooked·proxy" : "hooked",
  };
  _cache.set(key, result);
  return result;
}

/** The cached verdict for a hook, if it has been screened successfully in this process. */
export function peekHookRisk(hook: string): HookRisk | undefined {
  return _cache.get(hook.toLowerCase());
}

/**
 * Screen a hook on its own (one batch round trip). Successful reads are cached per address; on ANY read
 * failure this fails closed for this call — `ok:false`, so the pool is excluded — because a hook we cannot
 * inspect is exactly the one to be cautious about, and the aggregator loses only one third-party venue by
 * skipping it (every safe route still quotes). The failure itself is not remembered, so the next quote
 * re-screens.
 */
export async function screenHook(hook: string, rpcUrl?: string): Promise<HookRisk> {
  const key = hook.toLowerCase();
  const cached = _cache.get(key);
  if (cached) return cached;
  let answers: RpcBatchResult[];
  try {
    answers = await jsonRpcBatch(rpc(rpcUrl), hookScreenCalls(key), HOOK_SCREEN_TIMEOUT_MS);
  } catch {
    return unreadable(key);
  }
  return parseHookScreen(key, answers);
}

/** Test seam: drop the per-process screen cache. */
export function _clearHookRiskCache(): void {
  _cache.clear();
}
