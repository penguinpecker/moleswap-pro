/**
 * hookedQuote.ts — build an executable quote for a return-delta-hook v4 pool from an on-chain simulation.
 *
 * This is the fallback the tick-math router cannot provide: for a pool whose hook skims the swap, the only
 * honest output is what the chain returns, so this prices a DIRECT single hop through the pool via the
 * canonical V4 Quoter (v4Simulate.ts), screens the hook (hookRisk.ts) and the skim (v4Simulate.screenSkim),
 * and — only if both pass — assembles the same `SwapQuote` shape the tick path produces, with `minOut`
 * computed from the SIMULATED output and never above it.
 *
 * ONE ROUND TRIP. Every read the path needs for every candidate — the quoter call, the pool's slot0 and
 * liquidity (the tick-math reference), and the hook screen (code + two EIP-1967 slots, cached per hook) —
 * goes out as ONE JSON-RPC batch (rpcBatch.ts). That is what keeps the added latency at a single network
 * hop that overlaps the tick-state multicalls, instead of the 3–4 serial hops a naive implementation costs
 * (measured: the serial form added 300–800 ms under RPC contention; learnings 19.2).
 *
 * Two halves, split so the 1-second live session can use them separately:
 *   - `simulateHookedPools`  — ASYNC, the batch: screen + light reference + quoter, per candidate.
 *   - `assembleHookedQuote`  — PURE: turn a simulation into a SwapQuote for a recipient/deadline/slippage.
 * `bestHookedSimulateQuote` is the one-shot composition the server/API quote path (client.ts) uses.
 *
 * THE REFERENCE IS LIGHT ON PURPOSE, AND CONFIRMED WHEN IT MATTERS. The skim screen compares the simulated
 * output with what the curve alone would give. The batch reads slot0 + in-range liquidity only (no tick
 * window), which prices the swap exactly while it stays inside the current tick range, OVER-states the
 * curve output for a swap that would cross ticks, and prices NOTHING when in-range liquidity is zero (the
 * launchpad shape: one position with spot parked on its lower tick). Over-stating can only make a hook look
 * worse and pricing nothing decides nothing — so when, and only when, the light screen would EXCLUDE a pool
 * or cannot price it, the real tick window is read (fetchV4TickReference; cached per pool for a minute and
 * combined with the batch's fresh slot0/liquidity) and the decision is re-made on it. The common case stays
 * one round trip; an exclusion is never made on the approximation, and a launchpad-shaped pool is screened
 * on its real window rather than waved through.
 *
 * Deliberately single-hop and direct only. Multi-hop or split routing through a hooked pool would need the
 * simulator on the hot path per candidate slice, which the latency budget forbids and which the tick-math
 * router already covers for every non-hooked venue. A hooked pool is a leaf: quote it whole or not at all.
 */

import { decodeFunctionResult, encodeFunctionData } from "viem";
import type { PoolRow, SwapQuote } from "./client";
import type { Quote } from "./quote";
import { NATIVE } from "./quote";
import type { PoolState } from "./venues/v3Pool";
import type { Hop, Route, SplitRoute } from "./route";
import { planFromSplit } from "./plan";
import { encodePlan } from "./router";
import { isSimulateEligible } from "./hookClass";
import { hookScreenCalls, parseHookScreen, peekHookRisk, type HookRisk } from "./hookRisk";
import { quoteCall, parseQuoteAnswer, screenSkim, tickReferenceOutput } from "./venues/v4Simulate";
import { fetchV4TickReference, STATE_VIEW, stateViewAbi } from "./venues/v4Reader";
import { jsonRpcBatch, type RpcBatchCall, type RpcBatchResult } from "./rpcBatch";
import { ROBINHOOD_RPC_URL } from "../mole/chain";
import { poolIdOf, type V4PoolKey } from "../mole/poolId";

const lc = (a: string) => a.toLowerCase();

/** How many hooked pools may be simulated per quote. Every candidate adds three calls to the ONE batch
 *  (quoter, slot0, liquidity) plus, once per distinct hook, three screen calls — so the cap bounds the
 *  batch size, not the number of round trips. The hub pair WETH/USDG alone has ten hooked pools. */
export const MAX_SIMULATED_POOLS = 4;

/** Batch latency ceiling; a slow endpoint fails the whole hooked path closed for this quote. */
export const HOOKED_BATCH_TIMEOUT_MS = 1_500;

function rpcUrlOf(rpcUrl?: string): string {
  return (
    rpcUrl ||
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) ||
    ROBINHOOD_RPC_URL
  );
}

/** The unordered pair {a, b} matches the row's two tokens. */
function rowIsPair(row: PoolRow, a: string, b: string): boolean {
  const t0 = lc(row.token0);
  const t1 = lc(row.token1);
  return (t0 === a && t1 === b) || (t0 === b && t1 === a);
}

/** A short "0x1234.. → 0x5678.. [hooked]" line for the route breakdown. */
function describeHooked(routeIn: string, routeOut: string, tag: string): string {
  const s = (a: string) => `${a.slice(0, 6)}..`;
  return `${s(routeIn)} → ${s(routeOut)} [${tag}]`;
}

/** The pool key exactly as the row was initialised — fee sentinel included, since that is what hashes to
 *  the real pool id and what execution must carry. */
export function rowPoolKey(row: PoolRow): V4PoolKey {
  return {
    currency0: row.token0 as `0x${string}`,
    currency1: row.token1 as `0x${string}`,
    fee: row.fee,
    tickSpacing: row.tick_spacing,
    hooks: (row.hooks ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
  };
}

/** Resolve the NATIVE sentinel to WETH for routing; the hop trades WETH, the plan's outer token stays. */
export function resolveRouteTokens(tokenIn: string, tokenOut: string, weth: string): { routeIn: string; routeOut: string } {
  const routeIn = lc(tokenIn) === lc(NATIVE) ? weth : tokenIn;
  const routeOut = lc(tokenOut) === lc(NATIVE) ? weth : tokenOut;
  return { routeIn, routeOut };
}

/**
 * The rows the simulate fallback will consider for this pair: simulate-eligible (a THIRD-PARTY return-delta
 * hook on ERC-20 currencies — MoleSwap's own mole_v4 / MoleHook rows are tick-path pools and never
 * candidates; see hookClass.isSimulateEligible), serving the pair DIRECTLY, deduplicated by pool id, capped
 * at MAX_SIMULATED_POOLS in registry order. Pure — no network, and it never throws on a malformed row.
 */
export function hookedCandidateRows(pools: readonly PoolRow[], routeIn: string, routeOut: string): PoolRow[] {
  const inLc = lc(routeIn);
  const outLc = lc(routeOut);
  if (inLc === outLc) return [];
  const seen = new Set<string>();
  const out: PoolRow[] = [];
  for (const p of pools) {
    if (!isSimulateEligible(p) || !rowIsPair(p, inLc, outLc)) continue;
    const id = lc(p.id ?? `${p.token0}:${p.token1}:${p.fee}:${p.tick_spacing}:${p.hooks}`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(p);
    if (out.length >= MAX_SIMULATED_POOLS) break;
  }
  return out;
}

/** The NET input the router actually swaps: gross minus the input-side aggregator fee (mirrors quote.ts). */
export function netInputAfterFee(grossAmountIn: bigint, feeBps: number): { netAmountIn: bigint; feeAmount: bigint } {
  const clampedFee = feeBps > 100 ? 100 : feeBps < 0 ? 0 : feeBps; // mirror the router's MAX_FEE_BPS clamp
  const feeAmount = (grossAmountIn * BigInt(clampedFee)) / 10_000n;
  return { netAmountIn: grossAmountIn - feeAmount, feeAmount };
}

/** One hooked pool, simulated for one direction and one NET input. Everything needed to assemble a quote. */
export interface HookedPoolSim {
  row: PoolRow;
  poolKey: V4PoolKey;
  zeroForOne: boolean;
  /** The NET input that was simulated (gross − aggregator fee). */
  netAmountIn: bigint;
  /** The real exact-input output, hook deltas included. */
  amountOut: bigint;
  /** The quoter's gas estimate for the swap — display-grade, and far more honest than a flat per-hop
   *  constant for a hooked pool (measured 964k on one launchpad hook). */
  gasEstimate: bigint;
  hookRisk: HookRisk;
  /** Simulated output below the tick-math reference, in bps (null = unscreenable). */
  skimBps: number | null;
  /** The reference state the skim was screened against (real slot0/liquidity; ticks only if the full
   *  window was read to confirm). Carried onto the hop so spot/impact/fee displays have real numbers;
   *  NEVER used for the quote. */
  reference: PoolState | null;
  /** Wall-clock time of the simulation, for staleness checks in the live session. */
  at: number;
}

/* ------------------------------------------------------------------ the light reference (slot0 + liquidity) */

function slot0Call(poolId: `0x${string}`): RpcBatchCall {
  return { method: "eth_call", params: [{ to: STATE_VIEW, data: encodeFunctionData({ abi: stateViewAbi, functionName: "getSlot0", args: [poolId] }) }, "latest"] };
}
function liquidityCall(poolId: `0x${string}`): RpcBatchCall {
  return { method: "eth_call", params: [{ to: STATE_VIEW, data: encodeFunctionData({ abi: stateViewAbi, functionName: "getLiquidity", args: [poolId] }) }, "latest"] };
}

/**
 * A reference PoolState from slot0 + liquidity alone (no tick window). Exact while a swap stays in the
 * current tick range; over-states the curve beyond it (see the module header). Null when the pool is
 * uninitialised or either read failed — then the skim screen abstains.
 */
export function lightReference(poolKey: V4PoolKey, slot0Answer: RpcBatchResult | undefined, liqAnswer: RpcBatchResult | undefined): PoolState | null {
  if (!slot0Answer?.ok || !liqAnswer?.ok) return null;
  try {
    const [sqrtPriceX96, tickRaw, protoRaw, lpFeeRaw] = decodeFunctionResult({
      abi: stateViewAbi,
      functionName: "getSlot0",
      data: slot0Answer.result as `0x${string}`,
    }) as readonly [bigint, number, number, number];
    const liquidity = decodeFunctionResult({
      abi: stateViewAbi,
      functionName: "getLiquidity",
      data: liqAnswer.result as `0x${string}`,
    }) as bigint;
    if (sqrtPriceX96 === 0n) return null;
    // Same LP+protocol fee composition the full readers use (v4Reader.fetchV4PoolByKey), so the reference
    // charges the swap fee the chain does — only the hook delta is (unavoidably) absent from it.
    const protoRawN = Number(protoRaw);
    const protocolFee = Math.max(protoRawN & 0xfff, (protoRawN >> 12) & 0xfff);
    const lpFee = Number(lpFeeRaw);
    const effectiveFee = Math.round(1e6 - ((1e6 - protocolFee) * (1e6 - lpFee)) / 1e6);
    return {
      address: `v4ref:${poolKey.currency0}:${poolKey.currency1}:${poolKey.fee}:${poolKey.tickSpacing}:${poolKey.hooks}`,
      token0: poolKey.currency0,
      token1: poolKey.currency1,
      fee: effectiveFee,
      tickSpacing: poolKey.tickSpacing,
      sqrtPriceX96,
      tick: Number(tickRaw),
      liquidity,
      ticks: [],
      venue: "UniswapV4",
      poolKey: { ...poolKey, fee: effectiveFee },
    };
  } catch {
    return null;
  }
}

/**
 * Initialised-tick windows for hooked pools, cached per pool id. The batch supplies FRESH slot0 + liquidity
 * on every quote; the tick geometry changes only when someone mints or burns, so a cached window turns the
 * light reference into a near-exact one at zero extra round trips on the hot path. Read (and re-read after
 * the TTL) only when the light reference cannot decide on its own — which includes the launchpad shape, a
 * single position with spot parked on its lower tick and ZERO in-range liquidity, where the light reference
 * prices nothing and would otherwise abstain forever (leaving a skimming hook unscreened).
 */
const TICK_WINDOW_TTL_MS = 60_000;
const _tickWindows = new Map<string, { ticks: PoolState["ticks"]; at: number }>();

/** Test seam: forget every cached tick window. */
export function _clearHookedReferenceCache(): void {
  _tickWindows.clear();
}

async function referenceWithTicks(
  light: PoolState | null,
  poolKey: V4PoolKey,
  poolId: string,
  confirm: (poolKey: V4PoolKey) => Promise<PoolState | null>,
  nowMs: number,
): Promise<PoolState | null> {
  const cached = _tickWindows.get(poolId);
  if (cached && nowMs - cached.at <= TICK_WINDOW_TTL_MS) return light ? { ...light, ticks: cached.ticks } : null;
  let full: PoolState | null = null;
  try {
    full = await confirm(poolKey);
  } catch {
    full = null;
  }
  if (full) _tickWindows.set(poolId, { ticks: full.ticks, at: nowMs });
  // Prefer the batch's slot0/liquidity (same block as the simulation) under the full window's ticks; fall
  // back to the full read as-is when the batch's slot0 could not be decoded.
  if (light && full) return { ...light, ticks: full.ticks };
  return full;
}

/* ------------------------------------------------------------------ the batch */

/**
 * Simulate every candidate row for one direction and NET input in ONE JSON-RPC round trip. Returns the
 * sims that pass every gate (hook screen ok, quoter answered, skim within policy), in candidate order.
 * Never throws — a transport failure yields [] (fail closed for this quote).
 *
 * `confirmReference` (default: fetchV4TickReference) is only called for a candidate the light screen would
 * exclude, to re-decide on the full tick window.
 */
export async function simulateHookedPools(
  rows: readonly PoolRow[],
  ctx: {
    routeIn: string;
    routeOut: string;
    netAmountIn: bigint;
    rpcUrl?: string;
    nowMs?: number;
    confirmReference?: (poolKey: V4PoolKey) => Promise<PoolState | null>;
  },
): Promise<HookedPoolSim[]> {
  if (ctx.netAmountIn <= 0n) return [];
  const inLc = lc(ctx.routeIn);
  const outLc = lc(ctx.routeOut);
  const candidates = rows.filter((r) => !!r.hooks && rowIsPair(r, inLc, outLc));
  if (candidates.length === 0) return [];

  // Build the batch: per candidate (quoter, slot0, liquidity); per distinct UNCACHED hook, the screen.
  const calls: RpcBatchCall[] = [];
  const perRow = candidates.map((row) => {
    const poolKey = rowPoolKey(row);
    const poolId = poolIdOf(poolKey) as `0x${string}`;
    const zeroForOne = lc(row.token0) === inLc;
    const quoteIdx = calls.push(quoteCall(poolKey, zeroForOne, ctx.netAmountIn)) - 1;
    const slot0Idx = calls.push(slot0Call(poolId)) - 1;
    const liqIdx = calls.push(liquidityCall(poolId)) - 1;
    return { row, poolKey, zeroForOne, quoteIdx, slot0Idx, liqIdx };
  });
  const screenIdx = new Map<string, number>(); // hook → index of its first screen call
  for (const row of candidates) {
    const hook = lc(row.hooks!);
    if (peekHookRisk(hook) || screenIdx.has(hook)) continue;
    screenIdx.set(hook, calls.length);
    calls.push(...hookScreenCalls(hook));
  }

  let answers: RpcBatchResult[];
  try {
    answers = await jsonRpcBatch(rpcUrlOf(ctx.rpcUrl), calls, HOOKED_BATCH_TIMEOUT_MS);
  } catch {
    return []; // transport failure → no hooked quotes this time, never a guess
  }

  const confirm = ctx.confirmReference ?? fetchV4TickReference;
  const at = ctx.nowMs ?? Date.now();
  const out: HookedPoolSim[] = [];
  for (const c of perRow) {
    const hook = lc(c.row.hooks!);
    const si = screenIdx.get(hook);
    const hookRisk = peekHookRisk(hook) ?? parseHookScreen(hook, si === undefined ? [] : answers.slice(si, si + 3));
    if (!hookRisk.ok) continue; // hook is not a contract / unreadable → fail closed

    const sim = parseQuoteAnswer(answers[c.quoteIdx]);
    if (!sim) continue; // quoter reverted / undecodable → exclude, never quote a fiction

    let reference = lightReference(c.poolKey, answers[c.slot0Idx], answers[c.liqIdx]);
    let refOut = tickReferenceOutput(reference, c.zeroForOne, ctx.netAmountIn);
    let skim = screenSkim(sim.amountOut, refOut);
    if (!skim.ok || refOut === null) {
      // The light reference either would EXCLUDE this pool (it may be over-stating the curve for a swap that
      // crosses ticks) or cannot price this size at all (zero in-range liquidity, a reverted slot0 read).
      // Neither is a verdict: decide on the real tick window (cached per pool) before refusing — or before
      // waving through — a venue.
      reference = await referenceWithTicks(reference, c.poolKey, poolIdOf(c.poolKey), confirm, at);
      refOut = tickReferenceOutput(reference, c.zeroForOne, ctx.netAmountIn);
      skim = screenSkim(sim.amountOut, refOut);
      if (!skim.ok) continue; // confirmed on the full window: the hook skims more than policy allows
      // still unpriceable on the full window (partial fill / no liquidity this way) → abstain, allowed
    }

    out.push({
      row: c.row,
      poolKey: c.poolKey,
      zeroForOne: c.zeroForOne,
      netAmountIn: ctx.netAmountIn,
      amountOut: sim.amountOut,
      gasEstimate: sim.gasEstimate,
      hookRisk,
      skimBps: skim.skimBps,
      reference,
      at,
    });
  }
  return out;
}

/** Single-row convenience over {@link simulateHookedPools}. */
export async function simulateHookedPool(
  row: PoolRow,
  ctx: { routeIn: string; routeOut: string; netAmountIn: bigint; rpcUrl?: string; nowMs?: number },
): Promise<HookedPoolSim | null> {
  const [sim] = await simulateHookedPools([row], ctx);
  return sim ?? null;
}

/* ------------------------------------------------------------------ assembly (pure) */

/** The hop's PoolState for a hooked pool: the reference state's real numbers when read (so spot / impact /
 *  fee displays are honest), tagged v4 and carrying the EXECUTION key. Zeroed when there is no reference. */
function hookedHopPool(sim: HookedPoolSim): PoolState {
  const { row, poolKey } = sim;
  const address = `v4:${lc(row.token0)}:${lc(row.token1)}:${row.fee}:${row.tick_spacing}:${lc(row.hooks ?? "")}`;
  const ref = sim.reference;
  return {
    address,
    token0: row.token0,
    token1: row.token1,
    fee: ref?.fee ?? 0,
    tickSpacing: row.tick_spacing,
    sqrtPriceX96: ref?.sqrtPriceX96 ?? 0n,
    tick: ref?.tick ?? 0,
    liquidity: ref?.liquidity ?? 0n,
    ticks: ref?.ticks ?? [],
    venue: "UniswapV4",
    poolKey,
  };
}

/** Assembly inputs: the OUTER tokens (may be NATIVE) and the policy numbers at assembly time. */
export interface HookedAssembleCtx {
  tokenIn: string;
  tokenOut: string;
  grossAmountIn: bigint;
  feeBps: number;
  recipient: string;
  deadline: bigint;
  slippageBps: number;
}

/**
 * Turn a simulation into an executable `SwapQuote`. PURE. The plan is one path, one v4 hop; the hop carries
 * the pool key exactly as initialised (sentinel fee included) so it hashes to the real pool id.
 *
 * POLICY, enforced here and not merely documented: `minAmountOut` is computed from the SIMULATED output and
 * is never above it. planFromSplit applies `minOutFor(simulated, slippage)` with no output-fee step (the
 * aggregator fee is on the input), and the assertion below makes that a hard invariant rather than a
 * property of a helper that could change — a quote that violated it would be a fiction handed to minOut.
 */
export function assembleHookedQuote(sim: HookedPoolSim, ctx: HookedAssembleCtx): SwapQuote {
  const { netAmountIn, feeAmount } = netInputAfterFee(ctx.grossAmountIn, ctx.feeBps);
  if (netAmountIn !== sim.netAmountIn) {
    throw new Error(
      `hooked quote: simulation priced net ${sim.netAmountIn} but the request nets ${netAmountIn} (fee ${ctx.feeBps} bps) — re-simulate`,
    );
  }
  // The hop trades the pool's own currencies (WETH when the outer token is NATIVE); the plan's outer
  // tokenIn/tokenOut keep the caller's (possibly NATIVE) tokens so the executor wraps/unwraps at the edges.
  const hop: Hop = {
    pool: hookedHopPool(sim),
    zeroForOne: sim.zeroForOne,
    tokenIn: sim.zeroForOne ? sim.row.token0 : sim.row.token1,
    tokenOut: sim.zeroForOne ? sim.row.token1 : sim.row.token0,
  };
  const route: Route = { hops: [hop], amountIn: netAmountIn, amountOut: sim.amountOut, incomplete: false };
  const split: SplitRoute = { parts: [route], amountIn: netAmountIn, amountOut: sim.amountOut, incomplete: false };

  const plan = planFromSplit(split, ctx.tokenIn, ctx.tokenOut, {
    recipient: ctx.recipient,
    deadline: ctx.deadline,
    slippageBps: ctx.slippageBps,
    feeBps: ctx.feeBps,
    grossAmountIn: ctx.grossAmountIn,
  });
  if (plan.minAmountOut > sim.amountOut) {
    throw new Error(`hooked quote: minAmountOut ${plan.minAmountOut} exceeds the simulated output ${sim.amountOut}`);
  }

  const { arg: encoded, value } = encodePlan(plan);

  const quote: Quote = {
    amountIn: ctx.grossAmountIn,
    netAmountIn,
    amountOut: sim.amountOut,
    netAmountOut: sim.amountOut,
    feeBps: ctx.feeBps,
    feeAmount,
    minAmountOut: plan.minAmountOut,
    split,
    routeDescriptions: [describeHooked(hop.tokenIn, hop.tokenOut, sim.hookRisk.tag)],
    plan,
  };

  return { quote, encoded, value };
}

export interface HookedCandidate {
  swapQuote: SwapQuote;
  sim: HookedPoolSim;
  hookRisk: HookRisk;
  /** simulated output below the tick-math reference, in bps (null = unscreenable). */
  skimBps: number | null;
}

/** The highest-output simulation among several, or null. */
export function bestHookedSim(sims: readonly (HookedPoolSim | null)[]): HookedPoolSim | null {
  let best: HookedPoolSim | null = null;
  for (const s of sims) if (s && (best === null || s.amountOut > best.amountOut)) best = s;
  return best;
}

/**
 * The best simulate-based quote among the hooked pools that serve this pair directly, or null if none
 * qualifies. Runs at most {@link MAX_SIMULATED_POOLS} simulations, in ONE batch, and picks the highest
 * output. Never throws — a failure here degrades to "no hooked route", never breaks the tick-math quote.
 * Returns immediately, with NO network, when the pair has no simulate-eligible row — which is every pair
 * without a THIRD-PARTY return-delta-hook pool (the DEX's own mole_v4 pools are not candidates), so the
 * common case pays nothing for this path.
 */
export async function bestHookedSimulateQuote(
  pools: readonly PoolRow[],
  req: {
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    recipient: string;
    slippageBps: number;
    feeBps?: number;
    weth: string;
    nowSeconds: bigint;
    ttlSeconds: bigint;
  },
  rpcUrl?: string,
): Promise<HookedCandidate | null> {
  const { routeIn, routeOut } = resolveRouteTokens(req.tokenIn, req.tokenOut, req.weth);
  const candidates = hookedCandidateRows(pools, routeIn, routeOut);
  if (candidates.length === 0) return null;

  const feeBps = req.feeBps ?? 0;
  const { netAmountIn } = netInputAfterFee(req.amountIn, feeBps);
  if (netAmountIn <= 0n) return null;

  const sims = await simulateHookedPools(candidates, { routeIn, routeOut, netAmountIn, rpcUrl }).catch(() => [] as HookedPoolSim[]);
  const best = bestHookedSim(sims);
  if (!best) return null;

  try {
    const swapQuote = assembleHookedQuote(best, {
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      grossAmountIn: req.amountIn,
      feeBps,
      recipient: req.recipient,
      deadline: req.nowSeconds + req.ttlSeconds,
      slippageBps: req.slippageBps,
    });
    return { swapQuote, sim: best, hookRisk: best.hookRisk, skimBps: best.skimBps };
  } catch {
    return null; // an assembly invariant tripped → no hooked quote, never a wrong one
  }
}
