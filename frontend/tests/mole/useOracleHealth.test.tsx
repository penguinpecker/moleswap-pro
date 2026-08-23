/**
 * useOracleHealth.test.tsx — the hook every screen polls. Attacks first: a read that fails must not
 * produce a fresh-looking value, and a mid read fresh must go stale ON THE CLOCK, between polls, without
 * waiting for the next successful read — otherwise a dead RPC would freeze every badge in its last state.
 *
 * Rendered with react-dom directly (a probe component reports the hook's value), the way
 * settingsPanel.test.tsx does — no @testing-library/dom in this tree.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ORACLE_STALE_SECONDS } from "../../lib/mole/oracle";
import type { OracleHealthView } from "../../lib/mole/useOracleHealth";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.resetModules();
  vi.doUnmock("../../lib/mole/oracle");
});

async function hookWith(read: (...a: any[]) => Promise<any>, cross?: (...a: any[]) => Promise<any>) {
  vi.resetModules();
  const readOracleHealth = vi.fn(read);
  const readLivePoolCrossCheck = vi.fn(cross ?? (async () => { throw new Error("no reference"); }));
  vi.doMock("../../lib/mole/oracle", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/mole/oracle")>()),
    oracleClient: () => ({ readContract: async () => { throw new Error("no network in tests"); } }),
    readOracleHealth,
    readLivePoolCrossCheck,
  }));
  const { useOracleHealth } = await import("../../lib/mole/useOracleHealth");
  const latest: { current: OracleHealthView | null } = { current: null };
  function Probe(props: Parameters<typeof useOracleHealth>[0]) {
    latest.current = useOracleHealth(props);
    return null;
  }
  const mount = (props: Parameters<typeof useOracleHealth>[0] = {}) => {
    act(() => {
      root.render(<Probe {...props} />);
    });
  };
  const tick = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  return { mount, tick, latest, readOracleHealth, readLivePoolCrossCheck };
}

describe("useOracleHealth", () => {
  it("ATTACK: a mid read exactly at the threshold goes stale one second later, with no new read", async () => {
    const t0 = Math.floor(Date.now() / 1000);
    const h = await hookWith(async () => ({ mid: -200461, observedAt: t0 - ORACLE_STALE_SECONDS, ageSec: ORACLE_STALE_SECONDS, stale: false }));
    h.mount();
    await h.tick(10);
    expect(h.readOracleHealth).toHaveBeenCalledTimes(1);
    expect(h.latest.current?.oracle?.stale).toBe(false);
    expect(h.latest.current?.oracle?.mid).toBe(-200461);
    // Two ticks of the 1s clock, still inside the 15s poll window: no second read, yet the age has moved.
    await h.tick(2100);
    expect(h.readOracleHealth).toHaveBeenCalledTimes(1);
    expect(h.latest.current?.oracle?.stale).toBe(true);
    expect(h.latest.current!.oracle!.ageSec).toBeGreaterThan(ORACLE_STALE_SECONDS);
  });

  it("ATTACK: a failed read yields NO oracle (null), never a fresh-looking default", async () => {
    const h = await hookWith(async () => {
      throw new Error("http 429");
    });
    h.mount();
    await h.tick(50);
    expect(h.latest.current?.oracle).toBeNull();
    expect(h.latest.current?.cross).toBeNull();
  });

  it("keeps the prior reading when a later poll fails, and keeps aging it", async () => {
    const t0 = Math.floor(Date.now() / 1000);
    let n = 0;
    const h = await hookWith(async () => {
      if (n++ === 0) return { mid: 7, observedAt: t0 - 10, ageSec: 10, stale: false };
      throw new Error("http 429");
    });
    h.mount();
    await h.tick(10);
    expect(h.latest.current?.oracle?.mid).toBe(7);
    await h.tick(15_100); // the next poll, which fails
    expect(h.readOracleHealth).toHaveBeenCalledTimes(2);
    expect(h.latest.current?.oracle?.mid).toBe(7);
    expect(h.latest.current!.oracle!.ageSec).toBeGreaterThanOrEqual(25);
  });

  it("runs the Chainlink cross-check only when asked AND only for the live pool", async () => {
    const t0 = Math.floor(Date.now() / 1000);
    const cross = vi.fn(async () => ({ ourUsd: 1970, chainlinkUsd: 2426, chainlinkUpdatedAt: t0, chainlinkAgeSec: 0, deviationBps: 1878, warn: true }));
    const h = await hookWith(async () => ({ mid: -200461, observedAt: t0 - 5, ageSec: 5, stale: false }), cross);
    h.mount({ crossCheck: true });
    await h.tick(20);
    expect(h.readLivePoolCrossCheck).toHaveBeenCalledTimes(1);
    expect(h.latest.current?.cross?.warn).toBe(true);

    h.mount({ crossCheck: true, poolId: ("0x" + "ab".repeat(32)) as `0x${string}` });
    await h.tick(20);
    expect(h.readLivePoolCrossCheck).toHaveBeenCalledTimes(1); // not for a pool with no USD reference
    expect(h.latest.current?.cross).toBeNull();
  });

  it("ATTACK: a NULL mid (consult reverted) must not be cross-checked — tickToUsd(null) would be a false DEVIATION", async () => {
    const t0 = Math.floor(Date.now() / 1000);
    const cross = vi.fn(async () => ({ ourUsd: 1e12, chainlinkUsd: 2426, chainlinkUpdatedAt: t0, chainlinkAgeSec: 0, deviationBps: 4e12, warn: true }));
    const h = await hookWith(async () => ({ mid: null, observedAt: t0 - 5, ageSec: 5, stale: false }), cross);
    h.mount({ crossCheck: true });
    await h.tick(20);
    expect(h.readOracleHealth).toHaveBeenCalledTimes(1);
    expect(h.latest.current?.oracle?.mid).toBeNull(); // the age is still reported, the mid is not
    expect(h.readLivePoolCrossCheck).not.toHaveBeenCalled();
    expect(h.latest.current?.cross).toBeNull();
  });

  it("does nothing when disabled (the pools page only asks for the live pool)", async () => {
    const h = await hookWith(async () => ({ mid: 1, observedAt: 1, ageSec: 1, stale: false }));
    h.mount({ enabled: false });
    await h.tick(100);
    expect(h.readOracleHealth).not.toHaveBeenCalled();
    expect(h.latest.current?.oracle).toBeNull();
  });
});
