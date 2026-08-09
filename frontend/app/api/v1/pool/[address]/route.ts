import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import {
  CONTRACTS, POOLS, RH_RPC_URL,
  POOL_ABI, ERC20_ABI,
  getTokenByAddress,
} from "@/lib/chain/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const blocked = withRateLimit(req, "read");
  if (blocked) return blocked;

  try {
    const { address } = await params;
    if (!ethers.isAddress(address)) {
      return apiError("Invalid pool address", 400);
    }

    const provider = new ethers.JsonRpcProvider(RH_RPC_URL);
    const contract = new ethers.Contract(address, POOL_ABI, provider);

    const [slot0, liquidity, token0Addr, token1Addr, fee] = await Promise.all([
      contract.slot0(),
      contract.liquidity(),
      contract.token0(),
      contract.token1(),
      contract.fee(),
    ]);

    const token0Info = getTokenByAddress(token0Addr);
    const token1Info = getTokenByAddress(token1Addr);
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
      explorer: `https://robinhoodchain.blockscout.com/address/${address}`,
    });
  } catch (err: any) {
    return apiError(err.message || "Failed to fetch pool", 500);
  }
}
