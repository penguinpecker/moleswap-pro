/**
 * chain.config.test.ts — the address book must be EXACTLY the live deployment.
 *
 * There is NO canonical USDC on Robinhood Chain: both explorer entries named
 * "USD Coin" are 18-decimal fakes. The stable leg is USDG at SIX decimals.
 * These tests pin every live address byte-for-byte and prove the module never
 * resolves a token by symbol.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as chain from "../../lib/mole/chain";
import {
  WETH,
  USDG,
  TOKENS,
  tokenByAddress,
  MOLE_ADDRESSES,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_RPC_URL,
  robinhoodChain,
  LIVE_POOL_ID,
  LIVE_POOL_KEY,
  LIVE_POOL_DECIMALS,
  DYNAMIC_FEE_FLAG,
} from "../../lib/mole/chain";

/* Live deployment, as given — the single source of truth for this suite. */
const LIVE = {
  moleHook: "0xb2c9A0af48dF8858F3765385E733Cd8776a138C4",
  molePositions: "0x674625B6E6a2614ef6e247aF099BEA2e65e1536A",
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  poolId: "0x9aca9d2f4bb68ef41e6928bbe080a4b076b167e2d4b7fdebf4b4fd5d6dadd029",
  chainId: 4663,
  rpc: "https://rpc.mainnet.chain.robinhood.com",
} as const;

describe("live addresses are pinned byte-for-byte", () => {
  it("MoleHook proxy", () => {
    expect(MOLE_ADDRESSES.moleHook).toBe(LIVE.moleHook);
  });
  it("MolePositions proxy", () => {
    expect(MOLE_ADDRESSES.molePositions).toBe(LIVE.molePositions);
  });
  it("Uniswap v4 PoolManager", () => {
    expect(MOLE_ADDRESSES.poolManager).toBe(LIVE.poolManager);
  });
  it("WETH at 18 decimals", () => {
    expect(WETH.address).toBe(LIVE.weth);
    expect(WETH.decimals).toBe(18);
  });
  it("USDG at SIX decimals — the most load-bearing constant in this UI", () => {
    expect(USDG.address).toBe(LIVE.usdg);
    expect(USDG.decimals).toBe(6);
  });
  it("chain id 4663 and the mainnet RPC", () => {
    expect(ROBINHOOD_CHAIN_ID).toBe(LIVE.chainId);
    expect(robinhoodChain.id).toBe(LIVE.chainId);
    expect(ROBINHOOD_RPC_URL).toBe(LIVE.rpc);
    expect(robinhoodChain.rpcUrls.default.http[0]).toBe(LIVE.rpc);
  });
  it("the live pool id", () => {
    expect(LIVE_POOL_ID).toBe(LIVE.poolId);
  });
});

describe("the live pool key", () => {
  it("currency0 is WETH and currency1 is USDG — and that IS the address sort order", () => {
    expect(LIVE_POOL_KEY.currency0).toBe(WETH.address);
    expect(LIVE_POOL_KEY.currency1).toBe(USDG.address);
    // v4 requires currency0 < currency1; if this flips, every PoolKey the UI builds hashes to a different pool id.
    expect(BigInt(LIVE_POOL_KEY.currency0) < BigInt(LIVE_POOL_KEY.currency1)).toBe(true);
  });
  it("tick spacing 60, hook wired to the MoleHook proxy", () => {
    expect(LIVE_POOL_KEY.tickSpacing).toBe(60);
    expect(LIVE_POOL_KEY.hooks).toBe(LIVE.moleHook);
  });
  it("fee field is the dynamic-fee sentinel 0x800000, not a static tier", () => {
    expect(DYNAMIC_FEE_FLAG).toBe(0x800000);
    expect(LIVE_POOL_KEY.fee).toBe(0x800000);
  });
  it("LIVE_POOL_DECIMALS mirrors the token metadata in currency order (18, 6)", () => {
    expect(LIVE_POOL_DECIMALS.decimals0).toBe(WETH.decimals);
    expect(LIVE_POOL_DECIMALS.decimals1).toBe(USDG.decimals);
    expect(LIVE_POOL_DECIMALS.decimals0).toBe(18);
    expect(LIVE_POOL_DECIMALS.decimals1).toBe(6);
  });
});

describe("ATTACK: token resolution must be by ADDRESS, never by symbol", () => {
  it("the module exports no symbol-based resolver", () => {
    const fnNames = Object.entries(chain)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k);
    for (const name of fnNames) {
      expect(name).not.toMatch(/symbol/i);
    }
  });

  it("tokenByAddress is case-insensitive on the address", () => {
    expect(tokenByAddress(WETH.address.toLowerCase())).toBe(WETH);
    expect(tokenByAddress("0x" + LIVE.usdg.slice(2).toUpperCase())).toBe(USDG);
  });

  it("an unknown impostor address resolves to NOTHING — no fuzzy fallback", () => {
    expect(tokenByAddress("0x" + "11".repeat(20))).toBeUndefined();
    expect(tokenByAddress("0x" + "00".repeat(20))).toBeUndefined();
  });

  it("the registry contains exactly WETH and USDG, and neither claims to be USDC", () => {
    expect(TOKENS.length).toBe(2);
    expect(TOKENS.map((t) => t.symbol).sort()).toEqual(["USDG", "WETH"]);
    for (const t of TOKENS) {
      expect(t.symbol.toUpperCase()).not.toBe("USDC");
      expect(t.name.toLowerCase()).not.toContain("usd coin");
    }
  });

  it("every registry entry carries explicit decimals matching the live tokens", () => {
    for (const t of TOKENS) {
      if (t.address.toLowerCase() === LIVE.usdg.toLowerCase()) {
        expect(t.decimals).toBe(6);
      } else if (t.address.toLowerCase() === LIVE.weth.toLowerCase()) {
        expect(t.decimals).toBe(18);
      } else {
        throw new Error(`Unexpected token in registry: ${t.symbol} ${t.address}`);
      }
    }
  });

  it('ATTACK: no executable code in lib/mole mentions USDC or "USD Coin" (comments may warn; code may not)', () => {
    // Resolved from the project root, NOT from `import.meta.url`. The suite runs under
    // `environment: 'jsdom'`, where import.meta.url is not a file:// URL, so `fileURLToPath` threw
    // before this test ever read a byte — it had been failing on its own plumbing rather than on the
    // property it asserts, which is the worst way for a security test to be broken: loudly, but for
    // a reason nobody connects to what it guards.
    const moleDir = path.resolve(process.cwd(), "lib/mole");
    const files = readdirSync(moleDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const source = readFileSync(path.join(moleDir, f), "utf8");
      const codeOnly = source
        .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
        .replace(/\/\/.*$/gm, ""); // line comments
      expect(codeOnly, `${f} must not reference USDC in executable code`).not.toMatch(/usdc/i);
      expect(codeOnly, `${f} must not reference "USD Coin" in executable code`).not.toMatch(
        /usd\s*coin/i
      );
    }
  });
});
