/**
 * vaultChain.test.ts — the ALM's per-chain address book must be the LIVE deployment on BOTH chains.
 *
 * The bug this suite exists to prevent is not a typo, it is a lie: `chains.ts` advertised LP on Arc while
 * `vault.ts` pinned every read and every write to Robinhood and switched the user's wallet back to 4663
 * on each deposit. So this file checks two different things. First, that the resolved pool really is the
 * one that is whitelisted on chain — the PoolIds below were read back with `cast` against both RPCs on
 * 2026-08-24, and `MolePositions.isWhitelisted` returned true for each. Second, that the vault client
 * cannot quietly go back to being single-chain, which is a source check because there is no assertion
 * about behaviour that a hard-coded `robinhoodChain` would fail on a Robinhood-shaped test.
 *
 * The DECIMALS assertions are the load-bearing ones. Robinhood puts the 6-decimal leg at currency1 and Arc
 * puts it at currency0, so any code that learned "currency0 is the 18-decimal one" from the Robinhood pool
 * is wrong on Arc by 1e12.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_VAULT_CHAIN_ID,
  vaultChainFor,
  vaultChainForOrThrow,
  vaultChains,
  vaultTokensFor,
} from "../../lib/mole/vaultChain";
// Arc's two tokens are imported from the multi-chain registry, not from the vault module, because
// that is where they now live: `lib/mole/` is the Robinhood address book and may not name a "USDC"
// in executable code (chain.config.test.ts enforces it — Robinhood's USDCs are 18-decimal fakes).
// Asserting against the registry's constants also proves the vault did not quietly re-declare a
// second copy that could drift from the one the rest of the app resolves.
import { ARC_ARCHITECTS, ARC_USDC } from "../../lib/chain/arcTokens";
import { LIVE_POOL_ID, USDG, WETH } from "../../lib/mole/chain";
import { contractsFor } from "../../lib/chain/chains";
import { poolIdOf } from "../../lib/mole/poolId";

const RH = 4663;
const ARC = 5042;

/** Read back from chain on 2026-08-24; `isWhitelisted` is true for each on its own vault. */
const LIVE_POOL_IDS = {
  [RH]: "0x9aca9d2f4bb68ef41e6928bbe080a4b076b167e2d4b7fdebf4b4fd5d6dadd029",
  [ARC]: "0x180a035b0d60290514969d7c9dc169cad5fad5c423295848130be25e82f31796",
} as const;

describe("both chains resolve to the pool that is actually whitelisted", () => {
  for (const chainId of [RH, ARC] as const) {
    it(`chain ${chainId}: the computed PoolId is the live one`, () => {
      const cfg = vaultChainForOrThrow(chainId);
      expect(cfg.poolId).toBe(LIVE_POOL_IDS[chainId]);
      // and it is genuinely computed from the key beside it, not pasted next to a key it disagrees with
      expect(poolIdOf(cfg.poolKey)).toBe(cfg.poolId);
    });

    it(`chain ${chainId}: v4's currency0 < currency1 ordering holds`, () => {
      const cfg = vaultChainForOrThrow(chainId);
      expect(BigInt(cfg.poolKey.currency0) < BigInt(cfg.poolKey.currency1)).toBe(true);
      expect(cfg.poolKey.currency0).toBe(cfg.token0.address);
      expect(cfg.poolKey.currency1).toBe(cfg.token1.address);
    });

    it(`chain ${chainId}: addresses come from the ONE registry, not a second copy`, () => {
      const cfg = vaultChainForOrThrow(chainId);
      const c = contractsFor(chainId);
      expect(cfg.positions).toBe(c.MOLE_POSITIONS);
      expect(cfg.hook).toBe(c.MOLE_HOOK);
      expect(cfg.poolManager).toBe(c.POOL_MANAGER);
      // the hook is part of the pool's identity, so the key must carry the registry's hook too
      expect(cfg.poolKey.hooks).toBe(c.MOLE_HOOK);
    });

    it(`chain ${chainId}: the dynamic-fee sentinel and tick spacing match the live key`, () => {
      const cfg = vaultChainForOrThrow(chainId);
      expect(cfg.poolKey.fee).toBe(0x800000);
      expect(cfg.poolKey.tickSpacing).toBe(60);
      expect(cfg.tickSpacing).toBe(60);
    });
  }

  it("Robinhood's config is still the pool the rest of the app pins", () => {
    expect(vaultChainForOrThrow(RH).poolId).toBe(LIVE_POOL_ID);
  });
});

describe("decimals, which are the 1e12 fund-loss surface", () => {
  it("Robinhood is WETH(18)/USDG(6)", () => {
    const cfg = vaultChainForOrThrow(RH);
    expect(cfg.token0).toEqual(WETH);
    expect(cfg.token1).toEqual(USDG);
    expect(cfg.token0.decimals).toBe(18);
    expect(cfg.token1.decimals).toBe(6);
  });

  it("Arc is USDC(6)/Architects(18) — the SIX-decimal leg is on the OTHER side", () => {
    const cfg = vaultChainForOrThrow(ARC);
    expect(cfg.token0).toEqual(ARC_USDC);
    expect(cfg.token1).toEqual(ARC_ARCHITECTS);
    expect(cfg.token0.decimals).toBe(6);
    expect(cfg.token1.decimals).toBe(18);
  });

  it("so 'currency0 is the 18-decimal one' is false across the two chains", () => {
    expect(vaultChainForOrThrow(RH).token0.decimals).not.toBe(vaultChainForOrThrow(ARC).token0.decimals);
  });

  it("Arc's USDC is the ERC-20 facade at 0x3600…0000, which is the only view the vault pulls through", () => {
    expect(ARC_USDC.address).toBe("0x3600000000000000000000000000000000000000");
    expect(ARC_USDC.decimals).toBe(6);
  });

  it("both Arc legs call themselves what the chain calls them", () => {
    // Read on 2026-08-24: `name()` at 0x3600…0000 is "USDC", NOT "USD Coin", and both name() and
    // symbol() at 0x8bcb9427… are "Architects". A UI that prints a tidier name than the token's own
    // trains the user to trust a row their wallet will label differently.
    expect(ARC_USDC.name).toBe("USDC");
    expect(ARC_USDC.symbol).toBe("USDC");
    expect(ARC_ARCHITECTS.name).toBe("Architects");
    expect(ARC_ARCHITECTS.symbol).toBe("Architects");
  });

  it("every deposit token carries the decimals of the leg it actually lands in", () => {
    for (const chainId of [RH, ARC] as const) {
      const cfg = vaultChainForOrThrow(chainId);
      for (const d of cfg.depositTokens) {
        const leg =
          d.address.toLowerCase() === cfg.token0.address.toLowerCase() ? cfg.token0 : cfg.token1;
        expect(d.address.toLowerCase()).toBe(leg.address.toLowerCase());
        expect(d.decimals).toBe(leg.decimals);
      }
    }
  });
});

describe("the native deposit path is Robinhood's alone, and says so", () => {
  it("Robinhood offers exactly one native route, and it wraps into currency0", () => {
    const cfg = vaultChainForOrThrow(RH);
    const native = cfg.depositTokens.filter((d) => d.native);
    expect(native).toHaveLength(1);
    expect(native[0].address).toBe(cfg.token0.address); // ETH wraps to WETH, the pool's currency0
    expect(cfg.nativeDepositUnavailable).toBeNull();
  });

  it("Arc offers no native route at all — there is no WETH to wrap into", () => {
    const cfg = vaultChainForOrThrow(ARC);
    expect(cfg.depositTokens.some((d) => d.native)).toBe(false);
    // and the registry agrees: Arc's WETH slot is the zero address on purpose
    expect(contractsFor(ARC).WETH).toBe("0x0000000000000000000000000000000000000000");
  });

  it("Arc EXPLAINS the missing route rather than silently rendering one button fewer", () => {
    const why = vaultChainForOrThrow(ARC).nativeDepositUnavailable;
    expect(typeof why).toBe("string");
    expect((why as string).length).toBeGreaterThan(40);
  });
});

describe("the gas buffer, which on Arc is the difference between MAX and stranded", () => {
  it("each chain marks exactly one deposit token as the one that pays gas", () => {
    for (const chainId of [RH, ARC] as const) {
      const cfg = vaultChainForOrThrow(chainId);
      expect(cfg.depositTokens.filter((d) => d.gasBuffer > 0n)).toHaveLength(1);
    }
  });

  it("on Arc the gas token IS the USDC leg — one balance, so a true MAX would strand the user", () => {
    const cfg = vaultChainForOrThrow(ARC);
    const gasToken = cfg.depositTokens.find((d) => d.gasBuffer > 0n)!;
    expect(gasToken.address).toBe(ARC_USDC.address);
    // 6-decimal units, because that is the decimals of the token it is subtracted from
    expect(gasToken.gasBuffer).toBe(50_000n);
    expect(gasToken.decimals).toBe(6);
  });

  it("on Robinhood the buffer is on the NATIVE route, in 18-decimal wei", () => {
    const cfg = vaultChainForOrThrow(RH);
    const gasToken = cfg.depositTokens.find((d) => d.gasBuffer > 0n)!;
    expect(gasToken.native).toBe(true);
    expect(gasToken.decimals).toBe(18);
    expect(gasToken.gasBuffer).toBe(1_500_000_000_000_000n);
  });
});

describe("which leg is the dollar, so the chart cannot print a confidently wrong price", () => {
  it("Robinhood quotes WETH in USDG (currency1 is the dollar)", () => {
    expect(vaultChainForOrThrow(RH).usdLeg).toBe(1);
  });
  it("Arc quotes Architects in USDC (currency0 is the dollar) — the OTHER side", () => {
    expect(vaultChainForOrThrow(ARC).usdLeg).toBe(0);
  });
});

describe("resolution refuses rather than defaulting somewhere plausible", () => {
  it("an unsupported chain resolves to null, which is what lets a screen say so", () => {
    expect(vaultChainFor(1)).toBeNull();
    expect(vaultChainFor(8453)).toBeNull();
    expect(vaultTokensFor(1)).toBeNull();
  });

  it("undefined is NOT quietly read as Robinhood", () => {
    expect(vaultChainFor(undefined)).toBeNull();
  });

  it("the throwing form names the chains that do work, because 'unsupported' is not actionable", () => {
    let message = "";
    try {
      vaultChainForOrThrow(1);
    } catch (e: any) {
      message = String(e?.message ?? "");
    }
    expect(message).toContain("Robinhood Chain");
    expect(message).toContain("Arc");
  });

  it("vaultChains() lists both live chains, and the default is one of them", () => {
    expect(vaultChains().map((c) => c.id).sort()).toEqual([RH, ARC].sort());
    expect(vaultChainFor(DEFAULT_VAULT_CHAIN_ID)).not.toBeNull();
  });

  it("vaultTokensFor returns the two legs in currency order", () => {
    const pair = vaultTokensFor(ARC)!;
    expect(pair[0]).toEqual(ARC_USDC);
    expect(pair[1]).toEqual(ARC_ARCHITECTS);
  });
});

/* ---------------------------------------------- the regression this lane exists to prevent */

describe("the vault client cannot go back to being single-chain", () => {
  const root = path.resolve(__dirname, "../..");
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

  it("it never switches the user's wallet for them", () => {
    // The old ensureChain fired this on every deposit and withdrawal, which is how Arc LP became
    // unreachable while the app advertised it. A mismatch is now REPORTED, not corrected.
    // The QUOTED form only, because the header prose names the method it stopped calling and a bare
    // substring match would fail on the explanation rather than on the behaviour.
    expect(read("lib/mole/vault.ts")).not.toMatch(/["']wallet_switchEthereumChain["']/);
  });

  it("it pins neither the Robinhood chain object nor the Robinhood pool", () => {
    const src = read("lib/mole/vault.ts");
    expect(src).not.toMatch(/robinhoodChain/);
    expect(src).not.toMatch(/LIVE_POOL_ID/);
    expect(src).not.toMatch(/LIVE_POOL_KEY/);
    expect(src).not.toMatch(/ROBINHOOD_RPC_URL/);
  });

  it("it reads its addresses through vaultChain, and does read the wallet's real network", () => {
    const src = read("lib/mole/vault.ts");
    expect(src).toMatch(/from "\.\/vaultChain"/);
    expect(src).toMatch(/eth_chainId/);
  });

  it("the vault screen resolves the chain instead of gating on onRH", () => {
    const src = read("screens/vault/index.tsx");
    expect(src).toMatch(/vaultChainFor\(/);
    expect(src).not.toMatch(/onRH/);
    expect(src).not.toMatch(/switchToRH/);
    // and the swap link carries the chain it is actually on, not a literal 4663
    expect(src).not.toMatch(/toChainId=4663/);
  });
});
