/**
 * referencePrice.ts — an INDEPENDENT price to judge a quote against.
 *
 * WHY THIS EXISTS. The aggregator computes a price impact against the pool's own TWAP mid, which
 * is the right denominator when there is one. For pairs routed through the v3-style venue there
 * is no MoleHook TWAP at all, so that number comes back null — and the quote API never carried it
 * to the client in the first place. The result, measured on 2026-08-25:
 *
 *     0.1 ETH -> USDe quoted -24.06% against the Chainlink price
 *     and the swap card showed a confident number with no warning of any kind
 *
 * A user has no way to tell a fair fill from a quarter of their money. This module supplies the
 * denominator that makes the difference visible.
 *
 * WHY CHAINLINK AND NOT THE POOL. The pool being quoted cannot be the yardstick for judging that
 * same pool — a thin or walked pool reports itself as fair. Chainlink is independent of the venue,
 * is what the lending market already prices collateral with, and covers every asset listed here.
 *
 * WHAT THIS IS NOT. It is not a fee, not slippage tolerance, and not a guarantee. It is the gap
 * between what the route pays and what the asset is worth, which is exactly the number a user
 * needs and currently does not get.
 */
import { createPublicClient, http, type Address } from "viem";
import { RH_CHAIN } from "@/lib/chain/chains";

/**
 * Chainlink USD feeds on Robinhood Chain, keyed by the token they price.
 *
 * Taken from the Chainlink reference-data directory for this chain and matched to the token
 * addresses verified in `lib/chain/contracts.ts`. Every entry is 8 decimals on an 86,400 s
 * heartbeat. A token absent from this map yields a null reference rather than a guess — an
 * unverified pairing here would be worse than no number, because it would look authoritative.
 */
export const RH_USD_FEEDS: Record<string, Address> = {
  // WETH — also the feed the native ETH leg is priced with
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
  // USDG (Paxos)
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2",
  // USDe (Ethena)
  "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34": "0xb9fB4e65744E4178894f7C61CF80E8a48A5f224a",
  // Robinhood tokenised equities
  "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec": "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", // NVDA
  "0x117cc2133c37b721f49de2a7a74833232b3b4c0c": "0x319724394D3A0e3669269846abE664Cd621f9f6A", // SPY
  "0x322f0929c4625ed5bad873c95208d54e1c003b2d": "0x4A1166a659A55625345e9515b32adECea5547C38", // TSLA
  "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9": "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0", // AAPL
  "0xe93237c50d904957cf27e7b1133b510c669c2e74": "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E", // MSFT
};

/** Native ETH is priced with the WETH feed — same asset, one wrap apart. */
const NATIVE = "0x0000000000000000000000000000000000000000";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

const aggregatorAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/**
 * Chainlink on this chain runs a 24 h heartbeat. Anything materially older than that is not a
 * price, and judging a quote against it would produce a confident wrong warning — which is worse
 * than none, because it teaches users to ignore the warning.
 */
const MAX_FEED_AGE_SEC = 86_400 + 3_600;

export function feedFor(token: string): Address | null {
  const k = token.toLowerCase();
  if (k === NATIVE) return RH_USD_FEEDS[WETH] ?? null;
  return RH_USD_FEEDS[k] ?? null;
}

function client() {
  const rpc =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) || RH_CHAIN.rpcUrl;
  return createPublicClient({ chain: RH_CHAIN as any, transport: http(rpc) });
}

/** USD price with 8 decimals, or null when there is no feed or the feed is stale. */
async function usdPrice(token: string): Promise<number | null> {
  const feed = feedFor(token);
  if (!feed) return null;
  try {
    const r = (await client().readContract({
      address: feed,
      abi: aggregatorAbi,
      functionName: "latestRoundData",
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    const answer = Number(r[1]);
    const updatedAt = Number(r[3]);
    if (answer <= 0) return null;
    const age = Math.floor(Date.now() / 1000) - updatedAt;
    if (age > MAX_FEED_AGE_SEC) return null; // stale: no honest denominator
    return answer / 1e8;
  } catch {
    return null;
  }
}

export interface ReferenceCheck {
  /** How far below the reference value the route lands, in bps. Positive = the user loses. */
  priceImpactBps: number | null;
  /** USD value of what goes in, at the reference price. */
  valueInUsd: number | null;
  /** USD value of what comes out, at the reference price. */
  valueOutUsd: number | null;
  /** Null when either leg has no feed or a stale one — say so, never substitute a guess. */
  reason: string | null;
}

/**
 * Judge a quote against the independent reference.
 *
 * Only reports a LOSS (impact floored at zero). A route that beats the oracle is not a warning,
 * and surfacing a negative number as "impact" would read as a bonus rather than as noise.
 */
export async function checkAgainstReference(args: {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  decimalsIn: number;
  decimalsOut: number;
}): Promise<ReferenceCheck> {
  const none = (reason: string): ReferenceCheck => ({
    priceImpactBps: null,
    valueInUsd: null,
    valueOutUsd: null,
    reason,
  });

  const [pIn, pOut] = await Promise.all([usdPrice(args.tokenIn), usdPrice(args.tokenOut)]);
  if (pIn === null) return none("no fresh reference feed for the input token");
  if (pOut === null) return none("no fresh reference feed for the output token");

  const valueInUsd = (Number(args.amountIn) / 10 ** args.decimalsIn) * pIn;
  const valueOutUsd = (Number(args.amountOut) / 10 ** args.decimalsOut) * pOut;
  if (!(valueInUsd > 0)) return none("input value is zero");

  const lossBps = Math.max(0, Math.round((1 - valueOutUsd / valueInUsd) * 10_000));
  return { priceImpactBps: lossBps, valueInUsd, valueOutUsd, reason: null };
}
