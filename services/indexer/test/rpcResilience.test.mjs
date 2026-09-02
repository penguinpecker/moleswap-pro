/**
 * rpcResilience.test.mjs — the indexer must survive a rate limit rather than wedge on one.
 *
 * On 2026-09-01 the keyed RPC began answering "Monthly capacity limit exceeded" (HTTP 429) to every
 * call. With four retries over ~1.8s against a single URL, every cycle threw, the cursor never advanced,
 * and the service made no progress for six days while /health still printed a cursor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffMs } from "../src/backoff.mjs";

test("backoff grows exponentially instead of staying inside two seconds", () => {
  // Sample each attempt: jitter means we assert on the band, not on one value.
  const band = (a) => {
    let lo = Infinity, hi = 0;
    for (let i = 0; i < 200; i++) { const v = backoffMs(a); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return { lo, hi };
  };
  const a0 = band(0), a3 = band(3), a6 = band(6);
  assert.ok(a3.lo > a0.hi, `attempt 3 (${a3.lo}) must exceed attempt 0 (${a0.hi})`);
  // The whole point: late attempts are seconds apart, not milliseconds.
  assert.ok(a6.lo >= 5_000, `attempt 6 waits ${a6.lo}ms, expected >= 5000`);
});

test("the cap is honoured, so a retry never sleeps unboundedly", () => {
  for (let a = 0; a < 20; a++) assert.ok(backoffMs(a, null, 15_000) <= 15_000);
});

test("jitter is real — two callers do not retry in lockstep", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(backoffMs(4));
  assert.ok(seen.size > 5, `expected varied delays, got ${seen.size} distinct`);
});

test("a server that says Retry-After is obeyed, within the cap", () => {
  assert.equal(backoffMs(0, 7), 7000);
  assert.equal(backoffMs(0, 600, 15_000), 15_000); // an absurd hint is capped, not honoured literally
  // and a nonsense hint falls back to the exponential schedule rather than to zero
  assert.ok(backoffMs(2, 0) > 0);
  assert.ok(backoffMs(2, NaN) > 0);
  assert.ok(backoffMs(2, -5) > 0);
});
