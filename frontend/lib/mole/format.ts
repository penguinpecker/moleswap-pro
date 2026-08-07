/**
 * format.ts — decimal-safe amount formatting/parsing for the MoleSwap Pro UI.
 *
 * ============================================================================
 * THE 18-vs-6 DECIMAL MISMATCH IS THE HIGHEST-RISK THING IN THIS UI.
 * WETH is 18 decimals; USDG is SIX. Formatting a USDG amount with 18 decimals
 * (or parsing with the wrong side) is a 10^12 error — a fund-loss bug.
 *
 * Therefore EVERY function in this file takes `decimals` explicitly.
 * There are NO defaults, and 18 is never assumed anywhere.
 * Pass `token.decimals` from chain.ts (WETH.decimals / USDG.decimals);
 * never a literal you typed from memory.
 * ============================================================================
 *
 * All arithmetic is bigint/string based. No floats touch raw amounts.
 * (BigInt literals like 10n are avoided because tsconfig targets ES6.)
 */

const ZERO = BigInt(0);

/** Throws unless `decimals` is a sane token decimal count (integer 0..77). */
export function assertValidDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new RangeError(`Invalid token decimals: ${String(decimals)}`);
  }
}

/** 10^decimals as a bigint. The scale factor between raw units and whole tokens. */
export function scaleFactor(decimals: number): bigint {
  assertValidDecimals(decimals);
  // No bigint exponentiation: the app's tsconfig targets ES6 and `**` on bigint needs ES2016+.
  return BigInt("1" + "0".repeat(decimals));
}

/**
 * Raw on-chain units -> exact human-readable decimal string. Never loses precision,
 * never rounds. `formatUnits(1845000000n, 6) === "1845"`, `formatUnits(1n, 18) === "0.000000000000000001"`.
 */
export function formatUnits(value: bigint, decimals: number): string {
  assertValidDecimals(decimals);
  const negative = value < ZERO;
  const abs = negative ? -value : value;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals === 0 ? "" : s.slice(s.length - decimals).replace(/0+$/, "");
  return (negative ? "-" : "") + whole + (frac.length > 0 ? "." + frac : "");
}

/**
 * Human decimal string -> raw on-chain units. STRICT:
 *   - rejects anything but `[-]digits[.digits]` (no exponents, no separators, no whitespace);
 *   - rejects MORE fractional digits than the token has. It never silently truncates,
 *     because silent truncation of a USDG amount parsed as WETH is exactly the class
 *     of bug this file exists to prevent. Callers wanting rounding must do it visibly.
 */
export function parseUnits(value: string, decimals: number): bigint {
  assertValidDecimals(decimals);
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (m === null) {
    throw new Error(`Unparseable amount: "${value}"`);
  }
  const sign = m[1] === "-" ? BigInt(-1) : BigInt(1);
  const whole = m[2] ?? "0";
  const frac = m[3] ?? "";
  if (frac.length > decimals) {
    throw new Error(
      `Amount "${value}" has ${String(frac.length)} fractional digits but the token has only ${String(decimals)} decimals`
    );
  }
  const raw = BigInt(whole) * scaleFactor(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  return sign * raw;
}

/**
 * Display-oriented formatting: at most `maxFractionDigits` shown, ROUNDED TOWARD ZERO
 * (a balance display must never show more than the user has), with thousands grouping
 * on the whole part. Display only — never feed its output back into parseUnits for a tx.
 */
export function formatUnitsDisplay(
  value: bigint,
  decimals: number,
  maxFractionDigits: number
): string {
  assertValidDecimals(decimals);
  if (!Number.isInteger(maxFractionDigits) || maxFractionDigits < 0) {
    throw new RangeError(`Invalid maxFractionDigits: ${String(maxFractionDigits)}`);
  }
  const exact = formatUnits(value, decimals);
  const negative = exact.startsWith("-");
  const [wholeRaw, fracRaw = ""] = (negative ? exact.slice(1) : exact).split(".");
  const whole = (wholeRaw ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = fracRaw.slice(0, maxFractionDigits).replace(/0+$/, "");
  return (negative ? "-" : "") + whole + (frac.length > 0 ? "." + frac : "");
}

/**
 * Convert raw units to a JS number for charts/sorting ONLY. Precision is capped by
 * IEEE-754 doubles (~15 significant digits) — NEVER use the result to build a transaction.
 */
export function toApproxNumber(value: bigint, decimals: number): number {
  assertValidDecimals(decimals);
  return Number(formatUnits(value, decimals));
}

/** Basis points (e.g. performanceFeeBps = 1000) -> "10%". */
export function formatBps(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new RangeError(`Invalid bps: ${String(bps)}`);
  }
  const pct = bps / 100;
  return `${String(Number.isInteger(pct) ? pct : pct.toFixed(2))}%`;
}

/**
 * Apply a slippage haircut to a raw amount: `applySlippageFloor(x, 100)` = 99% of x,
 * rounded down. Use for `minLiquidity`-style floors. Raw units in, raw units out —
 * decimals never enter, so this one is safe without them.
 */
export function applySlippageFloor(value: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new RangeError(`Invalid slippageBps: ${String(slippageBps)}`);
  }
  return (value * BigInt(10_000 - slippageBps)) / BigInt(10_000);
}
