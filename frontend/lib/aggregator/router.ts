/**
 * router.ts — the on-chain side of the aggregator for the frontend: the MoleRouter ABI and the encoding
 * that turns a routing `SwapPlan` (from the ported router package) into the exact tuple `MoleRouter.swap`
 * expects.
 *
 * The struct shapes mirror MoleRouter.sol exactly — Solidity is the source of truth. viem encodes the
 * tuple positionally from the ABI, so the field ORDER here must match the contract; a reordering is a
 * silent fund-loss bug, which is why the ABI is written out in full rather than abbreviated.
 */

import type { SwapPlan as RouteSwapPlan, PlanHop } from "./plan";

/** The NATIVE sentinel, identical to MoleRouter's constant and the router package's. */
export const NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

/** Minimal ERC-20 ABI for approvals/balances the swap flow needs. */
export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

const POOL_KEY = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

const HOP = [
  { name: "venue", type: "uint8" },
  { name: "pool", type: "address" },
  { name: "zeroForOne", type: "bool" },
  { name: "tokenIn", type: "address" },
  { name: "tokenOut", type: "address" },
  { name: "key", type: "tuple", components: POOL_KEY },
] as const;

const PATH = [
  { name: "amountIn", type: "uint256" },
  { name: "hops", type: "tuple[]", components: HOP },
] as const;

const SWAP_PLAN = [
  { name: "tokenIn", type: "address" },
  { name: "tokenOut", type: "address" },
  { name: "amountIn", type: "uint256" },
  { name: "minAmountOut", type: "uint256" },
  { name: "recipient", type: "address" },
  { name: "deadline", type: "uint256" },
  { name: "paths", type: "tuple[]", components: PATH },
] as const;

export const moleRouterAbi = [
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    inputs: [{ name: "plan", type: "tuple", components: SWAP_PLAN }],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  { type: "function", name: "poolManager", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "weth", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "error", name: "InsufficientOutput", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "DeadlinePassed", inputs: [] },
  { type: "error", name: "BadValue", inputs: [] },
] as const;

/** The plan as viem's contract writer wants it: a positional tuple, addresses as-is, bigints for uints. */
export interface EncodedPlan {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  minAmountOut: bigint;
  recipient: `0x${string}`;
  deadline: bigint;
  paths: {
    amountIn: bigint;
    hops: {
      venue: number;
      pool: `0x${string}`;
      zeroForOne: boolean;
      tokenIn: `0x${string}`;
      tokenOut: `0x${string}`;
      key: {
        currency0: `0x${string}`;
        currency1: `0x${string}`;
        fee: number;
        tickSpacing: number;
        hooks: `0x${string}`;
      };
    }[];
  }[];
}

const hx = (a: string) => a as `0x${string}`;

function encodeHop(h: PlanHop): EncodedPlan["paths"][number]["hops"][number] {
  return {
    venue: h.venue,
    pool: hx(h.pool),
    zeroForOne: h.zeroForOne,
    tokenIn: hx(h.tokenIn),
    tokenOut: hx(h.tokenOut),
    key: {
      currency0: hx(h.key.currency0),
      currency1: hx(h.key.currency1),
      fee: h.key.fee,
      tickSpacing: h.key.tickSpacing,
      hooks: hx(h.key.hooks),
    },
  };
}

/** Turn a routing SwapPlan into the exact argument for `moleRouter.swap`, plus the ETH value to attach. */
export function encodePlan(plan: RouteSwapPlan): { arg: EncodedPlan; value: bigint } {
  const arg: EncodedPlan = {
    tokenIn: hx(plan.tokenIn),
    tokenOut: hx(plan.tokenOut),
    amountIn: plan.amountIn,
    minAmountOut: plan.minAmountOut,
    recipient: hx(plan.recipient),
    deadline: plan.deadline,
    paths: plan.paths.map((p) => ({ amountIn: p.amountIn, hops: p.hops.map(encodeHop) })),
  };
  // A native-in swap must attach the input as msg.value; everything else attaches nothing.
  const value = plan.tokenIn.toLowerCase() === NATIVE_SENTINEL.toLowerCase() ? plan.amountIn : 0n;
  return { arg, value };
}
