/**
 * focusedAssets.test.ts — the lend page leads with the equity-collateral product, and never hides money.
 *
 * The market's product is: post a tokenised equity, borrow dollars. So the page leads with the five
 * equities plus USDG, which is on the list only because it is the ONLY borrowable asset — a lending
 * page with nothing borrowable cannot lend. USDe is deliberately off it: borrowable at 75/80 with a
 * reserve factor of ZERO and $1M caps against roughly no liquidatable depth on this chain.
 *
 * The property that matters most here is the second one. Hiding a reserve is a presentation choice;
 * hiding a reserve somebody has funds in would take away their Withdraw and Repay buttons.
 */
import { describe, it, expect } from "vitest";
import { visibleAssets, FOCUSED_SYMBOLS, LENDING_ASSETS } from "../../lib/lending/market";

const emptyPos = () => ({
  totalCollateralBase: 0n, totalDebtBase: 0n, availableBorrowsBase: 0n,
  currentLiquidationThreshold: 0n, ltv: 0n, healthFactor: null,
  supplied: {} as Record<string, bigint>,
  borrowed: {} as Record<string, bigint>,
  walletBalance: {} as Record<string, bigint>,
});

const symbols = (pos: any) => visibleAssets(pos).map((a) => a.symbol);

describe("what the lend page leads with", () => {
  it("shows the five equities and USDG, disconnected", () => {
    expect(symbols(null)).toEqual(["USDG", "NVDA", "SPY", "TSLA", "AAPL", "MSFT"]);
  });

  it("keeps USDG, because nothing else on this market can be borrowed", () => {
    const borrowable = LENDING_ASSETS.filter((a) => a.borrowable).map((a) => a.symbol);
    expect(borrowable).toContain("USDG");
    expect(FOCUSED_SYMBOLS).toContain("USDG");
    // if this ever fails, the page is showing a lending market nobody can borrow from
    expect(symbols(null).some((s) => borrowable.includes(s))).toBe(true);
  });

  it("leaves USDe off — the market's most aggressive listing against no exit depth", () => {
    expect(symbols(null)).not.toContain("USDe");
    // and it is still a real reserve on chain; this is a UI decision, not a delisting
    expect(LENDING_ASSETS.map((a) => a.symbol)).toContain("USDe");
  });
});

describe("nothing anyone owns is ever hidden", () => {
  it("re-adds a reserve the wallet has SUPPLIED, so Withdraw stays reachable", () => {
    const pos = emptyPos();
    pos.supplied.ETH = 1_000_000_000_000_000n; // the 0.001 ETH deposit that exists on the live market
    expect(symbols(pos)).toContain("ETH");
  });

  it("re-adds a reserve the wallet OWES, so Repay stays reachable", () => {
    const pos = emptyPos();
    pos.borrowed.USDe = 5n;
    expect(symbols(pos)).toContain("USDe");
  });

  it("re-adds a reserve the wallet merely HOLDS, so it can still be supplied", () => {
    const pos = emptyPos();
    pos.walletBalance.ETH = 1n;
    expect(symbols(pos)).toContain("ETH");
  });

  it("does not re-add a reserve with nothing but zero balances", () => {
    const pos = emptyPos();
    pos.supplied.ETH = 0n;
    pos.borrowed.ETH = 0n;
    pos.walletBalance.ETH = 0n;
    expect(symbols(pos)).not.toContain("ETH");
  });

  it("never drops a focused asset, whatever the position says", () => {
    const pos = emptyPos();
    for (const s of FOCUSED_SYMBOLS) expect(symbols(pos)).toContain(s);
  });

  it("preserves the on-chain reserve order rather than re-sorting", () => {
    const pos = emptyPos();
    pos.supplied.ETH = 1n;
    const shown = symbols(pos);
    const all = LENDING_ASSETS.map((a) => a.symbol);
    // the shown list must be a subsequence of the canonical list
    let i = -1;
    for (const s of shown) {
      const next = all.indexOf(s);
      expect(next).toBeGreaterThan(i);
      i = next;
    }
  });
});

/**
 * The explanatory footnote under the table is DERIVED from the rows shown. It previously read the full
 * on-chain reserve list, so after the page narrowed to six assets it still explained the risk of ETH and
 * USDe beneath a table containing neither.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

describe("the risk footnote describes the table above it", () => {
  it("is built from the reserves actually rendered", () => {
    const src = readFileSync(path.resolve(__dirname, "../../screens/lend/index.tsx"), "utf8");
    expect(src).toMatch(/riskBands\(shownReserves\)/);
    expect(src).not.toMatch(/riskBands\(reserves\)/);
  });
});
