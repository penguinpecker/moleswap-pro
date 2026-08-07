/**
 * MoleSwap API — Shared response helpers
 */
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, rateLimitHeaders } from "./rate-limit";

export function getClientIP(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function apiResponse(data: any, status = 200, extra?: Record<string, string>) {
  return NextResponse.json(
    { success: true, data, timestamp: Date.now() },
    {
      status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Cache-Control": status === 200 ? "public, s-maxage=10, stale-while-revalidate=30" : "no-store",
        ...extra,
      },
    }
  );
}

export function apiError(message: string, status = 400, extra?: Record<string, string>) {
  return NextResponse.json(
    { success: false, error: message, timestamp: Date.now() },
    {
      status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Cache-Control": "no-store",
        ...extra,
      },
    }
  );
}

export function withRateLimit(
  req: NextRequest,
  type: "read" | "write" = "read"
): NextResponse | null {
  const ip = getClientIP(req);
  const limit = checkRateLimit(ip, type);
  const headers = rateLimitHeaders(limit);

  if (!limit.allowed) {
    return apiError("Rate limit exceeded. Try again in 60 seconds.", 429, headers);
  }
  return null;
}

export function corsPreflightResponse() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}
