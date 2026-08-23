/**
 * oracleStaleSurfaces.test.tsx — the stale badge on the RENDERED surfaces, not just in their source.
 *
 * oracle.test.ts proves by static read that every named surface contains `<OracleStaleBadge`; that
 * guards presence, not the condition. A screen that rendered the badge on the WRONG state — fresh
 * flagged, stale silent — would pass it. So here the engine (/pools: range bar + batch heartbeat) and the
 * queue page (/queue: epoch card) are mounted for real with the oracle hook stubbed to each state, and
 * `[data-testid="oracle-stale"]` must be present iff `stale`. Attacks first: the stale state must show
 * it; the fresh state and the not-yet-read state must not.
 *
 * Everything that would touch a wallet or an RPC is stubbed (the hook, the pool/queue readers, the
 * wallet context, the site chrome). Rendered with react-dom directly, as the other screen tests are.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ORACLE_STALE_SECONDS, usdPerWethFromTick } from "../../lib/mole/oracle";
import type { OracleHealthView } from "../../lib/mole/useOracleHealth";

const h = vi.hoisted(() => ({
  /** What the stubbed useOracleHealth returns; set per test. */
  view: { oracle: null, cross: null } as { oracle: any; cross: any },
  useOracleHealth: vi.fn(),
  /** A MoleHook pool as fetchV4MolePool would return it: spot between two initialised ticks. */
  pool: { tick: -200_400, liquidity: 10n ** 15n, fee: 3000, ticks: [{ index: -201_000 }, { index: -200_000 }] },
  schedule: { currentEpoch: 7n, epochStartedAt: 1_787_400_000n, epochDuration: 1800, freezeDuration: 60, maxEpochLife: 86_400, maxResidualSlippageBps: 50 },
  epoch: { phase: 0, frozenAt: 0n, totalIn0: 0n, totalIn1: 0n, out0: 0n, out1: 0n, refund0: 0n, refund1: 0n },
}));

vi.mock("@/lib/mole/useOracleHealth", () => ({ useOracleHealth: h.useOracleHealth }));
vi.mock("@/lib/aggregator/venues/v4Reader", () => ({ fetchV4MolePool: vi.fn(async () => h.pool) }));
vi.mock("@/lib/mole/queueClient", () => ({
  getQueueSchedule: vi.fn(async () => h.schedule),
  getEpoch: vi.fn(async () => h.epoch),
  getUserOrders: vi.fn(async () => []),
  placeOrder: vi.fn(),
  cancelOrder: vi.fn(),
  claimOrder: vi.fn(),
  settleEpoch: vi.fn(),
  timeoutEpoch: vi.fn(),
}));
vi.mock("@/lib/chain/provider", () => ({
  useWallet: () => ({ address: undefined, isConnected: false, onRH: false, connect: vi.fn(), switchToRH: vi.fn() }),
}));
// The site chrome (nav, background, mascot) pulls next/navigation + the wallet button; none of it is
// under test. screens/shared/OracleStale is a different module and stays real.
vi.mock("../../screens/shared", () => ({ BackgroundImage: () => null, NavBar: () => null, MoleMascot: () => null }));
vi.mock("next/link", async () => {
  const R = await import("react");
  return { default: ({ href, children, ...rest }: any) => R.createElement("a", { href: String(href), ...rest }, children) };
});

import QueuePage from "../../screens/queue";

const T0 = 1_787_400_948;
const MID = -200_461; // the live pool's frozen tick on 2026-08-22 → $1970.27/WETH
const STALE: OracleHealthView = {
  oracle: { mid: MID, observedAt: T0 - 223_108, ageSec: 223_108, stale: true },
  cross: { ourUsd: 1970.27, chainlinkUsd: 2426.01, chainlinkUpdatedAt: T0 - 800, chainlinkAgeSec: 800, deviationBps: 1878.6, warn: true },
};
const FRESH: OracleHealthView = {
  oracle: { mid: MID, observedAt: T0 - 5, ageSec: 5, stale: false },
  cross: { ourUsd: 1970.27, chainlinkUsd: 1975.0, chainlinkUpdatedAt: T0 - 800, chainlinkAgeSec: 800, deviationBps: 23.9, warn: false },
};
/** Exactly on the boundary: the threshold itself is fresh (the helper's contract). */
const AT_THRESHOLD: OracleHealthView = {
  oracle: { mid: MID, observedAt: T0 - ORACLE_STALE_SECONDS, ageSec: ORACLE_STALE_SECONDS, stale: false },
  cross: null,
};
const UNREAD: OracleHealthView = { oracle: null, cross: null };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.useOracleHealth.mockReset();
  h.useOracleHealth.mockImplementation(() => h.view);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(view: OracleHealthView, el: React.ReactElement) {
  h.view = view;
  await act(async () => {
    root.render(el);
  });
  // Let the stubbed pool / schedule reads resolve and re-render.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
const badges = () => container.querySelectorAll('[data-testid="oracle-stale"]').length;
const text = () => container.textContent ?? "";

// The /pools "MoleSwap Engine" panel (batch heartbeat + range bar + provenance) was removed from the
// product on 2026-08-23; its badge cases lived here. The remaining surfaces below still carry the badge.

describe("QueuePage (/queue: epoch card TWAP) renders the badge iff the oracle is stale", () => {
  it("STALE: one badge under the cutoff clock, next to the TWAP dollar price it would cross at", async () => {
    await mount(STALE, <QueuePage />);
    expect(badges()).toBe(1);
    expect(text()).toContain("ORACLE STALE");
    expect(text()).toContain(`$${usdPerWethFromTick(MID).toFixed(2)}`); // $1970.27 — the frozen price, labelled
    expect(text()).toContain("EPOCH #7");
  });

  it("ATTACK: FRESH must NOT show the badge, and still shows the TWAP price", async () => {
    await mount(FRESH, <QueuePage />);
    expect(badges()).toBe(0);
    expect(text()).not.toContain("ORACLE STALE");
    expect(text()).toContain(`$${usdPerWethFromTick(MID).toFixed(2)}`);
  });

  it("not yet read: a dash and no badge", async () => {
    await mount(UNREAD, <QueuePage />);
    expect(badges()).toBe(0);
    expect(text()).not.toContain("$1970.27");
  });
});
