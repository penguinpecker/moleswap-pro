/**
 * PushChain AMM Contract Addresses & Token Registry
 * Deployed on Push Chain Donut Testnet
 * Source: https://push.org/docs/chain/setup/smart-contract-address-book/
 */

// ═══ CORE AMM CONTRACTS ═══
export const CONTRACTS = {
  FACTORY: "0x81b8Bca02580C7d6b636051FDb7baAC436bFb454",
  SWAP_ROUTER: "0x5D548bB9E305AAe0d6dc6e6fdc3ab419f6aC0037",
  QUOTER_V2: "0x83316275f7C2F79BC4E26f089333e88E89093037",
  POSITION_MANAGER: "0xf9b3ac66aed14A2C7D9AA7696841aB6B27a6231e",
  TICK_LENS: "0xb64113Fc16055AfE606f25658812EE245Aa41dDC",
  MULTICALL: "0xa8c00017955c8654bfFbb6d5179c99f5aB8B7849",
  WPC: "0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9", // Wrapped Push Chain (like WETH)
  // ═══ MOLESWAP CUSTOM CONTRACTS ═══
  MOLESWAP_FEE_ROUTER: "0x2845d303d9C367bF9ad555b0de81945E02861adD",
  MOLESWAP_LIQUIDITY_PROXY: "0xE41F22796C076157688047ACBe9665CDE740A98e",
  /**
   * MoleSwapBridgeHelper — atomic bridge+swap for Solana users (1-sig UX).
   * Solves Solana's 1232-byte tx buffer limit by combining wrap+approve+swap
   * into a single function call.
   * Deployed: 2026-04-19 | Tx: 0x3cc43cd371545e082715be1b00f3a734e70acb4c2cf7033f7b53562998931379
   */
  MOLESWAP_BRIDGE_HELPER: "0x7db2Bdc454C62354C660a673B317D6945065cd0c",
} as const;

// ═══ PRC-20 TOKENS ON PUSH CHAIN ═══
export interface TokenInfo {
  address: string;
  /**
   * Internal canonical identifier (e.g. "pETH", "pSOL", "USDT.bnb").
   * Used as a lookup key in pool tables and routing logic — DO NOT change
   * these strings without updating POOLS and ROUTES accordingly.
   */
  symbol: string;
  /** Legacy long-form name (e.g. "Ether (Ethereum)"). Kept for backward-compat. */
  name: string;
  decimals: number;
  sourceChain: string;
  logoURI: string;
  swappable?: boolean;
  /**
   * If true, this PRC-20 has an official mapping in Push Chain's Universal
   * Gateway. Users on the matching origin chain can atomically bridge the
   * origin asset into Push Chain as part of a swap (1-sig cross-chain UX).
   * See lib/pushchain/prc20-bridge-map.ts for full bridge info.
   */
  bridgeable?: boolean;
  /**
   * Symbol of the origin-chain asset this PRC-20 represents. Shown in the UI
   * selector so users understand "pSOL = native SOL bridged from Solana".
   * Example: pSOL.originSymbol = "SOL", USDT.eth.originSymbol = "USDT",
   * pETH.originSymbol = "ETH".
   */
  originSymbol?: string;
  // ─── UI DISPLAY (preferred over `symbol`/`name` in all user-facing views) ──
  /**
   * Real asset ticker shown in the UI: "ETH", "SOL", "USDT", "PC", "WPC".
   * Should match the name of the underlying asset on its origin chain —
   * users should never see "pETH" or "pSOL" anywhere in the UI.
   */
  displaySymbol?: string;
  /**
   * Subtitle shown in the SWAP UI, labelling the ORIGIN chain the asset lives
   * on (what the user actually holds in Phantom/MetaMask). Examples:
   * "on Solana", "on Ethereum", "on Base", "Push Chain native". In the POOLS
   * UI this is overridden by `getPoolDisplayInfo` which labels the PRC-20 as
   * "on Push Chain" — the two contexts display the same token differently
   * because the user is interacting with different layers (origin asset vs
   * bridged PRC-20).
   */
  displaySubtitle?: string;
  /**
   * If true, hide from token pickers, pool listings, and routing results.
   * Used for legacy/mislabelled tokens (e.g. the token formerly known as
   * "pBNB", which is actually pETH_BNB in the SDK and has no clear UX story).
   */
  hidden?: boolean;
}

/**
 * Swap-context display data. In the DEX/swap UI the user thinks of a PRC-20
 * as the origin-chain asset — "SOL on Solana", "USDT on Ethereum" — because
 * that's what they actually hold (in Phantom/MetaMask) and what gets bridged
 * in. Prefer the annotated `displaySymbol`/`displaySubtitle`; fall back to
 * the internal `symbol`/`name` only for tokens that haven't been annotated.
 */
export function getDisplayInfo(token: TokenInfo): { symbol: string; subtitle: string } {
  return {
    symbol: token.displaySymbol ?? token.symbol,
    subtitle: token.displaySubtitle ?? token.name,
  };
}

/**
 * Pool-context display data. In the pools/AMM UI the user is interacting with
 * the PRC-20 that actually lives on Push Chain (the pool's reserves are
 * pSOL/WPC, not native SOL/PC), so we show the internal symbol + "on Push
 * Chain" — e.g. "pSOL on Push Chain", "USDT.eth on Push Chain". This matches
 * the way pool contracts, balances, and approvals all operate on Push Chain.
 *
 * The native PC / WPC entries keep their own labels; everything else uses the
 * internal symbol to disambiguate pSOL vs pETH vs USDT.eth vs USDT.sol, etc.
 */
export function getPoolDisplayInfo(token: TokenInfo): { symbol: string; subtitle: string } {
  // PC / WPC are Push-chain native tokens — keep their canonical labels.
  if (token.symbol === "PC") return { symbol: "PC", subtitle: "Push Chain native" };
  if (token.symbol === "WPC") return { symbol: "WPC", subtitle: "Wrapped Push Chain" };
  // Bridged PRC-20s: show internal symbol so pSOL/USDT.eth/USDT.sol are
  // distinguishable in the pools UI where chain context matters.
  return { symbol: token.symbol, subtitle: "on Push Chain" };
}

export const TOKENS: TokenInfo[] = [
  // ─── Push Chain native + wrapped ───────────────────────────────────────
  { address: "0x0000000000000000000000000000000000000000", symbol: "PC",  name: "Push Chain",         decimals: 18, sourceChain: "Push Chain", logoURI: "/push-chain-logo.png", swappable: true, originSymbol: "PC", displaySymbol: "PC",  displaySubtitle: "Push Chain native" },
  { address: CONTRACTS.WPC,                                  symbol: "WPC", name: "Wrapped Push Chain", decimals: 18, sourceChain: "Push Chain", logoURI: "/push-chain-logo.png", swappable: true, originSymbol: "PC", displaySymbol: "WPC", displaySubtitle: "Wrapped Push Chain" },

  // ─── Ethereum Sepolia ─────────────────────────────────────────────────
  // Internal symbol `pETH` preserved so existing pool/routing code keeps working.
  // Users see "ETH" with "on Push · Ethereum" subtitle — the real-asset naming
  // they asked for. bridgeable=true means a connected Phantom/MetaMask on the
  // matching origin chain can atomically bridge in during swap, and (new) the
  // final leg can atomically bridge back out if the destination token matches
  // that same origin chain.
  // WETH.eth, stETH.eth, USDC.eth: contracts exist but NO SDK bridge mapping
  // (getPRC20Address throws "Unsupported token symbol" — verified against
  // @pushchain/core 5.1.3, only ETH and USDT are bridgeable from Sepolia).
  // Kept as `swappable: true, bridgeable: false` so users can receive the
  // PRC-20 as a swap output, but not auto-bridge back to Sepolia.
  // USDC.eth address updated to the live one; the previous 0x387b…d68E is
  // the deprecated `USDC.eth.old` contract that no other dapp recognises.
  // NOTE: `displaySubtitle` is the origin-chain label shown in the SWAP UI —
  // "on Solana", "on Ethereum", etc. In the SWAP flow the user thinks of
  // these tokens as the origin asset (SOL on Solana) because that's what
  // they hold in Phantom/MetaMask and what gets bridged. The pools UI uses
  // the INTERNAL symbol (pSOL, USDT.eth) + "on Push Chain" label instead,
  // because the pool holds the PRC-20 representation that lives on Push —
  // see `getPoolDisplayInfo` below.
  { address: "0x2971824Db68229D087931155C2b8bB820B275809", symbol: "pETH",     name: "Ether (Ethereum)",    decimals: 18, sourceChain: "Ethereum",  logoURI: "https://assets.coingecko.com/coins/images/279/small/ethereum.png", swappable: true, bridgeable: true,  originSymbol: "ETH",  displaySymbol: "ETH",  displaySubtitle: "on Ethereum" },
  { address: "0xCA0C5E6F002A389E1580F0DB7cd06e4549B5F9d3", symbol: "USDT.eth", name: "Tether (Ethereum)",   decimals: 6,  sourceChain: "Ethereum",  logoURI: "https://assets.coingecko.com/coins/images/325/small/Tether.png",   swappable: true, bridgeable: true,  originSymbol: "USDT", displaySymbol: "USDT", displaySubtitle: "on Ethereum" },
  { address: "0x7A58048036206bB898008b5bBDA85697DB1e5d66", symbol: "USDC.eth", name: "USD Coin (Ethereum)", decimals: 6,  sourceChain: "Ethereum",  logoURI: "https://assets.coingecko.com/coins/images/6319/small/usdc.png",    swappable: true, bridgeable: false, originSymbol: "USDC", displaySymbol: "USDC", displaySubtitle: "on Ethereum" },

  // ─── Solana Devnet ────────────────────────────────────────────────────
  { address: "0x5D525Df2bD99a6e7ec58b76aF2fd95F39874EBed", symbol: "pSOL",     name: "Solana (Solana)",     decimals: 9, sourceChain: "Solana", logoURI: "https://assets.coingecko.com/coins/images/4128/small/solana.png", swappable: true, bridgeable: true,  originSymbol: "SOL",  displaySymbol: "SOL",  displaySubtitle: "on Solana" },
  { address: "0x4f1A3D22d170a2F4Bddb37845a962322e24f4e34", symbol: "USDT.sol", name: "Tether (Solana)",     decimals: 6, sourceChain: "Solana", logoURI: "https://assets.coingecko.com/coins/images/325/small/Tether.png",   swappable: true, bridgeable: true,  originSymbol: "USDT", displaySymbol: "USDT", displaySubtitle: "on Solana" },

  // ─── Base Sepolia ─────────────────────────────────────────────────────
  { address: "0xc7007af2B24D4eb963fc9633B0c66e1d2D90Fc21", symbol: "pETH.base", name: "Ether (Base)",      decimals: 18, sourceChain: "Base", logoURI: "https://assets.coingecko.com/coins/images/279/small/ethereum.png", swappable: true, bridgeable: true,  originSymbol: "ETH",  displaySymbol: "ETH",  displaySubtitle: "on Base" },
  { address: "0x2C455189D2af6643B924A981a9080CcC63d5a567", symbol: "USDT.base", name: "Tether (Base)",     decimals: 6,  sourceChain: "Base", logoURI: "https://assets.coingecko.com/coins/images/325/small/Tether.png",   swappable: true, bridgeable: true,  originSymbol: "USDT", displaySymbol: "USDT", displaySubtitle: "on Base" },
  { address: "0x84B62e44F667F692F7739Ca6040cD17DA02068A8", symbol: "USDC.base", name: "USD Coin (Base)",   decimals: 6,  sourceChain: "Base", logoURI: "https://assets.coingecko.com/coins/images/6319/small/usdc.png",     swappable: true, bridgeable: false, originSymbol: "USDC", displaySymbol: "USDC", displaySubtitle: "on Base" },

  // ─── Arbitrum Sepolia ─────────────────────────────────────────────────
  { address: "0xc0a821a1AfEd1322c5e15f1F4586C0B8cE65400e", symbol: "pETH.arb", name: "Ether (Arbitrum)",   decimals: 18, sourceChain: "Arbitrum", logoURI: "https://assets.coingecko.com/coins/images/279/small/ethereum.png", swappable: true, bridgeable: true,  originSymbol: "ETH",  displaySymbol: "ETH",  displaySubtitle: "on Arbitrum" },
  { address: "0x76Ad08339dF606BeEDe06f90e3FaF82c5b2fb2E9", symbol: "USDT.arb", name: "Tether (Arbitrum)",  decimals: 6,  sourceChain: "Arbitrum", logoURI: "https://assets.coingecko.com/coins/images/325/small/Tether.png",   swappable: true, bridgeable: true,  originSymbol: "USDT", displaySymbol: "USDT", displaySubtitle: "on Arbitrum" },
  { address: "0xa261A10e94aE4bA88EE8c5845CbE7266bD679DD6", symbol: "USDC.arb", name: "USD Coin (Arbitrum)", decimals: 6, sourceChain: "Arbitrum", logoURI: "https://assets.coingecko.com/coins/images/6319/small/usdc.png",     swappable: true, bridgeable: false, originSymbol: "USDC", displaySymbol: "USDC", displaySubtitle: "on Arbitrum" },

  // ─── BNB Testnet ──────────────────────────────────────────────────────
  // IMPORTANT: The token at 0x7a9082dA... was previously mislabelled "pBNB" but
  // per the Push SDK v5.1.2 source (node_modules/@pushchain/core/src/lib/constants/tokens.js:320)
  // it is actually `pETH_BNB` — ETH bridged from BNB Chain, NOT native BNB.
  // There is no native-BNB PRC-20 in the SDK. Hidden from swap UI per user decision.
  // Pool below is kept for on-chain integrity but also flagged hidden.
  { address: "0x7a9082dA308f3fa005beA7dB0d203b3b86664E36", symbol: "pBNB",     name: "BNB (BNB Chain)",     decimals: 18, sourceChain: "BNB Chain", logoURI: "https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png", swappable: false, bridgeable: false, originSymbol: "ETH",  displaySymbol: "ETH",  displaySubtitle: "on BNB Chain", hidden: true },
  { address: "0x2f98B4235FD2BA0173a2B056D722879360B12E7b", symbol: "USDT.bnb", name: "Tether (BNB Chain)",  decimals: 6,  sourceChain: "BNB Chain", logoURI: "https://assets.coingecko.com/coins/images/325/small/Tether.png",       swappable: true, bridgeable: true,  originSymbol: "USDT", displaySymbol: "USDT", displaySubtitle: "on BNB Chain" },
];

// ═══ LIVE AMM POOLS ═══
export interface PoolInfo {
  address: string;
  token0: string;
  token1: string;
  fee: number;
  name: string;
  thinLiquidity?: boolean; // Warn users — pool has very low liquidity, high slippage expected
  /**
   * Hide pool from UI surfaces (pool list, pool picker, routing results).
   * Pool still exists on-chain — this flag only affects display.
   * Used for the pBNB/WPC pool (mislabelled token; see TOKENS above).
   */
  hidden?: boolean;
}

export const POOLS: PoolInfo[] = [
  { address: "0x0E5914e3A7e2e6d18330Dd33fA387Ce33Da48b54", token0: "0x5D525Df2bD99a6e7ec58b76aF2fd95F39874EBed", token1: CONTRACTS.WPC, fee: 500, name: "pSOL/WPC" },
  { address: "0x012d5C099f8AE00009f40824317a18c3A342f622", token0: "0x2971824Db68229D087931155C2b8bB820B275809", token1: CONTRACTS.WPC, fee: 500, name: "pETH/WPC" },
  { address: "0x2d46b2b92266f34345934F17039768cd631aB026", token0: "0xCA0C5E6F002A389E1580F0DB7cd06e4549B5F9d3", token1: CONTRACTS.WPC, fee: 500, name: "USDT.eth/WPC", thinLiquidity: true },
  { address: "0x524b9B3e98ceF71a20b30859d6c52E13e17C5BA2", token0: "0x7A58048036206bB898008b5bBDA85697DB1e5d66", token1: CONTRACTS.WPC, fee: 500, name: "USDC.eth/WPC", thinLiquidity: true },
  { address: "0x1cE819E742b44f922D2F05fdFFd17b4997f4CD15", token0: "0x2C455189D2af6643B924A981a9080CcC63d5a567", token1: CONTRACTS.WPC, fee: 500, name: "USDT.base/WPC" },
  { address: "0xF926707689ad2fE9A81e666E5B888b2f3AD33980", token0: "0xc7007af2B24D4eb963fc9633B0c66e1d2D90Fc21", token1: CONTRACTS.WPC, fee: 500, name: "pETH.base/WPC" },
  { address: "0x1354c9A72F447f60F4811FC34b8C2e084FE338A3", token0: "0xc0a821a1AfEd1322c5e15f1F4586C0B8cE65400e", token1: CONTRACTS.WPC, fee: 3000, name: "pETH.arb/WPC" },
  { address: "0xF95B20Cf3f2dE495747EB3d33611D0FFEA29F448", token0: "0x76Ad08339dF606BeEDe06f90e3FaF82c5b2fb2E9", token1: CONTRACTS.WPC, fee: 500, name: "USDT.arb/WPC" },
  { address: "0x435875db8a76cCAA9cbf73690C6Dc1913BBC9168", token0: "0x2f98B4235FD2BA0173a2B056D722879360B12E7b", token1: CONTRACTS.WPC, fee: 500, name: "USDT.bnb/WPC" },
  { address: "0x826edC20c926653f4ddC01b8d4C7Df31a403e7d6", token0: "0x7a9082dA308f3fa005beA7dB0d203b3b86664E36", token1: CONTRACTS.WPC, fee: 500, name: "pBNB/WPC", hidden: true },
  { address: "0xF3578f9dEE1591a45366801CedF91B4935997964", token0: "0xa261A10e94aE4bA88EE8c5845CbE7266bD679DD6", token1: CONTRACTS.WPC, fee: 500, name: "USDC.arb/WPC" },
  { address: "0x96Ef417eA20114D86C2a60864a63A69344234930", token0: "0x84B62e44F667F692F7739Ca6040cD17DA02068A8", token1: CONTRACTS.WPC, fee: 500, name: "USDC.base/WPC" },
];

/** Visible tokens (hides internal/mislabelled entries like pBNB). */
export const VISIBLE_TOKENS: TokenInfo[] = TOKENS.filter(t => !t.hidden);

/** Visible pools (same filter). */
export const VISIBLE_POOLS: PoolInfo[] = POOLS.filter(p => !p.hidden);

// ═══ UNISWAP V3 ABIs (minimal) ═══
export const QUOTER_V2_ABI = [
  "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactOutputSingle(tuple(address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
] as const;

export const SWAP_ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function exactInput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
  "function exactOutputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  // PeripheryPaymentsExtended — needed when bundling unwrap/sweep/refund inside a SwapRouter.multicall
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function sweepToken(address token, uint256 amountMinimum, address recipient) payable",
  "function refundETH() payable",
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
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
] as const;

// ═══ NonfungiblePositionManager ABI (Uniswap V3 — add/remove liquidity) ═══
export const POSITION_MANAGER_ABI = [
  // Mint a new liquidity position
  "function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  // Add liquidity to an existing position
  "function increaseLiquidity(tuple(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
  // Remove liquidity from a position
  "function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) returns (uint256 amount0, uint256 amount1)",
  // Collect tokens owed (after decreaseLiquidity or from fees)
  "function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)",
  // Burn an empty position NFT
  "function burn(uint256 tokenId) external",
  // Read a position
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  // ERC721 NFT functions
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function approve(address to, uint256 tokenId) external",
  // Contract references
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
  // Multicall for batching
  "function multicall(bytes[] calldata data) payable returns (bytes[] memory results)",
  // Unwrap WETH9 (WPC) to native after collect
  "function unwrapWETH9(uint256 amountMinimum, address recipient) external payable",
  // Sweep leftover tokens
  "function sweepToken(address token, uint256 amountMinimum, address recipient) external payable",
  // Refund leftover ETH
  "function refundETH() external payable",
  // Operator approval for proxy contracts
  "function setApprovalForAll(address operator, bool approved) external",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
] as const;

// ═══ MoleSwap FeeRouter ABI ═══
export const FEE_ROUTER_ABI = [
  "function swapExactInputSingle(address tokenIn, address tokenOut, uint24 poolFee, uint256 amountIn, uint256 amountOutMinimum, uint256 deadline, uint160 sqrtPriceLimitX96) payable returns (uint256 amountOut)",
  "function swapNativeOutput(address tokenIn, uint24 poolFee, uint256 amountIn, uint256 amountOutMinimum, uint256 deadline, uint160 sqrtPriceLimitX96) returns (uint256 amountOut)",
  "function feeBps() view returns (uint256)",
  "function treasury() view returns (address)",
  "function owner() view returns (address)",
] as const;

// ═══ MoleSwap LiquidityProxy ABI ═══
export const LIQUIDITY_PROXY_ABI = [
  "function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) p) returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function increaseLiquidity(tuple(uint256 tokenId, address token0, address token1, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) p) returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) returns (uint256 amount0, uint256 amount1)",
  "function collect(uint256 tokenId, uint128 amount0Max, uint128 amount1Max) returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId)",
] as const;

// ═══ WETH9 (WPC) ABI ═══
export const WPC_ABI = [
  "function deposit() payable",
  "function withdraw(uint256 wad) external",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
  "function transfer(address, uint256) returns (bool)",
] as const;

// ═══ MoleSwapBridgeHelper ABI (1-sig Solana swaps) ═══
export const BRIDGE_HELPER_ABI = [
  // Single-hop: bridge + swap in one call
  "function bridgeAndSwap(address tokenIn, address tokenOut, uint24 poolFee, uint256 amountIn, uint256 amountOutMin, address recipient, uint256 deadline) returns (uint256 amountOut)",
  // Multi-hop: bridge + swap through WPC hub
  "function bridgeAndSwapMultiHop(address tokenIn, address tokenOut, bytes path, uint256 amountIn, uint256 amountOutMin, address recipient, uint256 deadline) returns (uint256 amountOut)",
  // Native bridge: wrap PC + swap
  "function bridgeNativeAndSwap(address tokenOut, uint24 poolFee, uint256 amountOutMin, address recipient, uint256 deadline) payable returns (uint256 amountOut)",
  // Bridge + swap to native PC
  "function bridgeAndSwapToNative(address tokenIn, uint24 poolFee, uint256 amountIn, uint256 amountOutMin, address recipient, uint256 deadline) returns (uint256 amountOut)",
] as const;

// ═══ Tick math constants ═══
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
// Common tick spacings by fee tier
export const TICK_SPACINGS: Record<number, number> = {
  100: 1,    // 0.01% fee
  500: 10,   // 0.05% fee
  3000: 60,  // 0.3% fee
  10000: 200, // 1% fee
};

// ═══ HELPERS ═══
export const PUSHCHAIN_RPC = "https://evm.donut.rpc.push.org/";
export const PUSHCHAIN_CHAIN_ID = 42101;
export const PUSHCHAIN_EXPLORER = "https://donut.push.network";

export function getTokenByAddress(address: string): TokenInfo | undefined {
  return TOKENS.find(t => t.address.toLowerCase() === address.toLowerCase());
}

export function getTokenBySymbol(symbol: string): TokenInfo | undefined {
  return TOKENS.find(t => t.symbol.toLowerCase() === symbol.toLowerCase());
}

export function findPool(tokenA: string, tokenB: string): PoolInfo | undefined {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  return POOLS.find(p =>
    (p.token0.toLowerCase() === a && p.token1.toLowerCase() === b) ||
    (p.token0.toLowerCase() === b && p.token1.toLowerCase() === a)
  );
}

export function getSwappableTokens(): TokenInfo[] {
  return TOKENS.filter(t => t.swappable !== false);
}
