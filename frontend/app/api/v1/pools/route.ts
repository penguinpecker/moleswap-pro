import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import { loadLivePools, ChainReadError, type LivePoolScope } from "@/lib/chain/livePools";
import {
  resolveApiChain,
  chainParamFrom,
  vaultUnavailable,
  type ApiChainScope,
} from "@/lib/api/chain-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflightResponse();
}

/**
 * The pool loader's view of a chain, derived from the API scope so the two can never disagree about
 * which vault's positions are being summed.
 *
 * The static pool + token pins matter on Arc and nowhere else: the indexer stamps every `mp_pools`
 * row with chain_id 4663, so a chain-scoped query finds nothing for Arc even though the pool holds
 * real money. Listing it from its verified key is the honest answer; reporting `count: 0` would not be.
 */
function poolScopeFor(scope: ApiChainScope): LivePoolScope {
  const vault = scope.vaultPool;
  return {
    chainId: scope.chainId,
    positions: scope.contracts.MOLE_POSITIONS,
    sourceChain: scope.meta.name,
    hubStable: vault?.stable.address ?? "",
    hubNative: scope.wrappedNative,
    staticPools: vault
      ? [
          {
            id: vault.id,
            token0: vault.key.currency0,
            token1: vault.key.currency1,
            fee: vault.key.fee,
            tick_spacing: vault.key.tickSpacing,
            hooks: vault.key.hooks,
          },
        ]
      : undefined,
    staticTokens: scope.tokens,
  };
}

/**
 * MoleSwap's own pools — the Uniswap-v4 pools bound to MoleHook that were created on this platform.
 *
 * Deliberately NOT a list of every venue on the chain. The aggregator routes across six external
 * factories to get the best price, but that is the router's business; this endpoint answers "what
 * pools does MoleSwap run", which is what the pools page is about.
 *
 * `?chainId=` picks the chain and defaults to Robinhood (4663). A chain with no vault is refused by
 * name rather than answered with another chain's pools: a pool list is a list of places to put money,
 * and the one thing worse than an empty one is a confident one pointing at the wrong chain.
 *
 * `?category=` filters by asset class (mains | stables | stocks | memes).
 */
export async function GET(req: NextRequest) {
  const blocked = withRateLimit(req, "read");
  if (blocked) return blocked;

  try {
    const resolved = resolveApiChain(chainParamFrom(req.nextUrl.searchParams));
    if (!resolved.ok) return apiError(resolved.error, 400);
    const scope = resolved.scope;

    const unavailable = vaultUnavailable(scope);
    if (unavailable) return apiError(unavailable, 400);

    const provider = new ethers.JsonRpcProvider(scope.rpcUrl);
    const includeEmpty = req.nextUrl.searchParams.get("includeEmpty") === "true";
    const category = (req.nextUrl.searchParams.get("category") || "").toLowerCase();

    let pools = await loadLivePools(provider, 24, 60_000, poolScopeFor(scope));

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
      chainId: scope.chainId,
      chain: scope.meta.name,
      rpc: scope.publicRpcUrl,
      categories: counts,
      totalTvlUsd: pools.reduce((s, p) => s + p.tvlUsd, 0),
      pools: pools.map((p) => ({
        poolId: p.poolId,
        address: p.pool.address,
        name: p.pool.name,
        fee: p.pool.fee,
        feeTier: "dynamic",
        // The key's hook and spacing, so a client can tag MoleHook-served vs foreign from the address.
        hooks: p.hooks,
        tickSpacing: p.tickSpacing,
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
    // A chain that could not be read is a 503, never an empty 200: the page keeps the list it has and
    // shows the reason, instead of telling a user with deposits here that there are no pools.
    if (err instanceof ChainReadError) return apiError(err.message, 503);
    return apiError(err.message || "Failed to fetch pools", 500);
  }
}
