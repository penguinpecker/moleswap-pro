/**
 * discover.ts — on-demand, on-chain pool discovery. This is what makes MoleSwap a real aggregator:
 * a user can paste ANY token address and, if it has liquidity anywhere on Robinhood Chain, we find its
 * pools live and quote across them — no waiting on the indexer.
 *
 * How: every Uniswap-V3-style factory exposes `getPool(tokenA, tokenB, fee)`. We batch a getPool call for
 * the pair (and its WETH/USDG hub legs) across every executable factory × every fee tier into ONE
 * Multicall3 request, keep the non-zero results, and hand them back as PoolRows the quoter already knows
 * how to price. Empty pools are dropped later when their state reads back with zero liquidity.
 *
 * Only factories MoleRouter can actually execute (Uniswap-V3 + Pancake-V3 callbacks) are queried — Ramses
 * and Velodrome/CLFactory are excluded because the immutable router cannot call their swap callbacks.
 */
import { createPublicClient, http, encodeFunctionData, decodeAbiParameters, type Address } from "viem";
import { robinhoodChain } from "@/lib/mole/chain";
import type { PoolRow } from "./client";

const MC3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE_LC = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

// Executable V3 factories on Robinhood Chain (MoleRouter has both these forks' swap callbacks).
const FACTORIES: { f: Address; venue: "uniswap_v3" | "pancake_v3" }[] = [
  { f: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa", venue: "uniswap_v3" }, // launchpad
  { f: "0xe51960f1b45f1c9fb6d166e6a884f866fc70433b", venue: "uniswap_v3" },
  { f: "0x3fdabf7ab5d871b89f1d9da04dc2e0733db70caf", venue: "uniswap_v3" },
  { f: "0xd479e71c45aeb1e846a7b549c346d62fe77b39ba", venue: "uniswap_v3" },
  { f: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", venue: "pancake_v3" },
  { f: "0x0ec554f0bff0be6c99d1e95c8015bb0950f6a2c7", venue: "pancake_v3" },
];
const FEES = [80, 100, 250, 500, 2500, 3000, 10000];
const SPACING: Record<number, number> = { 80: 1, 100: 1, 250: 5, 500: 10, 2500: 50, 3000: 60, 10000: 200 };

const getPoolAbi = [
  { type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] },
] as const;
const mc3Abi = [
  { type: "function", name: "aggregate3", stateMutability: "view", inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "callData", type: "bytes" }] }], outputs: [{ name: "returnData", type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }] },
] as const;

function client() {
  const rpc = (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) || robinhoodChain.rpcUrls.default.http[0];
  return createPublicClient({ chain: robinhoodChain, transport: http(rpc) });
}

const cache = new Map<string, { at: number; rows: PoolRow[] }>();
const lc = (a: string) => a.toLowerCase();

/** Discover every live V3 pool for the given unordered token pairs, across all executable factories. */
export async function discoverPools(pairs: [string, string][]): Promise<PoolRow[]> {
  // Normalise + drop degenerate/native pairs; cache key is the sorted pair set.
  const norm = pairs
    .map(([a, b]) => [lc(a), lc(b)] as [string, string])
    .filter(([a, b]) => a && b && a !== b && a !== NATIVE_LC && b !== NATIVE_LC);
  if (norm.length === 0) return [];
  const key = norm.map((p) => [...p].sort().join("-")).sort().join("|");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.rows;

  const calls: { target: Address; allowFailure: boolean; callData: `0x${string}` }[] = [];
  const meta: { a: string; b: string; fee: number; venue: "uniswap_v3" | "pancake_v3" }[] = [];
  for (const [a, b] of norm) {
    for (const { f, venue } of FACTORIES) {
      for (const fee of FEES) {
        calls.push({ target: f, allowFailure: true, callData: encodeFunctionData({ abi: getPoolAbi, functionName: "getPool", args: [a as Address, b as Address, fee] }) });
        meta.push({ a, b, fee, venue });
      }
    }
  }

  let res: readonly { success: boolean; returnData: `0x${string}` }[];
  try {
    res = (await client().readContract({ address: MC3, abi: mc3Abi, functionName: "aggregate3", args: [calls] })) as any;
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const rows: PoolRow[] = [];
  res.forEach((r, i) => {
    if (!r.success || !r.returnData || r.returnData.length < 66) return;
    let pool: string;
    try {
      pool = (decodeAbiParameters([{ type: "address" }], r.returnData)[0] as string).toLowerCase();
    } catch {
      return;
    }
    if (!pool || pool === ZERO || seen.has(pool)) return;
    seen.add(pool);
    const { a, b, fee, venue } = meta[i];
    const [token0, token1] = a < b ? [a, b] : [b, a];
    rows.push({ id: pool, venue, token0, token1, fee, tick_spacing: SPACING[fee] ?? 60, hooks: null, address: pool, active: true });
  });

  cache.set(key, { at: Date.now(), rows });
  return rows;
}

/** Discover the pools relevant to a swap: the direct pair plus WETH and USDG hub legs for both sides. */
export async function discoverForPair(tokenIn: string, tokenOut: string, weth: string): Promise<PoolRow[]> {
  const w = lc(weth);
  const inT = lc(tokenIn) === NATIVE_LC ? w : lc(tokenIn);
  const outT = lc(tokenOut) === NATIVE_LC ? w : lc(tokenOut);
  return discoverPools([
    [inT, outT],
    [inT, w],
    [outT, w],
    [inT, USDG],
    [outT, USDG],
  ]);
}

/** True if a token has any live pool against WETH or USDG — used to admit a pasted token for import. */
export async function tokenHasPool(token: string): Promise<PoolRow[]> {
  return discoverPools([[lc(token), WETH], [lc(token), USDG]]);
}
