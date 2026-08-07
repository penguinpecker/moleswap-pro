import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import {
  CONTRACTS, PUSHCHAIN_RPC, PUSHCHAIN_CHAIN_ID,
  SWAP_ROUTER_ABI, ERC20_ABI, FEE_ROUTER_ABI,
  getTokenByAddress, findPool,
} from "@/lib/pushchain/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function POST(req: NextRequest) {
  const blocked = withRateLimit(req, "write");
  if (blocked) return blocked;

  try {
    const body = await req.json();
    const {
      tokenIn,
      tokenOut,
      amountIn,
      amountOutMin,
      recipient,
      fee,
      slippageBps = 50,
      deadline,
    } = body;

    if (!tokenIn || !tokenOut || !amountIn || !recipient) {
      return apiError(
        "Missing required fields: tokenIn, tokenOut, amountIn (wei), recipient",
        400
      );
    }

    if (!ethers.isAddress(recipient)) {
      return apiError("Invalid recipient address", 400);
    }

    const isNativeIn = tokenIn === ethers.ZeroAddress;
    const isNativeOut = tokenOut === ethers.ZeroAddress;
    const actualIn = isNativeIn ? CONTRACTS.WPC : tokenIn;
    const actualOut = isNativeOut ? CONTRACTS.WPC : tokenOut;
    const amountInBig = BigInt(amountIn);
    const txDeadline = deadline || Math.floor(Date.now() / 1000) + 1800;

    const isWrap =
      isNativeIn &&
      actualOut.toLowerCase() === CONTRACTS.WPC.toLowerCase();
    const isUnwrap =
      actualIn.toLowerCase() === CONTRACTS.WPC.toLowerCase() &&
      isNativeOut;

    if (isWrap) {
      const wpcIface = new ethers.Interface(["function deposit() payable"]);
      return apiResponse({
        type: "wrap",
        description: "Wrap native PC → WPC (1:1)",
        transactions: [
          {
            to: CONTRACTS.WPC,
            value: amountIn,
            data: wpcIface.encodeFunctionData("deposit"),
            description: "deposit() — wrap PC to WPC",
          },
        ],
        chainId: PUSHCHAIN_CHAIN_ID,
      });
    }

    if (isUnwrap) {
      const wpcIface = new ethers.Interface(["function withdraw(uint256 wad)"]);
      return apiResponse({
        type: "unwrap",
        description: "Unwrap WPC → native PC (1:1)",
        transactions: [
          {
            to: CONTRACTS.WPC,
            value: "0",
            data: wpcIface.encodeFunctionData("withdraw", [amountInBig]),
            description: "withdraw() — unwrap WPC to PC",
          },
        ],
        chainId: PUSHCHAIN_CHAIN_ID,
      });
    }

    const pool = findPool(actualIn, actualOut);
    const poolFee = fee || pool?.fee || 500;

    const computedMinOut = amountOutMin
      ? BigInt(amountOutMin)
      : (amountInBig * BigInt(10000 - slippageBps)) / 10000n;

    const transactions: any[] = [];

    if (isNativeIn) {
      const wpcIface = new ethers.Interface(["function deposit() payable"]);
      transactions.push({
        to: CONTRACTS.WPC,
        value: amountIn,
        data: wpcIface.encodeFunctionData("deposit"),
        description: "Step 1: Wrap PC → WPC",
      });
    }

    const approveIface = new ethers.Interface([
      "function approve(address spender, uint256 amount) returns (bool)",
    ]);
    const MAX_UINT =
      "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    transactions.push({
      to: isNativeIn ? CONTRACTS.WPC : tokenIn,
      value: "0",
      data: approveIface.encodeFunctionData("approve", [
        CONTRACTS.MOLESWAP_FEE_ROUTER,
        MAX_UINT,
      ]),
      description: `Step ${isNativeIn ? 2 : 1}: Approve MoleSwap FeeRouter`,
      note: "Can skip if allowance is already sufficient",
    });

    const routerIface = new ethers.Interface(FEE_ROUTER_ABI);
    const swapCalldata = routerIface.encodeFunctionData("swapExactInputSingle", [
      actualIn,
      actualOut,
      poolFee,
      amountInBig,
      computedMinOut,
      txDeadline,
      0,
    ]);

    transactions.push({
      to: CONTRACTS.MOLESWAP_FEE_ROUTER,
      value: "0",
      data: swapCalldata,
      description: `Step ${isNativeIn ? 3 : 2}: swapExactInputSingle via MoleSwap FeeRouter`,
    });

    return apiResponse({
      type: "swap",
      description: `Swap ${getTokenByAddress(tokenIn)?.symbol || "?"} → ${getTokenByAddress(tokenOut)?.symbol || "?"}`,
      pool: pool?.address || null,
      fee: poolFee,
      transactions,
      chainId: PUSHCHAIN_CHAIN_ID,
      rpc: PUSHCHAIN_RPC,
      note: "Sign and send transactions sequentially. Wait for each to confirm before sending the next.",
    });
  } catch (err: any) {
    return apiError(err.message || "Failed to build swap transaction", 500);
  }
}
