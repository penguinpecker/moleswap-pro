import { NextRequest } from "next/server";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import {
  resolveApiChain,
  chainParamFrom,
  publicContracts,
} from "@/lib/api/chain-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/tokens — the token universe of ONE chain, plus that chain's contract addresses.
 *
 * `?chainId=` picks the chain and defaults to Robinhood (4663), so a caller who has never heard of
 * Arc gets exactly the response they got before. `?chain=` is the older spelling and still works: it
 * used to filter by the `sourceChain` label, and every value that filter could usefully take
 * ("Robinhood Chain", "arc") names a chain we now resolve properly, so the meaning survives. A chain
 * we do not serve is a 400 — this endpoint publishes APPROVAL TARGETS, and handing back Robinhood's
 * router under an Arc label is how an approval ends up on the wrong chain.
 */
export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function GET(req: NextRequest) {
  const blocked = withRateLimit(req, "read");
  if (blocked) return blocked;

  try {
    const resolved = resolveApiChain(chainParamFrom(req.nextUrl.searchParams));
    if (!resolved.ok) return apiError(resolved.error, 400);
    const scope = resolved.scope;

    const search = req.nextUrl.searchParams.get("search")?.toLowerCase();

    let tokens = scope.tokens.map((t) => ({
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      sourceChain: t.sourceChain,
      logoURI: t.logoURI,
      isNative: t.address === "0x0000000000000000000000000000000000000000",
      // Null-safe on purpose: Arc has no wrapped native at all, so nothing can be it.
      isWrappedNative:
        scope.wrappedNative !== null &&
        t.address.toLowerCase() === scope.wrappedNative.toLowerCase(),
    }));

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
      chainId: scope.chainId,
      chain: scope.meta.name,
      rpc: scope.publicRpcUrl,
      tokens,
      // What the chain charges gas in. On Arc this is the ONLY place a caller learns that the native
      // balance and the USDC ERC-20 are one balance under two decimal counts.
      nativeCurrency: scope.nativeCurrency,
      contracts: publicContracts(scope),
    });
  } catch (err: any) {
    return apiError(err.message || "Failed to fetch tokens", 500);
  }
}
