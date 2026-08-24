"use client";
/**
 * poolsSurface.ts — the /pools screen's answers about the chain the wallet is ACTUALLY on.
 *
 * WHY THIS FILE EXISTS. `screens/pools/index.tsx` was written when MoleSwap ran one chain, so it asked
 * for one chain's pools, read one chain's RPC, and called `lib/mole/vault`'s `getAlmPositions(address)`
 * and `almWithdraw(id)` with NO chain at all. A wallet on Arc was therefore shown ROBINHOOD's positions,
 * under a header that said Arc. The WRITES already re-read `eth_chainId` and refuse on a mismatch (see
 * `walletChainMismatch` in vault.ts), so today's failure is a wrong LIST rather than a mis-sent
 * transaction — which is not a distinction to lean on. A wrong list is how somebody comes to try to exit
 * a position that is not there, and having been refused, learns to distrust what the page says about the
 * position that is.
 *
 * NOTHING HERE RE-DECLARES AN ADDRESS, AN RPC OR A POOL. Chains and their RPCs come from
 * `lib/chain/chains`; availability comes from the same `AVAILABILITY` table `/api/v1/pools` refuses on,
 * so a product turned off in one place cannot stay on in the other; the per-chain ALM pool comes from
 * `lib/mole/vaultChain`, the resolver the vault screen already uses. This module only joins them, which
 * is why it can be read in one sitting and why a corrected address upstream cannot leave a stale twin here.
 *
 * THE ONE THING IT REFUSES TO DO IS GUESS. Every lookup below returns `null` rather than falling back to
 * Robinhood: an unknown chain has no provider, and an unrecognised PoolId has no token pair. A page that
 * prints "WETH/USDG" over a position that is really CASHCAT/WETH — which is exactly what the positions
 * tab did, because it labelled every position with the first pool in the Robinhood registry — is worse
 * than one that prints the PoolId and admits it does not know the pair.
 */
import { ethers } from "ethers";
import {
  RH_CHAIN,
  chainMetaFor,
  chainsWith,
  isAvailable,
  type ChainMeta,
} from "@/lib/chain/chains";
import { vaultChainFor } from "./vaultChain";
import type { Hex } from "./chain";
// The v4 StateView, at the SAME address on Robinhood and on Arc. Imported rather than restated: it is
// pinned once in priceAnchor.ts with the evidence for why one address answers for both chains.
import { STATE_VIEW } from "./priceAnchor";

/** The chain the page speaks for when the wallet has not said. Robinhood, as everywhere else. */
export const DEFAULT_POOLS_CHAIN_ID = RH_CHAIN.id;

/* ────────────────────────────────── the chain ────────────────────────────────── */

export interface PoolsChainView {
  chainId: number;
  meta: ChainMeta | undefined;
  /** What the page prints. Never another chain's name standing in for an unknown network. */
  name: string;
  /** Whether LP pools are live here at all. `false` is what the switch affordance is rendered from. */
  live: boolean;
  explorerUrl: string | null;
  /** The chains pools ARE live on, in switcher order — this wires the "switch to X" buttons. */
  alternatives: ChainMeta[];
}

/**
 * Resolve the chain the pools surface is about.
 *
 * `live: false` is the whole point: it is what lets the page say "pools are not live here, switch to X"
 * instead of rendering a list of another chain's pools with this chain's name at the top.
 */
export function poolsChainView(chainId: number | undefined): PoolsChainView {
  const id = Number.isInteger(chainId) ? (chainId as number) : DEFAULT_POOLS_CHAIN_ID;
  const meta = chainMetaFor(id);
  return {
    chainId: id,
    meta,
    name: meta?.name ?? `chain ${id}`,
    live: meta !== undefined && isAvailable("pools", id),
    explorerUrl: meta?.explorerUrl ?? null,
    alternatives: chainsWith("pools"),
  };
}

/* ───────────────────────────────── the provider ──────────────────────────────── */

/** One provider per chain, kept so a tab switch does not open a new socket per render. */
const providers = new Map<number, ethers.JsonRpcProvider>();

/**
 * A read-only provider for `chainId`, or `null` where we have no deployment.
 *
 * `null` matters. The alternative — the Robinhood provider this page used everywhere — reads Robinhood
 * balances and Robinhood pool state and prints them beside Arc token symbols, which is a confident lie
 * rather than a missing number.
 */
export function poolsProvider(chainId: number | undefined): ethers.JsonRpcProvider | null {
  const meta = chainMetaFor(Number.isInteger(chainId) ? (chainId as number) : DEFAULT_POOLS_CHAIN_ID);
  if (!meta) return null;
  let p = providers.get(meta.id);
  if (!p) {
    p = new ethers.JsonRpcProvider(meta.rpcUrl, meta.id);
    providers.set(meta.id, p);
  }
  return p;
}

const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
];
const V3_POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

/**
 * Live slot0 for either flavour of pool, ON `chainId`, keyed on the shape of the identity given:
 *   - 32-byte PoolId  → v4: there is no per-pool contract, so StateView is read by id
 *   - 20-byte address → v3: the pool contract has its own slot0()
 *
 * Returns `null` on any failure, including "this chain has no deployment", so a caller keeps whatever
 * value it already had instead of collapsing the page to zeros.
 */
export async function readSlot0(
  chainId: number | undefined,
  id: string,
): Promise<{ sqrtPriceX96: bigint; tick: number } | null> {
  const provider = poolsProvider(chainId);
  if (!provider) return null;
  try {
    if (/^0x[0-9a-fA-F]{64}$/.test(id)) {
      const sv = new ethers.Contract(STATE_VIEW, STATE_VIEW_ABI, provider);
      const s = await sv.getSlot0(id);
      return { sqrtPriceX96: BigInt(s[0]), tick: Number(s[1]) };
    }
    if (ethers.isAddress(id)) {
      const c = new ethers.Contract(id, V3_POOL_ABI, provider);
      const s = await c.slot0();
      return { sqrtPriceX96: BigInt(s[0]), tick: Number(s[1]) };
    }
  } catch (err) {
    console.error(`readSlot0(${chainId}, ${id}) failed:`, err);
  }
  return null;
}

/* ──────────────────────────── a position's own pool ──────────────────────────── */

export interface PoolPairToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
}

/** One pool, as much of it as the positions tab needs to label and value a position honestly. */
export interface PoolPair {
  poolId: string;
  token0: PoolPairToken;
  token1: PoolPairToken;
  fee: number;
  tickSpacing: number | null;
  /** The pool's current tick, or `null` when it is not known yet — never 0 as a stand-in. */
  tick: number | null;
}

/** A pool as the page already has it from `/api/v1/pools?chainId=…`. */
export interface ListedPool {
  /** The v4 PoolId, or the address for an address-identified pool. */
  poolId: string;
  token0: PoolPairToken;
  token1: PoolPairToken;
  fee: number;
  tickSpacing: number | null;
  tick: number;
}

/**
 * Which pool a position lives in, on `chainId` — its two tokens WITH THEIR OWN DECIMALS, its fee and
 * its current tick.
 *
 * Order of truth: the chain's own listed pools first (they came from `/api/v1/pools?chainId=`, read from
 * that chain's PoolManager), then the chain's ALM pool from `vaultChainFor` so a position in the vault's
 * own pool is still labelled when the pool list failed to load, then `null`.
 *
 * DECIMALS ARE THE REASON THIS EXISTS AND NOT A SYMBOL LOOKUP. The two chains put their six-decimal leg
 * on opposite sides (currency1 on Robinhood, currency0 on Arc), so a pair guessed from a registry rather
 * than matched by PoolId is wrong by twelve orders of magnitude on one of them — and it is the amounts a
 * user reads before deciding to exit.
 */
export function pairForPoolId(
  poolId: string | null | undefined,
  listed: readonly ListedPool[],
  chainId: number | undefined,
): PoolPair | null {
  if (!poolId) return null;
  const needle = poolId.toLowerCase();

  const hit = listed.find((p) => String(p.poolId).toLowerCase() === needle);
  if (hit) {
    return {
      poolId: hit.poolId,
      token0: hit.token0,
      token1: hit.token1,
      fee: hit.fee,
      tickSpacing: hit.tickSpacing,
      tick: Number.isFinite(hit.tick) ? hit.tick : null,
    };
  }

  const cfg = vaultChainFor(Number.isInteger(chainId) ? (chainId as number) : DEFAULT_POOLS_CHAIN_ID);
  if (cfg && cfg.poolId.toLowerCase() === needle) {
    return {
      poolId: cfg.poolId,
      token0: { ...cfg.token0 },
      token1: { ...cfg.token1 },
      fee: cfg.poolKey.fee,
      tickSpacing: cfg.tickSpacing,
      tick: null,
    };
  }

  return null;
}

/**
 * The one pool THIS chain's ALM vault manages — its PoolId and how to name it in prose — or `null`
 * where no vault is deployed.
 *
 * The id is what "is this the vault's pool" is decided from, because a PoolId IS the pool's identity;
 * the label exists so a sentence about the vault can name the pair the vault really runs instead of the
 * Robinhood pair that used to be hard-coded into the copy.
 */
export function vaultPoolFor(chainId: number | undefined): { poolId: Hex; label: string } | null {
  const cfg = vaultChainFor(Number.isInteger(chainId) ? (chainId as number) : DEFAULT_POOLS_CHAIN_ID);
  return cfg ? { poolId: cfg.poolId, label: `${cfg.token0.symbol}/${cfg.token1.symbol}` } : null;
}
