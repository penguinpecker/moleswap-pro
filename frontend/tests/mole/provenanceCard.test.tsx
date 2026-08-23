/**
 * provenanceCard.test.tsx — the card renders the proof from the ADDRESS before any chain read, and the
 * chain-read rows with their mutability labels once the read lands.
 *
 * Rendered with react-dom directly (same reason as settingsPanel.test.tsx: @testing-library/dom is not
 * installed and this change adds no dependency). The chain reader is mocked; `provenanceRows` stays real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PoolProvenance } from "../../lib/mole/provenance";

const readPoolProvenance = vi.fn<() => Promise<PoolProvenance>>();
vi.mock("../../lib/mole/provenance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/mole/provenance")>()),
  readPoolProvenance: (...args: unknown[]) => (readPoolProvenance as any)(...args),
}));

import { ProvenanceCard } from "../../screens/pools/ProvenanceCard";
import { hookBitmapProof } from "../../lib/mole/hookBitmap";
import { LIVE_POOL_KEY, MOLE_ADDRESSES } from "../../lib/mole/chain";
import { poolIdOf } from "../../lib/mole/poolId";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = "0xe4563270a72a9418f97dbb631E1696eDCC8bC8C8";
const IMPL = "0xE4192C72574e6E387D4C29Eb89feCeADa105F3e3";
const HOSTILE = "0xdeadbeefdeadbeefdeadbeefdeadbeefdead3ac4"; // 0x38c4 | 0x0200

const KEY = {
  currency0: LIVE_POOL_KEY.currency0,
  currency1: LIVE_POOL_KEY.currency1,
  fee: LIVE_POOL_KEY.fee,
  tickSpacing: LIVE_POOL_KEY.tickSpacing,
  hooks: LIVE_POOL_KEY.hooks,
};

function fixture(hooks: string = KEY.hooks): PoolProvenance {
  const key = { ...KEY, hooks: hooks as `0x${string}` };
  return {
    poolKey: key,
    poolId: poolIdOf(key),
    bitmap: hookBitmapProof(hooks),
    served: hooks.toLowerCase() === MOLE_ADDRESSES.moleHook.toLowerCase(),
    slot0: { sqrtPriceX96: 1n, tick: -201118, protocolFee: 0, lpFee: 3000 },
    hook: { address: hooks, impl: IMPL, upgradeAdmin: ROOT, lpFeePips: 3000, hookFeePips: 0, poolCreator: ROOT, restrictedLiquidity: false },
    vault: { address: MOLE_ADDRESSES.molePositions, impl: IMPL, upgradeAdmin: ROOT, moleHook: MOLE_ADDRESSES.moleHook, whitelisted: true, minRangeWidth: 120, maxRangeWidth: 60000, minPositionLiquidity: 0n, maxPositionLiquidity: 0n, performanceFeeBps: 1000 },
    queue: { address: MOLE_ADDRESSES.moleQueue, impl: IMPL, upgradeAdmin: ROOT, boundToThisPool: true },
    router: { address: MOLE_ADDRESSES.moleRouter, impl: IMPL, upgradeAdmin: ROOT, feeDial: MOLE_ADDRESSES.moleFeeDial, feeBps: 69 },
    currencies: [
      { address: key.currency0, symbol: "WETH", decimals: 18 },
      { address: key.currency1, symbol: "USDG", decimals: 6 },
    ],
    readAt: 0,
  };
}

let container: HTMLDivElement;
let root: Root;

const mount = (el: React.ReactElement) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(el);
  });
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  readPoolProvenance.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ATTACK — the proof is computed from the address, not trusted from a read", () => {
  it("a hostile hook renders ✗ in the header before any chain read, and the bitmap row reads ✗ after it", async () => {
    readPoolProvenance.mockResolvedValue(fixture(HOSTILE));
    mount(<ProvenanceCard poolKey={{ ...KEY, hooks: HOSTILE }} defaultOpen />);
    // the HEADER specifically (the body also prints the proof line, so textContent alone is not proof)
    expect(container.querySelector("button")?.textContent).toContain("& 0x0301 == 0 ✗");
    expect(container.querySelector("button")?.textContent).not.toContain("✓");
    await flush();
    expect(container.textContent).toContain("uint160(hook) & 0x0301 == 0 ✗");
    const bit9 = container.querySelector('[title="beforeRemoveLiquidity"] span');
    expect(bit9?.textContent).toBe("1");
  });

  it("a failed chain read never fabricates rows", async () => {
    readPoolProvenance.mockRejectedValue(new Error("rpc down"));
    mount(<ProvenanceCard poolKey={KEY} defaultOpen />);
    await flush();
    expect(container.querySelectorAll("[data-row]")).toHaveLength(0);
    expect(container.textContent).toContain("chain read failed");
    // the address-derived proof is still there — it needs no read
    expect(container.querySelector("button")?.textContent).toContain("& 0x0301 == 0 ✓");
    expect(container.textContent).toContain("uint160(hook) & 0x0301 == 0 ✓");
  });
});

describe("CONFIRM — the live key", () => {
  it("collapsed: shows the hook and the ✓ proof, reads nothing until opened", async () => {
    readPoolProvenance.mockResolvedValue(fixture());
    mount(<ProvenanceCard poolKey={KEY} />);
    expect(container.querySelector("button")?.textContent).toContain("PROVENANCE · hook 0xb2c9…38C4");
    expect(container.querySelector("button")?.textContent).toContain("& 0x0301 == 0 ✓");
    expect(readPoolProvenance).not.toHaveBeenCalled();
    expect(container.querySelectorAll("[data-row]")).toHaveLength(0);
  });

  it("open: 14 bit cells with 9, 8, 0 clear, the copy-pasteable one-liner, and the rows with honest labels", async () => {
    readPoolProvenance.mockResolvedValue(fixture());
    mount(<ProvenanceCard poolKey={KEY} defaultOpen />);
    await flush();
    expect(readPoolProvenance).toHaveBeenCalledTimes(1);
    expect(readPoolProvenance.mock.calls[0]![0 as never]).toMatchObject({ hooks: KEY.hooks, tickSpacing: 60 });

    const cells = container.querySelectorAll('[aria-label="hook permission bits"] > span');
    expect(cells).toHaveLength(14);
    for (const name of ["beforeRemoveLiquidity", "afterRemoveLiquidity", "afterRemoveLiquidityReturnDelta"]) {
      expect(container.querySelector(`[title="${name}"] span`)?.textContent).toBe("0");
    }
    expect(container.textContent).toContain(`(BigInt("${KEY.hooks}") & 0x0301n) === 0n`);
    expect(container.textContent).toContain("bits prove which callbacks can fire, not who deployed the hook");

    const mut = (key: string) => container.querySelector(`[data-row="${key}"] [data-mutability]`)?.getAttribute("data-mutability");
    expect(mut("hook")).toBe("IMMUTABLE");
    expect(mut("bitmap")).toBe("IMMUTABLE");
    expect(mut("poolId")).toBe("IMMUTABLE");
    expect(mut("tickSpacing")).toBe("IMMUTABLE");
    expect(mut("hookCode")).toBe("UPGRADEABLE");
    expect(mut("vault")).toBe("UPGRADEABLE");
    expect(mut("router")).toBe("UPGRADEABLE");
    expect(mut("lpFee")).toBe("UPGRADEABLE");
    expect(mut("rangeBand")).toBe("TUNABLE");
    expect(container.querySelector('[data-row="lpFee"]')?.textContent).toContain("0.30%");
    expect(container.querySelector('[data-row="currency1"]')?.textContent).toContain("USDG · 6 dec");
  });
});
