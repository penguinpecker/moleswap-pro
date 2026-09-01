/**
 * poolsSurface.test.ts — the /pools screen's chain resolver, pinned to the live deployments.
 *
 * Everything asserted here was read off the two chains on 2026-08-24 with `cast`, not copied from a
 * note:
 *
 *   Arc (5042)        MolePositions 0x8e6bB60d6A75e0390Ee3Da2b280aec2e39769D77
 *                     positionCount 5; ids 1..5 all owned by 0xe456…C8C8; only #2 has liquidity
 *                     (225918744401430) and it sits in pool
 *                     0x180a035b0d60290514969d7c9dc169cad5fad5c423295848130be25e82f31796,
 *                     ticks 335700→341700.
 *   Robinhood (4663)  MolePositions 0x674625B6E6a2614ef6e247aF099BEA2e65e1536A
 *                     funded positions 3, 4 (pool 0x9aca9d2f…, WETH/USDG), 7 (pool 0xf54b7c66…,
 *                     WETH/USDG at tickSpacing 10) and 11 (pool 0xb93693d6…, CASHCAT/WETH).
 *
 * The last of those is the point of `pairForPoolId`. Position 11 is a CASHCAT/WETH position; the page
 * used to label EVERY position with the first pool in the Robinhood registry, so it read as WETH/USDG
 * — with WETH's 18 decimals used to format a CASHCAT amount.
 */
import { describe, it, expect } from "vitest";
import {
  poolsChainView,
  poolsProvider,
  pairForPoolId,
  vaultPoolFor,
  DEFAULT_POOLS_CHAIN_ID,
  type ListedPool,
} from "@/lib/mole/poolsSurface";
import { ARC_CHAIN, RH_CHAIN } from "@/lib/chain/chains";

const ARC_POOL = "0x180a035b0d60290514969d7c9dc169cad5fad5c423295848130be25e82f31796";
const RH_ALM_POOL = "0x9aca9d2f4bb68ef41e6928bbe080a4b076b167e2d4b7fdebf4b4fd5d6dadd029";
const RH_CASHCAT_POOL = "0xb93693d680d3373b836c5fe174cb26f078e28175eb20c6f571a93ffb8e3206f9";
const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

/** The CASHCAT/WETH row exactly as /api/v1/pools?chainId=4663 returns it. */
const CASHCAT_ROW: ListedPool = {
  poolId: RH_CASHCAT_POOL,
  token0: { address: CASHCAT, symbol: "CASHCAT", name: "Cash Cat", decimals: 18 },
  token1: { address: WETH, symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
  fee: 8388608,
  tickSpacing: 60,
  tick: -95365,
};

describe("which chain the pools surface is about", () => {
  it("Robinhood and Arc both run pools, and each names itself", () => {
    expect(poolsChainView(RH_CHAIN.id)).toMatchObject({ chainId: 4663, name: "Robinhood Chain", live: true });
    expect(poolsChainView(ARC_CHAIN.id)).toMatchObject({ chainId: 5042, name: "Arc", live: true });
  });

  it("an unsupported chain is NOT quietly answered for Robinhood — it reports itself, and not live", () => {
    const view = poolsChainView(1);
    expect(view.live).toBe(false);
    expect(view.chainId).toBe(1);
    // The failure being guarded: `name` reading "Robinhood Chain" over Ethereum, which is how the page
    // came to render one chain's pools under another chain's heading.
    expect(view.name).not.toContain("Robinhood");
    expect(view.explorerUrl).toBeNull();
  });

  it("the switch prompt is offered BOTH live chains, so it can always be worded and wired", () => {
    for (const id of [1, RH_CHAIN.id, ARC_CHAIN.id]) {
      const ids = poolsChainView(id).alternatives.map((c) => c.id).sort();
      expect(ids).toEqual([RH_CHAIN.id, ARC_CHAIN.id].sort());
    }
  });

  it("no chain at all means the app's cold start, Robinhood — the same default as the API and the vault", () => {
    expect(poolsChainView(undefined).chainId).toBe(DEFAULT_POOLS_CHAIN_ID);
    expect(DEFAULT_POOLS_CHAIN_ID).toBe(RH_CHAIN.id);
  });
});

describe("the provider is the chain's own, or none at all", () => {
  it("each supported chain gets its OWN provider, pointed at its own RPC", () => {
    const rh = poolsProvider(RH_CHAIN.id)!;
    const arc = poolsProvider(ARC_CHAIN.id)!;
    expect(rh).not.toBe(arc);
    expect(rh._getConnection().url).toBe(RH_CHAIN.rpcUrl);
    expect(arc._getConnection().url).toBe(ARC_CHAIN.rpcUrl);
    // The RPCs are genuinely different endpoints — this is the whole difference between reading Arc
    // and reading Robinhood while calling it Arc.
    expect(RH_CHAIN.rpcUrl).not.toBe(ARC_CHAIN.rpcUrl);
    // And the same chain hands back the same provider rather than a socket per render.
    expect(poolsProvider(ARC_CHAIN.id)).toBe(arc);
  });

  it("ATTACK: an unsupported chain gets NULL, never Robinhood's provider", () => {
    // Returning Robinhood here is what made an Arc balance read as zero: a real balance, read on the
    // wrong chain, is indistinguishable from an empty wallet.
    expect(poolsProvider(1)).toBeNull();
  });
});

describe("which pool a position is actually in", () => {
  it("a listed pool wins, with ITS OWN tokens — the CASHCAT/WETH position is not WETH/USDG", () => {
    const pair = pairForPoolId(RH_CASHCAT_POOL, [CASHCAT_ROW], RH_CHAIN.id);
    expect(pair).not.toBeNull();
    expect(pair!.token0.symbol).toBe("CASHCAT");
    expect(pair!.token1.symbol).toBe("WETH");
    expect(pair!.tick).toBe(-95365);
  });

  it("matching is case-insensitive on the id — the vault returns a checksum-cased poolId", () => {
    expect(pairForPoolId(RH_CASHCAT_POOL.toUpperCase().replace("0X", "0x"), [CASHCAT_ROW], RH_CHAIN.id))
      .not.toBeNull();
  });

  it("Arc's ALM pool resolves from the vault registry even with NO pool list, at 6/18 decimals", () => {
    const pair = pairForPoolId(ARC_POOL, [], ARC_CHAIN.id);
    expect(pair).not.toBeNull();
    // Arc puts the six-decimal leg on currency0 and Robinhood puts it on currency1. A pair guessed from
    // a registry rather than matched by PoolId is wrong by 1e12 on one of the two chains.
    expect(pair!.token0.decimals).toBe(6);
    expect(pair!.token1.decimals).toBe(18);
    expect(pair!.token0.address.toLowerCase()).toBe("0x3600000000000000000000000000000000000000");
    expect(pair!.token1.address.toLowerCase()).toBe("0x8bcb94279fc2c984ec34e0c1f2192df8c69ea4f0");
    // Not read yet — and null, never 0, because 0 is a real tick meaning a price of 1.0.
    expect(pair!.tick).toBeNull();
  });

  it("Robinhood's ALM pool resolves the same way, with the six-decimal leg on the OTHER side", () => {
    const pair = pairForPoolId(RH_ALM_POOL, [], RH_CHAIN.id);
    expect(pair).not.toBeNull();
    expect(pair!.token0.decimals).toBe(18);
    expect(pair!.token1.decimals).toBe(6);
  });

  it("ATTACK: Arc's pool id must NOT resolve against Robinhood, and Robinhood's must not against Arc", () => {
    expect(pairForPoolId(ARC_POOL, [], RH_CHAIN.id)).toBeNull();
    expect(pairForPoolId(RH_ALM_POOL, [], ARC_CHAIN.id)).toBeNull();
  });

  it("an unknown pool is NULL — the page prints the id rather than borrowing another pool's tokens", () => {
    expect(pairForPoolId("0x" + "11".repeat(32), [CASHCAT_ROW], RH_CHAIN.id)).toBeNull();
    expect(pairForPoolId(undefined, [CASHCAT_ROW], RH_CHAIN.id)).toBeNull();
    expect(pairForPoolId("", [], RH_CHAIN.id)).toBeNull();
  });
});

describe("the pool the vault manages, per chain", () => {
  it("each chain reports its own vault pool and its own pair label", () => {
    expect(vaultPoolFor(RH_CHAIN.id)!.poolId.toLowerCase()).toBe(RH_ALM_POOL);
    expect(vaultPoolFor(RH_CHAIN.id)!.label).toBe("WETH/USDG");
    expect(vaultPoolFor(ARC_CHAIN.id)!.poolId.toLowerCase()).toBe(ARC_POOL);
    // Named from the tokens themselves, so the sentence a user reads matches what their wallet shows.
    expect(vaultPoolFor(ARC_CHAIN.id)!.label).toBe("USDC/Architects");
  });

  it("a chain with no vault has no pool — null, not Robinhood's", () => {
    expect(vaultPoolFor(1)).toBeNull();
  });
});
