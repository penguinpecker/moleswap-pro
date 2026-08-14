/**
 * settingsPanel.test.tsx — the panel must write what the quote path reads.
 *
 * The original defect was not that the buttons did nothing visually — they highlighted correctly — but
 * that the chosen value never left the component. These tests click the real buttons and then read the
 * value through the SAME function the quote path uses (getSlippageBps), so a regression that re-traps
 * the state in useState turns them RED. They also pin the labels, which must not change.
 *
 * Rendered with react-dom directly rather than @testing-library/react: that package is in
 * package.json but its @testing-library/dom peer is not installed, and adding a dependency is not
 * this change's business.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import Settings from "../../screens/settings";
import { getSlippageBps, readSwapSettings } from "../../lib/settings/swapSettings";

vi.mock("next/navigation", () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const mount = () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<Settings setShowSettings={vi.fn()} />);
  });
};

const unmount = () => {
  act(() => root.unmount());
  container.remove();
};

/** Every element whose own text is exactly `text` (buttons and headings, not their wrappers). */
const nodesWithText = (text: string): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>("h3, button, span")).filter(
    (el) => el.textContent?.trim() === text,
  );

const clickText = (text: string) => {
  const el = nodesWithText(text)[0];
  if (!el) throw new Error(`no element with text "${text}" — the panel's labels changed`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  try {
    unmount();
  } catch {
    /* already unmounted by the test */
  }
});

describe("Swap Settings panel", () => {
  it("still offers exactly the labels it always has", () => {
    mount();
    for (const label of ["Route Priority", "Max Slippage", "Gas Price", "Bridges", "Exchanges"]) {
      expect(nodesWithText(label).length).toBeGreaterThan(0);
    }
  });

  it("choosing 0.5 persists it and the quote path reads 50 bps", () => {
    mount();
    clickText("Max Slippage"); // expand the card
    clickText("0.5");
    expect(readSwapSettings().maxSlippage).toBe("0.5");
    expect(getSlippageBps()).toBe(50);
  });

  it("the choice survives closing and reopening the panel", () => {
    mount();
    clickText("Max Slippage");
    clickText("0.5");
    unmount();

    mount();
    // The collapsed card shows the stored value rather than resetting to AUTO.
    expect(nodesWithText("0.5").length).toBeGreaterThan(0);
    expect(getSlippageBps()).toBe(50);
  });

  it("Route Priority and Gas Price persist too (still not honoured on-chain — see swapSettings.ts)", () => {
    mount();
    clickText("Route Priority");
    clickText("FASTEST");
    clickText("Gas Price");
    clickText("FAST");
    unmount();

    mount();
    expect(readSwapSettings().routePriority).toBe("FASTEST");
    expect(readSwapSettings().gasPrice).toBe("FAST");
    expect(nodesWithText("FASTEST").length).toBeGreaterThan(0);
    expect(nodesWithText("FAST").length).toBeGreaterThan(0);
  });
});
