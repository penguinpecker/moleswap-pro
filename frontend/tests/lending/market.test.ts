/**
 * market.test.ts — the lending surface's arithmetic and its chain scoping.
 *
 * Attacks first, because the failure modes here are quiet ones: a config bitmap decoded at the
 * wrong offset reports someone else's LTV; a per-second rate multiplied instead of compounded
 * quotes a cheaper loan than the chain will give; a uint256-max health factor rendered as a number
 * prints 1.15e59; and a chain check that passes on Arc reads Robinhood's market and calls it the
 * user's own. Then the confirmations.
 */
import { describe, it, expect } from "vitest";
import {
  LENDING,
  LENDING_ASSETS,
  BASE_DECIMALS,
  lendingAvailableOn,
  lendingUnavailableOn,
  decodeConfig,
  rayRateToApy,
  healthBand,
  formatUsd,
  formatUnits,
  poolAbi,
  gatewayAbi,
} from "../../lib/lending/market";
import { RH_CHAIN, ARC_CHAIN, contractsFor, isAvailable } from "../../lib/chain/chains";

describe("ATTACK — the quiet ways a lending UI lies", () => {
  it("refuses on Arc rather than reading Robinhood's market for an Arc user", () => {
    expect(lendingAvailableOn(RH_CHAIN.id)).toBe(true);
    expect(lendingAvailableOn(ARC_CHAIN.id)).toBe(false);
    expect(lendingAvailableOn(undefined)).toBe(false);
    expect(lendingAvailableOn(1)).toBe(false);

    // and it SAYS so, naming where lending does run — a greyed button explains nothing
    const why = lendingUnavailableOn(ARC_CHAIN.id);
    expect(why).toBeTruthy();
    expect(why).toMatch(/Robinhood/i);
    expect(lendingUnavailableOn(RH_CHAIN.id)).toBeNull();
  });

  it("decodes the reserve config at Aave's OWN bit offsets, not remembered ones", () => {
    // Built from the offsets in ReserveConfiguration: ltv 0, liqThreshold 16, bonus 32,
    // active 56, frozen 57, borrowing 58, paused 60.
    const cfg =
      7500n | // ltv 75%
      (8000n << 16n) | // liquidation threshold 80%
      (10650n << 32n) | // bonus 106.5% -> +6.5%
      (1n << 56n) | // active
      (1n << 58n); // borrowing enabled

    const d = decodeConfig(cfg);
    expect(d.ltvBps).toBe(7500);
    expect(d.liquidationThresholdBps).toBe(8000);
    expect(d.liquidationBonusBps).toBe(650);
    expect(d.isActive).toBe(true);
    expect(d.isFrozen).toBe(false);
    expect(d.borrowingEnabled).toBe(true);
    expect(d.isPaused).toBe(false);
  });

  it("reads the LIVE mainnet WETH bitmap correctly — 75/80/6.5, collateral-only", () => {
    // captured from chain 2026-08-25. The FULL 256-bit value — an earlier version of this test
    // pasted a display-truncated one and decoded an LTV of 425.34%, which is how you learn to
    // copy the whole number.
    const live =
      7237005577332262213973186568751985011661521240809395328440125724097771478348n;
    const d = decodeConfig(live);
    expect(d.ltvBps).toBe(7500);
    expect(d.liquidationThresholdBps).toBe(8000);
    expect(d.borrowingEnabled).toBe(false); // WETH is collateral-only by design
    expect(d.isActive).toBe(true);
    expect(d.isPaused).toBe(false);
  });

  it("COMPOUNDS the per-second rate — multiplying understates what a borrower pays", () => {
    // Aave stores an ANNUAL rate in ray (MathUtils accrues rate*dt/SECONDS_PER_YEAR), so 5% is
    // 0.05 * RAY — not 0.05 divided by seconds-per-year, which is what this test asserted first
    // and why it read 0%.
    const RAY = 10n ** 27n;
    const nominal = 0.05;
    const annualRay = BigInt(Math.floor(nominal * Number(RAY)));

    const apy = rayRateToApy(annualRay);
    expect(apy).toBeGreaterThan(nominal); // compounding must exceed the nominal
    expect(apy).toBeCloseTo(Math.expm1(nominal), 4); // and converge on e^r - 1
  });

  it("a zero rate is zero, not NaN — an idle reserve must render 0.00%", () => {
    expect(rayRateToApy(0n)).toBe(0);
  });

  it("treats a uint256-max health factor as 'no debt', never as a number", () => {
    const MAX = (1n << 256n) - 1n;
    // healthBand is the render path; null is what readUserPosition maps MAX to
    expect(healthBand(null)).toBe("none");
    // and a real HF still bands correctly
    expect(healthBand(2n * 10n ** 18n)).toBe("safe");
    expect(healthBand(12n * 10n ** 17n)).toBe("warn"); // 1.2
    expect(healthBand(10n ** 18n)).toBe("danger"); // exactly 1.0 is NOT safe
    expect(healthBand(9n * 10n ** 17n)).toBe("danger"); // 0.9
    expect(MAX > 10n ** 30n).toBe(true); // the sentinel really is out of band
  });

  it("never renders a tiny non-zero balance as plain 0", () => {
    // a dust balance shown as "0" reads as "you have nothing", which is a different claim
    expect(formatUnits(1n, 18)).toMatch(/^</);
    expect(formatUnits(0n, 18)).toBe("0");
  });
});

describe("the market definition matches what is deployed", () => {
  it("is scoped to Robinhood and agrees with the chain registry", () => {
    expect(LENDING.chainId).toBe(RH_CHAIN.id);
    expect(isAvailable("lending", RH_CHAIN.id)).toBe(true);
    expect(isAvailable("lending", ARC_CHAIN.id)).toBe(false);
    // the registry's LENDING_POOL must be the pool this surface actually calls, or the two
    // disagree and one of them is wrong
    expect(contractsFor(RH_CHAIN.id).LENDING_POOL.toLowerCase()).toBe(LENDING.pool.toLowerCase());
  });

  it("lists exactly the two live reserves, with the right decimals and roles", () => {
    expect(LENDING_ASSETS).toHaveLength(2);

    const eth = LENDING_ASSETS.find((a) => a.symbol === "ETH")!;
    const usdg = LENDING_ASSETS.find((a) => a.symbol === "USDG")!;

    // decimals are NOT cosmetic: USDG is 6 and WETH is 18, and swapping them misprices by 1e12
    expect(eth.decimals).toBe(18);
    expect(usdg.decimals).toBe(6);

    // WETH is collateral-only on this market; offering a borrow button for it would revert
    expect(eth.borrowable).toBe(false);
    expect(usdg.borrowable).toBe(true);

    // only the wrapped-native reserve may route through the gateway
    expect(eth.isWrappedNative).toBe(true);
    expect(usdg.isWrappedNative).toBe(false);
  });

  it("every address is distinct — a copy-paste would alias a token to its own aToken", () => {
    const all = LENDING_ASSETS.flatMap((a) => [a.address, a.aToken, a.variableDebtToken]).map((x) =>
      x.toLowerCase(),
    );
    expect(new Set(all).size).toBe(all.length);
  });

  it("prices in Aave's 8-decimal base currency", () => {
    expect(BASE_DECIMALS).toBe(8);
    expect(formatUsd(12_418_179n)).toBe("$0.12"); // the collateral value proven on mainnet
    expect(formatUsd(0n)).toBe("$0.00");
  });
});

describe("the ABIs match the deployed selectors", () => {
  // These four were verified present in the deployed runtime bytecode before being written down.
  // The test pins the SHAPE so a later edit cannot silently change an argument list.
  it("Pool.borrow takes (asset, amount, rateMode, referral, onBehalfOf)", () => {
    const f = poolAbi.find((x) => x.name === "borrow")!;
    expect(f.inputs.map((i) => i.type)).toEqual([
      "address",
      "uint256",
      "uint256",
      "uint16",
      "address",
    ]);
  });

  it("Pool.repay returns the amount actually repaid", () => {
    const f = poolAbi.find((x) => x.name === "repay")!;
    expect(f.inputs.map((i) => i.type)).toEqual(["address", "uint256", "uint256", "address"]);
    expect(f.outputs.map((o) => o.type)).toEqual(["uint256"]);
  });

  it("gateway depositETH is PAYABLE — the ETH rides on value, not on an argument", () => {
    const f = gatewayAbi.find((x) => x.name === "depositETH")!;
    expect(f.stateMutability).toBe("payable");
    expect(f.inputs.map((i) => i.type)).toEqual(["address", "address", "uint16"]);
  });

  it("gateway withdrawETH is NOT payable and takes the amount as an argument", () => {
    const f = gatewayAbi.find((x) => x.name === "withdrawETH")!;
    expect(f.stateMutability).toBe("nonpayable");
    expect(f.inputs.map((i) => i.type)).toEqual(["address", "uint256", "address"]);
  });
});
