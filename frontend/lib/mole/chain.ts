/**
 * chain.ts — Robinhood Chain mainnet (4663) configuration for the MoleSwap Pro ALM.
 *
 * Everything here mirrors the LIVE deployment. Do not "helpfully" substitute addresses
 * discovered by symbol lookup — see the USDC warning below.
 *
 * ============================================================================
 * !!!  THERE IS NO CANONICAL USDC ON ROBINHOOD CHAIN.  !!!
 *
 * Both explorer entries named "USD Coin" / "USDC" on this chain are 18-decimal
 * FAKES. The stable leg of the live pool is USDG (Paxos) at SIX decimals.
 * NEVER resolve a token by its symbol on this chain; always use the pinned
 * addresses in TOKENS below, and always carry `decimals` with the token.
 * A WETH(18)/USDG(6) mix-up is a 12-order-of-magnitude error — a fund-loss bug,
 * not a cosmetic one.
 * ============================================================================
 */

/*
 * This module is deliberately dependency-free: viem is in package.json but its types
 * are structural, so the local aliases below are assignable to viem's `Address`/`Hex`
 * and `robinhoodChain` satisfies viem's `Chain` interface as-is. Callers can pass it
 * straight to viem's `createPublicClient({ chain: robinhoodChain, ... })` or a wagmi
 * config with no wrapping.
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/* ------------------------------------------------------------------ chain */

export const ROBINHOOD_CHAIN_ID = 4663;

export const ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

/** viem/wagmi-compatible chain object for Robinhood Chain mainnet. */
export const robinhoodChain = {
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [ROBINHOOD_RPC_URL] },
  },
} as const;

/* -------------------------------------------------------------- addresses */

/** Live contract addresses on Robinhood Chain mainnet (4663). Both Mole contracts are UUPS proxies. */
export const MOLE_ADDRESSES = {
  /** MoleHook proxy — the pool's hook AND the first-party TWAP oracle. */
  moleHook: "0xb2c9A0af48dF8858F3765385E733Cd8776a138C4" as Address,
  /** MolePositions proxy — the custody vault every UI call targets. */
  molePositions: "0x674625B6E6a2614ef6e247aF099BEA2e65e1536A" as Address,
  /** Uniswap v4 singleton PoolManager. */
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address,
  /**
   * MoleQueue proxy — the batch auction, bound to LIVE_POOL_KEY forever.
   * Orders cross against each other at the TWAP; only the net residual touches the pool.
   */
  moleQueue: "0x3dCb2494cBC9604f270177E38160ae4CA76CDEbd" as Address,
  /** MoleFeeCollector — redeems the protocol's ERC-6909 fee claims into real tokens. */
  moleFeeCollector: "0x4771865614D194Aa8b7aAB9d91e857686c37E584" as Address,
} as const;

/**
 * The live queue's schedule and bounds, as deployed. Mirrors DeployConfig.DEFAULT_QUEUE_*.
 *
 * A UI must not hard-code these anywhere else: they are readable on-chain
 * (`epochDuration()`, `freezeDuration()`, `maxEpochLife()`), and this object exists so a
 * component can render a countdown without a round trip — not so it can disagree with the chain.
 */
export const QUEUE_CONFIG = {
  /** Seconds an epoch accepts new orders and cancels. */
  epochDuration: 300,
  /** Seconds after the cutoff before settlement is allowed. Makes the price nobody's choice. */
  freezeDuration: 60,
  /** Seconds after the cutoff before the escape hatch opens. */
  maxEpochLife: 3600,
  /** TWAP window the batch is priced at. */
  twapWindow: 1800,
  /** Max TWAP-vs-spot drift before settlement refuses, in ticks. */
  maxTwapDeviationTicks: 600,
  /**
   * Max distance the aggregated residual swap may execute from the TWAP, in bps.
   *
   * READ THIS AS A SIZE CAP TOO. A batch's own honest price impact is indistinguishable from a
   * sandwicher's, so a one-sided epoch that is large relative to pool depth will breach this and
   * have its unmatched part returned IN KIND at the deadline rather than swapped.
   */
  maxResidualSlippageBps: 300,
} as const;

/* ----------------------------------------------------------------- tokens */

export interface TokenMeta {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  /** ALWAYS read decimals from here, never assume 18. WETH is 18; USDG is 6. */
  readonly decimals: number;
}

/** Wrapped Ether — 18 decimals. currency0 of the live pool (lower address sorts first). */
export const WETH: TokenMeta = {
  address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
  symbol: "WETH",
  name: "Wrapped Ether",
  decimals: 18,
};

/**
 * USDG (Paxos) — SIX decimals, not 18. currency1 of the live pool.
 * This is the ONLY real stable leg on this chain; anything named "USDC" is an impostor.
 */
export const USDG: TokenMeta = {
  address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address,
  symbol: "USDG",
  name: "USDG",
  decimals: 6,
};

/** Pinned token registry. Look tokens up by ADDRESS, never by symbol. */
export const TOKENS: readonly TokenMeta[] = [WETH, USDG];

export function tokenByAddress(address: string): TokenMeta | undefined {
  const needle = address.toLowerCase();
  return TOKENS.find((t) => t.address.toLowerCase() === needle);
}

/* ------------------------------------------------------------------- pool */

/**
 * Uniswap v4 dynamic-fee flag (0x800000). The live pool's `fee` field is this
 * sentinel, NOT a static fee tier — MoleHook drives the actual LP fee.
 */
export const DYNAMIC_FEE_FLAG = 0x800000;

/**
 * The live WETH/USDG pool key, exactly as it hashes to LIVE_POOL_ID.
 * Field shape matches the `PoolKey` tuple in abi.ts, so this object can be
 * passed directly as the `key` argument of `open` / inside `zapOpen`'s params.
 * A PoolKey is immutable — the hook is part of the id and can never change.
 */
export const LIVE_POOL_KEY = {
  currency0: WETH.address,
  currency1: USDG.address,
  fee: DYNAMIC_FEE_FLAG,
  tickSpacing: 60,
  hooks: MOLE_ADDRESSES.moleHook,
} as const;

/** keccak of the abi-encoded LIVE_POOL_KEY — the id used by isWhitelisted / getPosition.poolId. */
export const LIVE_POOL_ID: Hex =
  "0x9aca9d2f4bb68ef41e6928bbe080a4b076b167e2d4b7fdebf4b4fd5d6dadd029";

/** Convenience: decimals of each pool leg, in currency order. WETH=18, USDG=6. */
export const LIVE_POOL_DECIMALS = {
  decimals0: WETH.decimals,
  decimals1: USDG.decimals,
} as const;
