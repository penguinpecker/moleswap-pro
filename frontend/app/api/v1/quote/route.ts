import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import {
  CONTRACTS, RH_RPC_URL, QUOTER_V2_ABI,
  getTokenByAddress, findPool,
} from "@/lib/chain/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function GET(req: NextRequest) {
  const blocked = withRateLimit(req, "read");
  if (blocked) return blocked;

  try {
    const tokenIn = req.nextUrl.searchParams.get("tokenIn");
    const tokenOut = req.nextUrl.searchParams.get("tokenOut");
    const amountIn = req.nextUrl.searchParams.get("amountIn");
    const fee = req.nextUrl.searchParams.get("fee");

    if (!tokenIn || !tokenOut || !amountIn) {
      return apiError("Missing required params: tokenIn, tokenOut, amountIn (wei)", 400);
    }

    if (!ethers.isAddress(tokenIn) && tokenIn !== ethers.ZeroAddress) {
      return apiError("Invalid tokenIn address", 400);
    }
    if (!ethers.isAddress(tokenOut) && tokenOut !== ethers.ZeroAddress) {
      return apiError("Invalid tokenOut address", 400);
    }

    const amountInBig = BigInt(amountIn);
    if (amountInBig <= 0n) {
      return apiError("amountIn must be > 0", 400);
    }

    const actualIn = tokenIn === ethers.ZeroAddress ? CONTRACTS.WETH : tokenIn;
    const actualOut = tokenOut === ethers.ZeroAddress ? CONTRACTS.WETH : tokenOut;

    const tokenInInfo = getTokenByAddress(tokenIn);
    const tokenOutInfo = getTokenByAddress(tokenOut);

    if (actualIn.toLowerCase() === actualOut.toLowerCase()) {
      return apiResponse({
        tokenIn: tokenIn,
        tokenOut: tokenOut,
        amountIn,
        amountOut: amountIn,
        fee: 0,
        type: "wrap_unwrap",
        priceImpact: "0",
        gasEstimate: "50000",
        route: "direct",
      });
    }

    const provider = new ethers.JsonRpcProvider(RH_RPC_URL);
    const quoter = new ethers.Contract(CONTRACTS.QUOTER_V2, QUOTER_V2_ABI, provider);

    const pool = findPool(actualIn, actualOut);
    const poolFee = fee ? parseInt(fee) : pool?.fee || 500;

    if (pool) {
      const [amountOut, sqrtPriceAfter, ticksCrossed, gasEstimate] =
        await quoter.quoteExactInputSingle.staticCall({
          tokenIn: actualIn,
          tokenOut: actualOut,
          amountIn: amountInBig,
          fee: poolFee,
          sqrtPriceLimitX96: 0,
        });

      const decIn = tokenInInfo?.decimals || 18;
      const decOut = tokenOutInfo?.decimals || 18;
      const humanIn = Number(amountInBig) / 10 ** decIn;
      const humanOut = Number(amountOut) / 10 ** decOut;
      const effectivePrice = humanIn > 0 ? humanOut / humanIn : 0;

      return apiResponse({
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: amountOut.toString(),
        amountOutFormatted: humanOut.toFixed(decOut > 6 ? 8 : 6),
        fee: poolFee,
        feeTier: `${poolFee / 10000}%`,
        pool: pool.address,
        type: "direct",
        effectivePrice,
        sqrtPriceX96After: sqrtPriceAfter.toString(),
        ticksCrossed: Number(ticksCrossed),
        gasEstimate: gasEstimate.toString(),
        route: `${tokenInInfo?.symbol || "?"} → ${tokenOutInfo?.symbol || "?"}`,
      });
    }

    if (actualIn !== CONTRACTS.WETH && actualOut !== CONTRACTS.WETH) {
      const poolA = findPool(actualIn, CONTRACTS.WETH);
      const poolB = findPool(actualOut, CONTRACTS.WETH);

      if (poolA && poolB) {
        const [midAmount] = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: actualIn,
          tokenOut: CONTRACTS.WETH,
          amountIn: amountInBig,
          fee: poolA.fee,
          sqrtPriceLimitX96: 0,
        });

        const [finalAmount, , , gasEstimate] =
          await quoter.quoteExactInputSingle.staticCall({
            tokenIn: CONTRACTS.WETH,
            tokenOut: actualOut,
            amountIn: midAmount,
            fee: poolB.fee,
            sqrtPriceLimitX96: 0,
          });

        return apiResponse({
          tokenIn,
          tokenOut,
          amountIn,
          amountOut: finalAmount.toString(),
          fee: poolA.fee,
          type: "multi_hop",
          gasEstimate: gasEstimate.toString(),
          route: `${tokenInInfo?.symbol || "?"} → WETH → ${tokenOutInfo?.symbol || "?"}`,
          hops: [
            { pool: poolA.address, fee: poolA.fee },
            { pool: poolB.address, fee: poolB.fee },
          ],
        });
      }
    }

    return apiError("No liquidity route found for this pair", 404);
  } catch (err: any) {
    return apiError(err.message || "Quote failed", 500);
  }
}
