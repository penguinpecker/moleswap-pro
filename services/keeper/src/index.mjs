/**
 * MoleOrders keeper.
 *
 * Loops over open orders and fills the ones that are DUE (DCA interval / limit price met). It holds a
 * low-privilege KEEPER key: MoleOrders.fillLeg can ONLY send a swap whose output goes to the order owner,
 * bounded by the order's budget, floor and interval — so a compromised keeper can grief (fill at market,
 * within the owner's floor) but can NEVER steal. All routing is done server-side by the frontend's
 * /api/keeper/fill-plan; the keeper only signs and sends the returned plan.
 *
 * Env:
 *   KEEPER_KEY     — the keeper wallet private key (0x…64). NOT the deployer/root key.
 *   RPC_URL        — Robinhood Chain RPC (Alchemy).
 *   FILL_PLAN_URL  — https://moleswap.com/api/keeper/fill-plan  (or the vercel URL)
 *   KEEPER_SECRET  — shared secret gating fill-plan (== KEEPER_SECRET/MP_WRITE_SECRET on the frontend)
 *   MOLE_ORDERS    — the MoleOrders address (default 0x3bA3Ca1e…, redeployed 2026-08-15 for the fee-on-input router)
 *   POLL_SECONDS   — loop cadence (default 30)
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const FILL_PLAN_URL = process.env.FILL_PLAN_URL;
const SECRET = process.env.KEEPER_SECRET;
const MOLE_ORDERS = process.env.MOLE_ORDERS || "0x3bA3Ca1e5D411Dcd686E198C852e0d331384aE77";
const POLL_MS = (Number(process.env.POLL_SECONDS) || 30) * 1000;

let KEY = process.env.KEEPER_KEY || "";
if (KEY && !KEY.startsWith("0x")) KEY = "0x" + KEY;
if (!KEY || !FILL_PLAN_URL || !SECRET) {
  console.error("keeper: missing KEEPER_KEY / FILL_PLAN_URL / KEEPER_SECRET");
  process.exit(1);
}

const chain = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const account = privateKeyToAccount(KEY);
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const POOL_KEY = [
  { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
];
const HOP = [
  { name: "venue", type: "uint8" }, { name: "pool", type: "address" }, { name: "zeroForOne", type: "bool" },
  { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "key", type: "tuple", components: POOL_KEY },
];
const SWAP_PLAN = [
  { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amountIn", type: "uint256" },
  { name: "minAmountOut", type: "uint256" }, { name: "recipient", type: "address" }, { name: "deadline", type: "uint256" },
  { name: "paths", type: "tuple[]", components: [{ name: "amountIn", type: "uint256" }, { name: "hops", type: "tuple[]", components: HOP }] },
];
const ordersAbi = [{
  type: "function", name: "fillLeg", stateMutability: "nonpayable",
  inputs: [{ name: "id", type: "uint256" }, { name: "plan", type: "tuple", components: SWAP_PLAN }],
  outputs: [{ name: "amountOut", type: "uint256" }],
}];

/** Convert the JSON plan (bigints stringified by the API) back into the typed tuple viem needs. */
function rehydrate(plan) {
  return {
    tokenIn: plan.tokenIn, tokenOut: plan.tokenOut,
    amountIn: BigInt(plan.amountIn), minAmountOut: BigInt(plan.minAmountOut),
    recipient: plan.recipient, deadline: BigInt(plan.deadline),
    paths: plan.paths.map((p) => ({
      amountIn: BigInt(p.amountIn),
      hops: p.hops.map((h) => ({
        venue: Number(h.venue), pool: h.pool, zeroForOne: Boolean(h.zeroForOne),
        tokenIn: h.tokenIn, tokenOut: h.tokenOut,
        key: { currency0: h.key.currency0, currency1: h.key.currency1, fee: Number(h.key.fee), tickSpacing: Number(h.key.tickSpacing), hooks: h.key.hooks },
      })),
    })),
  };
}

async function api(params) {
  const url = `${FILL_PLAN_URL}?secret=${encodeURIComponent(SECRET)}${params}`;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  const j = await res.json();
  return j?.data ?? j;
}

async function tick() {
  const head = await api("");
  const count = Number(head?.orderCount || 0);
  if (!count) return;
  for (let id = 1; id <= count; id++) {
    let info;
    try {
      info = await api(`&id=${id}`);
    } catch (e) {
      console.warn(`order ${id}: fill-plan error`, e?.message || e);
      continue;
    }
    if (!info?.ready) continue;
    try {
      const plan = rehydrate(info.plan);
      // Simulate first — never burn gas on a leg that would revert (price moved, floor, etc).
      await pub.simulateContract({ address: MOLE_ORDERS, abi: ordersAbi, functionName: "fillLeg", args: [BigInt(id), plan], account: account.address });
      const hash = await wallet.writeContract({ address: MOLE_ORDERS, abi: ordersAbi, functionName: "fillLeg", args: [BigInt(id), plan] });
      const rcpt = await pub.waitForTransactionReceipt({ hash });
      console.log(`order ${id}: filled leg ${info.legIn} -> owner ${info.owner} · ${rcpt.status} · ${hash}`);
    } catch (e) {
      console.warn(`order ${id}: fill skipped —`, (e?.shortMessage || e?.message || String(e)).split("\n")[0]);
    }
  }
}

console.log(`keeper up · account ${account.address} · orders ${MOLE_ORDERS} · every ${POLL_MS / 1000}s`);
async function loop() {
  try {
    await tick();
  } catch (e) {
    console.error("tick error", e?.message || e);
  }
  setTimeout(loop, POLL_MS);
}
loop();
