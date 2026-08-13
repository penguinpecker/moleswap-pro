/**
 * poolIdLookup.ts — turn a Uniswap-v4 PoolId into the token pair it trades.
 *
 * WHY THIS EXISTS
 * On a launchpad chain the identifier a user has to hand is very often a v4 PoolId, not a token
 * address — it is what the launch UI and the explorer show for a v4 pool. Pasting one into a token
 * search returned "No token found — paste a contract address to import it", which reads as "your
 * token does not exist" when the pool is perfectly real and tradeable.
 *
 * A PoolId is keccak(abi.encode(PoolKey)), so it cannot be reversed and the PoolManager does not
 * store the key. The pair is recoverable from the Initialize event instead, which indexes the id
 * alongside both currencies:
 *
 *   Initialize(PoolId indexed id, Currency indexed currency0, Currency indexed currency1,
 *              uint24 fee, int24 tickSpacing, IHooks hooks, uint160 sqrtPriceX96, int24 tick)
 *
 * Filtering on topic0 + the id gives exactly one log, and currency0/currency1 come straight out of
 * the indexed topics — no ABI decode of the data needed, and it works for ANY v4 pool on the
 * manager rather than only the ones in our registry.
 */
import { ethers } from "ethers";
import { CONTRACTS, RH_RPC_URL } from "./contracts";

/** keccak of the v4 Initialize signature. */
const INITIALIZE_TOPIC = ethers.id(
  "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)",
);

const NATIVE = "0x0000000000000000000000000000000000000000";

export interface PoolIdPair {
  poolId: string;
  currency0: string;
  currency1: string;
  /** The leg that is not ETH/WETH/USDG — i.e. the one the user actually means. */
  token: string;
}

/** A 32-byte hex value: the shape of a PoolId (and of a tx hash — see resolvePoolId). */
export function looksLikePoolId(s: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(s.trim());
}

const cache = new Map<string, PoolIdPair | null>();

/**
 * Resolve a PoolId to its pair. Returns null when the id was never initialised on this manager —
 * which is also what a transaction hash pasted by mistake will do, so the caller can treat "not a
 * pool" and "not a token" as one honest "nothing found" rather than guessing.
 */
export async function resolvePoolId(poolId: string): Promise<PoolIdPair | null> {
  const id = poolId.trim().toLowerCase();
  if (!looksLikePoolId(id)) return null;
  if (cache.has(id)) return cache.get(id)!;

  try {
    const provider = new ethers.JsonRpcProvider(RH_RPC_URL);
    const logs = await provider.getLogs({
      address: CONTRACTS.POOL_MANAGER,
      topics: [INITIALIZE_TOPIC, id],
      fromBlock: 0,
      toBlock: "latest",
    });
    if (!logs.length) {
      cache.set(id, null);
      return null;
    }
    // currency0 / currency1 are indexed, so they are topics 2 and 3.
    const currency0 = ethers.getAddress("0x" + logs[0].topics[2].slice(-40));
    const currency1 = ethers.getAddress("0x" + logs[0].topics[3].slice(-40));

    // Prefer the non-hub leg: a v4 pool here is almost always ETH/token or WETH/token, and the
    // token is what the user is trying to select.
    const hubs = new Set(
      [NATIVE, CONTRACTS.WETH, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"].map((a) =>
        a.toLowerCase(),
      ),
    );
    const token = hubs.has(currency0.toLowerCase()) ? currency1 : currency0;

    const out: PoolIdPair = { poolId: id, currency0, currency1, token };
    cache.set(id, out);
    return out;
  } catch {
    return null;
  }
}
