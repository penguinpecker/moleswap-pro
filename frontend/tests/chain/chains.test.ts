import { describe, it, expect } from "vitest";
import {
  SUPPORTED_CHAINS,
  RH_CHAIN,
  ARC_CHAIN,
  chainMetaFor,
  isSupportedChain,
  contractsFor,
  isAvailable,
  chainsWith,
} from "@/lib/chain/chains";
import { CONTRACTS } from "@/lib/chain/contracts";

const ZERO = "0x0000000000000000000000000000000000000000";

describe("chain registry", () => {
  it("exposes exactly the two chains we have deployments on", () => {
    expect(SUPPORTED_CHAINS.map((c) => c.id)).toEqual([4663, 5042]);
  });

  it("resolves metadata by id and refuses anything else", () => {
    expect(chainMetaFor(4663)?.key).toBe("rh");
    expect(chainMetaFor(5042)?.key).toBe("arc");
    expect(chainMetaFor(1)).toBeUndefined();
    expect(chainMetaFor(undefined)).toBeUndefined();
    expect(isSupportedChain(1)).toBe(false);
    expect(isSupportedChain(5042)).toBe(true);
  });

  // The whole reason this module exists: an approval aimed at the wrong chain's router is a
  // fund-loss bug, so the two address sets must never overlap where they are both real.
  it("gives each chain its OWN router, never the other chain's", () => {
    const rh = contractsFor(4663);
    const arc = contractsFor(5042);
    expect(rh.MOLE_ROUTER.toLowerCase()).not.toBe(arc.MOLE_ROUTER.toLowerCase());
    expect(rh.MOLE_FEE_DIAL.toLowerCase()).not.toBe(arc.MOLE_FEE_DIAL.toLowerCase());
    expect(arc.MOLE_ROUTER.toLowerCase()).toBe("0xe4192c72574e6e387d4c29eb89feceada105f3e3");
  });

  it("keeps the Robinhood answer identical to the legacy flat registry", () => {
    // contracts.ts is still imported directly in dozens of places; if these ever drift, one of the
    // two is lying about the live deployment.
    const rh = contractsFor(4663);
    expect(rh.MOLE_ROUTER).toBe(CONTRACTS.MOLE_ROUTER);
    expect(rh.POOL_MANAGER).toBe(CONTRACTS.POOL_MANAGER);
    expect(rh.WETH).toBe(CONTRACTS.WETH);
    expect(rh.MOLE_POSITIONS).toBe(CONTRACTS.MOLE_POSITIONS);
  });

  it("defaults to Robinhood for an unknown or missing chain rather than returning nothing", () => {
    expect(contractsFor(undefined).MOLE_ROUTER).toBe(CONTRACTS.MOLE_ROUTER);
    expect(contractsFor(999999).MOLE_ROUTER).toBe(CONTRACTS.MOLE_ROUTER);
  });

  it("pins Arc's WETH to the zero address so no native path can half-work", () => {
    // Arc has no WETH. The deployed router's weth slot is pinned to the USDC ERC-20 precisely so a
    // native route fails closed; the client must not offer one either.
    expect(contractsFor(5042).WETH).toBe(ZERO);
  });

  it("reports availability conservatively — a product is live only where it is deployed", () => {
    expect(isAvailable("swap", 4663)).toBe(true);
    expect(isAvailable("swap", 5042)).toBe(true);
    // The ALM is Robinhood-only today, and lending is not deployed anywhere yet.
    expect(isAvailable("pools", 4663)).toBe(true);
    expect(isAvailable("pools", 5042)).toBe(false);
    expect(isAvailable("lending", 4663)).toBe(false);
    expect(isAvailable("lending", 5042)).toBe(false);
  });

  it("never claims a product is available while its contract is the zero address", () => {
    for (const c of SUPPORTED_CHAINS) {
      const addr = contractsFor(c.id);
      if (isAvailable("swap", c.id)) expect(addr.MOLE_ROUTER).not.toBe(ZERO);
      if (isAvailable("pools", c.id)) expect(addr.MOLE_POSITIONS).not.toBe(ZERO);
      if (isAvailable("lending", c.id)) expect(addr.LENDING_POOL).not.toBe(ZERO);
    }
  });

  it("can name the chains a product is live on, for the 'switch to X' prompt", () => {
    expect(chainsWith("pools").map((c) => c.id)).toEqual([RH_CHAIN.id]);
    expect(chainsWith("swap").map((c) => c.id)).toEqual([RH_CHAIN.id, ARC_CHAIN.id]);
    expect(chainsWith("lending")).toEqual([]);
  });

  it("carries Arc's gas token as USDC with the NATIVE 18-decimal convention", () => {
    // The ERC-20 view of the same balance is 6-decimal. Mixing them is a 12-order-of-magnitude bug.
    expect(ARC_CHAIN.nativeSymbol).toBe("USDC");
    expect(ARC_CHAIN.nativeDecimals).toBe(18);
    expect(RH_CHAIN.nativeSymbol).toBe("ETH");
  });
});
