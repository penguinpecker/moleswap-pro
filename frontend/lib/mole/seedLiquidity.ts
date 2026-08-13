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
import { getSqrtRatioAtTick } from "@/lib/aggregator/math/tickMath";

const Q96 = 1n << 96n;

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
