import { NextRequest } from "next/server";
import { createPublicClient, http, type Address } from "viem";
import { apiResponse, apiError } from "@/lib/api/helpers";
import { robinhoodChain } from "@/lib/chain/wagmi-config";
import { CONTRACTS } from "@/lib/chain/contracts";
import { quoteSwap } from "@/lib/aggregator/client";
import { loadPoolRowsServer } from "@/lib/aggregator/serverPools";
import { getAggFeeBps } from "@/lib/mole/aggFee";
import { ROBINHOOD_RPC_URL } from "@/lib/mole/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Builds the exact fillLeg plan for one MoleOrders order: reads the order on-chain, quotes the current leg
// through the aggregator, and — if the leg is due (time/budget) AND the market clears the order's floor —
// returns a SwapPlan with recipient = the order owner and minAmountOut = the floor. The keeper only signs
// and sends fillLeg(id, plan); all the routing lives here (one aggregator, server-side). Secret-gated.

const MOLE_ORDERS = "0x3bA3Ca1e5D411Dcd686E198C852e0d331384aE77" as Address;
const ordersAbi = [
  {
    type: "function", name: "orders", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" }, { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
      { name: "amountPerLeg", type: "uint256" }, { name: "totalBudget", type: "uint256" }, { name: "spent", type: "uint256" },
      { name: "minOutPerLeg", type: "uint256" }, { name: "interval", type: "uint64" }, { name: "lastFill", type: "uint64" },
      { name: "active", type: "bool" },
    ],
  },
  { type: "function", name: "orderCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

function stringifyBig(v: any): any {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(stringifyBig);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stringifyBig(x)]));
  return v;
}

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  const expected = process.env.KEEPER_SECRET || process.env.MP_WRITE_SECRET || process.env.INDEXER_SECRET;
  if (!expected || secret !== expected) return apiError("unauthorized", 401);

  const pub = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });

  // No id → return the current orderCount so the keeper knows the id range to scan.
  const idParam = req.nextUrl.searchParams.get("id");
  if (!idParam) {
    const count = (await pub.readContract({ address: MOLE_ORDERS, abi: ordersAbi, functionName: "orderCount" })) as bigint;
    return apiResponse({ orderCount: count.toString() });
  }

  try {
    const id = BigInt(idParam);
    const o = (await pub.readContract({ address: MOLE_ORDERS, abi: ordersAbi, functionName: "orders", args: [id] })) as any[];
    const [owner, tokenIn, tokenOut, amountPerLeg, totalBudget, spent, minOutPerLeg, interval, lastFill, active] = [
      o[0] as string, o[1] as string, o[2] as string, BigInt(o[3]), BigInt(o[4]), BigInt(o[5]), BigInt(o[6]), Number(o[7]), Number(o[8]), Boolean(o[9]),
    ];

    if (!active) return apiResponse({ ready: false, reason: "inactive" });
    const remaining = totalBudget - spent;
    if (remaining <= 0n) return apiResponse({ ready: false, reason: "budget" });
    const now = Math.floor(Date.now() / 1000);
    if (lastFill !== 0 && now < lastFill + interval) return apiResponse({ ready: false, reason: "interval", nextAt: lastFill + interval });

    const legIn = remaining < amountPerLeg ? remaining : amountPerLeg;
    const floor = (minOutPerLeg * legIn) / amountPerLeg;

    const rows = await loadPoolRowsServer(Date.now());
    if (rows.length === 0) return apiResponse({ ready: false, reason: "no-pools" });
    const feeBps = await getAggFeeBps(Date.now());
    const q = await quoteSwap(rows, {
      tokenIn, tokenOut, amountIn: legIn, recipient: owner, slippageBps: 100, feeBps, weth: CONTRACTS.WETH,
    });
    if (!q) return apiResponse({ ready: false, reason: "no-route" });

    // The market must clear the order's floor (this is the limit condition; for DCA the floor is 1).
    if (q.quote.netAmountOut < floor) {
      return apiResponse({ ready: false, reason: "price", quotedOut: q.quote.netAmountOut.toString(), floor: floor.toString() });
    }

    // Plan: quoteSwap already set recipient = owner and amountIn = legIn. Pin minAmountOut to the floor so
    // the router enforces exactly the user's guarantee (the contract requires plan.minAmountOut >= floor).
    const plan = { ...(q.encoded as any), minAmountOut: floor };

    return apiResponse({
      ready: true,
      id: idParam,
      owner, tokenIn, tokenOut,
      legIn: legIn.toString(),
      floor: floor.toString(),
      quotedOut: q.quote.netAmountOut.toString(),
      value: q.value.toString(),
      plan: stringifyBig(plan),
    });
  } catch (err: any) {
    return apiError(err?.message || "fill-plan failed", 500);
  }
}
