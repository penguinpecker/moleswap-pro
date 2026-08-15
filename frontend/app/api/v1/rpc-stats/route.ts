/**
 * /api/v1/rpc-stats — usage figures for the public Arc RPC.
 *
 *   GET /api/v1/rpc-stats?secret=<MP_WRITE_SECRET>&days=30
 *   GET /api/v1/rpc-stats?days=30      with header  x-mp-secret: <MP_WRITE_SECRET>
 *
 * Gated on the same shared secret that gates the write path. The numbers contain no personal
 * data, but they are MoleSwap's traffic figures and nobody asked for those to be public.
 *
 * Returns totals and a daily series: requests, errors, unique visitors, and transactions
 * actually broadcast. Note that unique visitors CANNOT be summed across days — a visitor
 * hashes differently every day by design (see 007_rpc_metrics.sql), which is what stops
 * anyone being followed over time. The daily series is the honest view; the total reports the
 * peak single day rather than a number that would silently double-count returning users.
 */

import { NextRequest } from "next/server";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflightResponse();
}

/** Constant-time compare, so the secret cannot be recovered a character at a time. */
function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function GET(req: NextRequest) {
  const blocked = withRateLimit(req, "read");
  if (blocked) return blocked;

  const expected = process.env.MP_WRITE_SECRET || process.env.INDEXER_SECRET;
  if (!expected) return apiError("Stats are not configured on this deployment", 503);

  const provided = req.headers.get("x-mp-secret") || req.nextUrl.searchParams.get("secret") || "";
  if (!secretMatches(provided, expected)) return apiError("Unauthorized", 401);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return apiError("Stats storage is not configured", 503);

  const days = Number.parseInt(req.nextUrl.searchParams.get("days") ?? "30", 10);

  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/mp_rpc_stats`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${anon}` },
      body: JSON.stringify({ p_secret: expected, p_days: Number.isFinite(days) ? days : 30 }),
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });

    if (!res.ok) return apiError(`Stats query failed (${res.status})`, 502);

    return apiResponse(await res.json(), 200, { "Cache-Control": "no-store" });
  } catch (err) {
    return apiError((err as Error).message || "Stats query failed", 502);
  }
}
