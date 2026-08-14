import { describe, expect, it } from "vitest";
import { widenWords } from "../../lib/aggregator/venues/v4Reader";
import { wordsToFetch, DEFAULT_WORD_RADIUS } from "../../lib/aggregator/indexer";

/**
 * Regression: the v4 fee-3000 blackout.
 *
 * The tick window is measured in BITMAP WORDS, and one word spans 256 * tickSpacing TICKS. So a fixed
 * word radius is a tick radius that shrinks as tickSpacing shrinks: +/-6 words reaches +/-307,200 ticks
 * at spacing 200 but only +/-92,160 at spacing 60. Every launchpad-seeded v4 pool on this chain holds
 * ONE position exactly 120,000 ticks wide with spot sitting on its lower tick — 2.3 words away at
 * spacing 200 (seen, quotes fine) and 7.8 words away at spacing 60 (missed by ONE word). Missing it made
 * the pool look one-sided, so the quoter could not cross upward and every fee-3000 pool answered
 * "No liquidity route found for this pair" for a buy the chain executes happily.
 *
 * Ground truth read from Robinhood Chain mainnet, pool 0xd6c1698f… (fee 3000, tickSpacing 60):
 * current tick -210600, exactly two initialised ticks — -210600 (word -14, the centre word) and
 * -90600 (word -6, EIGHT words above centre). Same shape on 0x66971aa12e, 0x21b5d391ca, 0xfde487955a,
 * 0xfb34db51bf, 0xab8c2342e8, 0x94920bbc6f.
 */
describe("widening the v4 tick window", () => {
  const SPACING = 60;
  const SPOT_TICK = -210600;
  const UPPER_TICK = -90600;
  const wordOfTick = (t: number) => Math.floor(Math.floor(t / SPACING) / 256);
  const CENTER = wordOfTick(SPOT_TICK); // -14
  const UPPER_WORD = wordOfTick(UPPER_TICK); // -6

  it("pins the measured geometry: the upper tick is 8 words above centre", () => {
    expect(CENTER).toBe(-14);
    expect(UPPER_WORD).toBe(-6);
    expect(UPPER_TICK - SPOT_TICK).toBe(120_000);
  });

  it("THE BUG: the fixed window alone cannot see the upper tick", () => {
    // This is the mutation guard — if this ever starts passing, the window covers the pool on its own
    // and the widening below is no longer what makes the buy quote.
    expect(wordsToFetch(CENTER, SPACING, DEFAULT_WORD_RADIUS)).not.toContain(UPPER_WORD);
  });

  it("THE SAME SHAPE IS FINE AT SPACING 200 — proving spacing, not fee, is the discriminator", () => {
    const spacing200 = 200;
    const centre200 = Math.floor(Math.floor(SPOT_TICK / spacing200) / 256);
    const upper200 = Math.floor(Math.floor((SPOT_TICK + 120_000) / spacing200) / 256);
    expect(upper200 - centre200).toBeLessThanOrEqual(DEFAULT_WORD_RADIUS);
  });

  it("THE FIX: widening upward reaches the word holding the upper tick", () => {
    const base = wordsToFetch(CENTER, SPACING, DEFAULT_WORD_RADIUS);
    const extra = widenWords(CENTER, SPACING, base, /* needBelow */ false, /* needAbove */ true);
    expect(extra).toContain(UPPER_WORD);
  });

  it("never re-reads a word the window already covered, and never duplicates one", () => {
    const base = wordsToFetch(CENTER, SPACING, DEFAULT_WORD_RADIUS);
    const extra = widenWords(CENTER, SPACING, base, true, true);
    expect(extra.filter((w) => base.includes(w))).toEqual([]);
    expect(new Set(extra).size).toBe(extra.length);
  });

  it("reads nothing when neither side is missing", () => {
    const base = wordsToFetch(CENTER, SPACING, DEFAULT_WORD_RADIUS);
    expect(widenWords(CENTER, SPACING, base, false, false)).toEqual([]);
  });

  it("only widens the side that is actually missing", () => {
    const base = wordsToFetch(CENTER, SPACING, DEFAULT_WORD_RADIUS);
    const up = widenWords(CENTER, SPACING, base, false, true);
    const down = widenWords(CENTER, SPACING, base, true, false);
    expect(up.every((w) => w > CENTER)).toBe(true);
    expect(down.every((w) => w < CENTER)).toBe(true);
  });

  it("is exhaustive at the spacings these pools use — it cannot miss a tick that exists", () => {
    for (const spacing of [60, 200]) {
      const minWord = Math.floor(Math.floor((Math.ceil(-887272 / spacing) * spacing) / spacing) / 256);
      const maxWord = Math.floor(Math.floor((Math.floor(887272 / spacing) * spacing) / spacing) / 256);
      for (const centre of [minWord, 0, maxWord, -14]) {
        const base = wordsToFetch(centre, spacing, DEFAULT_WORD_RADIUS);
        const covered = new Set([...base, ...widenWords(centre, spacing, base, true, true)]);
        for (let w = minWord; w <= maxWord; w++) expect(covered.has(w)).toBe(true);
      }
    }
  });

  it("stays bounded at fine spacings — at most `cap` extra words per side", () => {
    // tickSpacing 1 spans ~6,900 words; an unbounded walk would be a full-chain scan per quote.
    const base = wordsToFetch(0, 1, DEFAULT_WORD_RADIUS);
    expect(widenWords(0, 1, base, true, true).length).toBe(256); // 128 per side
    expect(widenWords(0, 1, base, false, true).length).toBe(128);
    expect(widenWords(0, 1, base, true, true, 4).length).toBe(8);
  });

  it("never walks past the ends of tick space", () => {
    for (const spacing of [1, 10, 60, 200]) {
      const minWord = Math.floor(Math.floor((Math.ceil(-887272 / spacing) * spacing) / spacing) / 256);
      const maxWord = Math.floor(Math.floor((Math.floor(887272 / spacing) * spacing) / spacing) / 256);
      const base = wordsToFetch(minWord, spacing, DEFAULT_WORD_RADIUS);
      const extra = widenWords(minWord, spacing, base, true, true);
      expect(Math.min(...extra, minWord)).toBeGreaterThanOrEqual(minWord);
      expect(Math.max(...extra, maxWord)).toBeLessThanOrEqual(maxWord);
    }
  });
});
