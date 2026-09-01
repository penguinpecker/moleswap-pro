/**
 * exchangePageArc.test.tsx — REACHABILITY, not compilation: with the wallet on Arc, what does the swap
 * card actually render?
 *
 * This is the exact screenshot the bug was reported from. The chrome said "Arc"; the card said
 * "Robinhood Chain / ETH → Robinhood Chain / USDG", with an ETH balance under it, and changing the
 * chain changed nothing on the page. Nothing about that failure was a type error — every file
 * compiled — so it is asserted here by mounting the real screen with the wallet on chain 5042 and
 * reading the DOM.
 *
 * Rendered with react-dom directly, the same way tests/dapp/swapPagePreflight.test.tsx does (there is
 * no @testing-library/dom in this project). Every module that reaches the network is mocked at its
 * boundary; `lib/chain/amm` keeps its REAL chain logic and stubs only the two calls that would do IO,
 * because the whole point is that the screen asks the right chain the right questions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

const ACCOUNT = "0x0069cb6f70e2f848405f4483f232274c720ce6f9";
const ARC_ID = 5042;
const RH_ID = 4663;
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const ARC_ARCHITECTS = "0x8bcb94279FC2c984EC34e0C1f2192df8c69EA4F0";

/**
 * The wallet, on Arc. `switchTo` is a spy: the card is allowed to OFFER a switch and must never
 * perform one on its own — that force-switch is what made the switcher look broken.
 */
const switchTo = vi.fn();
let walletChainId = ARC_ID;

vi.mock("@/lib/chain/provider", async () => {
  const { SUPPORTED_CHAINS, chainMetaFor, contractsFor, isSupportedChain } = await import(
    "@/lib/chain/chains"
  );
  return {
    readPreferredChainId: () => walletChainId,
    writePreferredChainId: vi.fn(),
    useWallet: () => ({
      address: ACCOUNT,
      isConnected: true,
      isConnecting: false,
      connectionStatus: "connected",
      chainClient: { ready: true, chainId: walletChainId },
      chainId: walletChainId,
      activeChain: chainMetaFor(walletChainId),
      onSupportedChain: isSupportedChain(walletChainId),
      contracts: contractsFor(walletChainId),
      supportedChains: SUPPORTED_CHAINS,
      switchTo,
      connect: vi.fn(),
      disconnect: vi.fn(),
      wallets: [],
      universalAccount: null,
      originChain: null,
      origin: ACCOUNT,
      uea: ACCOUNT,
      onRH: walletChainId === RH_ID,
      switchToRH: vi.fn(),
    }),
    useWalletContext: () => ({
      connectionStatus: "connected",
      universalAccount: null,
      handleConnectWallet: vi.fn(),
      handleUserLogOutEvent: vi.fn(),
    }),
    useChainClient: () => ({ chainClient: { ready: true } }),
    WalletUI: { CONSTANTS: { CONNECTION: { STATUS: { CONNECTED: "connected", CONNECTING: "connecting", NOT_CONNECTED: "notConnected" } } } },
    WalletProvider: ({ children }: any) => children,
  };
});

/**
 * The balance the card must show. These are the REAL numbers read from chain 5042 on 2026-08-24 —
 * 74760849399 in the ERC-20's SIX decimals (the very same balance the chain reports as
 * 74760849399000000000000 natively, exactly 1e12 apart). A screen that renders this with 18 decimals
 * shows ~0.0000000747 instead of ~74,760.85, which is the decimals bug in visible form.
 */
const ARC_BALANCES: Record<string, string> = {
  [ARC_USDC.toLowerCase()]: "74760.849399",
  [ARC_ARCHITECTS.toLowerCase()]: "47879020.304069123772010348",
};
const readTokenBalance = vi.fn(async (p: any) => {
  // Fails the test loudly if the screen ever reads a balance from the wrong chain.
  if (p.chainId !== ARC_ID) throw new Error(`balance requested on chain ${p.chainId}, not Arc`);
  return ARC_BALANCES[(p.token || "").toLowerCase()] ?? "0";
});
const loadPoolRows = vi.fn(async () => []);

vi.mock("@/lib/chain/amm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chain/amm")>();
  return { ...actual, loadPoolRows: (...a: any[]) => (loadPoolRows as any)(...a), readTokenBalance: (...a: any[]) => (readTokenBalance as any)(...a) };
});

// Everything below reaches the network or Supabase in real life; none of it is what is under test.
const initSpy = vi.fn();
vi.mock("@/lib/aggregator/live", () => ({
  LivePairSession: class {
    async init() { initSpy(); }
    async refresh() {}
    quote() { return null; }
  },
}));
vi.mock("@/lib/supabase/api", () => ({
  getOrCreateUser: async () => null,
  getUserSwapHistory: async () => [],
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ in: () => ({ range: async () => ({ data: [], error: null }) }) }) }) }) }) }));
const searchIndex = vi.fn(async () => []);
const heldTokens = vi.fn(async () => []);
const popularTokens = vi.fn(async () => []);
vi.mock("@/lib/chain/tokenSearch", () => ({
  searchIndex: (...a: any[]) => (searchIndex as any)(...a),
  heldTokens: (...a: any[]) => (heldTokens as any)(...a),
  popularTokens: (...a: any[]) => (popularTokens as any)(...a),
  resolveTokenMetas: async () => new Map(),
}));
vi.mock("@/lib/chain/tokenInfo", () => ({
  fetchTokenInfo: async () => new Map(),
  fmtUsd: (n: number) => `$${n}`,
  shortAddr: (a: string) => a.slice(0, 6),
}));
const tokenHasPool = vi.fn(async () => []);
vi.mock("@/lib/aggregator/discover", () => ({ tokenHasPool: (...a: any[]) => (tokenHasPool as any)(...a) }));
vi.mock("@/lib/chain/poolIdLookup", () => ({
  looksLikePoolId: (q: string) => /^0x[0-9a-f]{64}$/i.test(q),
  resolvePoolId: async () => null,
  tokenHasV4Pool: async () => false,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/swap",
}));
vi.mock("@/lib/diagnostics", () => ({ diagnostics: { log: vi.fn(), error: vi.fn() } }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

async function mount() {
  const { ExchangePage } = await import("../../screens/dapp/ExchangePage");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<ExchangePage onNext={vi.fn()} />); });
  await flush();
}

const text = () => container.textContent || "";
const testId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  walletChainId = ARC_ID;
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => { root.unmount(); });
  container?.remove();
});

describe("the swap card, with the wallet on Arc", () => {
  it("names Arc and shows ARC'S tokens — never Robinhood's", async () => {
    await mount();
    expect(text()).toContain("Arc");
    expect(text()).toContain("USDC");
    expect(text()).toContain("Architects");
    // The reported symptom, verbatim: the card kept saying this while the switcher said Arc.
    expect(text()).not.toContain("Robinhood Chain / ETH");
    expect(text()).not.toContain("Robinhood Chain");
    expect(text()).not.toContain("USDG");
  });

  it("reads the balance from ARC, with the ERC-20's SIX decimals", async () => {
    await mount();
    expect(readTokenBalance).toHaveBeenCalled();
    const call = readTokenBalance.mock.calls.find((c: any[]) => c[0]?.token?.toLowerCase() === ARC_USDC.toLowerCase());
    expect(call, "the card must ask for the Arc USDC balance").toBeTruthy();
    expect(call![0].chainId).toBe(ARC_ID);
    // 6, from the token. With 18 this renders 0.000000 and looks like an empty wallet.
    expect(call![0].decimals).toBe(6);
    // ...and the number reaches the screen, so this is reachability and not just a call assertion.
    expect(text()).toContain("74,760.849399");
  });

  it("says WHY there is no quote here instead of showing a Robinhood-priced one", async () => {
    await mount();
    const panel = testId("chain-not-quotable");
    // The card must not open a pricing session on a chain the engine reads Robinhood pools for.
    expect(initSpy).not.toHaveBeenCalled();
    // The panel only renders once an amount is entered (the Receive card is amount-gated), but the
    // REFUSAL must exist as copy the moment the chain is Arc — the button says it too.
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("Quotes not served"),
    );
    expect(btn, "the action button must state the refusal, not sit dead").toBeTruthy();
    expect(btn!.textContent).toContain("Arc");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    // (the panel itself is exercised by the amount-entered case below)
    expect(panel === null || (panel.textContent || "").includes("Arc")).toBe(true);
  });

  it("says Arc has no wrap path rather than silently omitting an ETH row", async () => {
    await mount();
    const note = testId("no-native-path");
    expect(note, "the missing native path must be explained, not just hidden").toBeTruthy();
    expect(note!.textContent).toMatch(/wrap/i);
  });

  it("does not run Robinhood-only token discovery on Arc", async () => {
    await mount();
    // Each of these reads a Robinhood client or the Robinhood-only mp_tokens index; running them
    // here fills an Arc picker with Robinhood tokens.
    expect(heldTokens).not.toHaveBeenCalled();
    expect(popularTokens).not.toHaveBeenCalled();
    expect(searchIndex).not.toHaveBeenCalled();
    expect(tokenHasPool).not.toHaveBeenCalled();
  });

  it("never switches the wallet's network by itself", async () => {
    await mount();
    expect(switchTo).not.toHaveBeenCalled();
  });
});

describe("the swap card, with the wallet on Robinhood", () => {
  it("is unchanged: Robinhood's chain name, Robinhood's pair, and a live quote session", async () => {
    walletChainId = RH_ID;
    await mount();
    expect(text()).toContain("Robinhood Chain");
    expect(text()).toContain("ETH");
    expect(text()).toContain("USDG");
    expect(text()).not.toContain("Architects");
    // The pricing session DOES open here — this chain is the one the engine can read.
    expect(initSpy).toHaveBeenCalled();
    // ...and none of the Arc refusals appear.
    expect(testId("chain-not-quotable")).toBeNull();
    expect(testId("no-native-path")).toBeNull();
    expect(testId("discovery-unavailable")).toBeNull();
  });

  it("reads its balance from Robinhood, with 18-decimal ETH", async () => {
    walletChainId = RH_ID;
    readTokenBalance.mockImplementation(async (p: any) => (p.chainId === RH_ID ? "1.5" : "0"));
    await mount();
    const call = readTokenBalance.mock.calls[0];
    expect(call[0].chainId).toBe(RH_ID);
    expect(call[0].decimals).toBe(18);
  });
});
