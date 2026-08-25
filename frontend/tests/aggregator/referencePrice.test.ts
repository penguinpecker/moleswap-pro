/**
 * referencePrice.test.ts — the independent yardstick for judging a quote.
 *
 * The failure this guards against is specific and was measured on the live site: a 0.1 ETH swap
 * into USDe returned -24.06% against the Chainlink price, and the quote API carried NO impact
 * field at all, so the card showed a confident number and warned nobody.
 *
 * The tests below are about the two ways this module could make that worse rather than better:
 * pairing a token with the WRONG feed (which would produce an authoritative-looking wrong
 * warning), and reporting a number when it should report "could not measure".
 */
import { describe, it, expect } from "vitest";
import { RH_USD_FEEDS, feedFor } from "../../lib/aggregator/referencePrice";
import { TOKENS } from "../../lib/chain/contracts";

describe("ATTACK — a wrong feed is worse than no feed", () => {
  it("maps every feed to a DISTINCT aggregator", () => {
    // Two tokens sharing one feed means one of them is priced as the other. On this chain that is
    // not hypothetical: ~20 USD proxies all answer decimals()==8 with a fresh timestamp, so a
    // transposed hex digit lands on a different pair that passes every shape check.
    const feeds = Object.values(RH_USD_FEEDS).map((f) => f.toLowerCase());
    expect(new Set(feeds).size).toBe(feeds.length);
  });

  it("only maps tokens that are actually in the registry", () => {
    const known = new Set(TOKENS.map((t) => t.address.toLowerCase()));
    for (const token of Object.keys(RH_USD_FEEDS)) {
      expect(known.has(token), `${token} has a feed but is not a listed token`).toBe(true);
    }
  });

  it("prices NATIVE ETH with the WETH feed — same asset, one wrap apart", () => {
    const native = feedFor("0x0000000000000000000000000000000000000000");
    const weth = feedFor("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
    expect(native).toBeTruthy();
    expect(native).toBe(weth);
  });

  it("returns null for an unknown token rather than guessing", () => {
    // A guessed denominator would render as an authoritative warning. Null is the honest answer
    // and the API turns it into a stated reason, not a silent zero.
    expect(feedFor("0x000000000000000000000000000000000000dEaD")).toBeNull();
  });

  it("has a feed for every SWAPPABLE token, since those are the ones users can lose money on", () => {
    const swappable = TOKENS.filter((t) => t.swappable !== false && !t.hidden);
    for (const t of swappable) {
      expect(
        feedFor(t.address),
        `${t.symbol} is swappable but has no reference feed — its impact cannot be measured`,
      ).toBeTruthy();
    }
  });

  it("is case-insensitive on the token address", () => {
    const lower = feedFor("0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec");
    const upper = feedFor("0xD0601CE157DB5BDC3162BBAC2A2C8AF5320D9EEC");
    expect(lower).toBeTruthy();
    expect(lower).toBe(upper);
  });

  it("pins the equity feeds to the Chainlink directory entries they came from", () => {
    // Each is the "Robinhood <TICKER> / USD" proxy. Pinned so a later edit cannot quietly point
    // NVDA's impact calculation at, say, the SPY feed — which would look completely normal.
    expect(RH_USD_FEEDS["0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"]).toBe(
      "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
    );
    expect(RH_USD_FEEDS["0x117cc2133c37b721f49de2a7a74833232b3b4c0c"]).toBe(
      "0x319724394D3A0e3669269846abE664Cd621f9f6A",
    );
    expect(RH_USD_FEEDS["0x322f0929c4625ed5bad873c95208d54e1c003b2d"]).toBe(
      "0x4A1166a659A55625345e9515b32adECea5547C38",
    );
    expect(RH_USD_FEEDS["0xaf3d76f1834a1d425780943c99ea8a608f8a93f9"]).toBe(
      "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0",
    );
    expect(RH_USD_FEEDS["0xe93237c50d904957cf27e7b1133b510c669c2e74"]).toBe(
      "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E",
    );
  });
});
