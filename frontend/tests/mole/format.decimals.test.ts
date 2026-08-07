/**
 * format.decimals.test.ts — adversarial tests for lib/mole/format.ts
 *
 * THE 18-vs-6 DECIMAL TRAP is the single most expensive bug this UI can have:
 * WETH is 18 decimals, USDG is SIX. Parsing "1.5" with the wrong side is a
 * 10^12 error. Every test here is written as the attack that would exploit a
 * sloppy helper, not as a smoke test.
 *
 * NOTE: BigInt literals (10n) are deliberately avoided — the module itself
 * avoids them for the ES6 tsconfig target, so the tests do too.
 */

import { describe, it, expect } from "vitest";
import {
  parseUnits,
  formatUnits,
  formatUnitsDisplay,
  scaleFactor,
  toApproxNumber,
  formatBps,
  applySlippageFloor,
} from "../../lib/mole/format";
import { WETH, USDG } from "../../lib/mole/chain";

const WETH_1_5 = BigInt("1500000000000000000"); // 1.5 * 10^18
const USDG_1_5 = BigInt("1500000"); // 1.5 * 10^6
const E12 = BigInt("1000000000000");

describe("ATTACK: the 18-vs-6 decimal trap", () => {
  it('parses "1.5" as WETH (18 dec) to exactly 1500000000000000000', () => {
    expect(parseUnits("1.5", WETH.decimals)).toBe(WETH_1_5);
  });

  it('parses "1.5" as USDG (SIX dec) to exactly 1500000', () => {
    expect(parseUnits("1.5", USDG.decimals)).toBe(USDG_1_5);
  });

  it("the same human input differs by exactly 10^12 between the two tokens", () => {
    expect(parseUnits("1.5", WETH.decimals) / parseUnits("1.5", USDG.decimals)).toBe(E12);
  });

  it('round-trips format(parse("1.5")) === "1.5" for BOTH tokens', () => {
    expect(formatUnits(parseUnits("1.5", WETH.decimals), WETH.decimals)).toBe("1.5");
    expect(formatUnits(parseUnits("1.5", USDG.decimals), USDG.decimals)).toBe("1.5");
  });

  it("ATTACK: parse with NO decimals argument must throw — a silent 18 default is a fund-loss bug", () => {
    const parseAny = parseUnits as unknown as (v: string, d?: number) => bigint;
    let returned: bigint | undefined;
    let threw = false;
    try {
      returned = parseAny("1.5");
    } catch {
      threw = true;
    }
    // The catastrophic outcome: helper quietly assumed 18 decimals.
    expect(returned).not.toBe(WETH_1_5);
    // The only acceptable outcome: refuse to guess at all.
    expect(threw).toBe(true);
  });

  it("ATTACK: format with NO decimals argument must throw too", () => {
    const formatAny = formatUnits as unknown as (v: bigint, d?: number) => string;
    let returned: string | undefined;
    let threw = false;
    try {
      returned = formatAny(USDG_1_5);
    } catch {
      threw = true;
    }
    expect(returned).not.toBe("0.0000000000015"); // 1500000 read as 18-dec
    expect(threw).toBe(true);
  });

  it("ATTACK: toApproxNumber with NO decimals must throw, not chart a 10^12-wrong series", () => {
    const approxAny = toApproxNumber as unknown as (v: bigint, d?: number) => number;
    expect(() => approxAny(USDG_1_5)).toThrow();
  });
});

describe("precision: excess fractional digits are rejected, never silently truncated", () => {
  it('rejects "1.1234567" for a 6-decimal token (7 fractional digits)', () => {
    expect(() => parseUnits("1.1234567", 6)).toThrow(/fractional digits|decimals/);
  });

  it('accepts the same digits where they fit: "1.123456" @6 and "1.1234567" @7', () => {
    expect(parseUnits("1.123456", 6)).toBe(BigInt("1123456"));
    expect(parseUnits("1.1234567", 7)).toBe(BigInt("11234567"));
  });

  it("ATTACK: sub-precision dust — 0.0000001 USDG cannot exist and must be rejected, not become 0 or 1", () => {
    expect(() => parseUnits("0.0000001", 6)).toThrow();
  });

  it("one unit of dust at exactly the token precision parses to 1 raw unit", () => {
    expect(parseUnits("0.000001", 6)).toBe(BigInt(1));
    expect(parseUnits("0.000000000000000001", 18)).toBe(BigInt(1));
  });

  it("19 fractional digits on an 18-decimal token is rejected", () => {
    expect(() => parseUnits("0.0000000000000000001", 18)).toThrow();
  });
});

describe("float immunity at real magnitudes (doubles die past 2^53)", () => {
  it("parses a 27-significant-digit WETH amount exactly", () => {
    expect(parseUnits("123456789.123456789123456789", 18)).toBe(
      BigInt("123456789123456789123456789")
    );
  });

  it("round-trips the 27-digit amount through format", () => {
    const raw = parseUnits("123456789.123456789123456789", 18);
    expect(formatUnits(raw, 18)).toBe("123456789.123456789123456789");
  });

  it("round-trips a live-magnitude USDG amount (1845.123456)", () => {
    expect(parseUnits("1845.123456", 6)).toBe(BigInt("1845123456"));
    expect(formatUnits(BigInt("1845123456"), 6)).toBe("1845.123456");
  });

  it("round-trips uint128.max formatted as WETH", () => {
    const max128 = BigInt("340282366920938463463374607431768211455");
    expect(parseUnits(formatUnits(max128, 18), 18)).toBe(max128);
  });

  it("formats 1 wei without scientific notation or precision loss", () => {
    expect(formatUnits(BigInt(1), 18)).toBe("0.000000000000000001");
  });
});

describe("malformed input is rejected outright", () => {
  const garbage = [
    "",
    " ",
    ".",
    "1.",
    ".5",
    "1e18", // exponent smuggling
    "1,5", // locale comma
    "1,500", // thousands separator
    "0x10", // hex smuggling
    "1.5.5",
    "+1.5",
    "NaN",
    "Infinity",
    "1 5",
    "1.5abc",
  ];
  for (const bad of garbage) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => parseUnits(bad, 6)).toThrow();
    });
  }

  it("documents the one laxity: surrounding whitespace is trimmed", () => {
    expect(parseUnits(" 1.5 ", 6)).toBe(USDG_1_5);
  });

  it("negative amounts parse and round-trip with the sign intact", () => {
    expect(parseUnits("-1.5", 6)).toBe(BigInt(-1500000));
    expect(formatUnits(BigInt(-1500000), 6)).toBe("-1.5");
  });
});

describe("zero and integer handling", () => {
  it('formats zero as "0" for any decimals', () => {
    expect(formatUnits(BigInt(0), 6)).toBe("0");
    expect(formatUnits(BigInt(0), 18)).toBe("0");
    expect(formatUnits(BigInt(0), 0)).toBe("0");
  });

  it("parses integer strings without a dot", () => {
    expect(parseUnits("2", 6)).toBe(BigInt("2000000"));
    expect(parseUnits("0", 18)).toBe(BigInt(0));
    expect(parseUnits("0.000000", 6)).toBe(BigInt(0));
  });

  it("strips trailing fractional zeros so round-trips are canonical", () => {
    expect(formatUnits(BigInt("1500000"), 6)).toBe("1.5"); // not "1.500000"
    expect(formatUnits(BigInt("1845000000"), 6)).toBe("1845"); // not "1845.000000"
  });
});

describe("scaleFactor and the decimals guard", () => {
  it("computes 10^decimals as bigint", () => {
    expect(scaleFactor(0)).toBe(BigInt(1));
    expect(scaleFactor(6)).toBe(BigInt("1000000"));
    expect(scaleFactor(18)).toBe(BigInt("1000000000000000000"));
  });

  it("rejects insane decimals: negative, fractional, > 77, NaN", () => {
    expect(() => scaleFactor(-1)).toThrow(RangeError);
    expect(() => scaleFactor(1.5)).toThrow(RangeError);
    expect(() => scaleFactor(78)).toThrow(RangeError);
    expect(() => scaleFactor(Number.NaN)).toThrow(RangeError);
  });
});

describe("display formatting truncates toward zero (never shows more than the user has)", () => {
  it("1.999999 USDG shown to 2 digits is 1.99, NOT 2.00", () => {
    expect(formatUnitsDisplay(BigInt("1999999"), 6, 2)).toBe("1.99");
  });

  it("0.999999 USDG shown to 2 digits is 0.99, NOT 1", () => {
    expect(formatUnitsDisplay(BigInt("999999"), 6, 2)).toBe("0.99");
  });

  it("groups thousands on the whole part", () => {
    expect(formatUnitsDisplay(BigInt("1234567123456"), 6, 3)).toBe("1,234,567.123");
  });

  it("zero fraction digits shows the floor", () => {
    expect(formatUnitsDisplay(BigInt("1500000"), 6, 0)).toBe("1");
  });

  it("rejects invalid maxFractionDigits", () => {
    expect(() => formatUnitsDisplay(BigInt(1), 6, -1)).toThrow(RangeError);
    expect(() => formatUnitsDisplay(BigInt(1), 6, 1.5)).toThrow(RangeError);
  });
});

describe("bps helpers", () => {
  it("formats fee bps", () => {
    expect(formatBps(1000)).toBe("10%");
    expect(formatBps(0)).toBe("0%");
  });

  it("rejects negative or fractional bps", () => {
    expect(() => formatBps(-1)).toThrow(RangeError);
    expect(() => formatBps(12.5)).toThrow(RangeError);
  });

  it("applySlippageFloor takes the haircut rounding DOWN", () => {
    expect(applySlippageFloor(BigInt("1000000"), 100)).toBe(BigInt("990000"));
    expect(applySlippageFloor(BigInt(999), 100)).toBe(BigInt(989)); // 989.01 floors to 989
    expect(applySlippageFloor(BigInt("1000000"), 0)).toBe(BigInt("1000000"));
    expect(applySlippageFloor(BigInt("1000000"), 10000)).toBe(BigInt(0));
  });

  it("rejects out-of-range slippage", () => {
    expect(() => applySlippageFloor(BigInt(1), 10001)).toThrow(RangeError);
    expect(() => applySlippageFloor(BigInt(1), -1)).toThrow(RangeError);
    expect(() => applySlippageFloor(BigInt(1), 0.5)).toThrow(RangeError);
  });

  it("toApproxNumber is display-grade only but exact at small magnitudes", () => {
    expect(toApproxNumber(BigInt("1500000"), 6)).toBe(1.5);
    expect(toApproxNumber(WETH_1_5, 18)).toBe(1.5);
  });
});
