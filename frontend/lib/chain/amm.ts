/**
 * MoleSwap swap engine — Robinhood Chain (4663).
 *
 * Quotes come from the MoleSwap off-chain router (exact against the chain to the wei), and execution
 * goes through MoleRouter — the immutable on-chain aggregator executor — via the connected wallet.
 *
 * Design contract for the UI:
 *   - getSwapQuote()        → { amountIn, amountOut, tokenIn, tokenOut, fee, pool, priceImpact, gas }
 *   - estimateSwapDetails() → { etaSeconds, totalGas, txCount, breakdown }
 *   - executeSwap()         → { success, txHash?, error? }, emitting onStep(idx,label,status)
 *   - approveToken()        → { success, txHash?, error? }
 *   - pools helpers         → live PancakeSwap-V3 WETH/USDG data from the indexer + on-chain reserves
 */
import { ethers } from "ethers";
import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
} from "viem";
import {
  CONTRACTS,
  TOKENS,
  POOLS,
  RH_RPC_URL,
  RH_CHAIN_ID,
  ERC20_ABI,
  POOL_ABI,
  getTokenByAddress,
  findPool,
  getSwappableTokens,
  getDisplayInfo,
  getPoolDisplayInfo,
  type TokenInfo,
  type PoolInfo,
} from "./contracts";
import { robinhoodChain } from "./wagmi-config";
import { moleRouterAbi, erc20Abi, NATIVE_SENTINEL } from "@/lib/aggregator/router";
import { quoteSwap } from "@/lib/aggregator/client";
import type { PoolRow } from "@/lib/aggregator/client";
import { createClient } from "@/lib/supabase/client";

/* ─── Re-exports (unchanged import surface) ──────────────────────────────── */
export {
  CONTRACTS,
  TOKENS,
  POOLS,
  RH_RPC_URL,
  RH_CHAIN_ID,
  getTokenByAddress,
  findPool,
  getSwappableTokens,
  getDisplayInfo,
  getPoolDisplayInfo,
  type TokenInfo,
  type PoolInfo,
};

export const AMM_ROUTER = CONTRACTS.MOLE_ROUTER;
export const AMM_FACTORY = CONTRACTS.FACTORY;
export type RhToken = TokenInfo;
export type Pool = PoolInfo;
export const RH_TOKENS = TOKENS;

const ZERO = "0x0000000000000000000000000000000000000000";
const WETH = CONTRACTS.WETH;
const RH_CHAIN_HEX = "0x1237"; // 4663
const DEFAULT_SLIPPAGE_BPS = 50;

/* ─── Types kept for the UI ─────────────────────────────────────────────── */
export interface SwapQuote {
  amountIn: string;
  amountOut: string;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  fee: number;
  pool: PoolInfo;
  priceImpact: number;
  gasEstimate: string;
}

export interface TxOptions {
  payGasWithToken?: string;
  payGasSlippageBps?: number;
  onProgress?: (p: { id: string; title: string; message: string; level: string; timestamp: string }) => void;
}

export interface AddLiquidityParams {
  token0: string; token1: string; fee?: number;
  amount0: string; amount1: string; recipient?: string; [k: string]: any;
}
export interface RemoveLiquidityParams { tokenId: number | string; [k: string]: any }
export interface LiquidityPosition {
  tokenId: string; token0: string; token1: string; fee: number;
  liquidity: string; amount0: string; amount1: string; [k: string]: any;
}

/* ─── Small helpers ─────────────────────────────────────────────────────── */
export function extractTxHash(result: any): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  for (const k of ["hash", "txHash", "transactionHash"]) {
    if (typeof result[k] === "string") return result[k];
  }
  const re = /^0x[a-fA-F0-9]{64}$/;
  for (const v of Object.values(result)) if (typeof v === "string" && re.test(v)) return v;
  return "";
}


export function getContractErrorMessage(err: any): string {
  if (!err) return "Transaction failed";
  const msg = err?.shortMessage || err?.message || String(err);
  if (/user rejected|rejected the request|denied/i.test(msg)) return "Transaction rejected in wallet";
  if (/insufficient funds/i.test(msg)) return "Insufficient balance for this swap";
  if (/InsufficientOutput/i.test(msg)) return "Price moved — increase slippage and retry";
  if (/DeadlinePassed/i.test(msg)) return "Quote expired — refresh and retry";
  return msg.slice(0, 160);
}

export function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(RH_RPC_URL, RH_CHAIN_ID);
}

/* ─── Pool registry loader (indexer → Supabase) ────────────────────────── */
let _poolRowsCache: { at: number; rows: PoolRow[] } | null = null;
export async function loadPoolRows(): Promise<PoolRow[]> {
  if (_poolRowsCache && Date.now() - _poolRowsCache.at < 30_000) return _poolRowsCache.rows;
  try {
    const sb = createClient();
    const { data } = await sb.from("mp_pools").select("*").eq("active", true);
    const rows = (data as PoolRow[]) || [];
    _poolRowsCache = { at: Date.now(), rows };
    return rows;
  } catch {
    return _poolRowsCache?.rows ?? [];
  }
}

/** Map the UI's native marker (0x0 / "" / "eth"/"native") to the aggregator's NATIVE sentinel. */
function toAggInput(addr: string | undefined | null): string {
  const a = (addr || "").toLowerCase();
  if (a === "" || a === ZERO || a === "native" || a === "eth") return NATIVE_SENTINEL;
  return addr as string;
}

function tokenMetaFor(addr: string): TokenInfo {
  return (
    getTokenByAddress(addr) || {
      address: addr,
      symbol: addr.slice(0, 6),
      name: addr,
      decimals: 18,
      sourceChain: "Robinhood Chain",
      logoURI: "",
    }
  );
}

/* ─── QUOTE ─────────────────────────────────────────────────────────────── */
export async function getSwapQuote(params: {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  fee?: number;
}): Promise<SwapQuote | null> {
  try {
    const amountIn = BigInt(params.amountIn || "0");
    if (amountIn <= 0n) return null;

    const rows = await loadPoolRows();
    if (rows.length === 0) return null;

    const q = await quoteSwap(rows, {
      tokenIn: toAggInput(params.tokenIn),
      tokenOut: toAggInput(params.tokenOut),
      amountIn,
      recipient: "0x000000000000000000000000000000000000dEaD",
      slippageBps: DEFAULT_SLIPPAGE_BPS,
      weth: WETH,
    });
    if (!q) return null;

    const pool = findPool(
      params.tokenIn === ZERO ? WETH : params.tokenIn,
      params.tokenOut === ZERO ? WETH : params.tokenOut,
    ) || POOLS[0];

    return {
      amountIn: params.amountIn,
      amountOut: q.quote.amountOut.toString(),
      tokenIn: tokenMetaFor(params.tokenIn),
      tokenOut: tokenMetaFor(params.tokenOut),
      fee: params.fee || pool?.fee || 500,
      pool,
      priceImpact: 0,
      gasEstimate: "150000",
    };
  } catch (err) {
    console.error("[MoleSwap] getSwapQuote error:", err);
    return null;
  }
}

/* ─── ESTIMATE (ETA + gas, for the exchange preview) ───────────────────── */
export async function estimateSwapDetails(params: {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  recipient: string;
}): Promise<{ etaSeconds: number; totalGas: number; txCount: number; breakdown: string[] } | null> {
  try {
    const amountIn = BigInt(params.amountIn || "0");
    if (amountIn <= 0n) return null;

    const isNativeIn = (params.tokenIn || "").toLowerCase() === ZERO || params.tokenIn === "";
    const steps: { label: string; gas: number }[] = [];

    // ERC-20 input needs a one-time approval to MoleRouter; native does not.
    if (!isNativeIn && params.recipient) {
      let needsApproval = true;
      try {
        const provider = getProvider();
        const token = new ethers.Contract(params.tokenIn, ERC20_ABI as any, provider);
        const allowance: bigint = await token.allowance(params.recipient, CONTRACTS.MOLE_ROUTER);
        needsApproval = allowance < amountIn;
      } catch { needsApproval = true; }
      if (needsApproval) steps.push({ label: "Approve token", gas: 46000 });
    }
    steps.push({ label: "Swap", gas: 180000 });

    // Robinhood Chain block time is ~1s; keep the ETA honest but small.
    const blockTime = 1.2;
    const totalGas = steps.reduce((s, x) => s + x.gas, 0);
    const etaSeconds = Math.round(steps.length * (3 + blockTime * 2));

    return {
      etaSeconds,
      totalGas,
      txCount: steps.length,
      breakdown: steps.map((s) => `${s.label}: ~${(s.gas / 1000).toFixed(0)}k gas`),
    };
  } catch (err) {
    console.error("[MoleSwap] estimateSwapDetails error:", err);
    return null;
  }
}

/* ─── wallet client plumbing (viem over the injected provider) ──────────── */
function browserEth(): any {
  if (typeof window === "undefined") return null;
  return (window as any).ethereum ?? null;
}

async function ensureChain(eth: any): Promise<void> {
  try {
    const cid = await eth.request({ method: "eth_chainId" });
    if (parseInt(cid, 16) !== RH_CHAIN_ID) {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: RH_CHAIN_HEX }] });
    }
  } catch (e: any) {
    // 4902 = chain not added; add it, then switch.
    if (e?.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: RH_CHAIN_HEX,
          chainName: "Robinhood Chain",
          rpcUrls: [RH_RPC_URL],
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
        }],
      });
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: RH_CHAIN_HEX }] });
    }
  }
}

function publicClient() {
  return createPublicClient({ chain: robinhoodChain, transport: http(RH_RPC_URL) });
}

/* ─── APPROVE ───────────────────────────────────────────────────────────── */
export async function approveToken(
  _client: any,
  token: string,
  amount?: string,
  spender: string = CONTRACTS.MOLE_ROUTER,
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const eth = browserEth();
    if (!eth) return { success: false, error: "No wallet found" };
    await ensureChain(eth);
    const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
    const [account] = await wallet.getAddresses();
    const value = amount ? BigInt(amount) : (1n << 256n) - 1n;
    const hash = await wallet.writeContract({
      address: token as `0x${string}`,
      abi: erc20Abi as any,
      functionName: "approve",
      args: [spender as `0x${string}`, value],
      account,
      chain: robinhoodChain,
    });
    await publicClient().waitForTransactionReceipt({ hash });
    return { success: true, txHash: hash };
  } catch (err) {
    return { success: false, error: getContractErrorMessage(err) };
  }
}

/* ─── EXECUTE ───────────────────────────────────────────────────────────── */
export async function executeSwap(params: {
  chainClient?: any;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOutMin?: string;
  recipient: string;
  outputRecipient?: string | null;
  fee?: number;
  originChain?: string | null;
  onStep?: (stepIdx: number, label: string, status: string) => void;
}): Promise<{ success: boolean; txHash?: string; error?: string; amountOut?: string }> {
  const onStep = params.onStep || (() => {});
  try {
    const eth = browserEth();
    if (!eth) return { success: false, error: "No wallet found" };
    await ensureChain(eth);

    const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
    const pub = publicClient();
    const [account] = await wallet.getAddresses();
    if (!account) return { success: false, error: "Wallet not connected" };

    const amountIn = BigInt(params.amountIn || "0");
    if (amountIn <= 0n) return { success: false, error: "Enter an amount" };

    const aggIn = toAggInput(params.tokenIn);
    const aggOut = toAggInput(params.tokenOut);
    const isNativeIn = aggIn.toLowerCase() === NATIVE_SENTINEL.toLowerCase();

    // Where the output tokens land: custom recipient if given, else the caller.
    const recipient =
      params.outputRecipient && /^0x[0-9a-fA-F]{40}$/.test(params.outputRecipient)
        ? params.outputRecipient
        : account;

    // Fresh quote at execution time → exact plan + honest minimum-out floor.
    onStep(0, "Swap", "pending");
    const rows = await loadPoolRows();
    const q = await quoteSwap(rows, {
      tokenIn: aggIn,
      tokenOut: aggOut,
      amountIn,
      recipient,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
      weth: WETH,
    });
    if (!q) return { success: false, error: "No route for this pair" };

    // ERC-20 input: ensure a standing allowance to MoleRouter.
    if (!isNativeIn) {
      const allowance = (await pub.readContract({
        address: aggIn as `0x${string}`,
        abi: erc20Abi as any,
        functionName: "allowance",
        args: [account, CONTRACTS.MOLE_ROUTER as `0x${string}`],
      })) as bigint;
      if (allowance < amountIn) {
        onStep(0, "Approve token", "signing");
        const ah = await wallet.writeContract({
          address: aggIn as `0x${string}`,
          abi: erc20Abi as any,
          functionName: "approve",
          args: [CONTRACTS.MOLE_ROUTER as `0x${string}`, amountIn],
          account,
          chain: robinhoodChain,
        });
        await pub.waitForTransactionReceipt({ hash: ah });
        onStep(0, "Approve token", "confirmed");
      }
    }

    onStep(0, "Swap", "signing");
    const hash = await wallet.writeContract({
      address: CONTRACTS.MOLE_ROUTER as `0x${string}`,
      abi: moleRouterAbi as any,
      functionName: "swap",
      args: [q.encoded as any],
      value: q.value,
      account,
      chain: robinhoodChain,
    });
    await pub.waitForTransactionReceipt({ hash });
    onStep(0, "Swap", "confirmed");

    return { success: true, txHash: hash, amountOut: q.quote.amountOut.toString() };
  } catch (err) {
    onStep(0, "Swap", "error");
    return { success: false, error: getContractErrorMessage(err) };
  }
}

/* ─── POOLS / LIQUIDITY (read-only display for /pools) ─────────────────── */

/** Live WETH/USDG pool rows: indexer registry + on-chain sqrtPrice/liquidity. */
export async function getAllPools(_userAddress?: string): Promise<any[]> {
  const provider = getProvider();
  const out: any[] = [];
  for (const p of POOLS) {
    let sqrtPriceX96 = "0";
    let liquidity = "0";
    let tick = 0;
    try {
      const pool = new ethers.Contract(p.address, POOL_ABI as any, provider);
      const [slot0, liq] = await Promise.all([pool.slot0(), pool.liquidity()]);
      sqrtPriceX96 = slot0[0].toString();
      tick = Number(slot0[1]);
      liquidity = liq.toString();
    } catch { /* skip a pool that fails to read */ }
    const t0 = getTokenByAddress(p.token0);
    const t1 = getTokenByAddress(p.token1);
    out.push({
      address: p.address,
      name: p.name,
      token0: p.token0,
      token1: p.token1,
      fee: p.fee,
      feePercent: p.fee / 10000,
      token0Symbol: t0?.symbol || "?",
      token1Symbol: t1?.symbol || "?",
      token0Logo: t0?.logoURI,
      token1Logo: t1?.logoURI,
      sqrtPriceX96,
      tick,
      liquidity,
      thinLiquidity: !!p.thinLiquidity,
    });
  }
  return out;
}

export async function getPairReserves(tokenA: string, tokenB: string) {
  const pool = findPool(tokenA === ZERO ? WETH : tokenA, tokenB === ZERO ? WETH : tokenB) || POOLS[0];
  try {
    const provider = getProvider();
    const c = new ethers.Contract(pool.address, POOL_ABI as any, provider);
    const [slot0, liq] = await Promise.all([c.slot0(), c.liquidity()]);
    return {
      pool: pool.address,
      sqrtPriceX96: slot0[0].toString(),
      tick: Number(slot0[1]),
      liquidity: liq.toString(),
      fee: pool.fee,
    };
  } catch {
    return { pool: pool.address, sqrtPriceX96: "0", tick: 0, liquidity: "0", fee: pool.fee };
  }
}

// The Robinhood Chain deployment is a v4 ALM (MoleHook/MolePositions); direct LP mint/burn from this
// UI is not wired yet. These keep the import surface intact and fail closed rather than sending a
// malformed transaction.
export async function getUserPositions(_userAddress: string): Promise<LiquidityPosition[]> {
  return [];
}
export async function addLiquidity(_params: AddLiquidityParams): Promise<{ txHash: string; success: boolean; error?: string }> {
  return { txHash: "", success: false, error: "Liquidity provisioning is managed by the MoleSwap ALM." };
}
export async function removeLiquidity(_params: RemoveLiquidityParams): Promise<{ txHash: string; success: boolean; error?: string }> {
  return { txHash: "", success: false, error: "Liquidity provisioning is managed by the MoleSwap ALM." };
}
export async function collectFees(_params: { tokenId: number | string; [k: string]: any }): Promise<{ txHash: string; success: boolean; error?: string }> {
  return { txHash: "", success: false, error: "Fees are auto-compounded by the MoleSwap ALM." };
}
