/**
 * borrowRefusal.test.tsx — a control that cannot work must SAY SO where the user is looking.
 *
 * Reported live: collateral $2.39, "Available to borrow $1.79", a green-looking Borrow button, and
 * pressing it did nothing. The refusal reason existed only in a `title` tooltip — which needs a hover
 * and never appears on a touch screen — while the one piece of red text in the row read "You hold no
 * USDG", which is about SUPPLYING and has nothing to do with borrowing. So the page showed a number
 * saying borrow, a button that looked pressable, and an explanation about a different action.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

const wallet = { address: "0x00000000000000000000000000000000000000a1" as string | undefined, chainId: 4663 };
vi.mock("@/lib/chain/provider", () => ({ useWallet: () => ({ ...wallet, switchTo: vi.fn() }) }));
vi.mock("@/screens/shared", () => ({ BackgroundImage: () => null, NavBar: () => null, MoleMascot: () => null }));
vi.mock("next/link", () => ({ default: ({ children }: any) => <a>{children}</a> }));

const RESERVES = [
  {
    symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6,
    aToken: "0x1", variableDebtToken: "0x2", borrowable: true, isWrappedNative: false,
    priceBase: 100000000n, supplyApy: 0, borrowApy: 0, ltvBps: 7200, liquidationThresholdBps: 7700,
  },
];
const POSITION = {
  totalCollateralBase: 238699290n, totalDebtBase: 0n, availableBorrowsBase: 179024467n,
  currentLiquidationThreshold: 8000n, ltv: 7500n, healthFactor: null,
  supplied: { USDG: 0n }, borrowed: { USDG: 0n }, walletBalance: { USDG: 0n },
};

const gate = { canBorrow: false };
vi.mock("@/lib/lending/market", async (orig) => {
  const actual = await orig<any>();
  return {
    ...actual,
    LENDING_ASSETS: RESERVES,
    readReserves: async () => RESERVES,
    readUserPosition: async () => POSITION,
    borrowPermitted: async () => gate.canBorrow,
    lendingAvailableOn: () => true,
    lendingUnavailableOn: () => null,
  };
});
vi.mock("@/lib/lending/actions", () => ({ supply: vi.fn(), withdraw: vi.fn(), borrow: vi.fn(), repay: vi.fn() }));

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

async function render() {
  const Mod = await import("../../screens/lend");
  const Page = (Mod as any).default ?? (Mod as any).LendPage;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Page />));
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return host!;
}

const buttonNamed = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll("button")].find((b) => (b.textContent || "").trim().toLowerCase() === name) as
    | HTMLButtonElement
    | undefined;

describe("borrowing while the gate is shut", () => {
  it("disables Borrow AND says why in the row, not only in a tooltip", async () => {
    gate.canBorrow = false;
    const el = await render();
    const borrow = buttonNamed(el, "borrow");
    expect(borrow, "a Borrow button for a borrowable reserve").toBeTruthy();
    expect(borrow!.disabled).toBe(true);
    const text = el.textContent || "";
    // the reason is VISIBLE text, not a title attribute
    expect(text.toLowerCase()).toMatch(/borrow: borrowing is paused/);
  });

  it("does not present borrowing power as spendable while borrowing is paused", async () => {
    gate.canBorrow = false;
    const el = await render();
    const text = el.textContent || "";
    expect(text).toMatch(/\$1\.79/); // the number is still shown — it is real borrowing power
    expect(text.toLowerCase()).toMatch(/paused — not borrowable now/); // but it is labelled
  });

  it("the supply refusal is labelled as being about supply, so it cannot be read as the row's state", async () => {
    gate.canBorrow = false;
    const el = await render();
    expect((el.textContent || "").toLowerCase()).toMatch(/supply: you hold no usdg/);
  });

  it("when the gate reopens, Borrow enables and the paused copy disappears", async () => {
    gate.canBorrow = true;
    const el = await render();
    const borrow = buttonNamed(el, "borrow");
    expect(borrow!.disabled).toBe(true); // still disabled: no amount typed yet
    const text = (el.textContent || "").toLowerCase();
    expect(text).not.toMatch(/borrowing is paused/);
    expect(text).not.toMatch(/paused — not borrowable now/);
  });
});
