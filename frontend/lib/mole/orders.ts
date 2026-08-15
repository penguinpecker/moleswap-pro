"use client";
/**
 * orders.ts — client for MoleOrders (non-custodial DCA + limit orders on Robinhood Chain).
 *
 * You approve MoleOrders for your input token, then createOrder with fixed terms. A keeper triggers each
 * leg through MoleRouter; the output is delivered directly to you and can never be redirected, over-spent,
 * or filled below your min-out floor. DCA = interval > 0; limit order = interval 0 + floor == limit price.
 */
import {
  createPublicClient, createWalletClient, custom, http, type Address,
} from "viem";
import { robinhoodChain } from "@/lib/chain/wagmi-config";
import { erc20Abi } from "./abi";
import { ROBINHOOD_RPC_URL } from "./chain";

export const MOLE_ORDERS = "0x3bA3Ca1e5D411Dcd686E198C852e0d331384aE77" as Address;

export const moleOrdersAbi = [
  {
    type: "function", name: "createOrder", stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
      { name: "amountPerLeg", type: "uint256" }, { name: "totalBudget", type: "uint256" },
      { name: "minOutPerLeg", type: "uint256" }, { name: "interval", type: "uint64" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  { type: "function", name: "cancelOrder", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  { type: "function", name: "ordersOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256[]" }] },
  {
    type: "function", name: "orders", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" }, { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
      { name: "amountPerLeg", type: "uint256" }, { name: "totalBudget", type: "uint256" }, { name: "spent", type: "uint256" },
      { name: "minOutPerLeg", type: "uint256" }, { name: "interval", type: "uint64" }, { name: "lastFill", type: "uint64" },
      { name: "active", type: "bool" },
    ],
  },
] as const;

export interface MoleOrder {
  id: string;
  owner: string;
  tokenIn: string;
  tokenOut: string;
  amountPerLeg: bigint;
  totalBudget: bigint;
  spent: bigint;
  minOutPerLeg: bigint;
  interval: number;
  lastFill: number;
  active: boolean;
}

function pub() {
  return createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });
}
function browserEth(): any {
  return typeof window !== "undefined" ? (window as any).ethereum ?? null : null;
}
async function ensureChain(eth: any) {
  try {
    const cid = await eth.request({ method: "eth_chainId" });
    if (parseInt(cid, 16) !== robinhoodChain.id) {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1237" }] });
    }
  } catch { /* wallet surfaces it */ }
}

export interface OrderTxResult { success: boolean; txHash?: string; orderId?: string; error?: string }

/**
 * Approve MoleOrders for `tokenIn` (up to `totalBudget`) then create the order. Two txs: the approval is
 * skipped when the allowance already covers the budget.
 */
export async function createOrder(params: {
  tokenIn: Address;
  tokenOut: Address;
  amountPerLeg: bigint;
  totalBudget: bigint;
  minOutPerLeg: bigint;
  intervalSeconds: number;
  onStep?: (label: string) => void;
}): Promise<OrderTxResult> {
  const onStep = params.onStep || (() => {});
  try {
    const eth = browserEth();
    if (!eth) return { success: false, error: "No wallet found" };
    await ensureChain(eth);
    const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
    const p = pub();
    const [account] = await wallet.getAddresses();
    if (!account) return { success: false, error: "Wallet not connected" };

    const allowance = (await p.readContract({
      address: params.tokenIn, abi: erc20Abi, functionName: "allowance", args: [account, MOLE_ORDERS],
    })) as bigint;
    if (allowance < params.totalBudget) {
      onStep("Approving token…");
      const ah = await wallet.writeContract({
        address: params.tokenIn, abi: erc20Abi, functionName: "approve",
        args: [MOLE_ORDERS, params.totalBudget], account, chain: robinhoodChain,
      });
      const ar = await p.waitForTransactionReceipt({ hash: ah });
      if (ar.status !== "success") return { success: false, error: "Approval reverted" };
    }

    onStep("Creating order…");
    const sim = await p.simulateContract({
      address: MOLE_ORDERS, abi: moleOrdersAbi, functionName: "createOrder",
      args: [params.tokenIn, params.tokenOut, params.amountPerLeg, params.totalBudget, params.minOutPerLeg, BigInt(params.intervalSeconds)],
      account,
    });
    const hash = await wallet.writeContract({ ...(sim.request as any), account, chain: robinhoodChain });
    const rcpt = await p.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") return { success: false, txHash: hash, error: "Create reverted" };
    return { success: true, txHash: hash, orderId: sim.result?.toString() };
  } catch (err: any) {
    return { success: false, error: err?.shortMessage || err?.message?.split("\n")[0] || "Create failed" };
  }
}

export async function cancelOrder(id: string | bigint): Promise<OrderTxResult> {
  try {
    const eth = browserEth();
    if (!eth) return { success: false, error: "No wallet found" };
    await ensureChain(eth);
    const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
    const p = pub();
    const [account] = await wallet.getAddresses();
    if (!account) return { success: false, error: "Wallet not connected" };
    const sim = await p.simulateContract({ address: MOLE_ORDERS, abi: moleOrdersAbi, functionName: "cancelOrder", args: [BigInt(id)], account });
    const hash = await wallet.writeContract({ ...(sim.request as any), account, chain: robinhoodChain });
    await p.waitForTransactionReceipt({ hash });
    return { success: true, txHash: hash };
  } catch (err: any) {
    return { success: false, error: err?.shortMessage || err?.message?.split("\n")[0] || "Cancel failed" };
  }
}

/** Read a wallet's orders (newest first). */
export async function getOrders(owner: string): Promise<MoleOrder[]> {
  const p = pub();
  const ids = (await p.readContract({ address: MOLE_ORDERS, abi: moleOrdersAbi, functionName: "ordersOf", args: [owner as Address] })) as bigint[];
  const out: MoleOrder[] = [];
  for (const id of ids) {
    try {
      const o = (await p.readContract({ address: MOLE_ORDERS, abi: moleOrdersAbi, functionName: "orders", args: [id] })) as any[];
      out.push({
        id: id.toString(),
        owner: o[0], tokenIn: o[1], tokenOut: o[2],
        amountPerLeg: BigInt(o[3]), totalBudget: BigInt(o[4]), spent: BigInt(o[5]), minOutPerLeg: BigInt(o[6]),
        interval: Number(o[7]), lastFill: Number(o[8]), active: Boolean(o[9]),
      });
    } catch { /* skip a bad read */ }
  }
  return out.reverse();
}
