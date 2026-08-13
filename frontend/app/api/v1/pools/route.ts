import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import { RH_RPC_URL, RH_PUBLIC_RPC_URL } from "@/lib/chain/contracts";
import { loadLivePools } from "@/lib/chain/livePools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflightResponse();
}

/**
 * MoleSwap's own pools — the Uniswap-v4 pools bound to MoleHook that were created on this platform.
 *
 * Deliberately NOT a list of every venue on the chain. The aggregator routes across six external
 * factories to get the best price, but that is the router's business; this endpoint answers "what
 * pools does MoleSwap run", which is what the pools page is about.
 *
 * `?category=` filters by asset class (mains | stables | stocks | memes).
 */
export async function GET(req: NextRequest) {
  const blocked = withRateLimit(req, "read");
  if (blocked) return blocked;

  try {
    const provider = new ethers.JsonRpcProvider(RH_RPC_URL);
    const includeEmpty = req.nextUrl.searchParams.get("includeEmpty") === "true";
    const category = (req.nextUrl.searchParams.get("category") || "").toLowerCase();

    let pools = await loadLivePools(provider);

    if (category && category !== "all") {
      pools = pools.filter((p) => p.category === category);
    }
    if (!includeEmpty) {
      // A pool with no open position holds nothing tradeable, whatever its liquidity field says.
      pools = pools.filter((p) => p.reserve0 > 0 || p.reserve1 > 0);
    }

    const counts = { mains: 0, stables: 0, stocks: 0, memes: 0 } as Record<string, number>;
    for (const p of pools) counts[p.category] = (counts[p.category] || 0) + 1;

    return apiResponse({
      count: pools.length,
      chainId: 4663,
      rpc: RH_PUBLIC_RPC_URL,
      categories: counts,
      totalTvlUsd: pools.reduce((s, p) => s + p.tvlUsd, 0),
      pools: pools.map((p) => ({
        poolId: p.poolId,
        address: p.pool.address,
        name: p.pool.name,
        fee: p.pool.fee,
        feeTier: "dynamic",
        category: p.category,
        token0: {
          address: p.token0.address, symbol: p.token0.symbol,
          name: p.token0.name, decimals: p.token0.decimals, logoURI: p.token0.logoURI,
        },
        token1: {
          address: p.token1.address, symbol: p.token1.symbol,
          name: p.token1.name, decimals: p.token1.decimals, logoURI: p.token1.logoURI,
        },
        tick: p.tick,
        sqrtPriceX96: p.sqrtPriceX96.toString(),
        liquidity: p.liquidity.toString(),
        reserve0: p.reserve0,
        reserve1: p.reserve1,
        tvlUsd: p.tvlUsd,
        hasLiquidity: p.reserve0 > 0 || p.reserve1 > 0,
      })),
    });
  } catch (err: any) {
    return apiError(err.message || "Failed to fetch pools", 500);
  }
}
