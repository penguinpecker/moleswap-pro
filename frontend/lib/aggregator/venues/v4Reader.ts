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
import { robinhoodChain } from "@/lib/pushchain/wagmi-config";
import { v4PoolState } from "./v4Pool";
import type { PoolState, TickData } from "./v3Pool";
import { LIVE_POOL_ID, LIVE_POOL_KEY, MOLE_ADDRESSES, DYNAMIC_FEE_FLAG, ROBINHOOD_RPC_URL } from "@/lib/mole/chain";

const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as Address;

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
  try {
    const c = client();
    const poolId = LIVE_POOL_ID as `0x${string}`;
    const tickSpacing = LIVE_POOL_KEY.tickSpacing;

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
    const words: number[] = [];
    for (let w = centerWord - 3; w <= centerWord + 3; w++) words.push(w);
    const bitmaps = await Promise.all(
      words.map((w) => c.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getTickBitmap", args: [poolId, w] }) as Promise<bigint>),
    );

    const tickList: number[] = [];
    words.forEach((w, i) => {
      let bm = bitmaps[i];
      if (bm === 0n) return;
      for (let bit = 0; bit < 256; bit++) {
        if ((bm >> BigInt(bit)) & 1n) tickList.push((w * 256 + bit) * tickSpacing);
      }
    });

    const infos = await Promise.all(
      tickList.map((t) => c.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getTickInfo", args: [poolId, t] }) as Promise<readonly [bigint, bigint, bigint, bigint]>),
    );
    const ticks: TickData[] = tickList
      .map((t, i) => ({ tick: t, liquidityNet: infos[i][1] }))
      .sort((a, b) => a.tick - b.tick);

    // Build the quotable state (quote fee = live lpFee), then restore the execution key's dynamic-fee
    // sentinel so the plan targets the real pool id.
    const state = v4PoolState({
      poolKey: {
        currency0: LIVE_POOL_KEY.currency0,
        currency1: LIVE_POOL_KEY.currency1,
        fee: lpFee,
        tickSpacing,
        hooks: LIVE_POOL_KEY.hooks,
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
