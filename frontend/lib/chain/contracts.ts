/**
 * MoleSwap contract + token registry — Robinhood Chain mainnet (4663).
 *
 * This file kept its original path so every screen/api-route that imports `CONTRACTS`, `TOKENS`,
 * `POOLS`, `getTokenByAddress`, etc. keeps working unchanged. The addresses underneath are the LIVE
 * Robinhood Chain deployment — the aggregator's on-chain executor (MoleRouter), the Uniswap-v4 ALM
 * (MoleHook / MolePositions), and PancakeSwap V3 as the primary liquidity venue.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  !!!  THERE IS NO CANONICAL USDC ON ROBINHOOD CHAIN.  !!!
 *  The stable leg is USDG (Global Dollar / Paxos) at SIX decimals. Never resolve a token by symbol;
 *  always use the pinned addresses below and always carry `decimals`. A WETH(18)/USDG(6) mix-up is a
 *  12-order-of-magnitude, fund-loss error.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ═══ CORE CONTRACTS (Robinhood Chain 4663) ═══
export const CONTRACTS = {
  // PancakeSwap V3 — primary liquidity venue the aggregator routes across.
  FACTORY: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
  TICK_LENS: "0x9a489505a00cE272eAa5e07Dba6491314CaE3796",
  QUOTER_V2: "0x0000000000000000000000000000000000000000", // unused — quoting is off-chain, to the wei
  MULTICALL: "0x0000000000000000000000000000000000000000",
  // Wrapped native (WETH) — currency0 of the live v4 pool.
  WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",

  // ═══ MoleSwap contracts ═══
  // MoleRouter — the aggregator's immutable on-chain executor. Users grant it a standing ERC-20
  // approval; it holds nothing between txs. This is both the swap router and the approval target.
  MOLE_ROUTER: "0x7D74a0959A321e362aDb171E405Ee97ADA6ca79d",
  SWAP_ROUTER: "0x7D74a0959A321e362aDb171E405Ee97ADA6ca79d",
  MOLESWAP_FEE_ROUTER: "0x7D74a0959A321e362aDb171E405Ee97ADA6ca79d",
  // Uniswap v4 singleton + the ALM's hook/vault/queue.
  POOL_MANAGER: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  MOLE_HOOK: "0xb2c9A0af48dF8858F3765385E733Cd8776a138C4",
  MOLE_POSITIONS: "0x674625B6E6a2614ef6e247aF099BEA2e65e1536A",
  POSITION_MANAGER: "0x674625B6E6a2614ef6e247aF099BEA2e65e1536A",
  MOLESWAP_LIQUIDITY_PROXY: "0x674625B6E6a2614ef6e247aF099BEA2e65e1536A",
  MOLE_QUEUE: "0x3dCb2494cBC9604f270177E38160ae4CA76CDEbd",
  MOLE_FEE_COLLECTOR: "0x4771865614D194Aa8b7aAB9d91e857686c37E584",
  MOLESWAP_BRIDGE_HELPER: "0x0000000000000000000000000000000000000000", // single chain — no bridging
} as const;

// ═══ TOKENS ═══
export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  sourceChain: string;
  logoURI: string;
  swappable?: boolean;
  bridgeable?: boolean;
  originSymbol?: string;
  displaySymbol?: string;
  displaySubtitle?: string;
  hidden?: boolean;
}

export function getDisplayInfo(token: TokenInfo): { symbol: string; subtitle: string } {
  return {
    symbol: token.displaySymbol ?? token.symbol,
    subtitle: token.displaySubtitle ?? token.name,
  };
}

export function getPoolDisplayInfo(token: TokenInfo): { symbol: string; subtitle: string } {
  if (token.symbol === "ETH") return { symbol: "ETH", subtitle: "Robinhood Chain" };
  if (token.symbol === "WETH") return { symbol: "WETH", subtitle: "Wrapped Ether" };
  return { symbol: token.symbol, subtitle: "on Robinhood Chain" };
}

// Self-hosted so they always render (external logo CDNs 404 / block cross-origin).
const ETH_LOGO = "/tokens/eth.svg";
const WETH_LOGO = "/tokens/weth.svg";
const USDG_LOGO = "/tokens/usdg.svg";

// The full indexed token universe on Robinhood Chain: native ETH, its wrapped form, and USDG.
export const TOKENS: TokenInfo[] = [
  {
    address: "0x0000000000000000000000000000000000000000",
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    sourceChain: "Robinhood Chain",
    logoURI: ETH_LOGO,
    swappable: true,
    originSymbol: "ETH",
    displaySymbol: "ETH",
    displaySubtitle: "Robinhood Chain",
  },
  {
    address: CONTRACTS.WETH,
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    sourceChain: "Robinhood Chain",
    logoURI: WETH_LOGO,
    swappable: true,
    originSymbol: "ETH",
    displaySymbol: "WETH",
    displaySubtitle: "Wrapped Ether",
  },
  {
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    symbol: "USDG",
    name: "Global Dollar",
    decimals: 6,
    sourceChain: "Robinhood Chain",
    logoURI: USDG_LOGO,
    swappable: true,
    isStable: true,
    originSymbol: "USDG",
    displaySymbol: "USDG",
    displaySubtitle: "Global Dollar",
  } as TokenInfo,
];

// ═══ POOLS (PancakeSwap V3 WETH/USDG tiers — the aggregator routes across all of them) ═══
export interface PoolInfo {
  address: string;
  token0: string;
  token1: string;
  fee: number;
  name: string;
  thinLiquidity?: boolean;
  hidden?: boolean;
}

const WETH_ADDR = CONTRACTS.WETH;
const USDG_ADDR = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

export const POOLS: PoolInfo[] = [
  { address: "0x88a8e96e7785d378825e8b5d7fc0e6f62487061e", token0: WETH_ADDR, token1: USDG_ADDR, fee: 500, name: "WETH/USDG" },
  { address: "0x4520f3f932ae530c58cc332b532951e5814e6cb8", token0: WETH_ADDR, token1: USDG_ADDR, fee: 100, name: "WETH/USDG" },
  { address: "0x0ff6bdd6ac5db3426c3c2c922f93a5749887e28d", token0: WETH_ADDR, token1: USDG_ADDR, fee: 10000, name: "WETH/USDG", thinLiquidity: true },
];

export const VISIBLE_TOKENS: TokenInfo[] = TOKENS.filter((t) => !t.hidden);
export const VISIBLE_POOLS: PoolInfo[] = POOLS.filter((p) => !p.hidden);

// ═══ ABIs (generic Uniswap-V3 / ERC-20 shapes; reused for on-chain reads) ═══
export const QUOTER_V2_ABI = [
  "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
] as const;

export const SWAP_ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
] as const;

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
] as const;

export const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
] as const;

export const POSITION_MANAGER_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
] as const;

export const FEE_ROUTER_ABI = [
  "function swap(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient, uint256 deadline, tuple(uint8 kind, address pool, address hookOrManager, bytes32 poolId, bool zeroForOne, uint24 fee, int24 tickSpacing)[] hops)[] paths) payable returns (uint256 amountOut)",
] as const;

export const LIQUIDITY_PROXY_ABI = [] as const;
export const WETH_ABI = [
  "function deposit() payable",
  "function withdraw(uint256 wad) external",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
] as const;
export const BRIDGE_HELPER_ABI = [] as const;

// ═══ Tick math constants ═══
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const TICK_SPACINGS: Record<number, number> = {
  100: 1,
  500: 10,
  2500: 50,
  3000: 60,
  10000: 200,
};

// ═══ Chain helpers ═══
export const RH_RPC_URL =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) ||
  "https://rpc.mainnet.chain.robinhood.com";
export const RH_CHAIN_ID = 4663;
export const RH_EXPLORER_URL = "https://robinhoodchain.blockscout.com";

export function getTokenByAddress(address: string): TokenInfo | undefined {
  return TOKENS.find((t) => t.address.toLowerCase() === address.toLowerCase());
}

export function getTokenBySymbol(symbol: string): TokenInfo | undefined {
  return TOKENS.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase());
}

export function findPool(tokenA: string, tokenB: string): PoolInfo | undefined {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  return POOLS.find(
    (p) =>
      (p.token0.toLowerCase() === a && p.token1.toLowerCase() === b) ||
      (p.token0.toLowerCase() === b && p.token1.toLowerCase() === a),
  );
}

export function getSwappableTokens(): TokenInfo[] {
  return TOKENS.filter((t) => t.swappable !== false);
}
