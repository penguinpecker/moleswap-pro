import { describe, expect, it } from "vitest";
import { wordsToFetch, DEFAULT_WORD_RADIUS } from "../../lib/aggregator/indexer";

/**
 * Regression: a full-range position's ticks live at the extremes of tick space, far outside any
 * window centred on spot. Reading only the window makes such a pool look one-sided, and the quoter
 * answers "no route" for a swap the chain executes fine.
 *
 * Ground truth is a real pool measured on Robinhood Chain (WETH/SWAPPY, 0xb3B2ad9B…, fee 10000,
 * tickSpacing 200): current tick 204040, and exactly two initialised ticks — 204200 (word +3, the
 * centre word) and -887200 (word -18, TWENTY-ONE words below centre). On-chain the pool returned
 * 7.137 SWAPPY for 1e-8 WETH; the engine refused to quote it at any size until the boundary words
 * were included.
 */
describe("tick bitmap word selection", () => {
  const SPACING = 200;
  const CENTER_WORD = 3; // floor(floor(204040 / 200) / 256)

  it("covers the window around spot", () => {
    const words = wordsToFetch(CENTER_WORD, SPACING, DEFAULT_WORD_RADIUS);
    for (let w = CENTER_WORD - DEFAULT_WORD_RADIUS; w <= CENTER_WORD + DEFAULT_WORD_RADIUS; w++) {
      expect(words).toContain(w);
    }
  });

  it("includes the word holding a full-range position's LOWER tick (-887200 -> word -18)", () => {
    // This is the assertion that fails without the fix: -18 is 21 words below centre, so a
    // radius-6 window never reaches it and buying the token is impossible.
    expect(wordsToFetch(CENTER_WORD, SPACING, DEFAULT_WORD_RADIUS)).toContain(-18);
  });

  it("includes the word holding a full-range position's UPPER tick (887200 -> word +17)", () => {
    expect(wordsToFetch(CENTER_WORD, SPACING, DEFAULT_WORD_RADIUS)).toContain(17);
  });

  it("computes the boundary words correctly for every tick spacing in use", () => {
    // fee tier -> tickSpacing, as probed by discover.ts
    for (const spacing of [1, 5, 10, 50, 60, 200]) {
      const lo = Math.ceil(-887272 / spacing) * spacing;
      const hi = Math.floor(887272 / spacing) * spacing;
      const wordOf = (t: number) => Math.floor(Math.floor(t / spacing) / 256);
      const words = wordsToFetch(0, spacing, DEFAULT_WORD_RADIUS);
      expect(words).toContain(wordOf(lo));
      expect(words).toContain(wordOf(hi));
      // the usable extremes must be inside the range the words cover
      expect(Math.min(...words)).toBeLessThanOrEqual(wordOf(lo));
      expect(Math.max(...words)).toBeGreaterThanOrEqual(wordOf(hi));
    }
  });

  it("stays cheap — a handful of extra reads, not a full scan", () => {
    const words = wordsToFetch(CENTER_WORD, SPACING, DEFAULT_WORD_RADIUS);
    // window is 2*radius+1; the fix adds at most two boundary words on top.
    expect(words.length).toBeLessThanOrEqual(2 * DEFAULT_WORD_RADIUS + 1 + 2);
  });

  it("does not duplicate a boundary word that already falls inside the window", () => {
    // centre near the bottom of tick space: word -18 is already within radius 6 of -20.
    const words = wordsToFetch(-20, SPACING, DEFAULT_WORD_RADIUS);
    expect(words.filter((w) => w === -18)).toHaveLength(1);
    expect(new Set(words).size).toBe(words.length);
  });
});
