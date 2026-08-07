import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import {
  CONTRACTS, POOLS, PUSHCHAIN_RPC,
  POOL_ABI, ERC20_ABI,
  getTokenByAddress,
} from "@/lib/pushchain/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function GET(req: NextRequest) {
  const blocked = withRateLimit(req, "read");
  if (blocked) return blocked;

  try {
    const provider = new ethers.JsonRpcProvider(PUSHCHAIN_RPC);
    const includeEmpty = req.nextUrl.searchParams.get("includeEmpty") === "true";

    const poolData = await Promise.allSettled(
      POOLS.map(async (pool) => {
        const contract = new ethers.Contract(pool.address, POOL_ABI, provider);
        const [slot0, liquidity] = await Promise.all([
          contract.slot0(),
          contract.liquidity(),
        ]);

        const token0Info = getTokenByAddress(pool.token0);
        const token1Info = getTokenByAddress(pool.token1);

        const sqrtPriceX96 = BigInt(slot0[0].toString());
        let price = 0;
        if (sqrtPriceX96 > 0n) {
          const dec0 = token0Info?.decimals || 18;
          const dec1 = token1Info?.decimals || 18;
          const sqr = sqrtPriceX96 * sqrtPriceX96;
          const raw = Number(sqr * 10n ** 18n / (2n ** 192n));
          price = raw / 10 ** 18 * 10 ** (dec0 - dec1);
        }

        return {
          address: pool.address,
          name: pool.name,
          fee: pool.fee,
          feeTier: `${pool.fee / 10000}%`,
          token0: {
            address: pool.token0,
            symbol: token0Info?.symbol || "???",
            name: token0Info?.name || "Unknown",
            decimals: token0Info?.decimals || 18,
          },
          token1: {
            address: pool.token1,
            symbol: token1Info?.symbol || "???",
            name: token1Info?.name || "Unknown",
            decimals: token1Info?.decimals || 18,
          },
          sqrtPriceX96: slot0[0].toString(),
          tick: Number(slot0[1]),
          liquidity: liquidity.toString(),
          hasLiquidity: liquidity > 0n,
          price,
        };
      })
    );

    let pools = poolData
      .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
      .map((r) => r.value);

    if (!includeEmpty) {
      pools = pools.filter((p) => p.hasLiquidity);
    }

    return apiResponse({
      count: pools.length,
      chainId: 42101,
      rpc: PUSHCHAIN_RPC,
      pools,
    });
  } catch (err: any) {
    return apiError(err.message || "Failed to fetch pools", 500);
  }
}
