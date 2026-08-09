import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createPublicClient, http, type Address } from "viem";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import { robinhoodChain } from "@/lib/chain/wagmi-config";
import { MOLE_ADDRESSES, DYNAMIC_FEE_FLAG, ROBINHOOD_RPC_URL } from "@/lib/mole/chain";
import { poolIdOf } from "@/lib/mole/poolId";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Registers an already-created + whitelisted MoleHook v4 pool into the aggregator's mp_pools registry so
// swaps route to it. Safety model: we only register a pool the VAULT already reports as whitelisted
// on-chain, and mp_upsert_pools is idempotent — so this can't poison the registry with fake pools. The
// write needs the shared indexer secret (MP_WRITE_SECRET / INDEXER_SECRET); if it isn't configured the
// route returns the exact row to register out-of-band instead of failing opaquely.

const whitelistAbi = [
  { type: "function", name: "isWhitelisted", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function POST(req: NextRequest) {
  const blocked = withRateLimit(req, "write");
  if (blocked) return blocked;

  try {
    const body = await req.json();
    let { currency0, currency1, tickSpacing } = body as { currency0?: string; currency1?: string; tickSpacing?: number };
    if (!currency0 || !currency1) return apiError("Missing currency0/currency1", 400);
    tickSpacing = Number(tickSpacing ?? 60);

    // Enforce v4 currency ordering rather than trusting the caller (address(0) native sorts lowest).
    if (currency0.toLowerCase() > currency1.toLowerCase()) [currency0, currency1] = [currency1, currency0];

    const key = {
      currency0: currency0 as Address,
      currency1: currency1 as Address,
      fee: DYNAMIC_FEE_FLAG,
      tickSpacing,
      hooks: MOLE_ADDRESSES.moleHook as Address,
    };
    const id = poolIdOf(key);

    // Only register a pool the vault already admitted — this is the whole anti-poisoning guarantee.
    const pub = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });
    const admitted = (await pub.readContract({
      address: MOLE_ADDRESSES.molePositions as Address,
      abi: whitelistAbi, functionName: "isWhitelisted", args: [id],
    })) as boolean;
    if (!admitted) {
      return apiError(`Pool ${id} is not whitelisted in the vault yet — create + whitelist it first`, 409);
    }

    const row = {
      id, venue: "mole_v4",
      token0: currency0.toLowerCase(), token1: currency1.toLowerCase(),
      fee: DYNAMIC_FEE_FLAG, tick_spacing: tickSpacing,
      hooks: MOLE_ADDRESSES.moleHook.toLowerCase(), address: "", active: true,
    };

    const secret = process.env.MP_WRITE_SECRET || process.env.INDEXER_SECRET;
    if (!secret) {
      return apiResponse(
        { registered: false, poolId: id, row, note: "Registry write secret not configured on this deployment — register out-of-band with mp_upsert_pools using this row." },
        200,
      );
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const sb = createClient(url, anon, { auth: { persistSession: false } });
    const { error } = await sb.rpc("mp_upsert_pools", { p_secret: secret, p_pools: [row] });
    if (error) return apiError(`Registry write failed: ${error.message}`, 502);

    return apiResponse({ registered: true, poolId: id, row });
  } catch (err: any) {
    return apiError(err.message || "register-pool failed", 500);
  }
}
