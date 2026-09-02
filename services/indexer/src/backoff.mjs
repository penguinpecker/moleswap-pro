/**
 * backoff.mjs — how long to wait before retrying an RPC call.
 *
 * Its own module, like oracleHealth/v4Class, so it can be tested without booting the indexer (importing
 * index.mjs demands Supabase credentials and exits without them).
 *
 * The shape this replaces retried 4 times over ~1.8s against a single URL. Any rate limit lasting longer
 * than two seconds — a per-second cap, let alone the monthly-quota 429 that wedged this service for six
 * days from 2026-09-01 — exhausted that instantly, threw, and aborted the cycle before the cursor moved.
 */

/** Default ceiling on a single wait. A retry must never sleep unboundedly. */
export const DEFAULT_CAP_MS = 15_000;

/**
 * Milliseconds to wait before attempt `a` (0-based).
 *
 * @param {number} a              attempt index
 * @param {number|null} retryAfterSec  the server's own Retry-After, in seconds, when it sent one
 * @param {number} cap            ceiling in ms
 */
export function backoffMs(a, retryAfterSec = null, cap = DEFAULT_CAP_MS) {
  // A server that TELLS us when to come back is obeyed, within the cap — guessing shorter just burns
  // quota and earns a longer ban. A nonsense hint (0, negative, NaN) falls through to the schedule
  // rather than becoming a zero-length sleep.
  if (retryAfterSec !== null && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(cap, Math.round(retryAfterSec * 1000));
  }
  const base = Math.min(cap, 500 * 2 ** a);
  // Half fixed, half jittered: two workers that start together must not retry in lockstep forever.
  return Math.round(base / 2 + Math.random() * (base / 2));
}
