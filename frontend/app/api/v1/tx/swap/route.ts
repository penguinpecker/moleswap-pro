import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { encodeFunctionData } from "viem";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import { CONTRACTS, RH_CHAIN_ID, RH_RPC_URL, RH_PUBLIC_RPC_URL, getTokenByAddress } from "@/lib/chain/contracts";
import { quoteSwap } from "@/lib/aggregator/client";
import { moleRouterAbi, NATIVE_SENTINEL } from "@/lib/aggregator/router";
import { loadPoolRowsServer } from "@/lib/aggregator/serverPools";
import { getAggFeeBps } from "@/lib/mole/aggFee";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Builds the exact MoleRouter.swap(plan) calldata the app itself sends (lib/chain/amm.ts executeSwap).
// The router wraps/unwraps native at the route edges, so there is no manual wrap step for an aggregator
// swap — native input rides along as msg.value. The prior version encoded a `swapExactInputSingle` that
// does not exist in the router ABI, so every real swap 500'd.

const ZERO = ethers.ZeroAddress.toLowerCase();
const toAgg = (a: string) => (a.toLowerCase() === ZERO || a.toLowerCase() === "native" ? NATIVE_SENTINEL : a);
const MAX_UINT = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function POST(req: NextRequest) {
  const blocked = withRateLimit(req, "write");
  if (blocked) return blocked;

  try {
    const body = await req.json();
    const { tokenIn, tokenOut, amountIn, recipient, slippageBps = 50 } = body;

    if (!tokenIn || !tokenOut || !amountIn || !recipient) {
      return apiError("Missing required fields: tokenIn, tokenOut, amountIn (wei), recipient", 400);
    }
    if (!ethers.isAddress(recipient)) return apiError("Invalid recipient address", 400);
    if (!ethers.isAddress(tokenIn) && tokenIn.toLowerCase() !== ZERO) return apiError("Invalid tokenIn address", 400);
    if (!ethers.isAddress(tokenOut) && tokenOut.toLowerCase() !== ZERO) return apiError("Invalid tokenOut address", 400);

    let amountInBig: bigint;
    try {
      amountInBig = BigInt(amountIn);
    } catch {
      return apiError("amountIn must be an integer string in wei", 400);
    }
    if (amountInBig <= 0n) return apiError("amountIn must be > 0", 400);

    const bps = Math.max(0, Math.min(5000, Number(slippageBps) || 0));
    const isNativeIn = tokenIn.toLowerCase() === ZERO;
    const isNativeOut = tokenOut.toLowerCase() === ZERO;
    const actualIn = isNativeIn ? CONTRACTS.WETH : tokenIn;
    const actualOut = isNativeOut ? CONTRACTS.WETH : tokenOut;

    // native <-> WETH is a pure 1:1 wrap/unwrap — no router, no route.
    if (isNativeIn && actualOut.toLowerCase() === CONTRACTS.WETH.toLowerCase()) {
      const wethIface = new ethers.Interface(["function deposit() payable"]);
      return apiResponse({
        type: "wrap",
        description: "Wrap native ETH → WETH (1:1)",
        transactions: [{ to: CONTRACTS.WETH, value: amountIn, data: wethIface.encodeFunctionData("deposit"), description: "deposit()" }],
        chainId: RH_CHAIN_ID,
      });
    }
    if (actualIn.toLowerCase() === CONTRACTS.WETH.toLowerCase() && isNativeOut) {
      const wethIface = new ethers.Interface(["function withdraw(uint256 wad)"]);
      return apiResponse({
        type: "unwrap",
        description: "Unwrap WETH → native ETH (1:1)",
        transactions: [{ to: CONTRACTS.WETH, value: "0", data: wethIface.encodeFunctionData("withdraw", [amountInBig]), description: "withdraw()" }],
        chainId: RH_CHAIN_ID,
      });
    }

    // Pair-scoped for the same reason as /api/v1/quote: the pairless window is both v4-blind and,
    // under database pressure, returns [] instead of throwing, bypassing the degraded fallback.
    const rows = await loadPoolRowsServer(Date.now(), {
      tokenIn: toAgg(tokenIn),
      tokenOut: toAgg(tokenOut),
      weth: CONTRACTS.WETH,
    });
    if (rows.length === 0) return apiError("Pool registry unavailable — try again shortly", 503);

    const q = await quoteSwap(rows, {
      tokenIn: toAgg(tokenIn),
      tokenOut: toAgg(tokenOut),
      amountIn: amountInBig,
      recipient,
      slippageBps: bps,
      feeBps: await getAggFeeBps(Date.now()),
      weth: CONTRACTS.WETH,
    });
    if (!q) return apiError("No liquidity route found for this pair", 404);

    const transactions: any[] = [];

    // ERC-20 input needs a standing allowance to MoleRouter; native input rides as msg.value.
    if (!isNativeIn) {
      const approveIface = new ethers.Interface(["function approve(address spender, uint256 amount) returns (bool)"]);
      transactions.push({
        to: actualIn,
        value: "0",
        data: approveIface.encodeFunctionData("approve", [CONTRACTS.MOLE_ROUTER, MAX_UINT]),
        description: "Approve MoleRouter (skip if allowance already covers amountIn)",
      });
    }

    const swapData = encodeFunctionData({ abi: moleRouterAbi as any, functionName: "swap", args: [q.encoded as any] });
    transactions.push({
      to: CONTRACTS.MOLE_ROUTER,
      value: q.value.toString(),
      data: swapData,
      description: "MoleRouter.swap — executes the routed plan",
    });

    return apiResponse({
      type: "swap",
      description: `Swap ${getTokenByAddress(tokenIn)?.symbol || tokenIn.slice(0, 8)} → ${getTokenByAddress(tokenOut)?.symbol || tokenOut.slice(0, 8)}`,
      amountOut: q.quote.netAmountOut.toString(),
      aggregatorFeeBps: q.quote.feeBps,
      minReceived: q.quote.minAmountOut.toString(),
      route: q.quote.routeDescriptions.join(" + "),
      slippageBps: bps,
      transactions,
      chainId: RH_CHAIN_ID,
      rpc: RH_PUBLIC_RPC_URL,
      note: "Send the approval (if present) first and wait for it to confirm, then send the swap.",
    });
  } catch (err: any) {
    return apiError(err.message || "Failed to build swap transaction", 500);
  }
}
