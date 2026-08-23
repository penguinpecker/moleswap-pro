/**
 * noQuoteCopy.test.ts — the exchange card must render a quote-engine FAILURE differently from a genuine
 * no-route. Both used to be "No route with live liquidity for this pair."
 */
import { describe, it, expect } from "vitest";
import { noQuoteCopy } from "../../screens/dapp/quoteCopy";

describe("the card's no-quote sentence", () => {
  it("a failure names itself and says it is not a liquidity problem", () => {
    const s = noQuoteCopy({ quoteRefreshing: false, quoteFailure: "quote failed: cannot build a plan from an incomplete split", canQuote: true });
    expect(s).toMatch(/not a liquidity problem/);
    expect(s).toContain("incomplete split");
    expect(s).not.toMatch(/No route with live liquidity/);
  });

  it("a genuine no-route says exactly that, and nothing about an error", () => {
    const s = noQuoteCopy({ quoteRefreshing: false, quoteFailure: null, canQuote: true });
    expect(s).toBe("No route with live liquidity for this pair.");
  });

  it("the two are never the same sentence", () => {
    expect(noQuoteCopy({ quoteRefreshing: false, quoteFailure: "boom", canQuote: true })).not.toBe(
      noQuoteCopy({ quoteRefreshing: false, quoteFailure: null, canQuote: true }),
    );
  });

  it("loading and idle copy are unchanged", () => {
    expect(noQuoteCopy({ quoteRefreshing: true, quoteFailure: null, canQuote: true })).toBe("Scanning every live pool for the best route…");
    expect(noQuoteCopy({ quoteRefreshing: false, quoteFailure: null, canQuote: false })).toBe("Select tokens and enter an amount to get a live quote.");
  });
});
