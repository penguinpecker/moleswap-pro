/**
 * providerWalletChain.test.tsx — `useWallet().chainId` is the chain the WALLET is on.
 *
 * `useChainId()` only ever answers with a configured chain, so with it alone a wallet parked on Ethereum
 * read as "Robinhood": the pill, balances and quote rendered Robinhood's, and the wrong-network state was
 * unreachable. Also pins the connect button: Arc is a supported chain and must not be told to switch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

const acct: { isConnected: boolean; chainId?: number; address?: string } = { isConnected: false };

vi.mock("wagmi", () => ({
  WagmiProvider: ({ children }: { children: React.ReactNode }) => children,
  useAccount: () => ({ ...acct, isConnecting: false, isReconnecting: false }),
  useChainId: () => 4663,
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [] }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(async () => undefined) }),
}));
vi.mock("@/lib/chain/wagmi-config", () => ({ wagmiConfig: {}, robinhoodChain: { id: 4663 }, arcChain: { id: 5042 } }));

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function renderWallet(): Promise<any> {
  const { useWallet } = await import("../../lib/chain/provider");
  let seen: any = null;
  const Probe = () => {
    seen = useWallet();
    return null;
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Probe />));
  return seen;
}

async function renderButton(): Promise<string> {
  const { ConnectWalletButton } = await import("../../components/ConnectWalletButton");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<ConnectWalletButton />));
  return host.textContent ?? "";
}

describe("useWallet reports the wallet's chain", () => {
  it("a wallet on Ethereum is an UNSUPPORTED chain, not Robinhood", async () => {
    acct.isConnected = true;
    acct.chainId = 1;
    acct.address = "0x00000000000000000000000000000000000000a1";
    const w = await renderWallet();
    expect(w.chainId).toBe(1);
    expect(w.onSupportedChain).toBe(false);
    expect(w.activeChain).toBeUndefined();
  });

  it("a wallet on Arc is Arc", async () => {
    acct.isConnected = true;
    acct.chainId = 5042;
    acct.address = "0x00000000000000000000000000000000000000a1";
    const w = await renderWallet();
    expect(w.chainId).toBe(5042);
    expect(w.activeChain?.key).toBe("arc");
    expect(w.onSupportedChain).toBe(true);
  });

  it("disconnected, the config chain (the switcher's preference) answers", async () => {
    acct.isConnected = false;
    delete acct.chainId;
    delete acct.address;
    const w = await renderWallet();
    expect(w.chainId).toBe(4663);
  });
});

describe("ConnectWalletButton", () => {
  it("on Arc shows the address, not 'Switch to Robinhood'", async () => {
    acct.isConnected = true;
    acct.chainId = 5042;
    acct.address = "0x00000000000000000000000000000000000000a1";
    const text = await renderButton();
    expect(text).not.toMatch(/Switch to/);
    expect(text).toMatch(/0x0000\.\.\.00a1/);
  });

  it("on an unsupported chain offers ONE switch, to Robinhood", async () => {
    acct.isConnected = true;
    acct.chainId = 1;
    acct.address = "0x00000000000000000000000000000000000000a1";
    const text = await renderButton();
    expect(text).toMatch(/Switch to Robinhood/);
  });
});
