/**
 * poolsPageChain.test.tsx — /pools is about the chain the wallet is ON, proven by mounting it.
 *
 * WHY THIS IS A RENDER TEST AND NOT A SOURCE READ. The pieces were all present and all correct:
 * `getAlmPositions(owner, chainId)` has taken a chain since the vault lane; `/api/v1/pools?chainId=`
 * has served Arc correctly for as long; `chains.ts` has said `AVAILABILITY.pools[5042] = true`. The
 * defect was purely in the wiring — the page called `getAlmPositions(address)` with no chain and
 * fetched `/api/v1/pools` with no query — so every per-half test passed while a user on Arc was shown
 * ROBINHOOD's positions under a header that said Arc. Only mounting the page can see that.
 *
 * EVERY FIXTURE BELOW IS LIVE STATE, read with `cast` on 2026-08-24:
 *   Arc 5042 / MolePositions 0x8e6bB60d6A75e0390Ee3Da2b280aec2e39769D77
 *     positionsOf(0xe456…C8C8) → [1,2,3,4,5]; only #2 has liquidity, 225918744401430, in pool
 *     0x180a035b… over ticks 335700→341700.
 *   Robinhood 4663 / MolePositions 0x674625B6E6a2614ef6e247aF099BEA2e65e1536A
 *     funded: #3 and #4 in 0x9aca9d2f… (WETH/USDG), #7 in 0xf54b7c66… (WETH/USDG, spacing 10),
 *     #11 in 0xb93693d6… (CASHCAT/WETH), liquidity 299176808053457542.
 *
 * Rendered with react-dom directly, as the other screen tests here are. Everything that would touch a
 * wallet, an RPC or the network is stubbed; the chain plumbing under test is real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";

const OWNER = "0xe4563270a72a9418f97dbb631E1696eDCC8bC8C8";

const h = vi.hoisted(() => ({
  wallet: { chainId: 4663 } as { chainId: number },
  getAlmPositions: vi.fn(),
  almWithdraw: vi.fn(),
  switchTo: vi.fn(async (_id: number) => undefined),
  /** Every URL the page fetched, so the chain scoping of the pool list can be asserted. */
  fetched: [] as string[],
  readSlot0: vi.fn(async () => null),
}));

/* ── the two chain-aware calls this page makes ───────────────────────────────────────────────── */
vi.mock("@/lib/mole/vault", () => ({
  getAlmPositions: (...a: any[]) => h.getAlmPositions(...a),
  almWithdraw: (...a: any[]) => h.almWithdraw(...a),
}));

/* ── the wallet ──────────────────────────────────────────────────────────────────────────────── */
vi.mock("@/lib/chain/provider", () => ({
  useWallet: () => ({
    address: OWNER,
    isConnected: true,
    chainId: h.wallet.chainId,
    switchTo: h.switchTo,
  }),
  useWalletContext: () => ({ connectionStatus: "connected", handleConnectWallet: vi.fn() }),
  useChainClient: () => ({ chainClient: { ready: true } }),
  WalletUI: { CONSTANTS: { CONNECTION: { STATUS: { CONNECTED: "connected", NOT_CONNECTED: "notConnected" } } } },
}));

/* ── everything that would reach the network or the chrome ───────────────────────────────────── */
vi.mock("../../screens/shared", () => ({ BackgroundImage: () => null, NavBar: () => null, MoleMascot: () => null }));
vi.mock("../../screens/pools/ProvenanceCard", () => ({ ProvenanceCard: () => null }));
vi.mock("@/lib/mole/useOracleHealth", () => ({ useOracleHealth: () => ({ oracle: null, cross: null }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({ select: () => ({ in: async () => ({ data: [] }) }) }) }) }));
// The slot0 top-up is a real RPC read; the pool list already carries every tick these assertions need.
vi.mock("@/lib/mole/poolsSurface", async (importOriginal) => {
  const real = (await importOriginal()) as any;
  return { ...real, readSlot0: (...a: any[]) => h.readSlot0(...(a as [])) };
});
vi.mock("@/lib/chain/amm", () => ({
  CONTRACTS: {}, TOKENS: [], POOLS: [],
  getTokenByAddress: () => undefined,
  findPool: () => undefined,
  getSwapQuote: vi.fn(),
  getProvider: () => { throw new Error("getProvider() is Robinhood-pinned — /pools must not call it"); },
  getPoolDisplayInfo: (t: any) => ({ symbol: t.symbol, subtitle: t.name }),
  AMM_ROUTER: "0x", AMM_FACTORY: "0x", RH_CHAIN_ID: 4663,
  collectFees: vi.fn(), addLiquidity: vi.fn(), addLiquidityOneSided: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", async () => {
  const R = await import("react");
  return { default: ({ href, children, ...rest }: any) => R.createElement("a", { href: String(href), ...rest }, children) };
});

import PoolsPage from "../../screens/pools";

/* ── live pool rows, exactly as /api/v1/pools returns them ───────────────────────────────────── */
const RH_POOLS = {
  chainId: 4663,
  chain: "Robinhood Chain",
  pools: [
    {
      poolId: "0x9aca9d2f4bb68ef41e6928bbe080a4b076b167e2d4b7fdebf4b4fd5d6dadd029",
      address: "", name: "WETH/USDG", fee: 8388608, hooks: "0xb2c9a0af48df8858f3765385e733cd8776a138c4",
      tickSpacing: 60, category: "mains",
      token0: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH", name: "Wrapped Ether", decimals: 18, logoURI: "" },
      token1: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", name: "USDG", decimals: 6, logoURI: "" },
      tick: -200461, sqrtPriceX96: "3516913918323387370479071", liquidity: "5902740233402",
      reserve0: 5.77269287457e-7, reserve1: 7.742399, tvlUsd: 7.7435, hasLiquidity: true,
    },
    {
      poolId: "0xf54b7c6690cdfb8629ea2bc66dacd29640e86b4847b13eeb019e4f033550fbe9",
      address: "", name: "WETH/USDG", fee: 8388608, hooks: "0xb2c9a0af48df8858f3765385e733cd8776a138c4",
      tickSpacing: 10, category: "mains",
      token0: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH", name: "Wrapped Ether", decimals: 18, logoURI: "" },
      token1: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", name: "USDG", decimals: 6, logoURI: "" },
      tick: -199626, sqrtPriceX96: "3666719348529695901558467", liquidity: "703176249668",
      reserve0: 0.000004386828932657, reserve1: 3.088257, tvlUsd: 3.0969, hasLiquidity: true,
    },
    {
      poolId: "0xb93693d680d3373b836c5fe174cb26f078e28175eb20c6f571a93ffb8e3206f9",
      address: "", name: "CASHCAT/WETH", fee: 8388608, hooks: "0xb2c9a0af48df8858f3765385e733cd8776a138c4",
      tickSpacing: 60, category: "memes",
      token0: { address: "0x020bfC650A365f8BB26819deAAbF3E21291018b4", symbol: "CASHCAT", name: "Cash Cat", decimals: 18, logoURI: "" },
      token1: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH", name: "Wrapped Ether", decimals: 18, logoURI: "" },
      tick: -95365, sqrtPriceX96: "673224846095506887879740520", liquidity: "299176808053457542",
      reserve0: 10.747995267541713, reserve1: 0.000533900142940854, tvlUsd: 2.104, hasLiquidity: true,
    },
  ],
};

const ARC_POOLS = {
  chainId: 5042,
  chain: "Arc",
  pools: [
    {
      poolId: "0x180a035b0d60290514969d7c9dc169cad5fad5c423295848130be25e82f31796",
      address: "", name: "USDC/Architects", fee: 8388608, hooks: "0xfFDCBf2f5b53C0fa2c5D7d25A87F99514Fbe78c4",
      tickSpacing: 60, category: "memes",
      token0: { address: "0x3600000000000000000000000000000000000000", symbol: "USDC", name: "USD Coin", decimals: 6, logoURI: "" },
      token1: { address: "0x8bcb94279FC2c984EC34e0C1f2192df8c69EA4F0", symbol: "Architects", name: "Architects", decimals: 18, logoURI: "" },
      tick: 337203, sqrtPriceX96: "1662636954788188540831530787255765628", liquidity: "225918744401430",
      reserve0: 2.167414, reserve1: 343.35144456948166, tvlUsd: 4.334828, hasLiquidity: true,
    },
  ],
};

/** Live ALM positions, per chain. Only the funded ones — `getAlmPositions` drops liquidity == 0. */
const POSITIONS: Record<number, any[]> = {
  4663: [
    { id: "3", owner: OWNER, poolId: RH_POOLS.pools[0].poolId, tickLower: -201060, tickUpper: -200460, liquidity: 4976312705240n, openedAtL1Block: 25698554n, fullRange: false },
    { id: "4", owner: OWNER, poolId: RH_POOLS.pools[0].poolId, tickLower: -201060, tickUpper: -200460, liquidity: 926427528162n, openedAtL1Block: 25698554n, fullRange: false },
    { id: "7", owner: OWNER, poolId: RH_POOLS.pools[1].poolId, tickLower: -201620, tickUpper: -199620, liquidity: 703176249668n, openedAtL1Block: 25719049n, fullRange: false },
    { id: "11", owner: OWNER, poolId: RH_POOLS.pools[2].poolId, tickLower: -100080, tickUpper: -88080, liquidity: 299176808053457542n, openedAtL1Block: 25745108n, fullRange: false },
  ],
  5042: [
    { id: "2", owner: OWNER, poolId: ARC_POOLS.pools[0].poolId, tickLower: 335700, tickUpper: 341700, liquidity: 225918744401430n, openedAtL1Block: 17099956n, fullRange: false },
  ],
};

let container: HTMLDivElement;
let root: Root;

const text = () => container.textContent ?? "";
// The remove/collect modals render through createPortal into document.body, so buttons are looked up
// across the whole document rather than inside the mount container.
const buttons = () => [...document.body.querySelectorAll("button")] as HTMLButtonElement[];
const byText = (re: RegExp) => buttons().find((b) => re.test(b.textContent || ""))!;
const flush = async () => {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

async function mount(chainId: number) {
  h.wallet.chainId = chainId;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<PoolsPage />); });
  await flush();
}

/** Click Positions and let the position read resolve. */
async function openPositions() {
  await act(async () => { byText(/^Positions$/).click(); });
  await flush();
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  h.fetched = [];
  h.getAlmPositions.mockReset();
  h.almWithdraw.mockReset();
  h.switchTo.mockClear();
  h.readSlot0.mockClear();
  h.getAlmPositions.mockImplementation(async (_owner: string, chainId?: number) => POSITIONS[chainId as number] ?? []);
  h.almWithdraw.mockResolvedValue({ success: true, txHash: "0x" + "ab".repeat(32) });
  (global.fetch as any) = vi.fn(async (url: string) => {
    h.fetched.push(String(url));
    const chainId = Number(new URL(String(url), "http://x").searchParams.get("chainId"));
    const body = chainId === 5042 ? ARC_POOLS : chainId === 4663 ? RH_POOLS : null;
    if (!body) return { ok: false, status: 400, json: async () => ({ success: false }) };
    return { ok: true, status: 200, json: async () => ({ success: true, data: body }) };
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the pool list is the ACTIVE chain's", () => {
  it("on Arc it asks for chain 5042 and lists Arc's pool", async () => {
    await mount(5042);
    // The regression in one line: the page used to fetch "/api/v1/pools" with no chain, which the
    // endpoint answers for Robinhood by documented default.
    expect(h.fetched.some((u) => u.includes("chainId=5042"))).toBe(true);
    expect(h.fetched.every((u) => !u.includes("chainId=4663"))).toBe(true);
    expect(text()).toContain("USDC/Architects");
    expect(text()).not.toContain("CASHCAT");
    // And the page says which chain it is showing, in its footer and on every row badge.
    expect(text()).toContain("Concentrated liquidity on Arc");
  });

  it("on Robinhood it asks for 4663 and lists all three Robinhood pools", async () => {
    await mount(4663);
    expect(h.fetched.some((u) => u.includes("chainId=4663"))).toBe(true);
    expect(text()).toContain("CASHCAT/WETH");
    expect(text()).toContain("WETH/USDG");
    expect(text()).toContain("Concentrated liquidity on Robinhood Chain");
  });
});

describe("the positions list is the ACTIVE chain's", () => {
  it("on Arc: the ONE live Arc position, read from Arc's vault", async () => {
    await mount(5042);
    await openPositions();
    expect(h.getAlmPositions).toHaveBeenCalled();
    // The defect, precisely: this second argument was missing, so vault.ts fell back to Robinhood.
    expect(h.getAlmPositions.mock.calls[0]![1]).toBe(5042);
    expect(text()).toContain("NFT #2");
    expect(text()).toContain("1 position");
    // Robinhood's ids must not appear on Arc — that is the wrong list this whole change is about.
    for (const id of ["NFT #3", "NFT #4", "NFT #7", "NFT #11"]) expect(text()).not.toContain(id);
    // Labelled with the pool it is actually in, at that pool's own decimals.
    expect(text()).toContain("USDC/Architects");
    expect(text()).toContain("Arc");
    /**
     * AND THE AMOUNTS ARE IN ARC'S DECIMALS, which is the part that is not cosmetic.
     *
     * Liquidity 225918744401430 over ticks 335700→341700 at the pool's tick 337203 is 2.1678 of the
     * 6-decimal leg and 343.2005 of the 18-decimal one — matching /api/v1/pools' own reserves for this
     * pool (2.167414 / 343.35), which is derived independently on the server. Formatted with Robinhood's
     * WETH/USDG decimals instead (18 and 6) the very same numbers read 0.000002 and 343200520.4475: a
     * 1e12 error, in the figures somebody reads before deciding whether to exit.
     */
    expect(text()).toContain("2.1678");
    expect(text()).toContain("343.2005");
    expect(text()).not.toContain("343200520");
    // The live top-up read is aimed at Arc too — Robinhood's StateView knows nothing of this PoolId.
    expect(h.readSlot0).toHaveBeenCalled();
    for (const call of h.readSlot0.mock.calls) expect((call as any[])[0]).toBe(5042);
  });

  it("on Robinhood: the four funded positions, each labelled with ITS OWN pool", async () => {
    await mount(4663);
    await openPositions();
    expect(h.getAlmPositions.mock.calls[0]![1]).toBe(4663);
    for (const id of ["NFT #3", "NFT #4", "NFT #7", "NFT #11"]) expect(text()).toContain(id);
    expect(text()).toContain("4 positions");
    // #11 is a CASHCAT/WETH position. Every position used to be labelled with the first pool in the
    // Robinhood registry, so this one read as WETH/USDG — with the wrong token's decimals under it.
    expect(text()).toContain("CASHCAT/WETH");
    expect(text()).not.toContain("NFT #2");
    // #11's own decimals (18/18) against its own pool's tick -95365 — 10.7481 CASHCAT, matching the
    // reserves /api/v1/pools derives for that pool on the server (10.747995).
    expect(text()).toContain("10.7481");
    for (const call of h.readSlot0.mock.calls) expect((call as any[])[0]).toBe(4663);
  });

  it("the exit is sent to the chain the position was read from", async () => {
    await mount(5042);
    await openPositions();
    await act(async () => { byText(/Exit position/).click(); });
    await flush();
    // The modal's confirm.
    await act(async () => { byText(/Confirm remove/).click(); });
    await flush();
    expect(h.almWithdraw).toHaveBeenCalledWith("2", 5042);
  });

  it("a refusal that names a network comes with a button that switches to it", async () => {
    h.almWithdraw.mockResolvedValue({
      success: false,
      // Verbatim from vault.ts `walletChainMismatch` — the sentence that used to arrive with no button.
      error: "Your wallet is on Robinhood Chain, but this position lives on Arc. Switch networks and try again — nothing was submitted.",
    });
    await mount(5042);
    await openPositions();
    await act(async () => { byText(/Exit position/).click(); });
    await flush();
    await act(async () => { byText(/Confirm remove/).click(); });
    await flush();
    const prompt = container.querySelector('[data-testid="position-chain-mismatch"]');
    expect(prompt, "a chain-mismatch refusal must offer the switch, not just describe it").not.toBeNull();
    const btn = container.querySelector('[data-testid="switch-to-5042"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    await act(async () => { btn.click(); });
    expect(h.switchTo).toHaveBeenCalledWith(5042);
  });
});

describe("a chain with no pools is refused with a way out", () => {
  it("on an unsupported network the page explains and offers both live chains", async () => {
    await mount(1);
    expect(container.querySelector('[data-testid="no-pools-here"]')).not.toBeNull();
    // No list is fetched at all — asking without a chain is what got Robinhood's answer.
    expect(h.fetched.length).toBe(0);
    expect(text()).toContain("MoleSwap runs no pools on");
    for (const id of [4663, 5042]) {
      expect(container.querySelector(`[data-testid="switch-to-${id}"]`)).not.toBeNull();
    }
    const btn = container.querySelector('[data-testid="switch-to-5042"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(h.switchTo).toHaveBeenCalledWith(5042);
  });

  it("and it never asks the vault for positions there — vaultChainForOrThrow would throw", async () => {
    await mount(1);
    await act(async () => {
      const tab = buttons().find((b) => /^Positions$/.test(b.textContent || ""));
      tab?.click();
    });
    await flush();
    expect(h.getAlmPositions).not.toHaveBeenCalled();
  });
});

describe("the + Liquidity link keeps the chain", () => {
  it("points at /vault with NO chain pinned in the href — the vault reads the wallet's chain", async () => {
    await mount(5042);
    const link = container.querySelector("a.liq-btn") as HTMLAnchorElement;
    expect(link, "Arc's MoleHook pool must offer + Liquidity").not.toBeNull();
    expect(link.getAttribute("href")).toBe("/vault");
    // A pinned chain in the URL would be the same bug wearing a different hat: /vault resolves through
    // vaultChainFor(useWallet().chainId), so a hard-coded 4663 in the link would either be ignored (and
    // mislead whoever reads it) or, if ever honoured, drag an Arc user back to Robinhood.
    expect(link.getAttribute("href")).not.toContain("4663");
    expect(link.dataset.chainId).toBe("5042");
  });

  it("and the destination really does take its chain from the wallet — the other half of that claim", () => {
    // The link above is only honest because /vault resolves through vaultChainFor(useWallet().chainId).
    // If the vault screen ever went back to a pinned chain or started reading one out of the URL, an
    // Arc user clicking + Liquidity would land on a Robinhood deposit form — and nothing else in either
    // lane's tests would notice, because each half would still be correct on its own.
    const src = readFileSync(path.join(process.cwd(), "screens/vault/index.tsx"), "utf8");
    expect(src).toMatch(/useWallet\(\)/);
    expect(src).toMatch(/vaultChainFor\(chainId\)/);
    expect(src).toMatch(/getAlmPositions\(address,\s*cfg\.chainId\)/);
  });
});
