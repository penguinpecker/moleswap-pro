"use client";
/**
 * createPool.ts — operator flow for minting a NEW Uniswap-v4 pool bound to MoleHook and admitting it to
 * the ALM vault. This is the SAME two-step the on-chain script (script/CreateMolePool.s.sol) performs:
 *
 *   1. PoolManager.initialize(key, sqrtPriceX96)   — creates the pool. MoleHook.beforeInitialize reverts
 *      unless the CALLER is `poolCreator` and the fee is the dynamic-fee sentinel, so the connected wallet
 *      MUST be the poolCreator (deployer) key. v4 has no factory and needs no position manager — the pool
 *      IS the key, initialised in the singleton.
 *   2. MolePositions.whitelistPool(key)            — admits it to the vault (permissionless, but the pool's
 *      hook must be MoleHook). After this, the existing vault zap deposits into it.
 *
 * Registering the pool in the aggregator's mp_pools registry (so swaps route to it) is a separate,
 * secret-gated server step — see /api/admin/register-pool.
 */
import {
  createPublicClient, createWalletClient, custom, http, type Address,
} from "viem";
import { robinhoodChain } from "@/lib/chain/wagmi-config";
import { MOLE_ADDRESSES, DYNAMIC_FEE_FLAG, ROBINHOOD_RPC_URL } from "./chain";
import { poolIdOf, type V4PoolKey } from "./poolId";

export { poolIdOf };
export type PoolKeyInput = V4PoolKey;

// The poolCreator / deployer key — the ONLY address the hook lets initialise a pool. Lower-cased for
// comparison. (keeper / feeRecipient / poolCreator / upgradeAdmin are all this one key today.)
export const POOL_CREATOR = "0xe4563270a72a9418f97dbb631e1696edcc8bc8c8";

const poolManagerAbi = [
  {
    type: "function", name: "initialize", stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "tuple", components: [
        { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
      ] },
      { name: "sqrtPriceX96", type: "uint160" },
    ],
    outputs: [{ name: "tick", type: "int24" }],
  },
] as const;

const whitelistAbi = [
  {
    type: "function", name: "whitelistPool", stateMutability: "nonpayable",
    inputs: [{ name: "key", type: "tuple", components: [
      { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
    ] }],
    outputs: [],
  },
  { type: "function", name: "isWhitelisted", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;

/**
 * sqrtPriceX96 for an initial price of `price` currency1 per currency0 (human units).
 * rawPrice = price * 10^dec1 / 10^dec0 ; sqrtPriceX96 = floor(sqrt(rawPrice) * 2^96).
 * Verified against the live WETH/USDG pool: price 1845, dec0 18, dec1 6 -> 3403123962154247711138459.
 */
export function priceToSqrtPriceX96(price: number, dec0: number, dec1: number): bigint {
  if (!(price > 0)) throw new Error("price must be > 0");
  const adjusted = price * 10 ** (dec1 - dec0);
  const sqrtP = Math.sqrt(adjusted);
  const x = BigInt(Math.floor(sqrtP * 2 ** 96));
  // v4 bounds: MIN_SQRT_PRICE 4295128739 .. MAX_SQRT_PRICE 1461446703485210103287273052203988822378723970342
  if (x < 4295128739n || x > 1461446703485210103287273052203988822378723970342n) {
    throw new Error("Resulting sqrtPriceX96 is out of the valid v4 range — check the price and decimals");
  }
  return x;
}

/** Sort two currencies into (currency0, currency1) with their decimals following. address(0)=native sorts lowest. */
export function orderCurrencies(a: Address, aDec: number, b: Address, bDec: number) {
  const swap = a.toLowerCase() > b.toLowerCase();
  return swap
    ? { currency0: b, dec0: bDec, currency1: a, dec1: aDec, swapped: true }
    : { currency0: a, dec0: aDec, currency1: b, dec1: bDec, swapped: false };
}

export interface CreatePoolResult { success: boolean; poolId?: string; txInit?: string; txWhitelist?: string; error?: string; key?: PoolKeyInput }

/**
 * Create + whitelist a MoleHook pool for currency0/currency1 (already sorted) at `sqrtPriceX96`.
 * The connected wallet MUST be POOL_CREATOR or initialize reverts (NotPoolCreator).
 */
export async function createMolePool(params: {
  currency0: Address; currency1: Address; tickSpacing: number; sqrtPriceX96: bigint;
}): Promise<CreatePoolResult> {
  try {
    if (typeof window === "undefined" || !(window as any).ethereum) return { success: false, error: "No wallet found" };
    const eth = (window as any).ethereum;
    const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
    const pub = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });
    const [account] = await wallet.getAddresses();
    if (!account) return { success: false, error: "Wallet not connected" };
    if (account.toLowerCase() !== POOL_CREATOR) {
      return { success: false, error: `Only the poolCreator key (${POOL_CREATOR.slice(0, 10)}…) can create a pool. Connect that wallet.` };
    }

    const key: PoolKeyInput = {
      currency0: params.currency0,
      currency1: params.currency1,
      fee: DYNAMIC_FEE_FLAG,
      tickSpacing: params.tickSpacing,
      hooks: MOLE_ADDRESSES.moleHook as Address,
    };
    const id = poolIdOf(key);

    // 1) initialize — simulate first so a NotPoolCreator/AlreadyInitialized reverts cleanly before signing.
    const sim = await pub.simulateContract({
      address: MOLE_ADDRESSES.poolManager as Address,
      abi: poolManagerAbi, functionName: "initialize",
      args: [key as any, params.sqrtPriceX96], account,
    });
    const txInit = await wallet.writeContract({ ...(sim.request as any), account, chain: robinhoodChain });
    const r1 = await pub.waitForTransactionReceipt({ hash: txInit });
    if (r1.status !== "success") return { success: false, txInit, error: "initialize reverted on-chain", key };

    // 2) whitelistPool in the vault.
    const sim2 = await pub.simulateContract({
      address: MOLE_ADDRESSES.molePositions as Address,
      abi: whitelistAbi, functionName: "whitelistPool",
      args: [key as any], account,
    });
    const txWhitelist = await wallet.writeContract({ ...(sim2.request as any), account, chain: robinhoodChain });
    const r2 = await pub.waitForTransactionReceipt({ hash: txWhitelist });
    if (r2.status !== "success") return { success: false, poolId: id, txInit, txWhitelist, error: "whitelistPool reverted on-chain", key };

    return { success: true, poolId: id, txInit, txWhitelist, key };
  } catch (err: any) {
    return { success: false, error: err?.shortMessage || err?.message?.split("\n")[0] || "Create pool failed" };
  }
}
