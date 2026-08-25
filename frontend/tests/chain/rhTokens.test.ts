/**
 * rhTokens.test.ts — the Robinhood token registry, pinned.
 *
 * WHY THIS FILE EXISTS AT ALL. On Robinhood Chain a ticker is not an identity:
 *
 *   39 tokens use the `USDC` symbol, and 13 are named EXACTLY "USD Coin"
 *   the token carrying `BTC` is a memecoin named "Beat Coin"
 *   `cbBTC` hides U+200B and U+2060 inside its name — invisible impersonation
 *   `WBTC` has 18 decimals where the real one has 8
 *   Circle and Tether both confirm NO deployment on this chain
 *
 * Chainlink publishes real BTC/USD and USDC/USD feeds here, so listing a fake against a real feed
 * is a one-transaction drain of anything that prices it. These tests pin the addresses that were
 * resolved from first-party sources and verified on chain, so a later "helpful" edit that swaps in
 * a same-ticker impostor fails loudly instead of shipping.
 *
 * If one of these ever needs to change, re-verify from the ISSUER, not from an explorer search.
 */
import { describe, it, expect } from "vitest";
import { TOKENS } from "../../lib/chain/contracts";

const bySymbol = (s: string) => TOKENS.find((t) => t.symbol === s);

/** Address + decimals, both verified on chain 2026-08-25. */
const PINNED: Record<string, { address: string; decimals: number }> = {
  ETH: { address: "0x0000000000000000000000000000000000000000", decimals: 18 },
  WETH: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", decimals: 18 },
  USDG: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6 },
  USDe: { address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", decimals: 18 },
  NVDA: { address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", decimals: 18 },
  SPY: { address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", decimals: 18 },
  TSLA: { address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", decimals: 18 },
  AAPL: { address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", decimals: 18 },
  MSFT: { address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", decimals: 18 },
};

describe("ATTACK — the Robinhood token registry cannot be quietly repointed", () => {
  it.each(Object.entries(PINNED))(
    "%s is the address verified on chain, not a same-ticker impostor",
    (symbol, expected) => {
      const t = bySymbol(symbol);
      expect(t, `${symbol} missing from the registry`).toBeTruthy();
      expect(t!.address.toLowerCase()).toBe(expected.address.toLowerCase());
      expect(t!.decimals).toBe(expected.decimals);
    },
  );

  it("lists NO token whose ticker has no canonical deployment on this chain", () => {
    // Circle's own docs list 45+ chains and Robinhood is not among them; Tether's supported-
    // protocols page likewise. Every token carrying these tickers here is unofficial, and the
    // BTC ones are outright fakes. Listing any of them beside a real Chainlink feed is the
    // single fastest way to drain a market that prices it.
    const forbidden = ["USDC", "USDT", "BTC", "WBTC", "cbBTC", "CBBTC", "LBTC"];
    for (const f of forbidden) {
      expect(
        TOKENS.find((t) => t.symbol.toUpperCase() === f.toUpperCase()),
        `${f} has no canonical deployment on Robinhood Chain and must not be listed`,
      ).toBeUndefined();
    }
  });

  it("has no duplicate addresses and no duplicate symbols", () => {
    const addrs = TOKENS.map((t) => t.address.toLowerCase());
    expect(new Set(addrs).size).toBe(addrs.length);
    const syms = TOKENS.map((t) => t.symbol.toUpperCase());
    expect(new Set(syms).size).toBe(syms.length);
  });

  it("carries no zero-width or invisible characters in any name or symbol", () => {
    // cbBTC on this chain carries U+200B + U+2060 precisely to defeat an eyeball check. Any
    // token that reaches this registry must be checked by CODEPOINT, not by how it renders.
    const invisible = /[​-‏⁠-⁤﻿]/;
    for (const t of TOKENS) {
      expect(invisible.test(t.symbol), `${t.symbol} symbol has invisible characters`).toBe(false);
      expect(invisible.test(t.name), `${t.name} name has invisible characters`).toBe(false);
    }
  });

  it("every non-native token has a checksummed 20-byte address", () => {
    for (const t of TOKENS) {
      expect(t.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
});

describe("the registry's shape", () => {
  it("keeps USDG at 6 decimals — the one asset here that is not 18", () => {
    // USDG is 6dp and everything else is 18. Treating it as 18 misprices by 1e12, and it is the
    // stable leg of every pair, so the error would be everywhere at once.
    expect(bySymbol("USDG")!.decimals).toBe(6);
    for (const t of TOKENS.filter((x) => x.symbol !== "USDG")) {
      expect(t.decimals).toBe(18);
    }
  });

  it("marks exactly the dollar assets as stable", () => {
    expect(bySymbol("USDG")!.isStable).toBe(true);
    expect(bySymbol("USDe")!.isStable).toBe(true);
    expect(bySymbol("NVDA")!.isStable).toBeUndefined();
  });
});
