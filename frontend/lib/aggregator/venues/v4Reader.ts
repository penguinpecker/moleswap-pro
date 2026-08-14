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
import { wordsToFetch } from "../indexer";

const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as Address;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

const stateViewAbi = [
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
    const compressed = Math.floor(tick / tickSpacing);
    const centerWord = compressed >> 8;
    // Boundary words included for the same reason as the v3 readers: a full-range position parks
    // its ticks at the extremes of tick space, far outside any window centred on spot, and reading
    // only the window makes the pool look one-sided so the quoter refuses one direction entirely.
    // This is our OWN v4 venue, and MoleSwap pools are seeded full-range by create-pool.
    const words: number[] = wordsToFetch(centerWord, tickSpacing, 3);
    const bitmapResults = await c.multicall({
      contracts: words.map((w) => ({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getTickBitmap" as const, args: [poolId, w] as const })),
      multicallAddress: MULTICALL3,
      allowFailure: false,
    });
    const bitmaps = bitmapResults as bigint[];

    const tickList: number[] = [];
    words.forEach((w, i) => {
      let bm = bitmaps[i]!;
      if (bm === 0n) return;
      for (let bit = 0; bit < 256; bit++) {
        if ((bm >> BigInt(bit)) & 1n) tickList.push((w * 256 + bit) * tickSpacing);
      }
    });

    const infos = (await c.multicall({
      contracts: tickList.map((t) => ({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getTickInfo" as const, args: [poolId, t] as const })),
      multicallAddress: MULTICALL3,
      allowFailure: false,
    })) as readonly (readonly [bigint, bigint, bigint, bigint])[];
    // TickData keys the tick by `index` — the simulator binary-searches on it; a wrong key here made
    // every v4 tick invisible and quoted the pool as constant-liquidity (over-quote → minOut revert).
    const ticks: TickData[] = tickList
      .map((t, i) => ({ index: t, liquidityNet: infos[i]![1] }))
      .sort((a, b) => a.index - b.index);

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

    const centerWord = Math.floor(Math.floor(tick / tickSpacing) / 256);
    const words = wordsToFetch(centerWord, tickSpacing, 6);
    const bitmaps = (await c.multicall({
      contracts: words.map((w) => ({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getTickBitmap" as const, args: [poolId, w] as const })),
      multicallAddress: MULTICALL3,
      allowFailure: false,
    })) as bigint[];

    const tickList: number[] = [];
    words.forEach((w, i) => {
      const bm = bitmaps[i]!;
      if (bm === 0n) return;
      for (let bit = 0; bit < 256; bit++) {
        if ((bm >> BigInt(bit)) & 1n) tickList.push((w * 256 + bit) * tickSpacing);
      }
    });

    const infos = (await c.multicall({
      contracts: tickList.map((t) => ({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getTickInfo" as const, args: [poolId, t] as const })),
      multicallAddress: MULTICALL3,
      allowFailure: false,
    })) as readonly (readonly [bigint, bigint, bigint, bigint])[];

    const ticks: TickData[] = tickList
      .map((t, i) => ({ index: t, liquidityNet: infos[i]![1] }))
      .sort((a, b) => a.index - b.index);

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
