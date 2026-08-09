import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import {
  CONTRACTS, PUSHCHAIN_RPC, PUSHCHAIN_CHAIN_ID,
  POSITION_MANAGER_ABI, LIQUIDITY_PROXY_ABI, ERC20_ABI,
  TICK_SPACINGS, MIN_TICK, MAX_TICK,
  getTokenByAddress,
} from "@/lib/pushchain/contracts";

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
      tokenA === ethers.ZeroAddress ? CONTRACTS.WPC : tokenA;
    const actualB =
      tokenB === ethers.ZeroAddress ? CONTRACTS.WPC : tokenB;

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

    const provider = new ethers.JsonRpcProvider(PUSHCHAIN_RPC);
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

    if (amount0Desired && amount1Desired) {
      const isNativeA = tokenA === ethers.ZeroAddress;
      const isNativeB = tokenB === ethers.ZeroAddress;
      const needsWrap = isNativeA || isNativeB;
      const wrapAmount = isNativeA ? amount0Desired : isNativeB ? amount1Desired : "0";

      if (needsWrap && BigInt(wrapAmount) > 0n) {
        const wpcIface = new ethers.Interface(["function deposit() payable"]);
        transactions.push({
          to: CONTRACTS.WPC,
          value: wrapAmount,
          data: wpcIface.encodeFunctionData("deposit"),
          description: "Wrap native PC → WPC",
        });
      }

      const approveIface = new ethers.Interface([
        "function approve(address, uint256) returns (bool)",
      ]);
      const MAX_UINT =
        "115792089237316195423570985008687907853269984665640564039457584007913129639935";

      transactions.push({
        to: token0,
        value: "0",
        data: approveIface.encodeFunctionData("approve", [
          CONTRACTS.MOLESWAP_LIQUIDITY_PROXY,
          MAX_UINT,
        ]),
        description: `Approve ${token0Info?.symbol || "token0"} for MoleSwap LiquidityProxy`,
      });

      transactions.push({
        to: token1,
        value: "0",
        data: approveIface.encodeFunctionData("approve", [
          CONTRACTS.MOLESWAP_LIQUIDITY_PROXY,
          MAX_UINT,
        ]),
        description: `Approve ${token1Info?.symbol || "token1"} for MoleSwap LiquidityProxy`,
      });

      const spacing = TICK_SPACINGS[fee] || 10;
      const tLower =
        tickLower != null
          ? tickLower
          : nearestUsableTick(MIN_TICK, spacing);
      const tUpper =
        tickUpper != null
          ? tickUpper
          : nearestUsableTick(MAX_TICK, spacing);

      const amt0 = BigInt(amount0Desired);
      const amt1 = BigInt(amount1Desired);
      // See amm.ts:1742 — `amountXMin` is min amount actually consumed by the
      // pool, not "slippage on the desired upper bound". Applying % slippage
      // to desired makes mint revert with "Price slippage check" because the
      // pool consumes less of one side than the user typed. Default to 0;
      // tickLower/tickUpper already define the acceptable price range.
      const amt0Min = 0n;
      const amt1Min = 0n;

      const proxyIface = new ethers.Interface(LIQUIDITY_PROXY_ABI);
      transactions.push({
        to: CONTRACTS.MOLESWAP_LIQUIDITY_PROXY,
        value: "0",
        data: proxyIface.encodeFunctionData("mint", [
          {
            token0,
            token1,
            fee,
            tickLower: tLower,
            tickUpper: tUpper,
            amount0Desired: amt0,
            amount1Desired: amt1,
            amount0Min: amt0Min,
            amount1Min: amt1Min,
            deadline: txDeadline,
          },
        ]),
        description: "Mint liquidity position via MoleSwap LiquidityProxy",
      });
    }

    return apiResponse({
      type: poolExists ? "add_liquidity_existing" : "create_pool",
      description: poolExists
        ? `Pool already exists at ${existingPool}. Adding liquidity.`
        : `Create new pool and seed liquidity`,
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
      chainId: PUSHCHAIN_CHAIN_ID,
      rpc: PUSHCHAIN_RPC,
      note: "Sign and send transactions sequentially. Wait for each to confirm before sending the next. For new pools, the pool address from createPool must be used in the initialize step.",
    });
  } catch (err: any) {
    return apiError(err.message || "Failed to build create-pool transaction", 500);
  }
}
