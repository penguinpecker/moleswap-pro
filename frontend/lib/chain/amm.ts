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
import { getAggFeeBps } from "@/lib/mole/aggFee";
import { createClient } from "@/lib/supabase/client";
// The registry query itself lives beside the API routes' loader so the browser and server copies cannot
// drift apart again — the last fix landed on the server twin only, which is what left this file broken.
import {
  fetchPoolRowsByPair,
  fetchPoolRowsWindow,
  poolPairTokens,
  type PoolPair,
} from "@/lib/aggregator/serverPools";
import {
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  getSlippageBps,
} from "@/lib/settings/swapSettings";
// One-sided ("deposit one token") liquidity for the live WETH/USDG v4 pool. ALL range/liquidity
// math lives in lib/mole/singleSided — this file only wires wallet plumbing around it.
import { molePositionsAbi } from "@/lib/mole/abi";
import { MOLE_ADDRESSES, LIVE_POOL_KEY, LIVE_POOL_ID } from "@/lib/mole/chain";
import {
  computeOneSidedRange,
  liquidityForOneSidedAmount,
  buildOneSidedOpenArgs,
  assertStrictlyOneSided,
  loadPoolTickState,
  type OneSidedSide,
  type OneSidedPreset,
} from "@/lib/mole/singleSided";

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
/** The tolerance used when the user has not chosen one (Max Slippage = AUTO). */
export { DEFAULT_SLIPPAGE_BPS };

export const AMM_ROUTER = CONTRACTS.MOLE_ROUTER;
export const AMM_FACTORY = CONTRACTS.FACTORY;
export type RhToken = TokenInfo;
export type Pool = PoolInfo;
export const RH_TOKENS = TOKENS;

const ZERO = "0x0000000000000000000000000000000000000000";
const WETH = CONTRACTS.WETH;
const RH_CHAIN_HEX = "0x1237"; // 4663

/**
 * The slippage tolerance to quote and sign with, in bps.
 *
 * An explicit argument wins (callers that already know the user's choice, e.g. a screen holding the
 * live quote). Otherwise the user's persisted Max Slippage from the Settings panel is read here —
 * executeSwap runs outside the render tree, so it cannot take the value from a hook. When nothing is
 * stored, that resolves to DEFAULT_SLIPPAGE_BPS, which is exactly the 50 bps this file used before,
 * so behaviour for a user who never opened the panel is unchanged.
 */
function resolveSlippageBps(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.min(MAX_SLIPPAGE_BPS, Math.max(MIN_SLIPPAGE_BPS, Math.round(explicit)));
  }
  return getSlippageBps();
}

/* ─── Types kept for the UI ─────────────────────────────────────────────── */
export interface SwapQuote {
  amountIn: string;
  amountOut: string;
  /** Pre-fee output and the fee taken from it — carried so the review screen can show a breakdown. */
  grossAmountOut?: string;
  minAmountOut?: string;
  feeBps?: number;
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

/**
 * Load the `mp_pools` rows a quote needs.
 *
 * WHAT WAS WRONG. This used to be `select("*").eq("active", true)` with `error` destructured away.
 * PostgREST caps an unranged select at 1000 rows and the registry now holds ~94k active pools, so the
 * browser priced every swap against an arbitrary ~1% slice — while `/api/v1/quote` used a paged loader,
 * which is why the UI and the public API could disagree about the same pair. On a Supabase error the
 * destructured-away `error` left `rows` empty and that empty array was cached as authoritative for 30s;
 * the `catch` below never ran for it, because supabase-js RETURNS errors rather than throwing them.
 *
 * v4 is the part that truncation actually breaks. A v4 pool has no address, so `discoverForPair` — which
 * asks factories for pool addresses — can never find one; v3 has that on-chain probe as a safety net and
 * v4 has nothing. v4 is also ~85% of the registry.
 *
 * WHAT IT DOES NOW. Given a pair it asks the database for exactly the pools that can carry that route
 * (direct + WETH hub legs + USDG legs), complete and unpaginated-away, sharing one implementation with
 * the server twin so the two can never drift again. That is both correct AND faster than the truncated
 * select it replaces (~40-90 rows, ~150-600ms).
 *
 * Called with no pair it keeps today's single 1000-row window — see the warning it logs. That is a
 * compatibility path for callers that have not been given a pair yet, not a supported way to quote.
 */
interface PoolRowsCacheEntry {
  at: number;
  rows: PoolRow[];
  /** False = a known-truncated window. Recorded so the truncation is legible rather than implied. */
  complete: boolean;
}
let _poolRowsCache: PoolRowsCacheEntry | null = null;
const _pairRowsCache = new Map<string, PoolRowsCacheEntry>();
const POOL_ROWS_CACHE_MS = 30_000;
/** Same cap PostgREST applies to an unranged select — i.e. exactly what this loader fetched before. */
const PAIRLESS_WINDOW_ROWS = 1000;

export async function loadPoolRows(pair?: PoolPair): Promise<PoolRow[]> {
  const key = pair ? poolPairTokens(pair).slice().sort().join("|") : null;
  const hit = key ? _pairRowsCache.get(key) : _poolRowsCache;
  const now = Date.now();
  if (hit && now - hit.at < POOL_ROWS_CACHE_MS) return hit.rows;

  try {
    const sb = createClient();
    if (pair && key) {
      try {
        const rows = await fetchPoolRowsByPair(sb, pair);
        _pairRowsCache.set(key, { at: now, rows, complete: true });
        return rows;
      } catch (pairErr) {
        // The pair query is the correct one, but it runs against the `anon` role's 3s statement_timeout
        // and a cold miss (after its own retry) must not take the swap card down with it: throwing here
        // aborts the session init, and the card then renders "No route with live liquidity for this
        // pair", which is a statement about the market that we have no evidence for. Degrade to the
        // bounded window instead — the same answer this loader gave before pair scoping existed — and
        // say, loudly, that this quote is built on a truncated registry.
        console.error(
          `[MoleSwap] pair-scoped registry read failed for ${pair.tokenIn} -> ${pair.tokenOut}; falling back to the first ${PAIRLESS_WINDOW_ROWS} rows, which may not contain this pair's pools:`,
          pairErr instanceof Error ? `${pairErr.name}: ${pairErr.message}` : pairErr,
        );
      }
    }
    const win = await fetchPoolRowsWindow(sb, PAIRLESS_WINDOW_ROWS);
    if (!win.complete) {
      console.warn(
        `[MoleSwap] loadPoolRows() was called without a pair, so it can only read the first ${PAIRLESS_WINDOW_ROWS} of ~94k active pools${
          win.error ? ` (${win.error})` : ""
        }. Pools outside that slice — in particular every v4 pool, which on-chain discovery cannot find — are missing from this quote. Pass { tokenIn, tokenOut, weth } to load the complete set for the route.`,
      );
      // Served and cached as today, but recorded AS truncated and warned about, instead of passing
      // itself off as the whole registry.
      _poolRowsCache = { at: now, rows: win.rows, complete: false };
      return win.rows;
    }
    _poolRowsCache = { at: now, rows: win.rows, complete: true };
    return win.rows;
  } catch (err) {
    console.error(
      `[MoleSwap] pool registry read failed${pair ? ` for ${pair.tokenIn} -> ${pair.tokenOut}` : ""}:`,
      err instanceof Error ? `${err.name}: ${err.message}` : err,
    );
    // Last known-good answer beats a silently empty registry; if there is none, the caller must be told
    // the registry did not answer rather than shown "no route for this pair".
    if (hit) return hit.rows;
    throw err;
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
  /** Tolerated shortfall in bps. Omitted → the user's persisted Max Slippage (AUTO → 50 bps). */
  slippageBps?: number;
}): Promise<SwapQuote | null> {
  try {
    const amountIn = BigInt(params.amountIn || "0");
    if (amountIn <= 0n) return null;

    // Ask the registry for this pair's pools specifically — the whole table is ~94k rows and a
    // truncated read silently deletes venues (v4 above all, which has no on-chain discovery fallback).
    const rows = await loadPoolRows({
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      weth: WETH,
    });
    if (rows.length === 0) return null;

    const q = await quoteSwap(rows, {
      tokenIn: toAggInput(params.tokenIn),
      tokenOut: toAggInput(params.tokenOut),
      amountIn,
      recipient: "0x000000000000000000000000000000000000dEaD",
      slippageBps: resolveSlippageBps(params.slippageBps),
      feeBps: await getAggFeeBps(Date.now()),
      weth: WETH,
    });
    if (!q) return null;

    const pool = findPool(
      params.tokenIn === ZERO ? WETH : params.tokenIn,
      params.tokenOut === ZERO ? WETH : params.tokenOut,
    ) || POOLS[0];

    return {
      amountIn: params.amountIn,
      // The aggregator fee is taken from the INPUT, so the route's whole output reaches the recipient and
      // netAmountOut == amountOut. Both are kept (equal) so consumers reading either stay correct.
      amountOut: q.quote.netAmountOut.toString(),
      grossAmountOut: q.quote.amountOut.toString(),
      minAmountOut: q.quote.minAmountOut.toString(),
      feeBps: q.quote.feeBps,
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
    const rcpt = await publicClient().waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") return { success: false, txHash: hash, error: "Approval reverted on-chain" };
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
  /** Tolerated shortfall in bps for the signing-time re-quote. Omitted → the user's Max Slippage. */
  slippageBps?: number;
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

    // Fresh quote at execution time → exact plan + honest minimum-out floor. The fee is re-read live here
    // too, so minAmountOut is built on the post-fee output at the instant of execution.
    onStep(0, "Swap", "pending");
    // Pair-scoped, same as the display quote — the route that executes must be built from the same
    // registry rows the price was shown from, not a different arbitrary slice of the table.
    const rows = await loadPoolRows({ tokenIn: params.tokenIn, tokenOut: params.tokenOut, weth: WETH });
    const feeBps = await getAggFeeBps(Date.now());
    const q = await quoteSwap(rows, {
      tokenIn: aggIn,
      tokenOut: aggOut,
      amountIn,
      recipient,
      slippageBps: resolveSlippageBps(params.slippageBps),
      feeBps,
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

    // Simulate against live state first — catches an obvious revert (e.g. price already moved past
    // minOut) BEFORE the user signs and pays gas, and surfaces the exact reason.
    onStep(0, "Swap", "signing");
    try {
      await pub.simulateContract({
        address: CONTRACTS.MOLE_ROUTER as `0x${string}`,
        abi: moleRouterAbi as any,
        functionName: "swap",
        args: [q.encoded as any],
        value: q.value,
        account,
      });
    } catch (simErr) {
      onStep(0, "Swap", "error");
      return { success: false, error: getContractErrorMessage(simErr) };
    }

    const hash = await wallet.writeContract({
      address: CONTRACTS.MOLE_ROUTER as `0x${string}`,
      abi: moleRouterAbi as any,
      functionName: "swap",
      args: [q.encoded as any],
      value: q.value,
      account,
      chain: robinhoodChain,
    });
    // CRITICAL: waitForTransactionReceipt does NOT throw on a reverted tx — it returns status
    // "reverted". Without this check the UI reported "SWAP COMPLETED" for a failed swap.
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      onStep(0, "Swap", "error");
      return { success: false, txHash: hash, error: "Swap reverted on-chain — the price moved past your minimum. Try again or raise slippage." };
    }
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

/**
 * addLiquidityOneSided — deposit ONE token into the live WETH/USDG v4 pool via MolePositions.open,
 * with the whole range placed strictly beyond the current tick (side "token0" = WETH, range ABOVE
 * spot; side "token1" = USDG, range BELOW spot — Uniswap v4 semantics). The other side's amountMax
 * is 0, so if the price moved into the range the open REVERTS instead of quietly pulling both
 * tokens. Range construction, liquidity sizing and the open() argument tuple all come from
 * lib/mole/singleSided; nothing is re-derived here.
 *
 * Sits BESIDE addLiquidity (the fail-closed two-sided stub), which is deliberately untouched.
 */
export async function addLiquidityOneSided(params: {
  chainClient?: any;
  /** The token the user deposits: "token0" (WETH → range above spot) or "token1" (USDG → below). */
  side: OneSidedSide;
  /** Deposit amount as a WEI STRING of the chosen token — a JS number cannot hold wei exactly. */
  amount: string;
  /** "launch" (widest legal width, 60000 ticks), "tight" (~300 ticks), or { widthTicks }. */
  preset?: OneSidedPreset;
  /** Unix seconds; default now + 30 min. */
  deadline?: number;
  onStep?: (stepIdx: number, label: string, status: string) => void;
}): Promise<{ success: boolean; txHash?: string; error?: string; tickLower?: number; tickUpper?: number }> {
  const onStep = params.onStep || (() => {});
  try {
    const eth = browserEth();
    if (!eth) return { success: false, error: "No wallet found" };
    await ensureChain(eth);

    const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
    const pub = publicClient();
    const [account] = await wallet.getAddresses();
    if (!account) return { success: false, error: "Wallet not connected" };

    const amount = BigInt(params.amount || "0");
    if (amount <= 0n) return { success: false, error: "Enter an amount" };
    const side = params.side;
    const token = (side === "token0" ? LIVE_POOL_KEY.currency0 : LIVE_POOL_KEY.currency1) as `0x${string}`;

    // Quote-time state: live tick → range strictly beyond spot → liquidity from the single amount.
    const { currentTick } = await loadPoolTickState(LIVE_POOL_ID);
    const range = computeOneSidedRange({
      side,
      currentTick,
      tickSpacing: LIVE_POOL_KEY.tickSpacing,
      preset: params.preset ?? "launch",
    });
    const liquidity = liquidityForOneSidedAmount({
      side,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      amount,
    });
    const deadline = BigInt(params.deadline ?? Math.floor(Date.now() / 1000) + 1800);
    const args = buildOneSidedOpenArgs({ key: LIVE_POOL_KEY, side, range, liquidity, amount, deadline });
    // The ON side's cap (amount + 1 wei of round-up headroom); the OFF side's cap is 0 by construction.
    const onSideMax = side === "token0" ? args[4] : args[5];

    // Approve exactly what open() may pull, and only if the standing allowance is short.
    const allowance = (await pub.readContract({
      address: token,
      abi: erc20Abi as any,
      functionName: "allowance",
      args: [account, MOLE_ADDRESSES.molePositions],
    })) as bigint;
    if (allowance < onSideMax) {
      onStep(0, "Approve token", "signing");
      const ah = await wallet.writeContract({
        address: token,
        abi: erc20Abi as any,
        functionName: "approve",
        args: [MOLE_ADDRESSES.molePositions, onSideMax],
        account,
        chain: robinhoodChain,
      });
      const arcpt = await pub.waitForTransactionReceipt({ hash: ah });
      if (arcpt.status !== "success") return { success: false, txHash: ah, error: "Approval reverted on-chain" };
      onStep(0, "Approve token", "confirmed");
    }

    // THE SNAP RULE, re-checked with a FRESH tick right before the send: a price move between quote
    // and signature must not silently turn this into a two-sided deposit. (Even if this race were
    // lost, the 0 off-side cap makes the open revert rather than pull the other token.)
    onStep(1, "Open position", "signing");
    const fresh = await loadPoolTickState(LIVE_POOL_ID);
    try {
      assertStrictlyOneSided(side, fresh.currentTick, range);
    } catch {
      onStep(1, "Open position", "error");
      return {
        success: false,
        error: "Price moved into your range before the deposit was sent — refresh and try again.",
      };
    }

    // Simulate against live state so an obvious revert surfaces BEFORE the user signs and pays gas.
    try {
      await pub.simulateContract({
        address: MOLE_ADDRESSES.molePositions,
        abi: molePositionsAbi as any,
        functionName: "open",
        args: args as any,
        account,
      });
    } catch (simErr) {
      onStep(1, "Open position", "error");
      return { success: false, error: getContractErrorMessage(simErr) };
    }

    const hash = await wallet.writeContract({
      address: MOLE_ADDRESSES.molePositions,
      abi: molePositionsAbi as any,
      functionName: "open",
      args: args as any,
      account,
      chain: robinhoodChain,
    });
    // waitForTransactionReceipt does NOT throw on a reverted tx — check status explicitly.
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      onStep(1, "Open position", "error");
      return {
        success: false,
        txHash: hash,
        error: "Deposit reverted on-chain — the price may have moved into your range. Try again.",
      };
    }
    onStep(1, "Open position", "confirmed");
    return { success: true, txHash: hash, tickLower: range.tickLower, tickUpper: range.tickUpper };
  } catch (err) {
    onStep(1, "Open position", "error");
    return { success: false, error: getContractErrorMessage(err) };
  }
}
export async function removeLiquidity(_params: RemoveLiquidityParams): Promise<{ txHash: string; success: boolean; error?: string }> {
  return { txHash: "", success: false, error: "Liquidity provisioning is managed by the MoleSwap ALM." };
}
export async function collectFees(_params: { tokenId: number | string; [k: string]: any }): Promise<{ txHash: string; success: boolean; error?: string }> {
  return { txHash: "", success: false, error: "Fees are auto-compounded by the MoleSwap ALM." };
}
