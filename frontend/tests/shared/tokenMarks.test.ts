/**
 * tokenMarks.test.ts — the per-ticker marks must draw their TICKER, not their background colour.
 *
 * The generator swapped the text and fill arguments, so every equity mark rendered the literal string
 * "#f2ffe0" in a colour named "NVDA" (an invalid paint, so the glyph fell back to black) and the
 * accessible name of the image was a hex code. Shipped that way in the swap picker, the pools pair
 * avatars and the lend table.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const TICKERS = ["nvda", "spy", "tsla", "aapl", "msft", "usde"];
const root = path.resolve(__dirname, "../..");

describe("token marks", () => {
  for (const t of TICKERS) {
    it(`${t}.svg draws its ticker with a colour fill`, () => {
      const svg = readFileSync(path.join(root, "public/tokens", `${t}.svg`), "utf8");
      const text = svg.match(/<text[^>]*fill="([^"]+)"[^>]*>([^<]+)<\/text>/);
      expect(text, "a <text> with a fill").toBeTruthy();
      const [, fill, label] = text!;
      expect(fill).toMatch(/^#[0-9a-fA-F]{3,8}$/); // a colour, never a ticker
      expect(label.toLowerCase()).toBe(t); // the ticker, never a hex string
      expect(label).not.toMatch(/^#/);
      // the accessible name is the ticker too — a screen reader read "#f2ffe0" before
      const aria = svg.match(/aria-label="([^"]+)"/);
      expect(aria?.[1]?.toLowerCase()).toBe(t);
    });
  }
});
