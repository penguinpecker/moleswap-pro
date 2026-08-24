import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import {
  POSITION_MANAGER_ABI, LIQUIDITY_PROXY_ABI, ERC20_ABI,
  TICK_SPACINGS, MIN_TICK, MAX_TICK,
} from "@/lib/chain/contracts";
import { assertValidDecimals, formatUnitsDisplay } from "@/lib/mole/format";
import {
  resolveApiChain,
  chainFieldFrom,
  chainParamFrom,
  tokenIn as tokenInScope,
  type ApiChainScope,
} from "@/lib/api/chain-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Decimals for one leg of the pool, resolved STRICTLY.
 *
 * There is no `|| 18`. Formatting — or worse, pricing — a 6-decimal token as an 18-decimal one is a
 * 10^12 error (see the banner in lib/mole/format.ts and the USDG warning in lib/chain/contracts.ts),
 * and `initialPrice` feeds priceToSqrtPriceX96 below, so a wrong decimal count here mis-initializes a
 * real pool's price by twelve orders of magnitude. An unknown token is asked on-chain; a token that
 * will not answer `decimals()` is an ERROR, never a guess.
 */
async function resolveDecimals(
  scope: ApiChainScope,
  provider: ethers.Provider,
  address: string,
): Promise<number> {
  const known = tokenInScope(scope, address);
  if (known) {
    assertValidDecimals(known.decimals);
    return known.decimals;
  }
  const erc20 = new ethers.Contract(address, ERC20_ABI, provider);
  const raw = await erc20.decimals();
  const decimals = Number(raw);
  assertValidDecimals(decimals); // throws RangeError on a non-integer / out-of-range answer
  return decimals;
}

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

    const resolved = resolveApiChain(
      chainFieldFrom(body) ?? chainParamFrom(req.nextUrl.searchParams),
    );
    if (!resolved.ok) return apiError(resolved.error, 400);
    const scope = resolved.scope;

    // A v3-style `createPool(tokenA, tokenB, fee)` needs a v3 factory, and only Robinhood has one of
    // ours. Arc carries the Uniswap v4 singleton and StateView but NO Uniswap periphery at all — do
    // not infer a factory from the singleton's presence. Saying so is the whole point: encoding a
    // createPool call against a chain that has no factory produces calldata that reverts on send.
    if (!scope.v3Factory) {
      return apiError(
        `Pool creation is not available on ${scope.meta.name} (chainId ${scope.chainId}): there is no ` +
          "v3 factory deployed there, so there is no createPool to encode. MoleSwap's pool on that " +
          `chain is a Uniswap-v4 pool bound to MoleHook (${scope.contracts.MOLE_HOOK})` +
          (scope.vaultPool ? `, poolId ${scope.vaultPool.id}` : "") +
          "; add liquidity to it through /api/v1/tx/add-liquidity.",
        400,
      );
    }
    const factoryAddress = scope.v3Factory;

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

    // 0x0 means "native", which only becomes a pool currency through its wrapped form.
    if ((tokenA === ethers.ZeroAddress || tokenB === ethers.ZeroAddress) && !scope.wrappedNative) {
      return apiError(
        `${scope.meta.name} has no wrapped native token, so 0x0 cannot be a pool currency there. ` +
          (scope.nativeCurrency.note ?? ""),
        400,
      );
    }
    const actualA =
      tokenA === ethers.ZeroAddress ? (scope.wrappedNative as string) : tokenA;
    const actualB =
      tokenB === ethers.ZeroAddress ? (scope.wrappedNative as string) : tokenB;

    const [token0, token1] =
      actualA.toLowerCase() < actualB.toLowerCase()
        ? [actualA, actualB]
        : [actualB, actualA];

    const provider = new ethers.JsonRpcProvider(scope.rpcUrl);

    // Metadata is looked up by the SORTED addresses, never by the caller's tokenA/tokenB order: pass
    // (USDG, WETH) and WETH still sorts to token0, so keying off tokenA would have paired token0=WETH
    // with USDG's 6 decimals and inverted the 10^12 scale inside priceToSqrtPriceX96.
    const token0Info = tokenInScope(scope, token0);
    const token1Info = tokenInScope(scope, token1);

    let dec0: number;
    let dec1: number;
    try {
      [dec0, dec1] = await Promise.all([
        resolveDecimals(scope, provider, token0),
        resolveDecimals(scope, provider, token1),
      ]);
    } catch (e: any) {
      return apiError(
        "Could not determine token decimals on-chain, and this API never assumes 18 — a 6-decimal token " +
          "priced as an 18-decimal one mis-initializes the pool by 10^12. Verify both addresses are " +
          `ERC-20s on ${scope.meta.name} (chain ${scope.chainId}) that answer decimals(). Underlying error: ` +
          (e?.shortMessage || e?.message || "unknown"),
        422,
      );
    }

    const txDeadline = deadline || Math.floor(Date.now() / 1000) + 3600;
    const transactions: any[] = [];

    const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
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
        to: factoryAddress,
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

    // Seeding a freshly-created pool needs a NonfungiblePositionManager, which is deployed on NEITHER
    // chain (the old code encoded `mint` against an empty ABI and 500'd). We therefore return only the
    // real, executable steps: createPool [+ initialize]. For the canonical vault pool, liquidity is
    // added single-sided through the ALM vault (MolePositions.zapOpen) — see /vault.
    const seedNote =
      amount0Desired && amount1Desired
        ? "Seeding liquidity into a new pool is not supported on this chain (no position manager). " +
          `Provide liquidity to the canonical ${scope.vaultPool?.label ?? "vault"} pool via the ALM vault ` +
          `(MolePositions ${scope.contracts.MOLE_POSITIONS}, zapOpen) at /vault.`
        : undefined;

    // Echo the requested seed amounts back in HUMAN units, using the decimals resolved above, so a
    // caller can see immediately whether they sized the legs against the right token. amount0Desired
    // belongs to token0 = the LOWER-sorting address, which is not necessarily the tokenA they sent.
    let requestedSeed: Record<string, string> | undefined;
    if (amount0Desired !== undefined || amount1Desired !== undefined) {
      const wei = (label: string, v: unknown): bigint => {
        const s = String(v ?? "0").trim();
        if (!/^\d+$/.test(s)) throw new Error(`${label} must be an unsigned integer string in wei`);
        return BigInt(s);
      };
      let raw0: bigint;
      let raw1: bigint;
      try {
        raw0 = wei("amount0Desired", amount0Desired);
        raw1 = wei("amount1Desired", amount1Desired);
      } catch (e: any) {
        return apiError(e.message, 400);
      }
      requestedSeed = {
        amount0Desired: raw0.toString(),
        amount1Desired: raw1.toString(),
        amount0Display: `${formatUnitsDisplay(raw0, dec0, dec0)} ${token0Info?.symbol || "token0"}`,
        amount1Display: `${formatUnitsDisplay(raw1, dec1, dec1)} ${token1Info?.symbol || "token1"}`,
        ordering: `amount0Desired is read against token0 ${token0} (${dec0} decimals); amount1Desired against token1 ${token1} (${dec1} decimals).`,
      };
    }

    return apiResponse({
      type: poolExists ? "pool_exists" : "create_pool",
      description: poolExists
        ? `Pool already exists at ${existingPool}.`
        : `Create new pool${initialPrice ? " and initialize its price" : ""}`,
      seedNote,
      requestedSeed,
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
      chainId: scope.chainId,
      chain: scope.meta.name,
      rpc: scope.publicRpcUrl,
      note: "Sign and send transactions sequentially. Wait for each to confirm before sending the next. For new pools, the pool address from createPool must be used in the initialize step.",
    });
  } catch (err: any) {
    return apiError(err.message || "Failed to build create-pool transaction", 500);
  }
}
