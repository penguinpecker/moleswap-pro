import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import { POOLS, POOL_ABI, ERC20_ABI } from "@/lib/chain/contracts";
import { resolveApiChain, chainParamFrom, tokenIn } from "@/lib/api/chain-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflightResponse();
}

/**
 * GET /api/v1/pool/:address — one v3-style pool contract, read live.
 *
 * `?chainId=` picks the chain and defaults to Robinhood (4663). It is not cosmetic: the same address
 * can hold an entirely different contract on another chain, and reading it over the wrong RPC either
 * reverts or — worse — succeeds against something that merely answers `slot0()`. Token metadata and
 * the explorer link come from the same scope as the RPC, so a response can never pair one chain's
 * price with another chain's symbols.
 *
 * v4 pools are NOT addressable this way — they are keys hashed into the PoolManager singleton. Use
 * /api/v1/pools, which reports them by PoolId.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const blocked = withRateLimit(req, "read");
  if (blocked) return blocked;

  try {
    const resolved = resolveApiChain(chainParamFrom(req.nextUrl.searchParams));
    if (!resolved.ok) return apiError(resolved.error, 400);
    const scope = resolved.scope;

    const { address } = await params;
    if (!ethers.isAddress(address)) {
      return apiError("Invalid pool address", 400);
    }

    const provider = new ethers.JsonRpcProvider(scope.rpcUrl);
    const contract = new ethers.Contract(address, POOL_ABI, provider);

    const [slot0, liquidity, token0Addr, token1Addr, fee] = await Promise.all([
      contract.slot0(),
      contract.liquidity(),
      contract.token0(),
      contract.token1(),
      contract.fee(),
    ]);

    const token0Info = tokenIn(scope, token0Addr);
    const token1Info = tokenIn(scope, token1Addr);
    // The named-pool registry is Robinhood's PancakeSwap tier list; on any other chain there simply is
    // no curated name, and the symbol pair below is the answer.
    const poolInfo = POOLS.find(
      (p) => p.address.toLowerCase() === address.toLowerCase()
    );

    const sqrtPriceX96 = BigInt(slot0[0].toString());
    let price = 0;
    if (sqrtPriceX96 > 0n) {
      const dec0 = token0Info?.decimals || 18;
      const dec1 = token1Info?.decimals || 18;
      const sqr = sqrtPriceX96 * sqrtPriceX96;
      const raw = Number(sqr * 10n ** 18n / (2n ** 192n));
      price = raw / 10 ** 18 * 10 ** (dec0 - dec1);
    }

    let token0Balance = "0";
    let token1Balance = "0";
    try {
      const t0 = new ethers.Contract(token0Addr, ERC20_ABI, provider);
      const t1 = new ethers.Contract(token1Addr, ERC20_ABI, provider);
      const [b0, b1] = await Promise.all([
        t0.balanceOf(address),
        t1.balanceOf(address),
      ]);
      token0Balance = b0.toString();
      token1Balance = b1.toString();
    } catch {}

    return apiResponse({
      address,
      chainId: scope.chainId,
      chain: scope.meta.name,
      name: poolInfo?.name || `${token0Info?.symbol || "???"}/${token1Info?.symbol || "???"}`,
      fee: Number(fee),
      feeTier: `${Number(fee) / 10000}%`,
      token0: {
        address: token0Addr,
        symbol: token0Info?.symbol || "???",
        name: token0Info?.name || "Unknown",
        decimals: token0Info?.decimals || 18,
        poolBalance: token0Balance,
      },
      token1: {
        address: token1Addr,
        symbol: token1Info?.symbol || "???",
        name: token1Info?.name || "Unknown",
        decimals: token1Info?.decimals || 18,
        poolBalance: token1Balance,
      },
      sqrtPriceX96: slot0[0].toString(),
      tick: Number(slot0[1]),
      liquidity: liquidity.toString(),
      hasLiquidity: BigInt(liquidity.toString()) > 0n,
      price,
      explorer: scope.explorerUrl ? `${scope.explorerUrl}/address/${address}` : null,
    });
  } catch (err: any) {
    return apiError(err.message || "Failed to fetch pool", 500);
  }
}
