import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import {
  CONTRACTS, RH_RPC_URL, RH_CHAIN_ID,
  POSITION_MANAGER_ABI, LIQUIDITY_PROXY_ABI,
  TICK_SPACINGS, MIN_TICK, MAX_TICK,
  getTokenByAddress, findPool,
} from "@/lib/chain/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function nearestUsableTick(tick: number, tickSpacing: number): number {
  const rounded = Math.round(tick / tickSpacing) * tickSpacing;
  if (rounded < MIN_TICK) return MIN_TICK + tickSpacing;
  if (rounded > MAX_TICK) return MAX_TICK - tickSpacing;
  return rounded;
}

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function POST(req: NextRequest) {
  const blocked = withRateLimit(req, "write");
  if (blocked) return blocked;

  try {
    const body = await req.json();
    const {
      token0,
      token1,
      fee = 500,
      amount0Desired,
      amount1Desired,
      recipient,
      tickLower,
      tickUpper,
      slippageBps = 50,
      deadline,
    } = body;

    if (!token0 || !token1 || !amount0Desired || !amount1Desired || !recipient) {
      return apiError(
        "Missing required fields: token0, token1, amount0Desired (wei), amount1Desired (wei), recipient",
        400
      );
    }

    if (!ethers.isAddress(recipient)) {
      return apiError("Invalid recipient address", 400);
    }

    const actual0 = token0 === ethers.ZeroAddress ? CONTRACTS.WETH : token0;
    const actual1 = token1 === ethers.ZeroAddress ? CONTRACTS.WETH : token1;

    const [sorted0, sorted1] =
      actual0.toLowerCase() < actual1.toLowerCase()
        ? [actual0, actual1]
        : [actual1, actual0];

    const isReversed = sorted0.toLowerCase() !== actual0.toLowerCase();
    const amt0 = BigInt(isReversed ? amount1Desired : amount0Desired);
    const amt1 = BigInt(isReversed ? amount0Desired : amount1Desired);

    const spacing = TICK_SPACINGS[fee] || 10;
    const tLower = tickLower != null ? tickLower : nearestUsableTick(MIN_TICK, spacing);
    const tUpper = tickUpper != null ? tickUpper : nearestUsableTick(MAX_TICK, spacing);

    // amount0Min / amount1Min are min AMOUNTS CONSUMED by the pool, not
    // "slippage on desired". See amm.ts:1742 for the full explanation —
    // applying a % slippage to the desired values makes mint revert with
    // "Price slippage check" whenever the pool ratio differs from the user's
    // input ratio (almost always). Default to 0; tickLower/tickUpper already
    // constrain the acceptable price range.
    const amt0Min = 0n;
    const amt1Min = 0n;
    const txDeadline = deadline || Math.floor(Date.now() / 1000) + 1800;

    const isNative0 = token0 === ethers.ZeroAddress;
    const isNative1 = token1 === ethers.ZeroAddress;
    const needsWrap = isNative0 || isNative1;
    const wrapAmount = isNative0 ? amount0Desired : isNative1 ? amount1Desired : "0";

    const transactions: any[] = [];

    if (needsWrap && BigInt(wrapAmount) > 0n) {
      const wpcIface = new ethers.Interface(["function deposit() payable"]);
      transactions.push({
        to: CONTRACTS.WETH,
        value: wrapAmount,
        data: wpcIface.encodeFunctionData("deposit"),
        description: "Wrap native PC → WETH",
      });
    }

    const approveIface = new ethers.Interface([
      "function approve(address, uint256) returns (bool)",
    ]);
    const MAX_UINT =
      "115792089237316195423570985008687907853269984665640564039457584007913129639935";

    transactions.push({
      to: sorted0,
      value: "0",
      data: approveIface.encodeFunctionData("approve", [
        CONTRACTS.MOLESWAP_LIQUIDITY_PROXY,
        MAX_UINT,
      ]),
      description: `Approve token0 for MoleSwap LiquidityProxy`,
      note: "Can skip if allowance already sufficient",
    });

    transactions.push({
      to: sorted1,
      value: "0",
      data: approveIface.encodeFunctionData("approve", [
        CONTRACTS.MOLESWAP_LIQUIDITY_PROXY,
        MAX_UINT,
      ]),
      description: `Approve token1 for MoleSwap LiquidityProxy`,
      note: "Can skip if allowance already sufficient",
    });

    const proxyIface = new ethers.Interface(LIQUIDITY_PROXY_ABI);
    transactions.push({
      to: CONTRACTS.MOLESWAP_LIQUIDITY_PROXY,
      value: "0",
      data: proxyIface.encodeFunctionData("mint", [
        {
          token0: sorted0,
          token1: sorted1,
          fee,
          tickLower: tLower,
          tickUpper: tUpper,
          amount0Desired: amt0,
          amount1Desired: amt1,
          amount0Min: amt0Min,
          amount1Min: amt1Min,
          deadline: txDeadline,
        },
      ]),
      description: "Mint liquidity position via MoleSwap LiquidityProxy",
    });

    const pool = findPool(sorted0, sorted1);
    const token0Info = getTokenByAddress(token0) || getTokenByAddress(sorted0);
    const token1Info = getTokenByAddress(token1) || getTokenByAddress(sorted1);

    return apiResponse({
      type: "add_liquidity",
      description: `Add liquidity to ${token0Info?.symbol || "?"}/${token1Info?.symbol || "?"} pool`,
      pool: pool?.address || null,
      token0: { address: sorted0, symbol: token0Info?.symbol || "???", decimals: token0Info?.decimals || 18 },
      token1: { address: sorted1, symbol: token1Info?.symbol || "???", decimals: token1Info?.decimals || 18 },
      fee,
      feeTier: `${fee / 10000}%`,
      tickRange: { lower: tLower, upper: tUpper },
      transactions,
      chainId: RH_CHAIN_ID,
      rpc: RH_RPC_URL,
      note: "Sign and send transactions sequentially. Wait for each to confirm before sending the next.",
    });
  } catch (err: any) {
    return apiError(err.message || "Failed to build add-liquidity transaction", 500);
  }
}
