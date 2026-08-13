import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import {
  CONTRACTS, RH_RPC_URL, RH_PUBLIC_RPC_URL, RH_CHAIN_ID,
  POSITION_MANAGER_ABI, LIQUIDITY_PROXY_ABI, ERC20_ABI,
  TICK_SPACINGS, MIN_TICK, MAX_TICK,
  getTokenByAddress,
} from "@/lib/chain/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FACTORY_ABI = [
  "function createPool(address tokenA, address tokenB, uint24 fee) returns (address pool)",
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
];

const POOL_INIT_ABI = [
  "function initialize(uint160 sqrtPriceX96) external",
];

function nearestUsableTick(tick: number, tickSpacing: number): number {
  const rounded = Math.round(tick / tickSpacing) * tickSpacing;
  if (rounded < MIN_TICK) return MIN_TICK + tickSpacing;
  if (rounded > MAX_TICK) return MAX_TICK - tickSpacing;
  return rounded;
}

function priceToSqrtPriceX96(price: number, decimals0: number, decimals1: number): string {
  const adjustedPrice = price * 10 ** (decimals1 - decimals0);
  const sqrtPrice = Math.sqrt(adjustedPrice);
  const sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * 2 ** 96));
  return sqrtPriceX96.toString();
}

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function POST(req: NextRequest) {
  const blocked = withRateLimit(req, "write");
  if (blocked) return blocked;

  try {
    const body = await req.json();
    const {
      tokenA,
      tokenB,
      fee = 500,
      initialPrice,
      amount0Desired,
      amount1Desired,
      recipient,
      tickLower,
      tickUpper,
      slippageBps = 100,
      deadline,
    } = body;

    if (!tokenA || !tokenB || !recipient) {
      return apiError(
        "Missing required fields: tokenA, tokenB, recipient. Optional: fee, initialPrice, amount0Desired, amount1Desired",
        400
      );
    }

    if (!ethers.isAddress(tokenA) || !ethers.isAddress(tokenB)) {
      return apiError("Invalid token addresses", 400);
    }
    if (!ethers.isAddress(recipient)) {
      return apiError("Invalid recipient address", 400);
    }

    if (tokenA.toLowerCase() === tokenB.toLowerCase()) {
      return apiError("tokenA and tokenB must be different", 400);
    }

    const validFees = [100, 500, 3000, 10000];
    if (!validFees.includes(fee)) {
      return apiError(`Invalid fee tier. Must be one of: ${validFees.join(", ")}`, 400);
    }

    const actualA =
      tokenA === ethers.ZeroAddress ? CONTRACTS.WETH : tokenA;
    const actualB =
      tokenB === ethers.ZeroAddress ? CONTRACTS.WETH : tokenB;

    const [token0, token1] =
      actualA.toLowerCase() < actualB.toLowerCase()
        ? [actualA, actualB]
        : [actualB, actualA];

    const token0Info = getTokenByAddress(tokenA) || getTokenByAddress(token0);
    const token1Info = getTokenByAddress(tokenB) || getTokenByAddress(token1);
    const dec0 = token0Info?.decimals || 18;
    const dec1 = token1Info?.decimals || 18;

    const txDeadline = deadline || Math.floor(Date.now() / 1000) + 3600;
    const transactions: any[] = [];

    const provider = new ethers.JsonRpcProvider(RH_RPC_URL);
    const factory = new ethers.Contract(CONTRACTS.FACTORY, FACTORY_ABI, provider);
    let existingPool: string;
    try {
      existingPool = await factory.getPool(token0, token1, fee);
    } catch {
      existingPool = ethers.ZeroAddress;
    }

    const poolExists =
      existingPool && existingPool !== ethers.ZeroAddress;

    if (!poolExists) {
      const factoryIface = new ethers.Interface(FACTORY_ABI);
      transactions.push({
        to: CONTRACTS.FACTORY,
        value: "0",
        data: factoryIface.encodeFunctionData("createPool", [
          token0,
          token1,
          fee,
        ]),
        description: `Create pool ${token0Info?.symbol || token0.slice(0, 8)}/${token1Info?.symbol || token1.slice(0, 8)} (fee: ${fee / 10000}%)`,
        note: "Returns the new pool address. Save it for the initialize step.",
      });

      if (initialPrice) {
        const sqrtPriceX96 = priceToSqrtPriceX96(initialPrice, dec0, dec1);
        const poolInitIface = new ethers.Interface(POOL_INIT_ABI);
        transactions.push({
          to: "POOL_ADDRESS_FROM_PREVIOUS_TX",
          value: "0",
          data: poolInitIface.encodeFunctionData("initialize", [sqrtPriceX96]),
          description: `Initialize pool with price ${initialPrice} (sqrtPriceX96: ${sqrtPriceX96})`,
          note: "Replace 'to' with the pool address returned by createPool. Must be called before adding liquidity.",
        });
      }
    }

    // Seeding a freshly-created pool needs a NonfungiblePositionManager, which is NOT deployed on
    // Robinhood Chain (the old code encoded `mint` against an empty ABI and 500'd). We therefore return
    // only the real, executable steps: createPool [+ initialize]. For the canonical WETH/USDG pool,
    // liquidity is added single-sided through the ALM vault (MolePositions.zapOpen) — see /vault.
    const seedNote =
      amount0Desired && amount1Desired
        ? "Seeding liquidity into a new pool is not supported on this chain (no position manager). " +
          `Provide liquidity to the canonical WETH/USDG pool via the ALM vault (MolePositions ${CONTRACTS.MOLE_POSITIONS}, zapOpen) at /vault.`
        : undefined;

    return apiResponse({
      type: poolExists ? "pool_exists" : "create_pool",
      description: poolExists
        ? `Pool already exists at ${existingPool}.`
        : `Create new pool${initialPrice ? " and initialize its price" : ""}`,
      seedNote,
      pool: poolExists ? existingPool : null,
      token0: {
        address: token0,
        symbol: token0Info?.symbol || "???",
        decimals: dec0,
      },
      token1: {
        address: token1,
        symbol: token1Info?.symbol || "???",
        decimals: dec1,
      },
      fee,
      feeTier: `${fee / 10000}%`,
      transactions,
      chainId: RH_CHAIN_ID,
      rpc: RH_PUBLIC_RPC_URL,
      note: "Sign and send transactions sequentially. Wait for each to confirm before sending the next. For new pools, the pool address from createPool must be used in the initialize step.",
    });
  } catch (err: any) {
    return apiError(err.message || "Failed to build create-pool transaction", 500);
  }
}
