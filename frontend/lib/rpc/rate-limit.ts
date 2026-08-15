/**
 * rate-limit.ts — a per-IP ceiling sized for an RPC endpoint, not an API endpoint.
 *
 * The app's existing limiter allows 60 reads/minute. That is correct for /api/v1/tokens
 * and catastrophic here: MetaMask alone polls eth_blockNumber on a timer, and a single
 * swap screen issues dozens of eth_calls before the user has typed an amount. Reusing
 * the "read" bucket would rate-limit our own front page.
 *
 * ⚠️ THIS COUNTER IS PER SERVERLESS INSTANCE, and so is the one it is modelled on.
 * Vercel runs many instances, so the effective global ceiling is (instances × limit)
 * and a determined abuser spreads across them. It is a courtesy guard against runaway
 * clients and accidental loops — the real protection against a paid upstream being
 * drained is the provider's own key-level quota and allowlist. Treat it as such; do not
 * let it become the story we tell ourselves about abuse resistance.
 */

interface Window {
  count: number;
  resetAt: number;
}

const store = new Map<string, Window>();

const WINDOW_MS = 60_000;

/** Requests per IP per minute. A batch counts as its LENGTH, not as one request. */
const DEFAULT_LIMIT = 600;

function limitFromEnv(): number {
  const raw = Number.parseInt(process.env.ARC_RPC_RATE_LIMIT ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIMIT;
}

/**
 * Sweep expired windows. Bounded work per call so a burst of unique IPs cannot make the
 * map grow without limit — an unbounded Map keyed by client IP is a memory leak with a
 * user-supplied key.
 */
function sweep(now: number) {
  if (store.size < 5_000) return;
  let examined = 0;
  for (const [key, w] of store) {
    if (now > w.resetAt) store.delete(key);
    if (++examined > 10_000) break;
  }
}

export interface RateVerdict {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
}

/**
 * @param cost how many requests this HTTP call represents — the batch length. Charging
 *   a 100-call batch as one request would make the limit trivially bypassable.
 */
export function checkRpcRateLimit(ip: string, cost = 1): RateVerdict {
  const now = Date.now();
  const limit = limitFromEnv();
  sweep(now);

  let w = store.get(ip);
  if (!w || now > w.resetAt) {
    w = { count: 0, resetAt: now + WINDOW_MS };
    store.set(ip, w);
  }

  w.count += Math.max(1, cost);

  return {
    allowed: w.count <= limit,
    remaining: Math.max(0, limit - w.count),
    resetAt: w.resetAt,
    limit,
  };
}

/** Test seam — the module-level Map otherwise leaks state between test cases. */
export function __resetRpcRateLimit() {
  store.clear();
}
