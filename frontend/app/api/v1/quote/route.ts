import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import { quoteSwap } from "@/lib/aggregator/client";
import { NATIVE_SENTINEL } from "@/lib/aggregator/router";
import { loadPoolRowsServer } from "@/lib/aggregator/serverPools";
import { getAggFeeBps } from "@/lib/mole/aggFee";
import {
  resolveApiChain,
  chainParamFrom,
  productUnavailable,
  quotingUnavailable,
  tokenIn as tokenInScope,
} from "@/lib/api/chain-scope";
import { checkAgainstReference } from "@/lib/aggregator/referencePrice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The app never quotes against an on-chain QuoterV2 (CONTRACTS.QUOTER_V2 is the zero address by design);
// pricing is off-chain, to the wei, via the same aggregator the swap executor uses. This route mirrors
// that exactly so a developer's quote matches what MoleRouter.swap would actually return.
//
// `?chainId=` picks the chain and defaults to Robinhood (4663). A chain whose liquidity the pricing
// engine cannot see is REFUSED rather than priced — see `quotingUnavailable`. Pricing Arc addresses
// against Robinhood pools would return a number that looks exactly like a real quote and is not one.

const ZERO = ethers.ZeroAddress.toLowerCase();
const toAgg = (a: string) => (a.toLowerCase() === ZERO || a.toLowerCase() === "native" ? NATIVE_SENTINEL : a);

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function GET(req: NextRequest) {
  const blocked = withRateLimit(req, "read");
  if (blocked) return blocked;

  try {
    const resolved = resolveApiChain(chainParamFrom(req.nextUrl.searchParams));
    if (!resolved.ok) return apiError(resolved.error, 400);
    const scope = resolved.scope;

    const swapUnavailable = productUnavailable(scope, "swap");
    if (swapUnavailable) return apiError(swapUnavailable, 400);
    const notQuotable = quotingUnavailable(scope);
    if (notQuotable) return apiError(notQuotable, 501);

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

    // 0x0 means "native", and native only routes where there is a wrapped form to route THROUGH. On a
    // chain with none, the whole native path fails closed rather than silently pricing something else.
    const weth = scope.wrappedNative;
    const wantsNative = tokenIn.toLowerCase() === ZERO || tokenOut.toLowerCase() === ZERO;
    if (wantsNative && !weth) {
      return apiError(
        `${scope.meta.name} has no wrapped native token, so 0x0 (native) is not a routable currency ` +
          `there. ${scope.nativeCurrency.note ?? ""}`.trim(),
        400,
      );
    }

    const actualIn = tokenIn.toLowerCase() === ZERO ? (weth as string) : tokenIn;
    const actualOut = tokenOut.toLowerCase() === ZERO ? (weth as string) : tokenOut;

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
        chainId: scope.chainId,
      });
    }

    // Pass the pair: the pairless call reads a bounded window of ~94k active pools, which both
    // misses v4 rows outside the window AND, under database pressure, returns [] instead of
    // throwing — turning a slow registry into a 503 before the loader's degraded fallback could run.
    const rows = await loadPoolRowsServer(Date.now(), {
      tokenIn: toAgg(tokenIn),
      tokenOut: toAgg(tokenOut),
      weth: weth as string,
    });
    if (rows.length === 0) return apiError("Pool registry unavailable — try again shortly", 503);

    const feeBps = await getAggFeeBps(Date.now());
    const q = await quoteSwap(rows, {
      tokenIn: toAgg(tokenIn),
      tokenOut: toAgg(tokenOut),
      amountIn: amountInBig,
      recipient: "0x0000000000000000000000000000000000000001", // quote-only; recipient does not affect price
      slippageBps,
      feeBps,
      weth: weth as string,
    });
    if (!q) return apiError("No liquidity route found for this pair", 404);

    const tokenInInfo = tokenInScope(scope, tokenIn);
    const tokenOutInfo = tokenInScope(scope, tokenOut);
    const decIn = tokenInInfo?.decimals ?? 18;
    const decOut = tokenOutInfo?.decimals ?? 18;
    const humanOut = Number(q.quote.netAmountOut) / 10 ** decOut;

    /**
     * Judge the route against an INDEPENDENT reference (Chainlink), because the pool being quoted
     * cannot be the yardstick for itself. Measured 2026-08-25: ETH -> USDe quoted -24.06% against
     * the oracle and this response carried no impact field at all, so the card showed a confident
     * number and warned nobody. Additive: every pre-existing field keeps its exact shape.
     */
    const ref = await checkAgainstReference({
      tokenIn,
      tokenOut,
      amountIn: BigInt(amountIn),
      amountOut: q.quote.netAmountOut,
      decimalsIn: decIn,
      decimalsOut: decOut,
    });

    return apiResponse({
      chainId: scope.chainId,
      chain: scope.meta.name,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: q.quote.netAmountOut.toString(),
      amountOutFormatted: humanOut.toFixed(decOut > 6 ? 8 : 6),
      // The fee is taken from the INPUT now, so the route's whole output reaches the recipient and there
      // is no "gross output" distinct from it. Kept and equal to amountOut so existing integrators do not
      // break, rather than removed silently.
      grossAmountOut: q.quote.amountOut.toString(),
      aggregatorFeeBps: q.quote.feeBps,
      /** ⚠ Denominated in tokenIn — the fee is charged on the source currency. Formatting this with
       *  tokenOut's decimals is a silent 10^12 error on a 6-vs-18 pair. `aggregatorFeeToken` names it
       *  explicitly so an integrator cannot guess wrong. */
      aggregatorFee: q.quote.feeAmount.toString(),
      aggregatorFeeToken: tokenIn,
      aggregatorFeeFormatted: (Number(q.quote.feeAmount) / 10 ** decIn).toFixed(decIn > 6 ? 8 : 6),
      /** What actually reaches the pools: amountIn − aggregatorFee. */
      netAmountIn: q.quote.netAmountIn.toString(),
      minReceived: q.quote.minAmountOut.toString(),
      slippageBps,
      type: q.quote.routeDescriptions.length > 1 ? "split" : "direct",
      route: q.quote.routeDescriptions.join(" + "),
      routeDescriptions: q.quote.routeDescriptions,
      nativeValue: q.value.toString(),
      /** How far below the independent reference this route lands, in bps. Null when either leg
       *  has no feed or a stale one — `priceImpactReason` says which, so a consumer can tell
       *  "no impact" apart from "could not measure". Those must never look the same. */
      priceImpactBps: ref.priceImpactBps,
      priceImpactReason: ref.reason,
      referenceValueInUsd: ref.valueInUsd,
      referenceValueOutUsd: ref.valueOutUsd,
    });
  } catch (err: any) {
    return apiError(err.message || "Quote failed", 500);
  }
}
