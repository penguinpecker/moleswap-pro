/**
 * navBarMenu.test.tsx — the mobile menu closes itself.
 *
 * It used to stay open over the hero and the swap card through a route change, Escape and taps
 * elsewhere on the page; only the X closed it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

const nav = { path: "/dapp" };
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/components/ConnectWalletButton", () => ({ ConnectWalletButton: () => null }));
vi.mock("@/components/ChainSwitcher", () => ({ ChainSwitcher: () => null }));

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount() {
  const { NavBar } = await import("../../screens/shared");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const render = () => act(() => root!.render(<NavBar />));
  await render();
  const panel = () => host!.querySelector(".menu-panel") as HTMLElement;
  const burger = () => host!.querySelector(".burger") as HTMLButtonElement;
  const open = async () => act(() => burger().click());
  return { render, panel, burger, open };
}

describe("NavBar menu", () => {
  it("closes on Escape", async () => {
    const m = await mount();
    await m.open();
    expect(m.panel().hidden).toBe(false);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(m.panel().hidden).toBe(true);
  });

  it("closes on a press outside the chrome", async () => {
    const m = await mount();
    await m.open();
    expect(m.panel().hidden).toBe(false);
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    await act(async () => {
      outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(m.panel().hidden).toBe(true);
    outside.remove();
  });

  it("closes when the route changes", async () => {
    const m = await mount();
    await m.open();
    expect(m.panel().hidden).toBe(false);
    nav.path = "/pools";
    await m.render();
    expect(m.panel().hidden).toBe(true);
    nav.path = "/dapp";
  });
});
