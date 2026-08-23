/**
 * v4Reader.ts — read the live MoleHook (Uniswap v4) pool state via the StateView periphery contract and
 * turn it into a routable PoolState the aggregator can quote and MoleRouter can execute.
 *
 * v4 pools have no per-pool contract; their state lives in the PoolManager singleton, read here through
 * StateView.getSlot0 / getLiquidity / getTickBitmap / getTickInfo by pool id. The swap math is identical
 * to v3 (v4PoolState reuses it), so the only work is fetching the right words and resolving the dynamic
 * fee. Two correctness pins:
 *   - QUOTE fee = the live lpFee from slot0 (MoleHook's fixed lpFeePips), NOT the 0x800000 sentinel.
 *   - EXECUTION key fee = the 0x800000 dynamic-fee sentinel, because that is the key that hashes to the
 *     live pool id; the quote fee and the execution-key fee are deliberately different.
 * If MoleHook is ever charging a hookFeePips (afterSwap delta), the pool is not quotable off-chain and is
 * excluded (v4PoolState throws → we return null) rather than mis-quoted.
 */
import { createPublicClient, http, type Address } from "viem";
import { v4PoolState } from "./v4Pool";
import type { PoolState, TickData } from "./v3Pool";
import { robinhoodChain, LIVE_POOL_KEY, MOLE_ADDRESSES, DYNAMIC_FEE_FLAG, ROBINHOOD_RPC_URL } from "@/lib/mole/chain";
import { poolIdOf, type V4PoolKey } from "@/lib/mole/poolId";
import { wordsToFetch, DEFAULT_WORD_RADIUS } from "../indexer";

/** Uniswap v4 StateView periphery on Robinhood Chain — exported so the hooked-pool batch (hookedQuote.ts)
 *  can read slot0/liquidity through the SAME contract and ABI this reader uses. */
export const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as Address;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

export const stateViewAbi = [
  { type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] },
  { type: "function", name: "getLiquidity", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ type: "uint128" }] },
  { type: "function", name: "getTickBitmap", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }, { name: "wordPos", type: "int16" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getTickInfo", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }, { name: "tick", type: "int24" }], outputs: [{ type: "uint128" }, { type: "int128" }, { type: "uint256" }, { type: "uint256" }] },
] as const;

const hookAbi = [
  { type: "function", name: "hookFeePips", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
] as const;

function client() {
  const rpc = (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) || ROBINHOOD_RPC_URL;
  return createPublicClient({ chain: robinhoodChain, transport: http(rpc) });
}

/* ------------------------------------------------------------------ tick window (widening) */

const MIN_TICK = -887272;
const MAX_TICK = 887272;

/** Which 256-bit bitmap word a tick lives in. Floor division twice — correct for negative ticks. */
function wordOfTick(tick: number, tickSpacing: number): number {
  return Math.floor(Math.floor(tick / tickSpacing) / 256);
}

/**
 * How far ONE widening pass may reach on a single side, in bitmap words.
 *
 * 128 words is the ENTIRE tick space at tickSpacing >= 60 (spacing 60 spans words -58..57, spacing 200
 * spans -18..17), so for the spacings these v4 pools actually use the widened search is exhaustive: if an
 * initialised tick exists on that side, it is found. At finer spacings it still reaches
 * 128 * 256 * tickSpacing ticks — 327,680 at spacing 10 — while keeping the read to ONE extra multicall.
 */
const MAX_WIDEN_WORDS_PER_SIDE = 128;

/** Calldata bytes per aggregate3 chunk. Sized so the base window is still one eth_call and a full
 *  widening pass is two or three, rather than viem's default 1024 bytes (~15 reads) per round trip. */
const MULTICALL_CHUNK_BYTES = 8_192;

/**
 * The EXTRA bitmap words to read when the window around spot came back one-sided, nearest word first.
 *
 * This is the second half of the fix that `wordsToFetch` started. That helper widened the window to the
 * MIN/MAX boundary words, which covers a FULL-RANGE position; it does nothing for a BOUNDED position
 * whose far tick is neither near spot nor at the extremes. The hole is invisible at one tickSpacing and
 * fatal at another, because the window is measured in WORDS: one word spans 256 * tickSpacing ticks, so
 * a fixed +/-6-word radius reaches +/-307,200 ticks at spacing 200 but only +/-92,160 at spacing 60.
 *
 * Measured on this chain: the launchpad seeds one position 120,000 ticks wide with spot sitting exactly
 * on its lower tick. At spacing 200 that upper tick is 2.3 words away and the pool quotes; at spacing 60
 * it is 7.8 words away — one word outside the window — so the reader saw only the lower tick, the pool
 * looked one-sided, the quoter could not cross upward, and every fee-3000 pool answered "no liquidity
 * route found" for a buy the chain executes happily. Live pool 0xd6c1698f… (fee 3000, spacing 60): spot
 * tick -210600, initialised ticks -210600 (word -14, the centre word) and -90600 (word -6, EIGHT words
 * up). Widening reads the second one.
 *
 * Bounded and lazy: nothing extra is read unless a side is genuinely missing, and never more than `cap`
 * words per side. Exported so the v3 readers can adopt the same widening rather than re-deriving it.
 *
 * @param alreadyRead the words the base window already covered — never re-read.
 */
export function widenWords(
  centerWord: number,
  tickSpacing: number,
  alreadyRead: readonly number[],
  needBelow: boolean,
  needAbove: boolean,
  cap: number = MAX_WIDEN_WORDS_PER_SIDE,
): number[] {
  const minWord = wordOfTick(Math.ceil(MIN_TICK / tickSpacing) * tickSpacing, tickSpacing);
  const maxWord = wordOfTick(Math.floor(MAX_TICK / tickSpacing) * tickSpacing, tickSpacing);
  const read = new Set(alreadyRead);
  // Nearest-first along one side, skipping what the window already covered, then truncated to the cap.
  const side = (count: number, at: (i: number) => number) =>
    Array.from({ length: Math.max(0, count) }, (_, i) => at(i))
      .filter((w) => !read.has(w))
      .slice(0, cap);
  const out: number[] = [];
  if (needAbove) out.push(...side(maxWord - centerWord, (i) => centerWord + 1 + i));
  if (needBelow) out.push(...side(centerWord - minWord, (i) => centerWord - 1 - i));
  return out;
}

/**
 * Read the initialised ticks a quote can actually cross: the window around spot, widened outward on any
 * side that came back empty. `baseRadius` is the cheap first look; the widening only fires when the pool
 * really is one-sided through that window, so a normal dense pool costs exactly what it cost before.
 *
 * "One side is missing" is defined the way the simulator crosses ticks: downward it consumes ticks at or
 * below the current tick, upward it consumes ticks strictly above it.
 */
async function readTickWindow(
  c: ReturnType<typeof client>,
  poolId: `0x${string}`,
  tickSpacing: number,
  tick: number,
  baseRadius: number,
): Promise<TickData[]> {
  const readBitmaps = async (ws: number[]): Promise<bigint[]> =>
    ws.length === 0
      ? []
      : ((await c.multicall({
          contracts: ws.map((w) => ({
            address: STATE_VIEW,
            abi: stateViewAbi,
            functionName: "getTickBitmap" as const,
            args: [poolId, w] as const,
          })),
          multicallAddress: MULTICALL3,
          allowFailure: false,
          batchSize: MULTICALL_CHUNK_BYTES,
        })) as bigint[]);

  const ticksIn = (ws: number[], bitmaps: bigint[]): number[] => {
    const out: number[] = [];
    ws.forEach((w, i) => {
      const bm = bitmaps[i]!;
      if (bm === 0n) return;
      for (let bit = 0; bit < 256; bit++) {
        if ((bm >> BigInt(bit)) & 1n) out.push((w * 256 + bit) * tickSpacing);
      }
    });
    return out;
  };

  const centerWord = wordOfTick(tick, tickSpacing);
  const base = wordsToFetch(centerWord, tickSpacing, baseRadius);
  const tickList = ticksIn(base, await readBitmaps(base));

  const needBelow = !tickList.some((t) => t <= tick);
  const needAbove = !tickList.some((t) => t > tick);
  if (needBelow || needAbove) {
    const extra = widenWords(centerWord, tickSpacing, base, needBelow, needAbove);
    if (extra.length > 0) tickList.push(...ticksIn(extra, await readBitmaps(extra)));
  }
  if (tickList.length === 0) return [];

  const infos = (await c.multicall({
    contracts: tickList.map((t) => ({
      address: STATE_VIEW,
      abi: stateViewAbi,
      functionName: "getTickInfo" as const,
      args: [poolId, t] as const,
    })),
    multicallAddress: MULTICALL3,
    allowFailure: false,
    batchSize: MULTICALL_CHUNK_BYTES,
  })) as readonly (readonly [bigint, bigint, bigint, bigint])[];

  // TickData keys the tick by `index` — the simulator binary-searches on it; a wrong key here made
  // every v4 tick invisible and quoted the pool as constant-liquidity (over-quote → minOut revert).
  return tickList.map((t, i) => ({ index: t, liquidityNet: infos[i]![1] })).sort((a, b) => a.index - b.index);
}

/** Read the live MoleHook WETH/USDG pool and return it as a routable PoolState, or null if unquotable. */
export async function fetchV4MolePool(): Promise<PoolState | null> {
  return fetchV4Pool({
    currency0: LIVE_POOL_KEY.currency0 as Address,
    currency1: LIVE_POOL_KEY.currency1 as Address,
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: LIVE_POOL_KEY.tickSpacing,
    hooks: LIVE_POOL_KEY.hooks as Address,
  });
}

/**
 * Read ANY MoleHook v4 pool (the live one or one created later via the operator flow) and return it as a
 * routable PoolState, or null if unquotable. The pool id is derived from the key, so a newly-created +
 * whitelisted pool routes the moment it is registered — no code change per pool.
 */
export async function fetchV4Pool(poolKey: V4PoolKey): Promise<PoolState | null> {
  try {
    const c = client();
    // fee on the KEY is always the dynamic-fee sentinel — that is what hashes to the pool id.
    const key: V4PoolKey = { ...poolKey, fee: DYNAMIC_FEE_FLAG };
    const poolId = poolIdOf(key) as `0x${string}`;
    const tickSpacing = key.tickSpacing;

    const [slot0, liquidity, hookFee] = await Promise.all([
      c.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] }) as Promise<readonly [bigint, number, number, number]>,
      c.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [poolId] }) as Promise<bigint>,
      c.readContract({ address: MOLE_ADDRESSES.moleHook as Address, abi: hookAbi, functionName: "hookFeePips", args: [] }).catch(() => 0) as Promise<number>,
    ]);

    const sqrtPriceX96 = slot0[0];
    const tick = Number(slot0[1]);
    const lpFee = Number(slot0[3]); // live dynamic lpFee (== MoleHook.lpFeePips)
    if (sqrtPriceX96 === 0n) return null; // pool uninitialised

    // Walk the tick bitmap around the current tick to collect initialised ticks (same layout as v3).
    // Boundary words are included for the same reason as the v3 readers: a full-range position parks
    // its ticks at the extremes of tick space, far outside any window centred on spot, and reading
    // only the window makes the pool look one-sided so the quoter refuses one direction entirely.
    // This is our OWN v4 venue, and MoleSwap pools are seeded full-range by create-pool — hence the
    // small base radius. readTickWindow widens it automatically if a side still comes back empty,
    // which is what a bounded (non-full-range) position needs; at spacing 60 a radius of 3 reaches
    // only +/-46,080 ticks, so an operator-created pool with a narrow band was unbuyable without it.
    const ticks: TickData[] = await readTickWindow(c, poolId, tickSpacing, tick, 3);

    // Build the quotable state (quote fee = live lpFee), then restore the execution key's dynamic-fee
    // sentinel so the plan targets the real pool id.
    const state = v4PoolState({
      poolKey: {
        currency0: key.currency0,
        currency1: key.currency1,
        fee: lpFee,
        tickSpacing,
        hooks: key.hooks,
      },
      sqrtPriceX96,
      tick,
      liquidity,
      ticks,
      hookFeePips: Number(hookFee),
    });

    return { ...state, poolKey: { ...(state.poolKey as any), fee: DYNAMIC_FEE_FLAG } };
  } catch {
    // Unquotable (hook charging a fee, RPC hiccup, etc.) → exclude rather than mis-quote.
    return null;
  }
}

/**
 * Read a return-delta-hook v4 pool as a TICK-MATH REFERENCE — the number the pool WOULD return if its
 * hook took no delta. This is NOT a quote and must never be executed against: for a return-delta hook the
 * real output differs (the hook moves tokens the tick math never sees), which is exactly why the executable
 * quote comes from the on-chain simulator (v4Simulate.ts). Its ONLY use is the skim screen — comparing
 * this tick-math figure against the simulated one tells us how much value the hook is currently extracting,
 * so a hook skimming more than a bounded fraction can be excluded.
 *
 * It deliberately does NOT call `v4PoolState`/`assertQuotableHook` (which throw on a delta hook by design);
 * it builds the state directly and tags it UniswapV4 so `quoteExactInput` can price it. Returns null when
 * the pool is uninitialised or unreadable.
 */
export async function fetchV4TickReference(poolKey: V4PoolKey): Promise<PoolState | null> {
  try {
    const c = client();
    const poolId = poolIdOf(poolKey) as `0x${string}`;
    const tickSpacing = poolKey.tickSpacing;

    const [slot0, liquidity] = await Promise.all([
      c.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] }) as Promise<readonly [bigint, number, number, number]>,
      c.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [poolId] }) as Promise<bigint>,
    ]);

    const sqrtPriceX96 = slot0[0];
    const tick = Number(slot0[1]);
    const lpFee = Number(slot0[3]);
    if (sqrtPriceX96 === 0n) return null;

    // Same LP+protocol fee composition the real reader uses (see fetchV4PoolByKey), so the reference
    // charges the same swap fee the chain does — only the hook delta is (unavoidably) absent from it.
    const protoRaw = Number(slot0[2]);
    const protocolFee = Math.max(protoRaw & 0xfff, (protoRaw >> 12) & 0xfff);
    const effectiveFee = Math.round(1e6 - ((1e6 - protocolFee) * (1e6 - lpFee)) / 1e6);

    const ticks: TickData[] = await readTickWindow(c, poolId, tickSpacing, tick, DEFAULT_WORD_RADIUS);

    return {
      address: `v4ref:${poolKey.currency0}:${poolKey.currency1}:${poolKey.fee}:${tickSpacing}:${poolKey.hooks}`,
      token0: poolKey.currency0,
      token1: poolKey.currency1,
      fee: effectiveFee,
      tickSpacing,
      sqrtPriceX96,
      tick,
      liquidity,
      ticks,
      venue: "UniswapV4",
      poolKey: { ...poolKey, fee: effectiveFee },
    };
  } catch {
    return null;
  }
}

/**
 * Read ANY v4 pool by its real key — external pools included.
 *
 * fetchV4Pool above is MoleHook-specific: it overwrites the key's fee with the dynamic-fee sentinel
 * (right for our own pools, which are all created dynamic) and reads MoleHook.hookFeePips. Neither
 * holds for a foreign pool — external pools carry a real fee tier (2500, 10000, …) or the sentinel,
 * and their hook is someone else's contract. The key is reproduced EXACTLY as initialised, because
 * any normalisation hashes to a different id and the pool reads as uninitialised.
 *
 * State is read live from the chain on every quote, exactly like the v3 multicall path — only the
 * pool's EXISTENCE comes from the registry.
 */
export async function fetchV4PoolByKey(poolKey: V4PoolKey): Promise<PoolState | null> {
  try {
    const c = client();
    const poolId = poolIdOf(poolKey) as `0x${string}`;
    const tickSpacing = poolKey.tickSpacing;

    const [slot0, liquidity] = await Promise.all([
      c.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] }) as Promise<readonly [bigint, number, number, number]>,
      c.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [poolId] }) as Promise<bigint>,
    ]);

    const sqrtPriceX96 = slot0[0];
    const tick = Number(slot0[1]);
    const lpFee = Number(slot0[3]);
    if (sqrtPriceX96 === 0n) return null;

    // v4 charges a PROTOCOL fee on top of the LP fee, and slot0 returns it separately. Our own
    // MoleHook pools have it set to zero, so the MoleHook reader never needed it — but external
    // pools do set it, and ignoring it over-quotes by exactly that amount. Measured on the GSMC
    // pool: protocolFee 4097000 packs to 1000 pips (0.1000%) per direction, and the engine
    // over-quoted the chain by 0.1000% until this was included.
    // Packing: the low 12 bits are the zeroForOne fee, the next 12 the oneForZero fee, in pips.
    const protoRaw = Number(slot0[2]);
    const protoZeroForOne = protoRaw & 0xfff;
    const protoOneForZero = (protoRaw >> 12) & 0xfff;
    // The simulator takes a single fee, so use the worse of the two directions rather than guess
    // which way this pool will be traded — under-quoting is safe, over-quoting causes reverts.
    const protocolFee = Math.max(protoZeroForOne, protoOneForZero);
    // v4 applies the protocol fee first, then the LP fee on the remainder. Composing them keeps a
    // single effective rate that reproduces the chain: 1 - (1-p)(1-l).
    const effectiveFee = Math.round(1e6 - ((1e6 - protocolFee) * (1e6 - lpFee)) / 1e6);

    // Window around spot, widened on any side that comes back empty. A fixed word radius is a tick
    // radius that SHRINKS with tickSpacing, which is exactly why the fee-3000/spacing-60 pools on this
    // chain read as one-sided and quoted "no route" while the fee-10000/spacing-200 pools — holding the
    // identically-shaped position — quoted fine. See widenWords.
    const ticks: TickData[] = await readTickWindow(c, poolId, tickSpacing, tick, DEFAULT_WORD_RADIUS);

    const state = v4PoolState({
      poolKey: { ...poolKey, fee: effectiveFee },
      sqrtPriceX96,
      tick,
      liquidity,
      ticks,
      hookFeePips: 0, // a foreign hook's fee is not readable through MoleHook's ABI
    });

    // Execution must target the key as initialised, fee included.
    return { ...state, poolKey: { ...(state.poolKey as any), fee: poolKey.fee } };
  } catch {
    return null;
  }
}
