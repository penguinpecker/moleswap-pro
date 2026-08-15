/**
 * /rpc/v1/arc — MoleSwap's public JSON-RPC endpoint for Arc mainnet (5042).
 *
 * Paste https://www.moleswap.com/rpc/v1/arc into MetaMask (or any wallet, or viem/ethers) as
 * the Arc RPC URL. POST speaks JSON-RPC 2.0; GET returns a machine-readable descriptor
 * of the network so tooling can configure itself.
 *
 * Whatever endpoint MoleSwap is actually using behind this URL can change — a provider
 * key can be rotated, added, or dropped — without a single user editing their wallet.
 * That indirection is the product; see upstreams.ts for why it matters.
 */

import { NextRequest, NextResponse, after } from "next/server";
import { MAX_BODY_BYTES, proxyJsonRpc, requestCost } from "@/lib/rpc/proxy";
import { flush, record, shouldFlush, summarise } from "@/lib/rpc/metrics";
import { arcUpstreams } from "@/lib/rpc/upstreams";
import { checkRpcRateLimit } from "@/lib/rpc/rate-limit";
import {
  ARC_BLOCK_EXPLORERS,
  ARC_CHAIN_ID,
  ARC_CHAIN_ID_HEX,
  ARC_NATIVE_CURRENCY,
  ARC_USDC_ERC20,
  arcRpcUrl,
} from "@/lib/rpc/arc-chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Wide-open CORS, deliberately. A wallet's own requests are not subject to CORS, but a
 * dapp calling this URL from a browser is — and a public RPC that only worked from
 * moleswap.com would not be a public RPC.
 */
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

/** No JSON-RPC answer is ever reusable — not by a CDN, not by the browser. */
const NO_STORE: Record<string, string> = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * GET — the network descriptor. A browser that lands here (or a script configuring
 * itself) gets everything needed to add Arc, including the decimals trap spelled out.
 */
export async function GET(req: NextRequest) {
  const origin = process.env.NEXT_PUBLIC_SITE_URL || req.nextUrl.origin;

  return NextResponse.json(
    {
      name: "Arc",
      chainId: ARC_CHAIN_ID,
      chainIdHex: ARC_CHAIN_ID_HEX,
      rpcUrl: arcRpcUrl(origin),
      nativeCurrency: ARC_NATIVE_CURRENCY,
      blockExplorerUrls: ARC_BLOCK_EXPLORERS,
      notes: {
        gasToken:
          "Arc charges gas in USDC. The native balance is 18-decimal; the ERC-20 facade over the same balance reports 6 decimals.",
        usdcErc20: ARC_USDC_ERC20,
      },
      transport: { protocol: "JSON-RPC 2.0", methods: ["POST"], batch: true, websocket: false },
    },
    { headers: { ...CORS, ...NO_STORE } },
  );
}

export async function POST(req: NextRequest) {
  // Reject an oversized body on the declared length before reading it into memory.
  const declared = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return new NextResponse(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: `Request too large (limit ${MAX_BODY_BYTES} bytes)` },
      }),
      { status: 413, headers: { ...CORS, ...NO_STORE, "Content-Type": "application/json" } },
    );
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return new NextResponse(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
      { status: 400, headers: { ...CORS, ...NO_STORE, "Content-Type": "application/json" } },
    );
  }

  // A batch is charged as its length; otherwise the limit is bypassed by batching.
  const limit = checkRpcRateLimit(clientIp(req), requestCost(rawBody));
  const limitHeaders = {
    "X-RateLimit-Limit": String(limit.limit),
    "X-RateLimit-Remaining": String(limit.remaining),
    "X-RateLimit-Reset": String(Math.ceil(limit.resetAt / 1000)),
  };

  if (!limit.allowed) {
    return new NextResponse(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        // -32005 is what providers return for this; wallets and viem already back off on it.
        error: { code: -32005, message: "Rate limit exceeded on the public MoleSwap Arc RPC" },
      }),
      {
        status: 429,
        headers: {
          ...CORS,
          ...NO_STORE,
          ...limitHeaders,
          "Retry-After": String(Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000))),
          "Content-Type": "application/json",
        },
      },
    );
  }

  const result = await proxyJsonRpc({ rawBody, upstreams: arcUpstreams() });

  /*
   * Counting happens AFTER the wallet has its answer. `after()` defers the work until the
   * response is sent, and everything inside is best-effort: a metrics failure must never
   * turn into a failed swap. Only the method name and whether an error came back are read —
   * never `params`, which is where the user's addresses live.
   */
  after(async () => {
    try {
      const parsed = JSON.parse(rawBody);
      record(summarise(Array.isArray(parsed) ? parsed : [parsed], result.body), clientIp(req));
      // MUST be awaited, not fired and forgotten: `after` keeps the function alive only for
      // as long as the promise it is given. A floating flush() is torn down mid-fetch and
      // every counter in that buffer is lost — silently, since flush swallows its own errors.
      if (shouldFlush()) await flush();
    } catch {
      /* unparseable request bodies are already rejected upstream; nothing to count */
    }
  });

  return new NextResponse(result.body || null, {
    status: result.status,
    headers: {
      ...CORS,
      ...NO_STORE,
      ...limitHeaders,
      "Content-Type": "application/json",
      // Host only — never the URL, which may carry a provider key.
      ...(result.servedBy ? { "X-Rpc-Upstream": result.servedBy } : {}),
    },
  });
}
