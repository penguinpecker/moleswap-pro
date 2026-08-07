/**
 * indexer.ts — read live pool state into the `PoolState` the quoter consumes.
 *
 * This is the only file in the router package that touches the chain, and it is written so that the
 * touching is INJECTED, not baked in: every function takes an `RpcTransport`, so the decoders — the part
 * that is easy to get wrong and expensive to get wrong — are unit-tested against REAL bytes captured from
 * the live chain, with no network in the test. A decoder that silently mis-reads a tick or a sqrt price
 * would feed the exact-to-the-wei quoter a wrong number and quietly undo all of it.
 *
 * The encoding is done by hand rather than with a library, deliberately, to keep this package
 * dependency-free and its trust surface small: the calls are a handful of fixed selectors over static
 * arguments, and the responses are fixed layouts. Everything here is checked against `rpc.fixture.json`,
 * which is raw hex the live PancakeSwap V3 pool actually returned.
 */

import type { PoolState, TickData } from "./venues/v3Pool.js";

/** A minimal JSON-RPC surface. Supply one backed by fetch, viem, ethers — whatever the host already has. */
export interface RpcTransport {
  /** eth_call at latest. `data` is 0x-prefixed calldata; returns 0x-prefixed return data. */
  call(to: string, data: string): Promise<string>;
  /** A batched eth_call. Implementations may fan out or use a JSON-RPC batch; order MUST be preserved. */
  batchCall(calls: { to: string; data: string }[]): Promise<string[]>;
}

/* ------------------------------------------------------------------------------- selectors + encoding */

const SEL = {
  slot0: "0x3850c7bd",
  liquidity: "0x1a686502",
  fee: "0xddca3f43",
  tickSpacing: "0xd0c93a7c",
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  getPopulatedTicksInWord: "0x351fb478",
} as const;

function pad32(hexNo0x: string): string {
  return hexNo0x.padStart(64, "0");
}

function encodeAddress(addr: string): string {
  return pad32(addr.toLowerCase().replace(/^0x/, ""));
}

/** int16, two's complement in a full 32-byte word. TickLens words are small signed integers. */
function encodeInt16(v: number): string {
  const masked = BigInt.asUintN(256, BigInt(v));
  return pad32(masked.toString(16));
}

/* ---------------------------------------------------------------------------------------- decoding */

function words(hex: string): string[] {
  const body = hex.replace(/^0x/, "");
  const out: string[] = [];
  for (let i = 0; i < body.length; i += 64) out.push(body.slice(i, i + 64));
  return out;
}

function toUint(word: string): bigint {
  return BigInt("0x" + word);
}

/** Interpret a 32-byte word as a signed integer of `bits` bits (two's complement). */
function toSigned(word: string, bits: number): number {
  const v = BigInt.asIntN(bits, BigInt("0x" + word.slice(64 - bits / 4)));
  return Number(v);
}

export interface Slot0 {
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
}

/** Decode a Uniswap/PancakeSwap V3 `slot0()` return. Only the first two fields matter for quoting. */
export function decodeSlot0(hex: string): Slot0 {
  const w = words(hex);
  if (w.length < 2) throw new Error(`slot0: short response ${hex}`);
  return {
    sqrtPriceX96: toUint(w[0]!), // uint160, right-aligned
    tick: toSigned(w[1]!, 24), // int24
  };
}

export function decodeUint(hex: string): bigint {
  const w = words(hex);
  if (w.length < 1) throw new Error(`uint: short response ${hex}`);
  return toUint(w[0]!);
}

export function decodeAddress(hex: string): string {
  const w = words(hex);
  if (w.length < 1) throw new Error(`address: short response ${hex}`);
  return "0x" + w[0]!.slice(24);
}

/**
 * Decode `TickLens.getPopulatedTicksInWord` → PopulatedTick[]. Each entry is (int24 tick,
 * int128 liquidityNet, uint128 liquidityGross), ABI-encoded one field per 32-byte word. TickLens returns
 * ticks in DESCENDING order; the quoter needs ascending, so the caller sorts the merged set.
 */
export function decodePopulatedTicks(hex: string): TickData[] {
  const w = words(hex);
  // [0] = offset to array, [1] = length, then length * 3 words.
  if (w.length < 2) return [];
  const length = Number(toUint(w[1]!));
  const out: TickData[] = [];
  for (let i = 0; i < length; i++) {
    const base = 2 + i * 3;
    if (base + 2 >= w.length + 1) break;
    out.push({
      index: toSigned(w[base]!, 24),
      liquidityNet: BigInt.asIntN(128, BigInt("0x" + w[base + 1]!)),
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------------- fetch a pool */

/** Which 256-tick words to read around the current tick. A wider radius costs more calls but lets the
 *  quoter price larger swaps without an exhaustion re-fetch. Tuned to the live chain's depth. */
export const DEFAULT_WORD_RADIUS = 6;

function wordOf(tick: number, tickSpacing: number): number {
  return Math.floor(Math.floor(tick / tickSpacing) / 256);
}

/**
 * Read a PancakeSwap-V3-style pool into a routable `PoolState`, including a tick window wide enough for
 * meaningful swaps. `tickLens` is the deployed TickLens (verified on Robinhood Chain).
 */
export async function fetchV3Pool(
  transport: RpcTransport,
  poolAddress: string,
  tickLens: string,
  wordRadius = DEFAULT_WORD_RADIUS,
): Promise<PoolState> {
  const base = [
    { to: poolAddress, data: SEL.slot0 },
    { to: poolAddress, data: SEL.liquidity },
    { to: poolAddress, data: SEL.fee },
    { to: poolAddress, data: SEL.tickSpacing },
    { to: poolAddress, data: SEL.token0 },
    { to: poolAddress, data: SEL.token1 },
  ];
  const [slot0Hex, liqHex, feeHex, spacingHex, t0Hex, t1Hex] = await transport.batchCall(base);

  const slot0 = decodeSlot0(slot0Hex!);
  const liquidity = decodeUint(liqHex!);
  const fee = Number(decodeUint(feeHex!));
  const tickSpacing = Number(decodeUint(spacingHex!));
  const token0 = decodeAddress(t0Hex!);
  const token1 = decodeAddress(t1Hex!);

  const centerWord = wordOf(slot0.tick, tickSpacing);
  const wordCalls = [];
  for (let w = centerWord - wordRadius; w <= centerWord + wordRadius; w++) {
    wordCalls.push({
      to: tickLens,
      data: SEL.getPopulatedTicksInWord + encodeAddress(poolAddress) + encodeInt16(w),
    });
  }
  const wordResults = await transport.batchCall(wordCalls);

  const ticks: TickData[] = [];
  for (const r of wordResults) {
    if (r && r !== "0x") ticks.push(...decodePopulatedTicks(r));
  }
  // Ascending, deduped by index — the simulator's precondition.
  const byIndex = new Map<number, TickData>();
  for (const t of ticks) byIndex.set(t.index, t);
  const sorted = [...byIndex.values()].sort((a, b) => a.index - b.index);

  return {
    address: poolAddress,
    token0,
    token1,
    fee,
    tickSpacing,
    sqrtPriceX96: slot0.sqrtPriceX96,
    tick: slot0.tick,
    liquidity,
    ticks: sorted,
    venue: "PancakeV3",
  };
}

export { SEL as INDEXER_SELECTORS };
