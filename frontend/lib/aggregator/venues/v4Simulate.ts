/**
 * v4Simulate.ts — price a return-delta-hook v4 pool by SIMULATION, because tick math cannot.
 *
 * A return-delta hook adds or removes tokens on the swap path (Part 2 §5): the caller's swap delta has the
 * hook's delta subtracted from it, so the honest output is whatever the swap ACTUALLY returns, not what the
 * curve says. The only thing that knows that number without moving funds is the canonical Uniswap v4
 * Quoter, which runs the real swap inside `unlock()` and reverts with the result (a revert-based simulation
 * that includes the hook's `beforeSwap`/`afterSwap` deltas). We call it read-only via `eth_call` — no key,
 * no gas, no state change, and no funded caller: the quoter needs no balance or allowance, which is what
 * unblocked this after the WETH-predeploy balance-override attempt (records 2026-08-13) went nowhere.
 *
 * SCOPE, on purpose: this path is used ONLY for return-delta-hook pools (hookClass.ts → "simulate"). Every
 * other pool stays on the network-free tick-math path (that is the whole reason a quote is microseconds).
 * Each simulate call is one `eth_call`; the caller caps how many run per quote so latency stays near the
 * ~0.15s baseline.
 *
 * FUND SAFETY: the number this returns is the real output, and the caller sets `minOut` from it and never
 * above it (never from the tick-math reference, which would bake in the hook's skim and revert). If the
 * hook reverts the swap, the quoter reverts, and we return null → the pool is excluded rather than quoted
 * on a fiction.
 *
 * The canonical V4Quoter on Robinhood Chain is 0x8dc178efb8111bb0973dd9d722ebeff267c98f94 — verified on
 * chain 2026-08-22: 6,118 bytes of code, `poolManager()` (0xdc4c90d3) == the live singleton 0x8366…0951,
 * `quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))` selector
 * 0xaa9d21cb (`cast sig` agrees), returns (uint256 amountOut, uint256 gasEstimate).
 */

import { encodeFunctionData, decodeFunctionResult, type Address } from "viem";
import type { V4PoolKey } from "../../mole/poolId";
import { ROBINHOOD_RPC_URL } from "../../mole/chain";
import { quoteExactInput, type PoolState } from "./v3Pool";
import { jsonRpcBatch, type RpcBatchCall, type RpcBatchResult } from "../rpcBatch";

/** Canonical Uniswap v4 Quoter on Robinhood Chain (4663). Verified on chain, see the module header. */
export const V4_QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" as Address;

/** `quoteExactInputSingle` selector, pinned so a silent ABI drift in this file fails a test rather than
 *  quietly calling a different function. */
export const QUOTE_EXACT_INPUT_SINGLE_SELECTOR = "0xaa9d21cb";

/** Per-call latency ceiling. A slow simulate must not drag a quote past its budget; a timeout fails closed
 *  (returns null → pool excluded), same as a revert. */
export const SIMULATE_TIMEOUT_MS = 1_500;

/**
 * How far the SIMULATED output may fall below the tick-math reference before the pool is excluded, in bps.
 *
 * "In the hook's favour" = the hook is taking value = the real output is below what the curve alone would
 * give. A small gap is an ordinary hook fee; a large one is a hook extracting most of the trade, and we
 * refuse to route users through it however honest the simulated number is. 1000 bps (10%) is the line: a
 * generous ceiling for a legitimate hook fee, well below the "the hook is eating the trade" regime. Tunable
 * — it is a policy number, not a law, and it is documented here as the one place it lives. Note that for a
 * DYNAMIC-fee pool the reference is priced at slot0's lpFee, so a per-swap fee override the hook applies
 * counts towards this gap too — a launch-phase toll above 10% is refused by design.
 */
export const MAX_HOOK_SKIM_BPS = 1000;

const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

function rpc(rpcUrl?: string): string {
  return (
    rpcUrl ||
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) ||
    ROBINHOOD_RPC_URL
  );
}

/** uint128 ceiling — the quoter's `exactAmount` type. A larger input cannot be encoded and must not be
 *  silently truncated into a smaller (wrongly priced) quote. */
const UINT128_MAX = (1n << 128n) - 1n;

/** Encode the exact `quoteExactInputSingle` calldata for a pool. Exported so a differential test can pin
 *  the encoding against the chain's expectation without a live call. */
export function encodeQuoteCalldata(poolKey: V4PoolKey, zeroForOne: boolean, exactAmount: bigint): `0x${string}` {
  if (exactAmount < 0n || exactAmount > UINT128_MAX) throw new Error(`exactAmount ${exactAmount} does not fit uint128`);
  return encodeFunctionData({
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: {
          currency0: poolKey.currency0,
          currency1: poolKey.currency1,
          fee: poolKey.fee,
          tickSpacing: poolKey.tickSpacing,
          hooks: poolKey.hooks,
        },
        zeroForOne,
        exactAmount,
        hookData: "0x",
      },
    ],
  });
}

/** Decode a raw `quoteExactInputSingle` return into (amountOut, gasEstimate). Exported for the
 *  differential test. */
export function decodeQuoteResult(data: `0x${string}`): { amountOut: bigint; gasEstimate: bigint } {
  const [amountOut, gasEstimate] = decodeFunctionResult({
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    data,
  }) as readonly [bigint, bigint];
  return { amountOut, gasEstimate };
}

/** The batchable form of one quoter read: an `eth_call` to the V4 Quoter. */
export function quoteCall(poolKey: V4PoolKey, zeroForOne: boolean, amountIn: bigint): RpcBatchCall {
  return { method: "eth_call", params: [{ to: V4_QUOTER, data: encodeQuoteCalldata(poolKey, zeroForOne, amountIn) }, "latest"] };
}

export interface SimulateResult {
  /** The real exact-input output including the hook's swap delta. */
  amountOut: bigint;
  /** The quoter's own gas estimate for the swap. */
  gasEstimate: bigint;
}

/**
 * Turn one quoter batch answer into a result, or null. A revert that reaches us (hook rejected,
 * NotEnoughLiquidity, uninitialised pool, …) arrives as a per-call error → exclude the pool. An error wins
 * even if a result field is also present — never trust a flagged response. A zero output is "nothing to
 * route", also null.
 */
export function parseQuoteAnswer(answer: RpcBatchResult | undefined): SimulateResult | null {
  if (!answer || !answer.ok || !answer.result || answer.result === "0x") return null;
  try {
    const { amountOut, gasEstimate } = decodeQuoteResult(answer.result as `0x${string}`);
    if (amountOut <= 0n) return null;
    return { amountOut, gasEstimate };
  } catch {
    return null; // undecodable → fail closed
  }
}

/**
 * Simulate an exact-input single-hop swap through a v4 pool via the canonical Quoter. Returns null when the
 * quoter reverts (hook rejected the swap, no liquidity, uninitialised pool) or the read times out — every
 * one of which means "do not quote this pool", not "the output is zero".
 */
export async function simulateV4ExactInputSingle(
  poolKey: V4PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  rpcUrl?: string,
  timeoutMs: number = SIMULATE_TIMEOUT_MS,
): Promise<SimulateResult | null> {
  if (amountIn <= 0n || amountIn > UINT128_MAX) return null;
  try {
    const [answer] = await jsonRpcBatch(rpc(rpcUrl), [quoteCall(poolKey, zeroForOne, amountIn)], timeoutMs);
    return parseQuoteAnswer(answer);
  } catch {
    // Timeout / network failure → fail closed.
    return null;
  }
}

export interface SkimScreen {
  /** Pass = the pool may be quoted by simulation. */
  ok: boolean;
  /** How far the simulated output sits below the tick-math reference, in bps (positive = hook's favour).
   *  Null when no usable reference exists (the direction has no tick-math route to compare against). */
  skimBps: number | null;
}

/**
 * Screen the simulated output against a tick-math reference for the same pool and amount.
 *
 * Excludes a pool whose hook skims more than `maxSkimBps` in its own favour. A missing/zero reference is
 * NOT a failure: the direction may simply have no tick-math route (a one-sided position), in which case
 * there is nothing to compare and the simulated number stands on its own — fund safety does not rest on
 * this screen (it rests on minOut ≤ simulated), so an unscreenable pool is allowed, not rejected.
 */
export function screenSkim(
  simulated: bigint,
  tickReference: bigint | null | undefined,
  maxSkimBps: number = MAX_HOOK_SKIM_BPS,
): SkimScreen {
  if (simulated <= 0n) return { ok: false, skimBps: null };
  if (!tickReference || tickReference <= 0n) return { ok: true, skimBps: null };
  // Only a shortfall counts as the hook's favour; a simulated output at or above the reference is fine.
  if (simulated >= tickReference) return { ok: true, skimBps: 0 };
  const skimBps = Number(((tickReference - simulated) * 10_000n) / tickReference);
  return { ok: skimBps <= maxSkimBps, skimBps };
}

/** Tick-math output for a reference pool state in one direction, or null if it cannot be priced. Wraps
 *  `quoteExactInput` so a screen caller need not know the simulator's partial-fill contract. */
export function tickReferenceOutput(reference: PoolState | null | undefined, zeroForOne: boolean, amountIn: bigint): bigint | null {
  if (!reference || amountIn <= 0n) return null;
  try {
    const q = quoteExactInput(reference, zeroForOne, amountIn);
    // A partial fill priced against liquidity we could not see is not a trustworthy reference; treat it as
    // "no reference" so the skim screen abstains rather than comparing against a number it cannot stand on.
    if (q.exhaustedTickData || q.amountOut <= 0n) return null;
    return q.amountOut;
  } catch {
    return null;
  }
}
