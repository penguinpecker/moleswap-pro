/**
 * vitest.live.config.ts — the OPT-IN live-chain configuration.
 *
 * The default suite (vitest.config.ts) mocks `fetch` globally in tests/setup.ts (learnings 21.8), so no
 * default test can reach Robinhood Chain. The differential checks that must talk to the REAL V4 Quoter and
 * the REAL registry live under tests/live/*.live.spec.ts (not *.test.ts, so the default run never picks
 * them up) and run only through this config, in a plain node environment with the real fetch:
 *
 *   cd frontend && set -a && . ./.env.local && set +a && \
 *     MOLE_LIVE=1 npx vitest run --config tests/live/vitest.live.config.ts
 *
 * They are gated on MOLE_LIVE=1 as well, so even this config cannot hit the network by accident.
 */
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/live/**/*.live.spec.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One file at a time, in order: these are latency measurements against a shared public endpoint.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../.."),
    },
  },
});
