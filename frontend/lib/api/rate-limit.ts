/**
 * MoleSwap API — In-memory rate limiter
 * Simple sliding window per IP, resets on deploy
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_READ = 60;
const MAX_REQUESTS_WRITE = 20;

function cleanup() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.resetAt) store.delete(key);
  }
}

setInterval(cleanup, 60_000);

export function checkRateLimit(
  ip: string,
  type: "read" | "write" = "read"
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const max = type === "write" ? MAX_REQUESTS_WRITE : MAX_REQUESTS_READ;
  const key = `${ip}:${type}`;

  let entry = store.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    store.set(key, entry);
  }

  entry.count++;
  const allowed = entry.count <= max;
  const remaining = Math.max(0, max - entry.count);

  return { allowed, remaining, resetAt: entry.resetAt };
}

export function rateLimitHeaders(limit: { remaining: number; resetAt: number }) {
  return {
    "X-RateLimit-Remaining": limit.remaining.toString(),
    "X-RateLimit-Reset": Math.ceil(limit.resetAt / 1000).toString(),
  };
}
