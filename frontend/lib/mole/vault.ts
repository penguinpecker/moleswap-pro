"use client";
/**
 * vault.ts — client for the MoleSwap ALM vault (MolePositions proxy on Robinhood Chain 4663).
 *
 * This wires the on-chain primitives that were built and tested in this repo:
 *   - positionsOf / getPosition  → read a wallet's ALM positions (exact, view-only)
 *   - withdrawAll(id)            → exit a position (the verified-safe one-arg exit; reads liquidity
 *                                   inside the call, so no stale-read race — see records.txt:545/1211)
 *   - zapOpen(z, deadline)       → single-sided full-range deposit
 *
 * IMPORTANT (records.txt:1354): `minLiquidity` is NOT a dependable slippage bound on a one-sided zap.
 * So every write is `simulateContract`-checked against the live vault before it is sent, and deposits
 * default to a full-range position (the downside-safe, keeper-free tier per the backtests).
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
} from "viem";
import { robinhoodChain } from "@/lib/pushchain/wagmi-config";
import { molePositionsAbi, erc20Abi } from "./abi";
import {
  MOLE_ADDRESSES,
  LIVE_POOL_KEY,
  WETH,
  USDG,
  ROBINHOOD_RPC_URL,
} from "./chain";

const VAULT = MOLE_ADDRESSES.molePositions;
const TICK_SPACING = 60;
// Full range aligned to the pool's tick spacing.
const FULL_LOWER = Math.ceil(-887272 / TICK_SPACING) * TICK_SPACING; // -887220
const FULL_UPPER = Math.floor(887272 / TICK_SPACING) * TICK_SPACING; //  887220
const RH_HEX = "0x1237";

export const VAULT_TOKENS = [WETH, USDG] as const;

export function almPublicClient() {
  return createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });
}

function browserEth(): any {
  if (typeof window === "undefined") return null;
  return (window as any).ethereum ?? null;
}

async function ensureChain(eth: any) {
  try {
    const cid = await eth.request({ method: "eth_chainId" });
    if (parseInt(cid, 16) !== robinhoodChain.id) {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: RH_HEX }] });
    }
  } catch {
    /* wallet will surface the error */
  }
}

export interface AlmPosition {
  id: string;
  owner: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  openedAtL1Block: bigint;
  fullRange: boolean;
}

/** Read every ALM position a wallet owns (positions with liquidity > 0). */
export async function getAlmPositions(owner: string): Promise<AlmPosition[]> {
  const pub = almPublicClient();
  const ids = (await pub.readContract({
    address: VAULT as Address,
    abi: molePositionsAbi,
    functionName: "positionsOf",
    args: [owner as Address],
  })) as bigint[];

  const out: AlmPosition[] = [];
  for (const id of ids) {
    try {
      const p = (await pub.readContract({
        address: VAULT as Address,
        abi: molePositionsAbi,
        functionName: "getPosition",
        args: [id],
      })) as any;
      const liquidity = BigInt(p.liquidity ?? 0n);
      if (liquidity === 0n) continue;
      out.push({
        id: id.toString(),
        owner: p.owner,
        poolId: p.poolId,
        tickLower: Number(p.tickLower),
        tickUpper: Number(p.tickUpper),
        liquidity,
        openedAtL1Block: BigInt(p.openedAtL1Block ?? 0n),
        fullRange: Number(p.tickLower) <= FULL_LOWER && Number(p.tickUpper) >= FULL_UPPER,
      });
    } catch {
      /* skip a position that fails to read */
    }
  }
  return out;
}

function poolKeyArg() {
  return {
    currency0: LIVE_POOL_KEY.currency0 as Address,
    currency1: LIVE_POOL_KEY.currency1 as Address,
    fee: LIVE_POOL_KEY.fee,
    tickSpacing: LIVE_POOL_KEY.tickSpacing,
    hooks: LIVE_POOL_KEY.hooks as Address,
  };
}

/** Build the zapOpen argument for a single-sided, full-range deposit of `amountIn` of `token`. */
function buildZap(token: Address, amountIn: bigint) {
  // WETH is currency0; USDG is currency1. zeroForOne = swap currency0 -> currency1.
  const isToken0 = token.toLowerCase() === (WETH.address as string).toLowerCase();
  return {
    key: poolKeyArg(),
    tickLower: FULL_LOWER,
    tickUpper: FULL_UPPER,
    zeroForOne: isToken0,
    amountIn,
    swapAmount: amountIn / 2n, // 50/50 split for a full-range position
    minLiquidity: 0n,
  };
}

export interface DepositResult { success: boolean; txHash?: string; error?: string; positionId?: string }

function deadline(): bigint {
  // 20 minutes from a server-supplied-ish clock. Date.now is fine in the browser.
  return BigInt(Math.floor(Date.now() / 1000) + 1200);
}

/**
 * Deposit `amountIn` (wei) of `token` (WETH or USDG) into the ALM as a full-range position.
 * Simulates against the live vault first; only sends if the simulation succeeds.
 */
export async function almDeposit(token: Address, amountIn: bigint): Promise<DepositResult> {
  try {
    const eth = browserEth();
    if (!eth) return { success: false, error: "No wallet found" };
    await ensureChain(eth);
    const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
    const pub = almPublicClient();
    const [account] = await wallet.getAddresses();
    if (!account) return { success: false, error: "Wallet not connected" };
    if (amountIn <= 0n) return { success: false, error: "Enter an amount" };

    // 1) allowance → vault
    const allowance = (await pub.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, VAULT as Address],
    })) as bigint;
    if (allowance < amountIn) {
      const ah = await wallet.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [VAULT as Address, amountIn],
        account,
        chain: robinhoodChain,
      });
      await pub.waitForTransactionReceipt({ hash: ah });
    }

    // 2) simulate zapOpen, then send
    const z = buildZap(token, amountIn);
    const sim = await pub.simulateContract({
      address: VAULT as Address,
      abi: molePositionsAbi,
      functionName: "zapOpen",
      args: [z as any, deadline()],
      account,
    });
    const hash = await wallet.writeContract({ ...(sim.request as any), account, chain: robinhoodChain });
    await pub.waitForTransactionReceipt({ hash });
    return { success: true, txHash: hash, positionId: sim.result?.toString() };
  } catch (err: any) {
    return { success: false, error: err?.shortMessage || err?.message?.split("\n")[0] || "Deposit failed" };
  }
}

/** Exit a position fully via the verified-safe withdrawAll(id). */
export async function almWithdraw(id: string | bigint): Promise<DepositResult> {
  try {
    const eth = browserEth();
    if (!eth) return { success: false, error: "No wallet found" };
    await ensureChain(eth);
    const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
    const pub = almPublicClient();
    const [account] = await wallet.getAddresses();
    if (!account) return { success: false, error: "Wallet not connected" };

    const sim = await pub.simulateContract({
      address: VAULT as Address,
      abi: molePositionsAbi,
      functionName: "withdrawAll",
      args: [BigInt(id)],
      account,
    });
    const hash = await wallet.writeContract({ ...(sim.request as any), account, chain: robinhoodChain });
    await pub.waitForTransactionReceipt({ hash });
    return { success: true, txHash: hash };
  } catch (err: any) {
    return { success: false, error: err?.shortMessage || err?.message?.split("\n")[0] || "Withdraw failed" };
  }
}
