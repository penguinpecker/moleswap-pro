import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import { CONTRACTS, getTokenByAddress } from "@/lib/chain/contracts";
import { quoteSwap } from "@/lib/aggregator/client";
import { NATIVE_SENTINEL } from "@/lib/aggregator/router";
import { loadPoolRowsServer } from "@/lib/aggregator/serverPools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The app never quotes against an on-chain QuoterV2 (CONTRACTS.QUOTER_V2 is the zero address by design);
// pricing is off-chain, to the wei, via the same aggregator the swap executor uses. This route mirrors
// that exactly so a developer's quote matches what MoleRouter.swap would actually return.

const ZERO = ethers.ZeroAddress.toLowerCase();
const toAgg = (a: string) => (a.toLowerCase() === ZERO || a.toLowerCase() === "native" ? NATIVE_SENTINEL : a);

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
    const slippageParam = req.nextUrl.searchParams.get("slippageBps");

    if (!tokenIn || !tokenOut || !amountIn) {
      return apiError("Missing required params: tokenIn, tokenOut, amountIn (wei)", 400);
    }
    if (!ethers.isAddress(tokenIn) && tokenIn.toLowerCase() !== ZERO) {
      return apiError("Invalid tokenIn address", 400);
    }
    if (!ethers.isAddress(tokenOut) && tokenOut.toLowerCase() !== ZERO) {
      return apiError("Invalid tokenOut address", 400);
    }

    let amountInBig: bigint;
    try {
      amountInBig = BigInt(amountIn);
    } catch {
      return apiError("amountIn must be an integer string in wei", 400);
    }
    if (amountInBig <= 0n) return apiError("amountIn must be > 0", 400);

    const slippageBps = slippageParam != null ? Math.max(0, Math.min(5000, parseInt(slippageParam) || 0)) : 50;

    const actualIn = tokenIn.toLowerCase() === ZERO ? CONTRACTS.WETH : tokenIn;
    const actualOut = tokenOut.toLowerCase() === ZERO ? CONTRACTS.WETH : tokenOut;

    // Same-asset (native <-> WETH) is a 1:1 wrap/unwrap, no route needed.
    if (actualIn.toLowerCase() === actualOut.toLowerCase()) {
      return apiResponse({
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: amountIn,
        minReceived: amountIn,
        fee: 0,
        type: "wrap_unwrap",
        priceImpactBps: 0,
        route: "direct",
      });
    }

    const rows = await loadPoolRowsServer(Date.now());
    if (rows.length === 0) return apiError("Pool registry unavailable — try again shortly", 503);

    const q = await quoteSwap(rows, {
      tokenIn: toAgg(tokenIn),
      tokenOut: toAgg(tokenOut),
      amountIn: amountInBig,
      recipient: "0x0000000000000000000000000000000000000001", // quote-only; recipient does not affect price
      slippageBps,
      weth: CONTRACTS.WETH,
    });
    if (!q) return apiError("No liquidity route found for this pair", 404);

    const tokenInInfo = getTokenByAddress(tokenIn);
    const tokenOutInfo = getTokenByAddress(tokenOut);
    const decIn = tokenInInfo?.decimals ?? 18;
    const decOut = tokenOutInfo?.decimals ?? 18;
    const humanOut = Number(q.quote.amountOut) / 10 ** decOut;

    return apiResponse({
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: q.quote.amountOut.toString(),
      amountOutFormatted: humanOut.toFixed(decOut > 6 ? 8 : 6),
      minReceived: q.quote.minAmountOut.toString(),
      slippageBps,
      type: q.quote.routeDescriptions.length > 1 ? "split" : "direct",
      route: q.quote.routeDescriptions.join(" + "),
      routeDescriptions: q.quote.routeDescriptions,
      nativeValue: q.value.toString(),
    });
  } catch (err: any) {
    return apiError(err.message || "Quote failed", 500);
  }
}
