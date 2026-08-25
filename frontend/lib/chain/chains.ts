/**
 * Multi-chain registry — Robinhood Chain (4663) and Arc (5042).
 *
 * WHY THIS FILE EXISTS. `contracts.ts` is a flat, Robinhood-only registry that dozens of screens and
 * API routes import directly. Switching the wallet to Arc while those imports keep handing out
 * Robinhood addresses would be a fund-loss bug, not a cosmetic one: an approval or a swap would be
 * aimed at an address that either does not exist on Arc or belongs to somebody else entirely. So the
 * per-chain truth lives here, `contracts.ts` is left exactly as it was (and remains the Robinhood
 * answer), and anything chain-aware reads `contractsFor(chainId)` / `isAvailable(product, chainId)`.
 *
 * PRODUCT SCOPE. Three products, and only three: the DEX aggregator (swap), LP pools, and the
 * lending/borrowing market. `AVAILABILITY` below is the single source of truth for which of them is
 * live on which chain, so the UI can say "not on this chain yet" instead of silently mis-executing.
 */

export type ProductKey = "swap" | "pools" | "lending";

export interface ChainMeta {
  id: number;
  key: "rh" | "arc";
  name: string;
  /** What the switcher shows. Kept short — it sits in a pill in the chrome. */
  shortName: string;
  nativeSymbol: string;
  nativeDecimals: number;
  rpcUrl: string;
  explorerUrl: string;
  /** Two-letter mark drawn in the switcher when there is no logo asset. */
  mark: string;
  /** The accent the switcher tints this chain with. Both come from the Burrow palette. */
  accent: string;
}

export const RH_CHAIN: ChainMeta = {
  id: 4663,
  key: "rh",
  name: "Robinhood Chain",
  shortName: "Robinhood",
  nativeSymbol: "ETH",
  nativeDecimals: 18,
  rpcUrl: process.env.NEXT_PUBLIC_RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  mark: "RH",
  accent: "#5c9440", // --grass
};

export const ARC_CHAIN: ChainMeta = {
  id: 5042,
  key: "arc",
  name: "Arc",
  shortName: "Arc",
  // Arc pays gas in USDC. The NATIVE balance is 18-decimal; the ERC-20 view of the very same balance
  // at 0x3600…0000 is 6-decimal. Same money, two decimal conventions — never convert between them by
  // assuming a wrapper exists, and never show a native balance with 6 decimals.
  nativeSymbol: "USDC",
  nativeDecimals: 18,
  rpcUrl: process.env.NEXT_PUBLIC_ARC_RPC_URL || "https://www.moleswap.com/rpc/v1/arc",
  explorerUrl: "https://arc-scan.io",
  mark: "AR",
  accent: "#f0a03c", // --amber
};

export const SUPPORTED_CHAINS: ChainMeta[] = [RH_CHAIN, ARC_CHAIN];

export const chainMetaFor = (chainId: number | undefined): ChainMeta | undefined =>
  SUPPORTED_CHAINS.find((c) => c.id === chainId);

export const isSupportedChain = (chainId: number | undefined): boolean =>
  chainMetaFor(chainId) !== undefined;

/* ─────────────────────────────── contracts ─────────────────────────────── */

export interface ChainContracts {
  /** The aggregator's executor and approval target. */
  MOLE_ROUTER: string;
  /** Uniswap v4 singleton. */
  POOL_MANAGER: string;
  /** Wrapped native, or the zero address where the chain has none. */
  WETH: string;
  /** The fee dial the router reads its bps from. */
  MOLE_FEE_DIAL: string;
  /** LP-pool contracts. Zero address where the product is not deployed on this chain. */
  MOLE_HOOK: string;
  MOLE_POSITIONS: string;
  /**
   * The batch-auction queue. OPTIONAL because it is a per-chain fact, not a universal one: Robinhood
   * has one, Arc does not. Absent must stay absent — a screen that falls back to the other chain's
   * queue address would show a trust card for a contract that is not on the chain being viewed.
   */
  MOLE_QUEUE?: string;
  /** Lending market. Zero address until it ships. */
  LENDING_POOL: string;
}

const ZERO = "0x0000000000000000000000000000000000000000";

const RH_CONTRACTS: ChainContracts = {
  MOLE_ROUTER: "0xBd9B841d690E31B61aa3858EB145EA8BBe71122c",
  POOL_MANAGER: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  MOLE_FEE_DIAL: "0x242263f3Ea6165a70B463d8b65F8DdFdd66762EA",
  MOLE_HOOK: "0xb2c9A0af48dF8858F3765385E733Cd8776a138C4",
  MOLE_POSITIONS: "0x674625B6E6a2614ef6e247aF099BEA2e65e1536A",
  MOLE_QUEUE: "0x3dCb2494cBC9604f270177E38160ae4CA76CDEbd",
  LENDING_POOL: "0xb819FD2DabF86dB45911Cd57D4588E9440E485dD",
};

const ARC_CONTRACTS: ChainContracts = {
  // Deployed and verified with real funds on 2026-08-23, both directions. See records.txt.
  MOLE_ROUTER: "0xe4192c72574e6e387d4c29eb89feceada105f3e3",
  POOL_MANAGER: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  // Arc has no WETH. The router's `weth` slot is deliberately pinned to the USDC ERC-20 so that any
  // native-ETH code path fails closed rather than half-working. Nothing here should wrap or unwrap.
  WETH: ZERO,
  MOLE_FEE_DIAL: "0x6a8E4aB1A2e9Ef23366Aa0a67568D4e7F1cdF539",
  // Deployed and proven with a real-fund open/withdraw round trip on 2026-08-23.
  // The hook address is mined: its low 14 bits are 0x38C4 and cannot be changed.
  MOLE_HOOK: "0xfFDCBf2f5b53C0fa2c5D7d25A87F99514Fbe78c4",
  MOLE_POSITIONS: "0x8e6bB60d6A75e0390Ee3Da2b280aec2e39769D77",
  // Lending is NOT deployed on Arc, and not because of engineering effort: the chain
  // has no collateral asset with both a Chainlink feed and liquidatable depth. See
  // AVAILABILITY below and rh-lending/PLAN.md §9.
  LENDING_POOL: ZERO,
};

const BY_CHAIN: Record<number, ChainContracts> = {
  [RH_CHAIN.id]: RH_CONTRACTS,
  [ARC_CHAIN.id]: ARC_CONTRACTS,
};

/** Contracts for a chain. Defaults to Robinhood, matching `contracts.ts`'s historical behaviour. */
export const contractsFor = (chainId: number | undefined): ChainContracts =>
  BY_CHAIN[chainId ?? RH_CHAIN.id] ?? RH_CONTRACTS;

/* ────────────────────────────── availability ───────────────────────────── */

/**
 * Which product is live on which chain. A `false` here is what the UI must show as "not on this
 * chain yet" — it is deliberately conservative: a product counts as available only once its
 * contracts are deployed AND verified on that chain.
 */
export const AVAILABILITY: Record<ProductKey, Record<number, boolean>> = {
  swap: { [RH_CHAIN.id]: true, [ARC_CHAIN.id]: true },
  pools: { [RH_CHAIN.id]: true, [ARC_CHAIN.id]: true },
  // Robinhood: LIVE since 2026-08-25 (Aave v3.7 — Pool 0xb819FD2D…). Arc has no lending
  // deployment at all, and `false` is what makes the UI say "not on this chain yet" instead of
  // reading Robinhood's market for an Arc user.
  lending: { [RH_CHAIN.id]: true, [ARC_CHAIN.id]: false },
};

export const isAvailable = (product: ProductKey, chainId: number | undefined): boolean =>
  Boolean(AVAILABILITY[product]?.[chainId ?? RH_CHAIN.id]);

/** The chains a given product IS live on — used to word the "switch to X" prompt. */
export const chainsWith = (product: ProductKey): ChainMeta[] =>
  SUPPORTED_CHAINS.filter((c) => isAvailable(product, c.id));
