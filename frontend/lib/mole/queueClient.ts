"use client";
/**
 * queueClient.ts — network layer for the MoleQueue batch auction (proxy on Robinhood Chain 4663).
 *
 * Composes the pure engine in queue.ts (phase clock, payouts, exits) with live reads/writes via viem.
 * Every write simulates against the live contract before sending. Escrow: a `zeroForOne` order sells
 * currency0 (WETH), the reverse sells currency1 (USDG) — the queue pulls it via transferFrom on place,
 * so we approve the escrow token to the queue first.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
} from "viem";
import { robinhoodChain } from "@/lib/chain/wagmi-config";
import { erc20Abi } from "./abi";
import { MOLE_ADDRESSES, WETH, USDG, ROBINHOOD_RPC_URL } from "./chain";
import {
  moleQueueAbi,
  QueuePhase,
  phaseAt,
  claimableOf,
  exitFor,
  crossedBpsOfSide,
  type EpochState,
  type OrderState,
  type QueueSchedule,
  type Exit,
  type Claimable,
} from "./queue";

const QUEUE = MOLE_ADDRESSES.moleQueue as Address;
const RH_HEX = "0x1237";

export function queuePublicClient() {
  return createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });
}

function browserEth(): any {
  if (typeof window === "undefined") return null;
  return (window as any).ethereum ?? null;
}
async function ensureChain(eth: any) {
  try {
    const cid = await eth.request({ method: "eth_chainId" });
    if (parseInt(cid, 16) !== robinhoodChain.id) {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: RH_HEX }] });
    }
  } catch {}
}

export async function getQueueSchedule(): Promise<QueueSchedule & { maxResidualSlippageBps: number }> {
  const pub = queuePublicClient();
  const read = (functionName: string, args: any[] = []) =>
    pub.readContract({ address: QUEUE, abi: moleQueueAbi, functionName: functionName as any, args: args as any });
  const [currentEpoch, epochStartedAt, epochDuration, freezeDuration, maxEpochLife, maxResidualSlippageBps] =
    (await Promise.all([
      read("currentEpoch"),
      read("epochStartedAt"),
      read("epochDuration"),
      read("freezeDuration"),
      read("maxEpochLife"),
      read("maxResidualSlippageBps"),
    ])) as any[];
  return {
    currentEpoch: BigInt(currentEpoch),
    epochStartedAt: BigInt(epochStartedAt),
    epochDuration: Number(epochDuration),
    freezeDuration: Number(freezeDuration),
    maxEpochLife: Number(maxEpochLife),
    maxResidualSlippageBps: Number(maxResidualSlippageBps),
  };
}

export async function getEpoch(e: bigint): Promise<EpochState> {
  const pub = queuePublicClient();
  const r = (await pub.readContract({
    address: QUEUE,
    abi: moleQueueAbi,
    functionName: "epochs",
    args: [e],
  })) as any[];
  return {
    phase: Number(r[0]) as QueuePhase,
    frozenAt: BigInt(r[1]),
    totalIn0: BigInt(r[2]),
    totalIn1: BigInt(r[3]),
    out0: BigInt(r[4]),
    out1: BigInt(r[5]),
    refund0: BigInt(r[6]),
    refund1: BigInt(r[7]),
  };
}

/** The chain's own clock — used for the phase math so a UI never disagrees with the contract. */
export async function chainNow(): Promise<bigint> {
  const pub = queuePublicClient();
  const block = await pub.getBlock();
  return BigInt(block.timestamp);
}

export interface UserOrderView {
  epoch: bigint;
  index: bigint;
  zeroForOne: boolean;
  amountIn: bigint;
  withdrawn: boolean;
  phase: QueuePhase;
  claimable: Claimable;
  exit: Exit;
  crossedBps: number;
}

/** Every order a wallet has ever placed, with its live phase / claimable / exit. */
export async function getUserOrders(owner: string): Promise<UserOrderView[]> {
  const pub = queuePublicClient();
  const schedule = await getQueueSchedule();
  const now = await chainNow();

  const logs = await pub.getLogs({
    address: QUEUE,
    event: moleQueueAbi.find((x: any) => x.type === "event" && x.name === "OrderPlaced") as any,
    args: { owner: owner as Address },
    fromBlock: 0n,
    toBlock: "latest",
  });

  const seen = new Set<string>();
  const views: UserOrderView[] = [];
  for (const log of logs) {
    const epoch = BigInt((log as any).args.epoch);
    const index = BigInt((log as any).args.index);
    const key = `${epoch}-${index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const [orderRaw, epochState] = await Promise.all([
        pub.readContract({ address: QUEUE, abi: moleQueueAbi, functionName: "orders", args: [epoch, index] }) as Promise<any[]>,
        getEpoch(epoch),
      ]);
      const order: OrderState = {
        owner: orderRaw[0],
        zeroForOne: Boolean(orderRaw[1]),
        amountIn: BigInt(orderRaw[2]),
        withdrawn: Boolean(orderRaw[3]),
      };
      const phase = phaseAt(epochState.phase, epoch, schedule, now);
      views.push({
        epoch,
        index,
        zeroForOne: Boolean(order.zeroForOne),
        amountIn: order.amountIn,
        withdrawn: order.withdrawn,
        phase,
        claimable: claimableOf(order, epochState, phase),
        exit: exitFor(order, epochState, phase, schedule, now),
        crossedBps: crossedBpsOfSide(epochState, Boolean(order.zeroForOne)),
      });
    } catch {
      /* skip an order that fails to read */
    }
  }
  // newest first
  return views.sort((a, b) => (b.epoch === a.epoch ? Number(b.index - a.index) : Number(b.epoch - a.epoch)));
}

/* ----------------------------------------------------------------- writes */

async function wallet() {
  const eth = browserEth();
  if (!eth) throw new Error("No wallet found");
  await ensureChain(eth);
  const w = createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
  const [account] = await w.getAddresses();
  if (!account) throw new Error("Wallet not connected");
  return { w, account, pub: queuePublicClient() };
}

export interface TxResult { success: boolean; txHash?: string; error?: string; value?: string }

function err(e: any): TxResult {
  return { success: false, error: e?.shortMessage || e?.message?.split("\n")[0] || "Transaction failed" };
}

/** Place a batch-auction order. zeroForOne = selling WETH for USDG. amountIn in escrow-token wei. */
export async function placeOrder(zeroForOne: boolean, amountIn: bigint): Promise<TxResult> {
  try {
    if (amountIn <= 0n) return { success: false, error: "Enter an amount" };
    const { w, account, pub } = await wallet();
    const escrow = (zeroForOne ? WETH.address : USDG.address) as Address;

    const allowance = (await pub.readContract({
      address: escrow,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, QUEUE],
    })) as bigint;
    if (allowance < amountIn) {
      const ah = await w.writeContract({
        address: escrow,
        abi: erc20Abi,
        functionName: "approve",
        args: [QUEUE, amountIn],
        account,
        chain: robinhoodChain,
      });
      await pub.waitForTransactionReceipt({ hash: ah });
    }

    const sim = await pub.simulateContract({
      address: QUEUE,
      abi: moleQueueAbi,
      functionName: "place",
      args: [zeroForOne, amountIn],
      account,
    });
    const hash = await w.writeContract({ ...(sim.request as any), account, chain: robinhoodChain });
    await pub.waitForTransactionReceipt({ hash });
    return { success: true, txHash: hash, value: sim.result?.toString() };
  } catch (e) {
    return err(e);
  }
}

async function simpleWrite(functionName: "cancel" | "claim" | "settle" | "freeze" | "timeout", args: any[]): Promise<TxResult> {
  try {
    const { w, account, pub } = await wallet();
    const sim = await pub.simulateContract({
      address: QUEUE,
      abi: moleQueueAbi,
      functionName: functionName as any,
      args: args as any,
      account,
    });
    const hash = await w.writeContract({ ...(sim.request as any), account, chain: robinhoodChain });
    await pub.waitForTransactionReceipt({ hash });
    return { success: true, txHash: hash, value: (sim as any).result?.toString?.() };
  } catch (e) {
    return err(e);
  }
}

export const cancelOrder = (e: bigint, index: bigint) => simpleWrite("cancel", [e, index]);
export const claimOrder = (e: bigint, index: bigint) => simpleWrite("claim", [e, index]);
export const settleEpoch = (e: bigint) => simpleWrite("settle", [e]);
export const freezeEpoch = () => simpleWrite("freeze", []);
export const timeoutEpoch = (e: bigint) => simpleWrite("timeout", [e]);

export { QueuePhase };
