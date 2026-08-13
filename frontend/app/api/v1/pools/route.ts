import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import {
  CONTRACTS, POOLS, RH_RPC_URL, RH_PUBLIC_RPC_URL,
  POOL_ABI, ERC20_ABI,
  getTokenByAddress,
} from "@/lib/chain/contracts";
import { loadLivePools, tvlUsd as calcTvlUsd } from "@/lib/chain/livePools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function GET(req: NextRequest) {
  const blocked = withRateLimit(req, "read");
  if (blocked) return blocked;

  try {
    const provider = new ethers.JsonRpcProvider(RH_RPC_URL);
    const includeEmpty = req.nextUrl.searchParams.get("includeEmpty") === "true";
    const limit = Math.max(1, Math.min(50, parseInt(req.nextUrl.searchParams.get("limit") || "24") || 24));

    // The real, self-maintaining pool set (every memecoin/WETH pair with genuine depth), not the
    // hardcoded three. Falls back to the static list only if the registry is unreachable, so this
    // endpoint degrades to "fewer pools" rather than "wrong pools".
    const live = await loadLivePools(provider, limit);
    const descriptors = live.length
      ? live.map((l) => ({ pool: l.pool, token0: l.token0, token1: l.token1, hub: l.hub }))
      : POOLS.map((pool) => ({
          pool,
          token0: getTokenByAddress(pool.token0),
          token1: getTokenByAddress(pool.token1),
          hub: "usdg" as const,
        }));

    const poolData = await Promise.allSettled(
      descriptors.map(async ({ pool, token0: token0Info, token1: token1Info, hub }) => {
        const contract = new ethers.Contract(pool.address, POOL_ABI, provider);
        const erc0 = new ethers.Contract(pool.token0, ERC20_ABI, provider);
        const erc1 = new ethers.Contract(pool.token1, ERC20_ABI, provider);
        const [slot0, liquidity, bal0, bal1] = await Promise.all([
          contract.slot0(),
          contract.liquidity(),
          erc0.balanceOf(pool.address),
          erc1.balanceOf(pool.address),
        ]);

        const dec0 = token0Info?.decimals ?? 18;
        const dec1 = token1Info?.decimals ?? 18;

        const sqrtPriceX96 = BigInt(slot0[0].toString());
        let price = 0;
        if (sqrtPriceX96 > 0n) {
          const sqr = sqrtPriceX96 * sqrtPriceX96;
          const raw = Number(sqr * 10n ** 18n / (2n ** 192n));
          price = raw / 10 ** 18 * 10 ** (dec0 - dec1);
        }

        // Real reserves, straight from the pool's token balances. `liquidity > 0` was the previous
        // test and it is NOT a depth signal: on 2026-08-13 it reported a pool holding ~$2 and one
        // holding ~$0.03 as having liquidity. Reserves are what a trader actually gets to trade against.
        const reserve0 = Number(ethers.formatUnits(bal0, dec0));
        const reserve1 = Number(ethers.formatUnits(bal1, dec1));
        const hubIsUsdg = hub === "usdg";
        const hubAddr = hubIsUsdg
          ? "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
          : CONTRACTS.WETH;
        const hubIsToken0 = pool.token0.toLowerCase() === hubAddr.toLowerCase();

        return {
          address: pool.address,
          name: pool.name,
          fee: pool.fee,
          feeTier: `${pool.fee / 10000}%`,
          token0: {
            address: pool.token0,
            symbol: token0Info?.symbol || "???",
            name: token0Info?.name || "Unknown",
            decimals: dec0,
          },
          token1: {
            address: pool.token1,
            symbol: token1Info?.symbol || "???",
            name: token1Info?.name || "Unknown",
            decimals: dec1,
          },
          sqrtPriceX96: slot0[0].toString(),
          tick: Number(slot0[1]),
          liquidity: liquidity.toString(),
          reserve0: reserve0.toString(),
          reserve1: reserve1.toString(),
          hub,
          hubIsUsdg,
          hubIsToken0,
          hasLiquidity: liquidity > 0n && reserve0 > 0 && reserve1 > 0,
          price,
        };
      })
    );

    let pools = poolData
      .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
      .map((r) => r.value);

    // ETH price in dollars, taken from the deepest WETH/USDG pool in this very response — the same
    // number the swap engine trades at, so the page can never disagree with the quote. No price feed.
    const wethLc = CONTRACTS.WETH.toLowerCase();
    const usdgLc = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
    const ethPool = pools
      .filter((p: any) => {
        const a = p.token0.address.toLowerCase();
        const b = p.token1.address.toLowerCase();
        return (a === wethLc && b === usdgLc) || (a === usdgLc && b === wethLc);
      })
      .sort((a: any, b: any) => Number(b.liquidity) - Number(a.liquidity))[0];
    const ethUsd = ethPool
      ? ethPool.token0.address.toLowerCase() === wethLc
        ? ethPool.price // USDG per WETH
        : ethPool.price > 0
          ? 1 / ethPool.price
          : 0
      : 0;

    pools = pools
      .map((p: any) => ({
        ...p,
        tvlUsd: calcTvlUsd({
          reserve0: Number(p.reserve0),
          reserve1: Number(p.reserve1),
          price: p.price,
          hubIsToken0: p.hubIsToken0,
          hubIsUsdg: p.hubIsUsdg,
          ethUsd,
        }),
      }))
      .sort((a: any, b: any) => b.tvlUsd - a.tvlUsd);

    if (!includeEmpty) {
      // A pool with no real reserves is not a pool a user can trade against, whatever its
      // `liquidity` field says. $100 is the floor for being shown at all.
      pools = pools.filter((p: any) => p.hasLiquidity && p.tvlUsd >= 100);
    }

    return apiResponse({
      count: pools.length,
      chainId: 4663,
      rpc: RH_PUBLIC_RPC_URL,
      ethUsd,
      pools,
    });
  } catch (err: any) {
    return apiError(err.message || "Failed to fetch pools", 500);
  }
}
