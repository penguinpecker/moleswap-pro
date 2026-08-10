import { createPublicClient, http, type Address } from "viem";
import { robinhoodChain } from "@/lib/chain/wagmi-config";
import { MOLE_ADDRESSES, ROBINHOOD_RPC_URL } from "./chain";

/**
 * The live aggregator fee, read from the router's fee dial.
 *
 * The router (immutable) exposes `feeDial()`; the dial exposes `feeBps()`. We read the dial live so the UI
 * follows a fee change within its cache TTL and — critically — computes minAmountOut on the POST-fee
 * output, matching the router's on-chain check.
 *
 * SAFETY OF THE FALLBACK: erring HIGH on the assumed fee only LOOSENS minAmountOut (the router's real
 * post-fee output is then >= our assumed net, so it clears the floor). Erring LOW would tighten it and
 * revert. So the fallback equals the deployed dial's setting and, on any read failure, we keep the last
 * good value — never a value below the truth.
 */
export const AGG_FEE_BPS_FALLBACK = 69; // 0.69%, the deployed dial's initial setting

const routerAbi = [
  { type: "function", name: "feeDial", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const dialAbi = [
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

let _dial: Address | null | undefined; // undefined = unread, null = router has no dial (feeless)
let _cache: { at: number; bps: number } | null = null;
const TTL = 30_000;

function client() {
  const rpc = (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) || ROBINHOOD_RPC_URL;
  return createPublicClient({ chain: robinhoodChain, transport: http(rpc) });
}

/** Live aggregator fee in bps (clamped to [0,100]). Cached 30s; returns the last good value on failure. */
export async function getAggFeeBps(nowMs: number): Promise<number> {
  if (_cache && nowMs - _cache.at < TTL) return _cache.bps;
  try {
    const c = client();
    if (_dial === undefined) {
      _dial = (await c.readContract({
        address: MOLE_ADDRESSES.moleRouter as Address,
        abi: routerAbi,
        functionName: "feeDial",
      })) as Address;
      if (/^0x0+$/i.test(_dial)) _dial = null; // feeless router
    }
    if (_dial === null) {
      _cache = { at: nowMs, bps: 0 };
      return 0;
    }
    const raw = (await c.readContract({ address: _dial, abi: dialAbi, functionName: "feeBps" })) as bigint;
    let bps = Number(raw);
    if (bps > 100) bps = 100;
    if (bps < 0) bps = 0;
    _cache = { at: nowMs, bps };
    return bps;
  } catch {
    // Keep the last good value; if we never read one, assume the deployed setting (never below the truth).
    return _cache?.bps ?? AGG_FEE_BPS_FALLBACK;
  }
}

/** Last known fee without a network round-trip — for pure/sync code paths. */
export function cachedAggFeeBps(): number {
  return _cache?.bps ?? AGG_FEE_BPS_FALLBACK;
}
