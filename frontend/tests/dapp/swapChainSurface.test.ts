/**
 * swapChainSurface.test.ts — the swap surface must describe the chain the WALLET is on, not Robinhood.
 *
 * THE BUG THESE PIN. The chrome's switcher said "Arc"; the swap card said "Robinhood Chain / ETH →
 * Robinhood Chain / USDG" with an ETH balance under it, and changing chains changed nothing. Three
 * separate hard-codes caused it, and each one is asserted here:
 *
 *   1. `getChains()` returned a hardcoded single-element Robinhood array.
 *   2. `ExchangePage` set `chainId` to the string "4663" on every token pick, with a comment saying
 *      "Single chain — always set chainId to 4663 (Robinhood Chain)".
 *   3. `amm.ts` built one Robinhood provider and called `wallet_switchEthereumChain` to drag the
 *      wallet BACK to Robinhood the moment the user pressed a button.
 *
 * EVERY ARC NUMBER BELOW WAS READ FROM CHAIN 5042 through https://www.moleswap.com/rpc/v1/arc on
 * 2026-08-24, not copied from a note:
 *   0x3600…0000  symbol() "USDC"        decimals() 6
 *   0x8bcb9427…  symbol() "Architects"  decimals() 18   name() "Architects"
 *   MoleRouter 0xe419…f3e3  weth() → 0x3600…0000  (the USDC ERC-20, NOT a wrapper and NOT 0x0)
 *   The gas balance of one holder read 74760849399000000000000 natively and 74760849399 through the
 *   ERC-20 — exactly 1e12 apart, one balance under two decimal conventions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { getChains, getTokensForChain, chainEntryFor, defaultPairFor } from "@/lib/chain/tokenList";
import {
  getProvider,
  routerFor,
  quotingUnavailableOn,
  nativePathUnavailableOn,
  swapChainStatus,
  preflightRpcUrls,
} from "@/lib/chain/amm";
import { ARC_CHAIN, RH_CHAIN, contractsFor } from "@/lib/chain/chains";

const ARC_USDC_ADDR = "0x3600000000000000000000000000000000000000";
const ARC_ARCHITECTS_ADDR = "0x8bcb94279fc2c984ec34e0c1f2192df8c69ea4f0";
const ARC_ROUTER = "0xe4192c72574e6e387d4c29eb89feceada105f3e3";
const ZERO = "0x0000000000000000000000000000000000000000";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("getChains(): every supported chain, each with its OWN tokens", () => {
  it("returns BOTH chains — not a hardcoded single-element Robinhood array", async () => {
    const chains = await getChains();
    expect(chains.map((c) => c.id)).toEqual([RH_CHAIN.id, ARC_CHAIN.id]);
  });

  it("gives Arc its own tokens, at Arc's decimals, read back from chain 5042", async () => {
    const arc = chainEntryFor(await getChains(), ARC_CHAIN.id)!;
    expect(arc).toBeDefined();
    const tokens = getTokensForChain(arc);
    const bySymbol = new Map(tokens.map((t) => [t.symbol, t]));

    expect(bySymbol.get("USDC")?.address.toLowerCase()).toBe(ARC_USDC_ADDR);
    // SIX. This is the decimals count the pool — and therefore every amount on the card — uses.
    // Rendering Arc's USDC with 18 would misprice the card by twelve orders of magnitude.
    expect(bySymbol.get("USDC")?.decimals).toBe(6);
    expect(bySymbol.get("Architects")?.address.toLowerCase()).toBe(ARC_ARCHITECTS_ADDR);
    expect(bySymbol.get("Architects")?.decimals).toBe(18);
  });

  it("never puts Robinhood's assets on Arc", async () => {
    const arc = chainEntryFor(await getChains(), ARC_CHAIN.id)!;
    const symbols = getTokensForChain(arc).map((t) => t.symbol);
    expect(symbols).not.toContain("ETH");
    expect(symbols).not.toContain("WETH");
    expect(symbols).not.toContain("USDG");
  });

  it("lists Arc's gas token ONCE — its native and its ERC-20 are one balance, not two assets", async () => {
    const arc = chainEntryFor(await getChains(), ARC_CHAIN.id)!;
    const tokens = getTokensForChain(arc);
    // Two rows for one balance would let a user try to swap USDC for USDC: a trade with no
    // counterparty, against a pool that cannot exist.
    expect(tokens.filter((t) => t.symbol === "USDC")).toHaveLength(1);
    // ...and NOT as a 0x0 native row: a transfer to the zero address reverts on Arc.
    expect(tokens.some((t) => t.address.toLowerCase() === ZERO)).toBe(false);
    expect(arc.currency?.address?.toLowerCase()).toBe(ARC_USDC_ADDR);
    expect(arc.currency?.decimals).toBe(6);
    // The other convention is recorded, not lost: eth_getBalance reports the same money with 18.
    expect(arc.nativeDecimals).toBe(18);
  });

  it("says Arc has no wrapped native, in a sentence — a hidden control alone is indistinguishable from a bug", async () => {
    const chains = await getChains();
    const arc = chainEntryFor(chains, ARC_CHAIN.id)!;
    const rh = chainEntryFor(chains, RH_CHAIN.id)!;
    expect(arc.wrappedNative).toBeNull();
    expect(arc.nativePathUnavailable).toBeTruthy();
    expect(arc.nativePathUnavailable).toMatch(/wrap/i);
    // Robinhood DOES have one, so it must not carry the refusal.
    expect(rh.wrappedNative?.toLowerCase()).toBe("0x0bd7d308f8e1639fab988df18a8011f41eacad73");
    expect(rh.nativePathUnavailable).toBeNull();
  });

  it("gives each chain a default pair drawn from its own tokens", async () => {
    const chains = await getChains();
    for (const c of chains) {
      const pair = defaultPairFor(c);
      const addrs = getTokensForChain(c).map((t) => t.address.toLowerCase());
      expect(addrs, `${c.name} from`).toContain(pair.from.toLowerCase());
      expect(addrs, `${c.name} to`).toContain(pair.to.toLowerCase());
      expect(pair.from.toLowerCase()).not.toBe(pair.to.toLowerCase());
    }
    const arc = chainEntryFor(chains, ARC_CHAIN.id)!;
    expect(defaultPairFor(arc).from.toLowerCase()).toBe(ARC_USDC_ADDR);
    expect(defaultPairFor(arc).to.toLowerCase()).toBe(ARC_ARCHITECTS_ADDR);
    // Robinhood's default pair is unchanged: ETH → USDG, exactly what the card always opened on.
    const rh = chainEntryFor(chains, RH_CHAIN.id)!;
    expect(defaultPairFor(rh).from.toLowerCase()).toBe(ZERO);
    expect(defaultPairFor(rh).to.toLowerCase()).toBe("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
  });

  it("carries a gas buffer on whichever token actually pays for gas, in that token's decimals", async () => {
    const chains = await getChains();
    const arcUsdc = getTokensForChain(chainEntryFor(chains, ARC_CHAIN.id)!).find((t) => t.symbol === "USDC")!;
    const rhTokens = getTokensForChain(chainEntryFor(chains, RH_CHAIN.id)!);
    // Arc's swap leg IS the gas balance, so MAX must keep something back or the user cannot pay for
    // the transaction that spends it. 0.05 USDC in SIX decimals.
    expect(arcUsdc.gasBuffer).toBe("50000");
    // Robinhood: native ETH keeps a buffer, the ERC-20s do not — unchanged behaviour.
    expect(rhTokens.find((t) => t.symbol === "ETH")?.gasBuffer).toBe("300000000000000");
    expect(rhTokens.find((t) => t.symbol === "USDG")?.gasBuffer).toBeUndefined();
    expect(rhTokens.find((t) => t.symbol === "WETH")?.gasBuffer).toBeUndefined();
  });
});

describe("amm.ts resolves its chain instead of pinning Robinhood", () => {
  it("builds its provider from the ACTIVE chain's RPC", () => {
    // URL only, asserted synchronously: this harness has no network, and the point being pinned is
    // WHICH endpoint the provider was constructed against, not what that endpoint replies.
    const arc = getProvider(ARC_CHAIN.id);
    const rh = getProvider();
    try {
      expect((arc as any)._getConnection().url).toBe(ARC_CHAIN.rpcUrl);
      // Omitting the chain still means Robinhood — every pre-multichain caller depends on that.
      expect((rh as any)._getConnection().url).toBe(RH_CHAIN.rpcUrl);
      expect((arc as any)._getConnection().url).not.toBe((rh as any)._getConnection().url);
    } finally {
      arc.destroy();
      rh.destroy();
    }
  });

  it("aims at the ACTIVE chain's router — an approval to the wrong one is a fund-loss bug", () => {
    expect(routerFor(ARC_CHAIN.id).toLowerCase()).toBe(ARC_ROUTER);
    expect(routerFor(RH_CHAIN.id).toLowerCase()).toBe(contractsFor(RH_CHAIN.id).MOLE_ROUTER.toLowerCase());
    expect(routerFor().toLowerCase()).toBe(contractsFor(RH_CHAIN.id).MOLE_ROUTER.toLowerCase());
    expect(routerFor(ARC_CHAIN.id).toLowerCase()).not.toBe(routerFor(RH_CHAIN.id).toLowerCase());
  });

  it("pre-flights against the chain's own RPCs, and does not claim a second provider it does not have", () => {
    expect(preflightRpcUrls(ARC_CHAIN.id)).toEqual([ARC_CHAIN.rpcUrl]);
    expect(preflightRpcUrls(RH_CHAIN.id).length).toBeGreaterThanOrEqual(1);
    expect(preflightRpcUrls(RH_CHAIN.id)[0]).toBe(RH_CHAIN.rpcUrl);
  });

  it("refuses to price a chain the off-chain engine cannot see, and says why", () => {
    expect(quotingUnavailableOn(RH_CHAIN.id)).toBeNull();
    const why = quotingUnavailableOn(ARC_CHAIN.id);
    expect(why).toBeTruthy();
    // The refusal has to be actionable, not "unsupported": it names the chain, admits the router IS
    // live there, and explains that the alternative would be a confident wrong number.
    expect(why).toContain(ARC_CHAIN.name);
    expect(why!.toLowerCase()).toContain("wrong");
  });

  it("throws rather than returning null when asked to quote an unpriceable chain", async () => {
    const { getSwapQuote, prepareSwap } = await import("@/lib/chain/amm");
    // `null` is this module's word for "no route", which is a claim about the MARKET. "We cannot
    // price this chain" is a claim about us. Sharing a return value between them is the exact
    // confusion that made a quoter regression look like an illiquid pair.
    await expect(
      getSwapQuote({ tokenIn: ARC_USDC_ADDR, tokenOut: ARC_ARCHITECTS_ADDR, amountIn: "1000000", chainId: ARC_CHAIN.id }),
    ).rejects.toThrow(/Arc/);
    await expect(
      prepareSwap({
        tokenIn: ARC_USDC_ADDR,
        tokenOut: ARC_ARCHITECTS_ADDR,
        amountIn: "1000000",
        recipient: "0x00000000000000000000000000000000000000a1",
        chainId: ARC_CHAIN.id,
      }),
    ).rejects.toThrow(/Arc/);
  });

  it("knows Arc has no native path, and Robinhood does", () => {
    // Read live on 2026-08-24: Arc's MoleRouter.weth() returns the USDC ERC-20, so every native code
    // path fails closed. The registry records that as the zero address — "this chain has no wrapper".
    expect(contractsFor(ARC_CHAIN.id).WETH).toBe(ZERO);
    expect(nativePathUnavailableOn(ARC_CHAIN.id)).toBeTruthy();
    expect(nativePathUnavailableOn(RH_CHAIN.id)).toBeNull();
  });

  it("REPORTS a wrong-chain wallet and offers a switch — it never performs one", () => {
    const ok = swapChainStatus(RH_CHAIN.id, RH_CHAIN.id);
    expect(ok.ok).toBe(true);

    const mismatch = swapChainStatus(RH_CHAIN.id, ARC_CHAIN.id);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.offer).toEqual({ chainId: ARC_CHAIN.id, name: ARC_CHAIN.name });
      expect(mismatch.reason).toContain(ARC_CHAIN.name);
    }

    const unsupported = swapChainStatus(1, undefined);
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) {
      // Naming the chains that DO work is the whole point: "unsupported network" tells a user nothing.
      expect(unsupported.reason).toContain(RH_CHAIN.name);
      expect(unsupported.offer?.chainId).toBe(RH_CHAIN.id);
    }
  });
});

describe("the Robinhood pins are gone from the source, not merely bypassed", () => {
  it("amm.ts no longer switches the user's network behind their back", () => {
    const src = read("lib/chain/amm.ts");
    // Comments explaining the removal are fine; a call is not. Strip line comments before matching.
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
      .join("\n");
    expect(code).not.toContain("wallet_switchEthereumChain");
    expect(code).not.toContain("wallet_addEthereumChain");
  });

  it("ExchangePage no longer hardcodes 4663 anywhere it can act on", () => {
    const src = read("screens/dapp/ExchangePage.tsx");
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
      .join("\n");
    expect(code).not.toContain('"4663"');
    expect(code).not.toContain("|| 4663");
    // ...and the comment that justified it is gone with it.
    expect(src).not.toContain("Single chain — always set chainId to 4663");
  });

  it("ExchangePage reads the wallet's chain and resets the pair when it changes", () => {
    const src = read("screens/dapp/ExchangePage.tsx");
    expect(src).toMatch(/walletState\.activeChain\?\.id/);
    // The reset itself: the active chain's default pair is applied, keyed on the chain entry.
    expect(src).toMatch(/defaultPairFor\(chainEntry\)/);
    expect(src).toMatch(/appliedChainRef/);
  });

  it("ExchangePage reads balances from the active chain's RPC, not the Robinhood-pinned helper", () => {
    const src = read("screens/dapp/ExchangePage.tsx");
    // lib/wallet/walletClient.ts builds every public client on Robinhood's RPC whatever chainId it is
    // handed, so a balance "on Arc" came back as a Robinhood balance. That is the ETH balance in the
    // bug report, and this screen must not go through it.
    expect(src).not.toContain("@/lib/wallet/walletClient");
    expect(src).toMatch(/readTokenBalance\(\{/);
  });
});
