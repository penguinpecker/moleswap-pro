"use client";
/**
 * vault.ts — client for the MoleSwap ALM vault (MolePositions proxy on Robinhood Chain 4663).
 *
 * This wires the on-chain primitives that were built and tested in this repo:
 *   - positionsOf / getPosition  → read a wallet's ALM positions (exact, view-only)
 *   - withdrawAll(id)            → exit a position (the verified-safe one-arg exit; reads liquidity
 *                                   inside the call, so no stale-read race — see records.txt:545/1211)
 *   - zapOpen(z, deadline)       → single-token deposit into a bounded range around spot
 *
 * IMPORTANT: the vault REJECTS full-range positions — it enforces minRangeWidth/maxRangeWidth (live:
 * 120 / 60000 ticks), so a deposit must sit in a bounded range centred on the current tick. And the
 * ZapParams slippage bound is `amountOutMin` on the swap leg (records.txt:1354 — `minLiquidity` alone is
 * NOT protection on a one-sided zap). Both are derived from the live pool below; every write is also
 * `simulateContract`-checked against the vault before it is sent.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
} from "viem";
import { robinhoodChain } from "@/lib/chain/wagmi-config";
import { molePositionsAbi, erc20Abi } from "./abi";
import {
  MOLE_ADDRESSES,
  LIVE_POOL_KEY,
  LIVE_POOL_ID,
  WETH,
  USDG,
  ROBINHOOD_RPC_URL,
} from "./chain";

const VAULT = MOLE_ADDRESSES.molePositions;
const TICK_SPACING = 60;
// The vault refuses full-range; positions must sit in [minRangeWidth, maxRangeWidth] (live 120/60000).
// Half-width of the deposit range in ticks (full width 30000 → comfortably inside the bounds).
const RANGE_HALF_WIDTH = 15_000;
const DEFAULT_SLIPPAGE_BPS = 100; // on the zap's swap leg
const RH_HEX = "0x1237";

const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as Address;
const stateViewAbi = [
  { type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] },
] as const;

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

/**
 * Build the zapOpen argument for a single-token deposit of `amountIn` of `token`, reading the live pool
 * so the range is centred on spot within the vault's width bounds and `amountOutMin` bounds the swap.
 */
async function buildZap(pub: ReturnType<typeof almPublicClient>, token: Address, amountIn: bigint, slippageBps = DEFAULT_SLIPPAGE_BPS) {
  const isToken0 = token.toLowerCase() === (WETH.address as string).toLowerCase(); // WETH=currency0, USDG=currency1
  const slot0 = (await pub.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [LIVE_POOL_ID as `0x${string}`] })) as readonly [bigint, number, number, number];
  const sqrtPriceX96 = slot0[0];
  const tick = Number(slot0[1]);

  // Range centred on the current tick, snapped to spacing, width inside [minRangeWidth, maxRangeWidth].
  const center = Math.round(tick / TICK_SPACING) * TICK_SPACING;
  const half = Math.round(RANGE_HALF_WIDTH / TICK_SPACING) * TICK_SPACING;
  const tickLower = center - half;
  const tickUpper = center + half;

  // amountOutMin — the REAL slippage bound. Swap `swapAmount` of the input token at spot, less slippage.
  // price = (sqrtP/2^96)^2 = currency1_raw per currency0_raw (USDG_raw per WETH_raw).
  const swapAmount = amountIn / 2n;
  const Q192 = 1n << 192n;
  const priceX192 = sqrtPriceX96 * sqrtPriceX96; // USDG_raw per WETH_raw, scaled by 2^192
  const expectedOut = isToken0
    ? (swapAmount * priceX192) / Q192 // WETH -> USDG
    : (swapAmount * Q192) / priceX192; // USDG -> WETH
  const amountOutMin = (expectedOut * BigInt(10000 - slippageBps)) / 10000n;

  return {
    key: poolKeyArg(),
    tickLower,
    tickUpper,
    zeroForOne: isToken0,
    amountIn,
    swapAmount,
    minLiquidity: 1n, // must be non-zero; amountOutMin above is the real protection
    amountOutMin,
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

    // 2) simulate zapOpen (bounded range + amountOutMin from live pool), then send
    const z = await buildZap(pub, token, amountIn);
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
