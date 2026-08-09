import { NextRequest } from "next/server";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import { TOKENS, CONTRACTS } from "@/lib/chain/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function GET(req: NextRequest) {
  const blocked = withRateLimit(req, "read");
  if (blocked) return blocked;

  try {
    const chain = req.nextUrl.searchParams.get("chain");
    const search = req.nextUrl.searchParams.get("search")?.toLowerCase();

    let tokens = TOKENS.map((t) => ({
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      sourceChain: t.sourceChain,
      logoURI: t.logoURI,
      isNative: t.address === "0x0000000000000000000000000000000000000000",
      isWrappedNative: t.address.toLowerCase() === CONTRACTS.WETH.toLowerCase(),
    }));

    if (chain) {
      tokens = tokens.filter(
        (t) => t.sourceChain.toLowerCase() === chain.toLowerCase()
      );
    }

    if (search) {
      tokens = tokens.filter(
        (t) =>
          t.symbol.toLowerCase().includes(search) ||
          t.name.toLowerCase().includes(search) ||
          t.address.toLowerCase().includes(search)
      );
    }

    return apiResponse({
      count: tokens.length,
      tokens,
      contracts: {
        factory: CONTRACTS.FACTORY,
        swapRouter: CONTRACTS.SWAP_ROUTER,
        quoterV2: CONTRACTS.QUOTER_V2,
        positionManager: CONTRACTS.POSITION_MANAGER,
        weth: CONTRACTS.WETH,
        moleswapFeeRouter: CONTRACTS.MOLESWAP_FEE_ROUTER,
        moleswapLiquidityProxy: CONTRACTS.MOLESWAP_LIQUIDITY_PROXY,
      },
    });
  } catch (err: any) {
    return apiError(err.message || "Failed to fetch tokens", 500);
  }
}
