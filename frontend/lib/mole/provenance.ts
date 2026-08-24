"use client";
/**
 * provenance.ts — everything the provenance card shows, read from the chain, with an honest mutability
 * label per parameter.
 *
 * THE LABELS, AND WHY THEY ARE NOT CONFIG. A PoolKey (currency0, currency1, fee, tickSpacing, hooks) is
 * hashed into the PoolId, so those five are IMMUTABLE by construction — and the hook's permission bitmap
 * is the hook's address, so it is immutable too. Everything else is a contract field, and every MoleSwap
 * contract that touches user funds — MoleHook, MolePositions (the vault), MoleQueue, MoleRouter — is a
 * UUPS proxy. So "this value cannot change" is NOT something the periphery can claim: a parameter with no
 * setter is UPGRADEABLE (a new implementation changes it, visibly), a parameter with a setter is TUNABLE
 * (one transaction changes it, under whatever cap the CURRENT implementation compiles in), and only a
 * proxy whose upgrade key has been burned (`upgradeAdmin == address(0)`) may be called immutable — and
 * that, too, is read from chain here rather than asserted.
 *
 * Read paths: StateView.getSlot0 for the live lpFee (the hook re-asserts `lpFeePips` on every swap, so
 * slot0 is the fee that actually applied last), ERC-1967 implementation slots for proxy status,
 * `upgradeAdmin()` on each proxy, `decimals()` on each currency (never assumed — USDG is 6, WETH 18), and
 * the vault / queue / router fields the rows quote. Nothing here is hard-coded except the addresses the
 * whole app is pinned to.
 */
import { createPublicClient, http, type Address, type Hex } from "viem";
import { robinhoodChain } from "@/lib/chain/wagmi-config";
import { MOLE_ADDRESSES, ROBINHOOD_RPC_URL, DYNAMIC_FEE_FLAG, tokenByAddress } from "./chain";
import { contractsFor } from "@/lib/chain/chains";
import { vaultChainFor } from "./vaultChain";
import { poolIdOf, type V4PoolKey } from "./poolId";
import { hookBitmapProof, isMoleHookServed, type HookBitmapProof } from "./hookBitmap";

/** keccak256("eip1967.proxy.implementation") - 1. Non-zero here means "this address is a proxy". */
export const ERC1967_IMPLEMENTATION_SLOT: Hex =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as Address;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";

const POOL_KEY_COMPONENTS = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

const stateViewAbi = [
  { type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] },
] as const;

const hookAbi = [
  { type: "function", name: "lpFeePips", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "hookFeePips", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "upgradeAdmin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "poolCreator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "restrictedLiquidity", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

const vaultAbi = [
  { type: "function", name: "upgradeAdmin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "moleHook", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "isWhitelisted", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "minRangeWidth", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
  { type: "function", name: "maxRangeWidth", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
  { type: "function", name: "minPositionLiquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  { type: "function", name: "maxPositionLiquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  { type: "function", name: "performanceFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
] as const;

const queueAbi = [
  { type: "function", name: "upgradeAdmin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "key", stateMutability: "view", inputs: [], outputs: POOL_KEY_COMPONENTS },
] as const;

const routerAbi = [
  { type: "function", name: "upgradeAdmin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeDial", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const dialAbi = [
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
] as const;

const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/**
 * The client this card reads its evidence from, on the chain the card is DESCRIBING.
 *
 * This used to be pinned to Robinhood. On a pools page that had become chain-aware, that meant an Arc
 * pool rendered a provenance card built from ROBINHOOD's PoolManager, MolePositions, MoleQueue and
 * MoleRouter — a trust surface, confidently displaying another chain's contracts as proof about this
 * one. That is worse than showing nothing: the card exists precisely so a user does not have to take
 * the pool's word for what it is, and a card that lies is a card that launders a wrong answer.
 */
function client(chainId?: number) {
  const cfg = vaultChainFor(chainId);
  if (cfg) return createPublicClient({ chain: cfg.chain as any, transport: http(cfg.rpcUrl) });
  const rpc = (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) || ROBINHOOD_RPC_URL;
  return createPublicClient({ chain: robinhoodChain, transport: http(rpc) });
}

/** The MoleSwap addresses for the chain being described, never the flat Robinhood-only registry. */
/**
 * Exported for tests: this is the function that decides WHICH chain's contracts the trust card
 * describes, and a silent fallback here is the failure mode the card exists to prevent.
 */
export function addressesFor(chainId?: number) {
  const c = contractsFor(chainId);
  return {
    molePositions: c.MOLE_POSITIONS as Address,
    moleQueue: (c as { MOLE_QUEUE?: string }).MOLE_QUEUE as Address | undefined,
    moleRouter: c.MOLE_ROUTER as Address,
  };
}

/* ----------------------------------------------------------------------------- mutability */

/**
 * IMMUTABLE  — hashed into the PoolId, or a proxy whose upgrade key is burned, or a plain contract.
 * UPGRADEABLE— lives in a UUPS proxy with a live upgrade key and has no setter.
 * TUNABLE    — has a setter; one transaction changes it under the current implementation's cap.
 * UNVERIFIED — the read that decides it failed; never rendered as a guarantee.
 */
/**
 * ABSENT is distinct from UNVERIFIED on purpose: UNVERIFIED means a contract is there and we could
 * not prove what it is, ABSENT means there is no such contract on this chain at all. Collapsing the
 * two would let a missing deployment read as a mere verification gap.
 */
export type Mutability = "IMMUTABLE" | "UPGRADEABLE" | "TUNABLE" | "UNVERIFIED" | "ABSENT";

const isZero = (a: string | null | undefined) => typeof a === "string" && /^0x0{40}$/i.test(a);

/**
 * Classify a contract's code from two chain facts: its ERC-1967 implementation slot and its
 * `upgradeAdmin()`. Fails closed — a proxy whose admin could not be read is UPGRADEABLE, and an
 * implementation slot that could not be read is UNVERIFIED, never "immutable".
 */
export function upgradeability(impl: string | null, upgradeAdmin: string | null): { label: Mutability; note: string } {
  if (impl === null) return { label: "UNVERIFIED", note: "proxy status unread" };
  if (isZero(impl)) return { label: "IMMUTABLE", note: "not a proxy" };
  if (upgradeAdmin === null) return { label: "UPGRADEABLE", note: "UUPS proxy · admin unread" };
  if (isZero(upgradeAdmin)) return { label: "IMMUTABLE", note: "UUPS proxy · upgrade key burned" };
  return { label: "UPGRADEABLE", note: `UUPS proxy · admin ${short(upgradeAdmin)}` };
}

export const short = (a: string) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/* ----------------------------------------------------------------------------- shapes */

export interface CurrencyInfo {
  readonly address: string;
  readonly symbol: string;
  /** From `decimals()` on chain. null when the read failed — rendered as "?", never assumed. */
  readonly decimals: number | null;
}

export interface ProxyFacts {
  readonly address: string;
  /** ERC-1967 implementation, or the zero address for a plain contract, or null if unread. */
  readonly impl: string | null;
  readonly upgradeAdmin: string | null;
}

export interface PoolProvenance {
  readonly poolKey: V4PoolKey;
  /** keccak256(abi.encode(key)) — computed here, not read from anywhere. */
  readonly poolId: Hex;
  readonly bitmap: HookBitmapProof;
  /** The identity check — hooks IS the pinned MoleHook. */
  readonly served: boolean;
  readonly slot0: { sqrtPriceX96: bigint; tick: number; protocolFee: number; lpFee: number } | null;
  readonly hook: ProxyFacts & {
    lpFeePips: number | null;
    hookFeePips: number | null;
    poolCreator: string | null;
    restrictedLiquidity: boolean | null;
  };
  readonly vault: ProxyFacts & {
    moleHook: string | null;
    whitelisted: boolean | null;
    minRangeWidth: number | null;
    maxRangeWidth: number | null;
    minPositionLiquidity: bigint | null;
    maxPositionLiquidity: bigint | null;
    performanceFeeBps: number | null;
  };
  /**
   * NULL on a chain that has no batch queue deployed at all (Arc today). That is a real state, not a
   * read failure, and the card must render it as "no queue on this chain" rather than fall back to
   * another chain's queue address — a provenance card naming a contract that is not there is worse
   * than one admitting the gap.
   */
  readonly queue: (ProxyFacts & {
    /** Whether the queue's own `key()` hashes to THIS pool's id. */
    boundToThisPool: boolean | null;
  }) | null;
  readonly router: ProxyFacts & { feeDial: string | null; feeBps: number | null };
  readonly currencies: readonly [CurrencyInfo, CurrencyInfo];
  readonly readAt: number;
}

/* ----------------------------------------------------------------------------- reader */

type MC = { status: "success"; result: unknown } | { status: "failure"; error: unknown };
const ok = <T,>(r: MC | undefined, map: (v: any) => T): T | null =>
  r && r.status === "success" ? map(r.result) : null;

/** Read everything the card shows for `key`, tolerating per-field failures (each becomes null). */
export async function readPoolProvenance(key: V4PoolKey, chainId?: number): Promise<PoolProvenance> {
  const c = client(chainId);
  const poolId = poolIdOf(key) as Hex;
  const hook = key.hooks as Address;
  const { molePositions, moleQueue, moleRouter } = addressesFor(chainId);

  const implOf = (addr: Address) =>
    c.getStorageAt({ address: addr, slot: ERC1967_IMPLEMENTATION_SLOT })
      .then((w) => (w ? `0x${w.slice(-40)}` : null))
      .catch(() => null);

  /**
   * The reads whose positions the destructuring below depends on. Held in its own array so that
   * FIXED_READS is DERIVED from it: adding a read here can never silently shift the queue slice.
   */
  const fixedReads = [
        { address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] },
        { address: hook, abi: hookAbi, functionName: "lpFeePips" },
        { address: hook, abi: hookAbi, functionName: "hookFeePips" },
        { address: hook, abi: hookAbi, functionName: "upgradeAdmin" },
        { address: hook, abi: hookAbi, functionName: "poolCreator" },
        { address: hook, abi: hookAbi, functionName: "restrictedLiquidity" },
        { address: molePositions, abi: vaultAbi, functionName: "upgradeAdmin" },
        { address: molePositions, abi: vaultAbi, functionName: "moleHook" },
        { address: molePositions, abi: vaultAbi, functionName: "isWhitelisted", args: [poolId] },
        { address: molePositions, abi: vaultAbi, functionName: "minRangeWidth" },
        { address: molePositions, abi: vaultAbi, functionName: "maxRangeWidth" },
        { address: molePositions, abi: vaultAbi, functionName: "minPositionLiquidity" },
        { address: molePositions, abi: vaultAbi, functionName: "maxPositionLiquidity" },
        { address: molePositions, abi: vaultAbi, functionName: "performanceFeeBps" },
        { address: moleRouter, abi: routerAbi, functionName: "upgradeAdmin" },
        { address: moleRouter, abi: routerAbi, functionName: "feeDial" },
        { address: key.currency0 as Address, abi: erc20Abi, functionName: "decimals" },
        { address: key.currency0 as Address, abi: erc20Abi, functionName: "symbol" },
        { address: key.currency1 as Address, abi: erc20Abi, functionName: "decimals" },
        { address: key.currency1 as Address, abi: erc20Abi, functionName: "symbol" },
  ];
  const FIXED_READS = fixedReads.length;

  const [mc, hookImpl, vaultImpl, queueImpl, routerImpl] = await Promise.all([
    c.multicall({
      multicallAddress: MULTICALL3,
      allowFailure: true,
      contracts: [
        ...fixedReads,
        // Tail, and conditional: a chain without a queue contributes no entries here, which is why the
        // fixed reads above are destructured positionally and these two are sliced off the end.
        ...(moleQueue
          ? [
              { address: moleQueue, abi: queueAbi, functionName: "upgradeAdmin" },
              { address: moleQueue, abi: queueAbi, functionName: "key" },
            ]
          : []),
      ],
    }) as Promise<MC[]>,
    implOf(hook),
    implOf(molePositions as Address),
    moleQueue ? implOf(moleQueue) : Promise.resolve(null),
    implOf(moleRouter as Address),
  ]);

  const [
    slot0R, lpFeeR, hookFeeR, hookAdminR, poolCreatorR, restrictedR,
    vaultAdminR, vaultHookR, whitelistedR, minWR, maxWR, minLR, maxLR, perfR,
    routerAdminR, feeDialR,
    dec0R, sym0R, dec1R, sym1R,
  ] = mc;
  const [queueAdminR, queueKeyR] = moleQueue ? mc.slice(FIXED_READS) : [undefined, undefined];

  // The dial is whatever the ROUTER says it is — read, not assumed — and its rate is a second hop.
  const feeDial = ok(feeDialR, (v) => String(v));
  let feeBps: number | null = null;
  if (feeDial && !isZero(feeDial)) {
    feeBps = await c
      .readContract({ address: feeDial as Address, abi: dialAbi, functionName: "feeBps" })
      .then((v) => Number(v))
      .catch(() => null);
  } else if (feeDial && isZero(feeDial)) {
    feeBps = 0; // feeless router
  }

  const queueKey = ok(queueKeyR, (v: any) =>
    Array.isArray(v)
      ? { currency0: v[0], currency1: v[1], fee: Number(v[2]), tickSpacing: Number(v[3]), hooks: v[4] }
      : { currency0: v.currency0, currency1: v.currency1, fee: Number(v.fee), tickSpacing: Number(v.tickSpacing), hooks: v.hooks },
  );
  let boundToThisPool: boolean | null = null;
  if (queueKey) {
    try {
      boundToThisPool = poolIdOf(queueKey as V4PoolKey).toLowerCase() === poolId.toLowerCase();
    } catch {
      boundToThisPool = null;
    }
  }

  const currency = (addr: string, decR: MC | undefined, symR: MC | undefined): CurrencyInfo => ({
    address: addr,
    // symbol() is cosmetic and some tokens return bytes32 — fall back to the pinned registry, then the
    // short address. decimals() is NOT cosmetic and is never defaulted.
    symbol: ok(symR, (v) => String(v)) ?? tokenByAddress(addr)?.symbol ?? short(addr),
    decimals: ok(decR, (v) => Number(v)),
  });

  return {
    poolKey: key,
    poolId,
    bitmap: hookBitmapProof(key.hooks),
    served: isMoleHookServed(key.hooks),
    slot0: ok(slot0R, (v: any) => ({
      sqrtPriceX96: BigInt(v[0]),
      tick: Number(v[1]),
      protocolFee: Number(v[2]),
      lpFee: Number(v[3]),
    })),
    hook: {
      address: key.hooks,
      impl: hookImpl,
      upgradeAdmin: ok(hookAdminR, (v) => String(v)),
      lpFeePips: ok(lpFeeR, (v) => Number(v)),
      hookFeePips: ok(hookFeeR, (v) => Number(v)),
      poolCreator: ok(poolCreatorR, (v) => String(v)),
      restrictedLiquidity: ok(restrictedR, (v) => Boolean(v)),
    },
    vault: {
      address: molePositions,
      impl: vaultImpl,
      upgradeAdmin: ok(vaultAdminR, (v) => String(v)),
      moleHook: ok(vaultHookR, (v) => String(v)),
      whitelisted: ok(whitelistedR, (v) => Boolean(v)),
      minRangeWidth: ok(minWR, (v) => Number(v)),
      maxRangeWidth: ok(maxWR, (v) => Number(v)),
      minPositionLiquidity: ok(minLR, (v) => BigInt(v)),
      maxPositionLiquidity: ok(maxLR, (v) => BigInt(v)),
      performanceFeeBps: ok(perfR, (v) => Number(v)),
    },
    queue: moleQueue
      ? {
          address: moleQueue,
          impl: queueImpl,
          upgradeAdmin: ok(queueAdminR, (v) => String(v)),
          boundToThisPool,
        }
      : null,
    router: {
      address: moleRouter,
      impl: routerImpl,
      upgradeAdmin: ok(routerAdminR, (v) => String(v)),
      feeDial,
      feeBps,
    },
    currencies: [currency(key.currency0, dec0R, sym0R), currency(key.currency1, dec1R, sym1R)],
    readAt: Date.now(),
  };
}

/* ----------------------------------------------------------------------------- rows */

export interface ProvenanceRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly mutability: Mutability;
  readonly note?: string;
  /** A check the row carries: true ✓, false ✗, undefined none. */
  readonly ok?: boolean;
}

const pips = (v: number | null) => (v === null ? "?" : `${(v / 10_000).toFixed(2)}%`);
const eqAddr = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Turn the chain facts into the rows the card renders. Pure, so the labelling can be tested against a
 * fixture without a network: every mutability label below is a function of what was read, and the only
 * rows allowed to say IMMUTABLE without a chain read are the five PoolKey fields and the bitmap — which
 * are immutable by construction, not by promise.
 */
export function provenanceRows(p: PoolProvenance): ProvenanceRow[] {
  const hookUp = upgradeability(p.hook.impl, p.hook.upgradeAdmin);
  const vaultUp = upgradeability(p.vault.impl, p.vault.upgradeAdmin);
  const queueUp = p.queue ? upgradeability(p.queue.impl, p.queue.upgradeAdmin) : null;
  const routerUp = upgradeability(p.router.impl, p.router.upgradeAdmin);
  const [c0, c1] = p.currencies;
  const isDynamic = (p.poolKey.fee & DYNAMIC_FEE_FLAG) !== 0;
  const feeAgrees =
    p.slot0 && p.hook.lpFeePips !== null ? p.slot0.lpFee === p.hook.lpFeePips : undefined;

  const rows: ProvenanceRow[] = [
    { key: "hook", label: "Hook", value: p.poolKey.hooks, mutability: "IMMUTABLE", note: "in the PoolId", ok: p.served ? true : undefined },
    {
      key: "bitmap",
      label: "Permission bits",
      value: `${p.bitmap.bitmapHex} · ${p.bitmap.binary}`,
      mutability: "IMMUTABLE",
      note: p.bitmap.proofLine,
      ok: p.bitmap.removeBitsClear,
    },
    {
      key: "hookCode",
      label: "Hook code",
      value: p.hook.impl && !isZero(p.hook.impl) ? `impl ${short(p.hook.impl)}` : p.hook.impl === null ? "?" : "no proxy",
      mutability: hookUp.label,
      note: hookUp.note,
    },
    { key: "poolId", label: "PoolId", value: p.poolId, mutability: "IMMUTABLE", note: "keccak256(PoolKey)" },
    {
      key: "currency0",
      label: "currency0",
      value: `${c0.symbol} · ${c0.decimals ?? "?"} dec`,
      mutability: "IMMUTABLE",
      note: c0.address,
    },
    {
      key: "currency1",
      label: "currency1",
      value: `${c1.symbol} · ${c1.decimals ?? "?"} dec`,
      mutability: "IMMUTABLE",
      note: c1.address,
    },
    { key: "tickSpacing", label: "tickSpacing", value: String(p.poolKey.tickSpacing), mutability: "IMMUTABLE" },
    {
      key: "feeMode",
      label: "Fee mode",
      value: isDynamic ? "dynamic · 0x800000" : `static · ${pips(p.poolKey.fee)}`,
      mutability: "IMMUTABLE",
      note: isDynamic ? "hook sets the fee per swap" : undefined,
    },
    {
      key: "lpFee",
      label: "LP fee (live)",
      value: p.slot0 ? pips(p.slot0.lpFee) : "?",
      // No setter — only a new implementation changes it. So it inherits the hook's own label: UPGRADEABLE
      // while the key lives, IMMUTABLE once it is burned. Never TUNABLE: nothing can move it in one tx.
      mutability: hookUp.label,
      note: `slot0 lpFee · hook.lpFeePips ${pips(p.hook.lpFeePips)}${feeAgrees === undefined ? "" : feeAgrees ? " · re-asserted per swap" : " · DIFFERS"}`,
      ok: feeAgrees,
    },
    {
      key: "hookFee",
      label: "Hook fee",
      value: pips(p.hook.hookFeePips),
      mutability: hookUp.label,
      note: p.hook.hookFeePips === 0 ? "no hook cut" : p.hook.hookFeePips === null ? "unread" : "hook takes a swap delta",
      ok: p.hook.hookFeePips === null ? undefined : p.hook.hookFeePips === 0,
    },
    {
      key: "vault",
      label: "Vault",
      value: short(p.vault.address),
      mutability: vaultUp.label,
      note: `${vaultUp.note}${p.vault.whitelisted === null ? "" : p.vault.whitelisted ? " · pool whitelisted" : " · pool NOT whitelisted"}`,
      ok: p.vault.whitelisted ?? undefined,
    },
    {
      key: "vaultPin",
      label: "Vault hook pin",
      value: p.vault.moleHook ? short(p.vault.moleHook) : "?",
      mutability: vaultUp.label,
      note: p.vault.moleHook === null ? "unread" : eqAddr(p.vault.moleHook, p.poolKey.hooks) ? "equals this pool's hook" : "differs from this pool's hook",
      ok: p.vault.moleHook === null ? undefined : eqAddr(p.vault.moleHook, p.poolKey.hooks),
    },
    {
      key: "rangeBand",
      label: "Range width band",
      value: p.vault.minRangeWidth === null || p.vault.maxRangeWidth === null ? "?" : `${p.vault.minRangeWidth}–${p.vault.maxRangeWidth} ticks`,
      mutability: "TUNABLE",
      note: "setRangeWidthBand · upgradeAdmin",
    },
    {
      key: "sizeBand",
      label: "Position size band",
      value:
        p.vault.minPositionLiquidity === null || p.vault.maxPositionLiquidity === null
          ? "?"
          : `${p.vault.minPositionLiquidity === 0n ? "off" : p.vault.minPositionLiquidity.toString()} – ${p.vault.maxPositionLiquidity === 0n ? "off" : p.vault.maxPositionLiquidity.toString()}`,
      mutability: "TUNABLE",
      note: "setPositionSizeBand · upgradeAdmin",
    },
    {
      key: "perfFee",
      label: "Performance fee",
      value: p.vault.performanceFeeBps === null ? "?" : `${(p.vault.performanceFeeBps / 100).toFixed(0)}%`,
      mutability: vaultUp.label,
      note: "of realised LP fees · no setter",
    },
    // A chain with no queue says so. It is NOT dropped from the list: a missing row reads as an
    // oversight, whereas "not deployed on this chain" is the actual fact and is worth stating.
    p.queue && queueUp
      ? {
          key: "queue",
          label: "Queue",
          value: short(p.queue.address),
          mutability: queueUp.label,
          note: `${queueUp.note}${p.queue.boundToThisPool === null ? "" : p.queue.boundToThisPool ? " · bound to this pool" : " · bound to another pool"}`,
          ok: p.queue.boundToThisPool ?? undefined,
        }
      : {
          key: "queue",
          label: "Queue",
          value: "—",
          mutability: "ABSENT" as const,
          note: "no batch queue deployed on this chain",
          ok: undefined,
        },
    {
      key: "router",
      label: "Router",
      value: short(p.router.address),
      mutability: routerUp.label,
      note: routerUp.note,
    },
    {
      key: "aggFee",
      label: "Aggregator fee",
      value: p.router.feeBps === null ? "?" : `${p.router.feeBps} bps`,
      mutability: "TUNABLE",
      note: p.router.feeDial && !isZero(p.router.feeDial) ? `dial ${short(p.router.feeDial)} · cap 100 bps` : p.router.feeDial ? "no dial" : "dial unread",
    },
  ];
  return rows;
}
