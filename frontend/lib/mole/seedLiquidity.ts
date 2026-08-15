"use client";
/**
 * seedLiquidity.ts — put the FIRST liquidity into a freshly created v4 pool.
 *
 * WHY THIS IS SEPARATE FROM THE VAULT'S NORMAL DEPOSIT
 * The vault's usual entry point is `zapOpen`, which takes ONE token and swaps half of it into the
 * other leg inside the pool being deposited into. That is a chicken-and-egg for a brand new pool:
 * there is no liquidity yet, so there is nothing to swap against and the zap cannot bootstrap it.
 * `MolePositions.open` is the two-sided entry point — it takes an explicit liquidity amount plus a
 * cap on each leg — so it is the correct (and only) way to seed a pool that has just been created.
 *
 * A pool created without this step is initialised but untradeable: quotes against it return nothing
 * and the aggregator will correctly ignore it. Creating and seeding therefore belong together.
 */
import { createPublicClient, createWalletClient, custom, http, type Address } from "viem";
import { robinhoodChain } from "@/lib/chain/wagmi-config";
import { ROBINHOOD_RPC_URL, MOLE_ADDRESSES, DYNAMIC_FEE_FLAG } from "./chain";
import { getSqrtRatioAtTick, MIN_TICK, MAX_TICK } from "@/lib/aggregator/math/tickMath";
import {
  MIN_RANGE_WIDTH,
  MAX_RANGE_WIDTH,
  computeOneSidedRange,
  liquidityForOneSidedAmount,
  buildOneSidedOpenArgs,
  assertStrictlyOneSided,
  loadPoolTickState,
  type OneSidedSide,
  type OneSidedRange,
} from "./singleSided";
import { poolIdOf } from "./poolId";

const Q96 = 1n << 96n;
const NATIVE = "0x0000000000000000000000000000000000000000";

/**
 * Liquidity obtainable from a pair of maximum amounts over [tickLower, tickUpper] at the current
 * price — the standard Uniswap concentrated-liquidity relation, integer-only.
 *
 * Below the range the position is entirely token0, above it entirely token1, and inside it is the
 * BINDING (minimum) of the two legs — using anything but the minimum would compute a liquidity the
 * wallet cannot actually fund, and `open` would revert against its amountMax caps.
 */
export function getLiquidityForAmounts(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const liq0 = (sa: bigint, sb: bigint, amt: bigint) =>
    sb <= sa ? 0n : (amt * ((sa * sb) / Q96)) / (sb - sa);
  const liq1 = (sa: bigint, sb: bigint, amt: bigint) =>
    sb <= sa ? 0n : (amt * Q96) / (sb - sa);

  if (sqrtP <= sqrtA) return liq0(sqrtA, sqrtB, amount0);
  if (sqrtP >= sqrtB) return liq1(sqrtA, sqrtB, amount1);
  const l0 = liq0(sqrtP, sqrtB, amount0);
  const l1 = liq1(sqrtA, sqrtP, amount1);
  return l0 < l1 ? l0 : l1;
}

const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const openAbi = [
  {
    type: "function", name: "open", stateMutability: "payable",
    inputs: [
      { name: "key", type: "tuple", components: [
        { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
      ] },
      { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0Max", type: "uint256" }, { name: "amount1Max", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export interface SeedResult { success: boolean; txHash?: string; positionId?: string; liquidity?: string; error?: string }

/**
 * Seed `amount0`/`amount1` into a range centred on the pool's initial tick.
 *
 * `halfWidthTicks` must keep the range inside the vault's own minRangeWidth/maxRangeWidth bounds
 * (live: 120 / 60000 ticks) — the vault rejects full-range positions outright, so a seed cannot
 * simply span everything.
 */
export async function seedNewPool(params: {
  currency0: Address;
  currency1: Address;
  tickSpacing: number;
  initialTick: number;
  amount0: bigint;
  amount1: bigint;
  halfWidthTicks?: number;
  onStep?: (s: string) => void;
}): Promise<SeedResult> {
  const { currency0, currency1, tickSpacing, initialTick, amount0, amount1, onStep } = params;
  const halfWidth = params.halfWidthTicks ?? 6000;
  try {
    const eth = (globalThis as any).ethereum;
    if (!eth) return { success: false, error: "No wallet found" };
    const pub = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });
    const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
    const [account] = await wallet.getAddresses();
    if (!account) return { success: false, error: "Wallet not connected" };

    const vault = MOLE_ADDRESSES.molePositions as Address;
    const spacing = Math.max(1, tickSpacing);
    const center = Math.round(initialTick / spacing) * spacing;
    const half = Math.max(spacing, Math.round(halfWidth / spacing) * spacing);
    const tickLower = center - half;
    const tickUpper = center + half;

    const sqrtP = getSqrtRatioAtTick(center);
    const liquidity = getLiquidityForAmounts(
      sqrtP, getSqrtRatioAtTick(tickLower), getSqrtRatioAtTick(tickUpper), amount0, amount1,
    );
    if (liquidity <= 0n) return { success: false, error: "Amounts are too small to mint any liquidity" };

    // Approve only what `open` may actually pull — the amountMax caps below are the real bound.
    for (const [token, amt] of [[currency0, amount0], [currency1, amount1]] as const) {
      if (amt <= 0n) continue;
      const cur = (await pub.readContract({
        address: token, abi: erc20Abi, functionName: "allowance", args: [account, vault],
      })) as bigint;
      if (cur < amt) {
        onStep?.(`Approving ${token === currency0 ? "token 0" : "token 1"}…`);
        const h = await wallet.writeContract({
          address: token, abi: erc20Abi, functionName: "approve", args: [vault, amt], account, chain: robinhoodChain,
        });
        await pub.waitForTransactionReceipt({ hash: h });
      }
    }

    onStep?.("Seeding liquidity…");
    const key = {
      currency0, currency1, fee: DYNAMIC_FEE_FLAG, tickSpacing: spacing,
      hooks: MOLE_ADDRESSES.moleHook as Address,
    };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
    // Simulate before sending, exactly as the vault deposit path does.
    const sim = await pub.simulateContract({
      address: vault, abi: openAbi, functionName: "open",
      args: [key, tickLower, tickUpper, liquidity, amount0, amount1, deadline],
      account,
    });
    const hash = await wallet.writeContract({ ...sim.request, account, chain: robinhoodChain });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") return { success: false, txHash: hash, error: "Seed reverted" };
    return { success: true, txHash: hash, positionId: String(sim.result), liquidity: liquidity.toString() };
  } catch (err: any) {
    return { success: false, error: err?.shortMessage || err?.message?.split("\n")[0] || "Seed failed" };
  }
}

/* ===================================================================== one-sided seed */

/**
 * Custom one-sided range from two user-chosen bound ticks (already converted from prices).
 *
 * This does NOT re-derive the snap rule: the nearest-legal anchor comes from
 * `computeOneSidedRange` (the single home of "strictly beyond spot"), the custom bounds are
 * merely snapped to spacing and CLAMPED so they can never come closer to spot than that
 * anchor, and `assertStrictlyOneSided` re-checks the result. Width is clamped into the live
 * [MIN_RANGE_WIDTH, MAX_RANGE_WIDTH] band as spacing multiples.
 */
export function customOneSidedRange(params: {
  side: OneSidedSide;
  currentTick: number;
  tickSpacing: number;
  boundTickA: number;
  boundTickB: number;
}): OneSidedRange {
  const { side, currentTick, tickSpacing, boundTickA, boundTickB } = params;
  const spacing = Math.max(1, Math.floor(tickSpacing));
  for (const [name, t] of [["boundTickA", boundTickA], ["boundTickB", boundTickB]] as const) {
    if (!Number.isFinite(t) || !Number.isInteger(t)) throw new Error(`${name} must be an integer tick`);
  }
  // Nearest legal one-sided range at minimum width — its near edge is the closest ANY custom
  // range may come to spot. Throws if spot is too close to a tick bound for any legal range.
  const anchor = computeOneSidedRange({
    side, currentTick, tickSpacing: spacing, preset: { widthTicks: MIN_RANGE_WIDTH },
  });

  const snapUp = (t: number) => Math.ceil(t / spacing) * spacing;
  const snapDown = (t: number) => Math.floor(t / spacing) * spacing;
  const minW = snapUp(MIN_RANGE_WIDTH);
  const maxW = snapDown(MAX_RANGE_WIDTH);
  if (minW > maxW) throw new Error(`tickSpacing ${spacing} cannot produce a legal range width`);
  const maxUsable = snapDown(MAX_TICK);
  const minUsable = snapUp(MIN_TICK);
  const lo = Math.min(boundTickA, boundTickB);
  const hi = Math.max(boundTickA, boundTickB);

  let tickLower: number;
  let tickUpper: number;
  if (side === "token0") {
    // Snap the near bound UP (inward) and never let it come below the anchor's lower edge.
    tickLower = Math.min(Math.max(snapUp(lo), anchor.tickLower), maxUsable - minW);
    if (tickLower < anchor.tickLower) throw new Error("spot too close to MAX_TICK for this range");
    tickUpper = Math.min(Math.max(snapDown(hi), tickLower + minW), tickLower + maxW, maxUsable);
  } else {
    // Mirror: snap the near bound DOWN and never let it rise above the anchor's upper edge.
    tickUpper = Math.max(Math.min(snapDown(hi), anchor.tickUpper), minUsable + minW);
    if (tickUpper > anchor.tickUpper) throw new Error("spot too close to MIN_TICK for this range");
    tickLower = Math.max(Math.min(snapUp(lo), tickUpper - minW), tickUpper - maxW, minUsable);
  }

  const range = { tickLower, tickUpper };
  // Defense in depth — a clamp bug must throw here, not ship a two-sided "one-sided" seed.
  assertStrictlyOneSided(side, currentTick, range);
  const width = tickUpper - tickLower;
  if (width < MIN_RANGE_WIDTH || width > MAX_RANGE_WIDTH) {
    throw new Error(`internal: custom width ${width} outside live band`);
  }
  return range;
}

/**
 * Seed a freshly created pool with ONE token only, via MolePositions.open over a range
 * strictly beyond spot (built by computeOneSidedRange / customOneSidedRange).
 *
 * Safety chain, in order:
 *   1. the live tick is RE-READ here and assertStrictlyOneSided re-run — a trade landing
 *      between preview and send cannot silently turn the deposit two-sided;
 *   2. buildOneSidedOpenArgs sets the OFF side's amountMax to 0, so even if (1) were
 *      bypassed the chain would revert rather than pull the other token;
 *   3. only the deposit token is approved (open pulls with transferFrom), capped at the
 *      documented amount+1 wei. A NATIVE (address-zero) deposit side sends that cap as
 *      msg.value instead — open is payable and refunds unused native, the same contract
 *      behaviour the vault's WETH/ETH leg relies on.
 */
export async function seedNewPoolOneSided(params: {
  currency0: Address;
  currency1: Address;
  tickSpacing: number;
  side: OneSidedSide;
  /** Raw units of the deposit token (currency0 if side==='token0', else currency1). */
  amount: bigint;
  range: OneSidedRange;
  onStep?: (s: string) => void;
}): Promise<SeedResult> {
  const { currency0, currency1, side, amount, range, onStep } = params;
  try {
    const eth = (globalThis as any).ethereum;
    if (!eth) return { success: false, error: "No wallet found" };
    const pub = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });
    const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
    const [account] = await wallet.getAddresses();
    if (!account) return { success: false, error: "Wallet not connected" };
    if (amount <= 0n) return { success: false, error: "Enter an amount" };

    const vault = MOLE_ADDRESSES.molePositions as Address;
    const spacing = Math.max(1, params.tickSpacing);
    const key = {
      currency0, currency1, fee: DYNAMIC_FEE_FLAG, tickSpacing: spacing,
      hooks: MOLE_ADDRESSES.moleHook as Address,
    };

    // 1) FRESH tick immediately before the send.
    onStep?.("Checking the pool price…");
    const { currentTick } = await loadPoolTickState(poolIdOf(key));
    try {
      assertStrictlyOneSided(side, currentTick, range);
    } catch {
      return { success: false, error: "The pool price moved into your range — rebuild the range and retry" };
    }

    const liquidity = liquidityForOneSidedAmount({
      side, tickLower: range.tickLower, tickUpper: range.tickUpper, amount,
    });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
    const args = buildOneSidedOpenArgs({ key, side, range, liquidity, amount, deadline });
    const onSideMax = side === "token0" ? args[4] : args[5];

    // 2) Approve the ONE deposit token only (never the other side), up to the pull cap.
    const depositToken = (side === "token0" ? currency0 : currency1) as Address;
    const isNative = depositToken.toLowerCase() === NATIVE;
    if (!isNative) {
      const cur = (await pub.readContract({
        address: depositToken, abi: erc20Abi, functionName: "allowance", args: [account, vault],
      })) as bigint;
      if (cur < onSideMax) {
        onStep?.(`Approving ${side === "token0" ? "token 0" : "token 1"}…`);
        const h = await wallet.writeContract({
          address: depositToken, abi: erc20Abi, functionName: "approve",
          args: [vault, onSideMax], account, chain: robinhoodChain,
        });
        await pub.waitForTransactionReceipt({ hash: h });
      }
    }

    onStep?.("Seeding one-sided liquidity…");
    // Simulate before sending, exactly as the two-sided seed path does.
    const sim = await pub.simulateContract({
      address: vault, abi: openAbi, functionName: "open",
      args: args as any,
      account,
      ...(isNative ? { value: onSideMax } : {}),
    });
    const hash = await wallet.writeContract({ ...sim.request, account, chain: robinhoodChain });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") return { success: false, txHash: hash, error: "Seed reverted" };
    return { success: true, txHash: hash, positionId: String(sim.result), liquidity: liquidity.toString() };
  } catch (err: any) {
    return { success: false, error: err?.shortMessage || err?.message?.split("\n")[0] || "Seed failed" };
  }
}
