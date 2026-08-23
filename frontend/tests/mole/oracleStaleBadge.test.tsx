/**
 * oracleStaleBadge.test.tsx — the one rendering of the one stale state: it says ORACLE_STALE_COPY, it
 * carries the age, and it is the same component on every surface (the copy guard in oracle.test.ts
 * proves nobody bypasses it). Rendered with react-dom directly, the way settingsPanel.test.tsx does —
 * no @testing-library/dom in this tree.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { OracleStaleBadge } from "../../screens/shared/OracleStale";
import { ORACLE_STALE_COPY } from "../../lib/mole/oracle";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("OracleStaleBadge", () => {
  it("renders the shared copy and the observation age (the live pool's 62h on 2026-08-22)", () => {
    act(() => {
      root.render(<OracleStaleBadge ageSec={223_108} />);
    });
    const el = container.querySelector('[data-testid="oracle-stale"]')!;
    expect(el).not.toBeNull();
    expect(el.textContent).toContain(ORACLE_STALE_COPY);
    expect(el.textContent).toContain("61h 58m");
    expect(el.getAttribute("title")).toMatch(/61h 58m/);
    expect(el.getAttribute("title")).toMatch(/last tick, extended/);
  });

  it("a never-observed pool reads 'never' rather than a number", () => {
    act(() => {
      root.render(<OracleStaleBadge ageSec={Number.POSITIVE_INFINITY} />);
    });
    expect(container.querySelector('[data-testid="oracle-stale"]')!.textContent).toContain("never");
  });
});
