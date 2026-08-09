import { describe, it, expect } from "vitest";
import { poolIdOf, priceToSqrtPriceX96, orderCurrencies } from "@/lib/mole/createPool";
import { LIVE_POOL_KEY, LIVE_POOL_ID, DYNAMIC_FEE_FLAG, MOLE_ADDRESSES, WETH, USDG } from "@/lib/mole/chain";

describe("createPool math", () => {
  it("poolIdOf reproduces the live WETH/USDG pool id (keccak of the encoded key)", () => {
    const id = poolIdOf({
      currency0: LIVE_POOL_KEY.currency0 as `0x${string}`,
      currency1: LIVE_POOL_KEY.currency1 as `0x${string}`,
      fee: LIVE_POOL_KEY.fee,
      tickSpacing: LIVE_POOL_KEY.tickSpacing,
      hooks: LIVE_POOL_KEY.hooks as `0x${string}`,
    });
    expect(id.toLowerCase()).toBe(LIVE_POOL_ID.toLowerCase());
  });

  it("priceToSqrtPriceX96 reproduces the live pool's opening price (ETH ~ $1845, 18/6 decimals)", () => {
    const x = priceToSqrtPriceX96(1845, 18, 6);
    // The CreatePool script used 3403123962154247711138459; float sqrt lands within a hair of it.
    const expected = 3403123962154247711138459n;
    const diff = x > expected ? x - expected : expected - x;
    expect(diff < expected / 1_000_000n).toBe(true);
  });

  it("priceToSqrtPriceX96 rejects out-of-range / non-positive prices", () => {
    expect(() => priceToSqrtPriceX96(0, 18, 6)).toThrow();
    expect(() => priceToSqrtPriceX96(-1, 18, 6)).toThrow();
  });

  it("orderCurrencies sorts by address and carries decimals", () => {
    const o = orderCurrencies(USDG.address as `0x${string}`, 6, WETH.address as `0x${string}`, 18);
    // WETH (0x0Bd7…) sorts below USDG (0x5fc5…), so WETH must become currency0.
    expect(o.currency0.toLowerCase()).toBe(WETH.address.toLowerCase());
    expect(o.dec0).toBe(18);
    expect(o.currency1.toLowerCase()).toBe(USDG.address.toLowerCase());
    expect(o.dec1).toBe(6);
  });

  it("the live key uses the dynamic-fee sentinel and the MoleHook", () => {
    expect(LIVE_POOL_KEY.fee).toBe(DYNAMIC_FEE_FLAG);
    expect(LIVE_POOL_KEY.hooks.toLowerCase()).toBe(MOLE_ADDRESSES.moleHook.toLowerCase());
  });
});
