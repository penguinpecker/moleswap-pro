/**
 * quoteCopy.ts — the one sentence the exchange card shows when it has no quote to render.
 *
 * Kept out of ExchangePage so it can be unit-tested without mounting the whole screen. The order matters and
 * is the point: a FAILURE of the quote engine (a thrown QuoteFailedError, a pool-state load that blew up) must
 * never read as "no route" — the two used to share the same sentence, and a live quoter regression looked
 * like an illiquid pair to every user (learnings.txt 2026-08-14 #2).
 */
export function noQuoteCopy(s: {
  /** The session is still loading pools / discovering venues. */
  readonly quoteRefreshing: boolean;
  /** The quote engine failed — a message describing the defect, or null. */
  readonly quoteFailure: string | null;
  /** A pair and an amount are set, so a null quote means the router found no path. */
  readonly canQuote: boolean;
}): string {
  if (s.quoteRefreshing) return "Scanning every live pool for the best route…";
  if (s.quoteFailure) return `The quote engine hit an error — this is not a liquidity problem: ${s.quoteFailure}`;
  if (s.canQuote) return "No route with live liquidity for this pair.";
  return "Select tokens and enter an amount to get a live quote.";
}
