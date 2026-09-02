import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { encodeFunctionData } from "viem";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import { quoteSwap } from "@/lib/aggregator/client";
import { InsufficientLiquidityError } from "@/lib/aggregator/quote";
import { moleRouterAbi, NATIVE_SENTINEL } from "@/lib/aggregator/router";
import { loadPoolRowsServer } from "@/lib/aggregator/serverPools";
import { getAggFeeBps } from "@/lib/mole/aggFee";
import { checkAgainstReference } from "@/lib/aggregator/referencePrice";
import {
  resolveApiChain,
  chainFieldFrom,
  chainParamFrom,
  productUnavailable,
  quotingUnavailable,
  tokenIn as tokenInScope,
} from "@/lib/api/chain-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Builds the exact MoleRouter.swap(plan) calldata the app itself sends (lib/chain/amm.ts executeSwap).
// The router wraps/unwraps native at the route edges, so there is no manual wrap step for an aggregator
// swap — native input rides along as msg.value. The prior version encoded a `swapExactInputSingle` that
// does not exist in the router ABI, so every real swap 500'd.
//
// `chainId` in the body (or the query string) picks the chain and defaults to Robinhood (4663). The
// approval target this route hands back is a standing ERC-20 allowance to MoleRouter — naming the
// wrong chain's router there is precisely how an approval lands somewhere the user never meant, so the
// chain is resolved before a single address is emitted, and an unrecognised one is refused.

const ZERO = ethers.ZeroAddress.toLowerCase();
const toAgg = (a: string) => (a.toLowerCase() === ZERO || a.toLowerCase() === "native" ? NATIVE_SENTINEL : a);
const MAX_UINT = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
/**
 * Where a route stops being a bad price and becomes a mistake. 30% against an independent oracle is far
 * outside anything slippage or fee can explain on a real pair; the case that motivated it measured
 * ~99.95%. Deliberately NOT the swap card's 5% warning threshold: this refuses to emit a transaction,
 * so it must only catch trades nobody means to make.
 */
const CATASTROPHIC_IMPACT_BPS = 3000;

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function POST(req: NextRequest) {
  const blocked = withRateLimit(req, "write");
  if (blocked) return blocked;

  try {
    const body = await req.json();

    const resolved = resolveApiChain(
      chainFieldFrom(body) ?? chainParamFrom(req.nextUrl.searchParams),
    );
    if (!resolved.ok) return apiError(resolved.error, 400);
    const scope = resolved.scope;

    const swapUnavailable = productUnavailable(scope, "swap");
    if (swapUnavailable) return apiError(swapUnavailable, 400);
    const notQuotable = quotingUnavailable(scope);
    if (notQuotable) return apiError(notQuotable, 501);

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

    // A chain with no wrapped native has no wrap step to build and no native leg to route. Refuse the
    // whole native path rather than encode a deposit() against an address that is not a WETH.
    const weth = scope.wrappedNative;
    if ((isNativeIn || isNativeOut) && !weth) {
      return apiError(
        `${scope.meta.name} has no wrapped native token, so 0x0 (native) is not a routable currency ` +
          `there and there is nothing to wrap. ${scope.nativeCurrency.note ?? ""}`.trim(),
        400,
      );
    }

    const actualIn = isNativeIn ? (weth as string) : tokenIn;
    const actualOut = isNativeOut ? (weth as string) : tokenOut;
    // The wrapped token's own symbol, so the description names what the caller will actually hold.
    const wethSymbol = weth ? tokenInScope(scope, weth)?.symbol ?? "wrapped native" : "wrapped native";

    // native <-> WETH is a pure 1:1 wrap/unwrap — no router, no route.
    if (isNativeIn && actualOut.toLowerCase() === (weth as string).toLowerCase()) {
      const wethIface = new ethers.Interface(["function deposit() payable"]);
      return apiResponse({
        type: "wrap",
        description: `Wrap native ${scope.nativeCurrency.symbol} → ${wethSymbol} (1:1)`,
        transactions: [{ to: weth, value: amountIn, data: wethIface.encodeFunctionData("deposit"), description: "deposit()" }],
        chainId: scope.chainId,
      });
    }
    if (actualIn.toLowerCase() === (weth as string).toLowerCase() && isNativeOut) {
      const wethIface = new ethers.Interface(["function withdraw(uint256 wad)"]);
      return apiResponse({
        type: "unwrap",
        description: `Unwrap ${wethSymbol} → native ${scope.nativeCurrency.symbol} (1:1)`,
        transactions: [{ to: weth, value: "0", data: wethIface.encodeFunctionData("withdraw", [amountInBig]), description: "withdraw()" }],
        chainId: scope.chainId,
      });
    }

    // Pair-scoped for the same reason as /api/v1/quote: the pairless window is both v4-blind and,
    // under database pressure, returns [] instead of throwing, bypassing the degraded fallback.
    const rows = await loadPoolRowsServer(Date.now(), {
      tokenIn: toAgg(tokenIn),
      tokenOut: toAgg(tokenOut),
      weth: weth as string,
    });
    if (rows.length === 0) return apiError("Pool registry unavailable — try again shortly", 503);

    const q = await quoteSwap(rows, {
      tokenIn: toAgg(tokenIn),
      tokenOut: toAgg(tokenOut),
      amountIn: amountInBig,
      recipient,
      slippageBps: bps,
      feeBps: await getAggFeeBps(Date.now()),
      weth: weth as string,
    });
    if (!q) return apiError("No liquidity route found for this pair", 404);

    const router = scope.contracts.MOLE_ROUTER;
    const transactions: any[] = [];

    // ERC-20 input needs a standing allowance to MoleRouter; native input rides as msg.value.
    if (!isNativeIn) {
      const approveIface = new ethers.Interface(["function approve(address spender, uint256 amount) returns (bool)"]);
      transactions.push({
        to: actualIn,
        value: "0",
        data: approveIface.encodeFunctionData("approve", [router, MAX_UINT]),
        description: `Approve MoleRouter on ${scope.meta.name} (skip if allowance already covers amountIn)`,
      });
    }

    /**
     * JUDGE THE ROUTE AGAINST AN INDEPENDENT REFERENCE BEFORE HANDING OVER EXECUTABLE CALLDATA.
     *
     * /api/v1/quote already does this, and this route did not — so the endpoint whose whole job is to
     * emit a transaction was the one with no warning attached. Measured 2026-08-25: USDe, which THIS
     * SAME API publishes as `swappable: false`, still produced signable calldata at a ~99.95% loss, and
     * `minReceived` was derived from that same catastrophic quote — so the slippage floor could not
     * save the caller either. It does not revert; it executes.
     *
     * A quote the oracle says is catastrophic is refused (422) rather than encoded. `acknowledgeImpact`
     * is the deliberate override for a caller who has seen the number and means it, because a hard
     * refusal with no way through is its own failure mode on a thin market. The reference fields are
     * ALWAYS returned, so even an acknowledged trade carries the number that justified the warning.
     */
    const refIn = tokenInScope(scope, tokenIn);
    const refOut = tokenInScope(scope, tokenOut);
    const ref = await checkAgainstReference({
      tokenIn,
      tokenOut,
      amountIn: amountInBig,
      amountOut: q.quote.netAmountOut,
      decimalsIn: refIn?.decimals ?? 18,
      decimalsOut: refOut?.decimals ?? 18,
    });
    const acknowledged = body.acknowledgeImpact === true;
    if (ref.priceImpactBps !== null && ref.priceImpactBps >= CATASTROPHIC_IMPACT_BPS && !acknowledged) {
      return apiError(
        `This route would lose ${(ref.priceImpactBps / 100).toFixed(2)}% against the reference price ` +
          `($${(ref.valueInUsd ?? 0).toFixed(2)} in, $${(ref.valueOutUsd ?? 0).toFixed(2)} out). ` +
          `No transaction was built. Trade a smaller size, or resend with "acknowledgeImpact": true if this is intended.`,
        422,
      );
    }

    const swapData = encodeFunctionData({ abi: moleRouterAbi as any, functionName: "swap", args: [q.encoded as any] });
    transactions.push({
      to: router,
      value: q.value.toString(),
      data: swapData,
      description: "MoleRouter.swap — executes the routed plan",
    });

    return apiResponse({
      type: "swap",
      description: `Swap ${tokenInScope(scope, tokenIn)?.symbol || tokenIn.slice(0, 8)} → ${tokenInScope(scope, tokenOut)?.symbol || tokenOut.slice(0, 8)}`,
      amountOut: q.quote.netAmountOut.toString(),
      aggregatorFeeBps: q.quote.feeBps,
      minReceived: q.quote.minAmountOut.toString(),
      route: q.quote.routeDescriptions.join(" + "),
      slippageBps: bps,
      /** Loss against Chainlink, in bps. Null (with a reason) when either leg has no fresh feed —
       *  never silently 0, which would read as "this route is fine". */
      priceImpactBps: ref.priceImpactBps,
      priceImpactReason: ref.reason,
      referenceValueInUsd: ref.valueInUsd,
      referenceValueOutUsd: ref.valueOutUsd,
      /** True when the caller overrode a refusal that the reference price had earned. */
      impactAcknowledged: acknowledged && ref.priceImpactBps !== null && ref.priceImpactBps >= CATASTROPHIC_IMPACT_BPS,
      transactions,
      chainId: scope.chainId,
      chain: scope.meta.name,
      rpc: scope.publicRpcUrl,
      note: "Send the approval (if present) first and wait for it to confirm, then send the swap.",
    });
  } catch (err: any) {
    // A trade larger than the visible depth is the MARKET's answer, not an engine failure: 422 with the
    // size that would fit, never a 500 telling the caller to re-quote at the same amount.
    if (err instanceof InsufficientLiquidityError) return apiError(err.message, 422);
    return apiError(err.message || "Failed to build swap transaction", 500);
  }
}
