/**
 * abi.ts — minimal viem-style ABIs for the MolePositions vault
 * (proxy 0x674625B6E6a2614ef6e247aF099BEA2e65e1536A on Robinhood Chain 4663).
 *
 * Shapes are derived directly from src/MolePositions.sol in this repo — not guessed:
 *   - `PoolKey`  : { Currency currency0; Currency currency1; uint24 fee; int24 tickSpacing; IHooks hooks }
 *                  (Currency and IHooks are both address-typed wrappers)
 *   - `ZapParams`: { PoolKey key; int24 tickLower; int24 tickUpper; bool zeroForOne;
 *                    uint256 amountIn; uint256 swapAmount; uint128 minLiquidity }
 *   - `Position` : { address owner; PoolId poolId; int24 tickLower; int24 tickUpper;
 *                    uint128 liquidity; uint64 openedAtL1Block; uint64 lastRebalancedAt }
 *                  (PoolId is a bytes32 wrapper)
 *
 * Notes for callers:
 *   - The owner-position enumerator is `positionsOf(address)`. There is no external
 *     `ownerPositions` accessor in the contract; the storage mapping is private.
 *   - `open` / `zapOpen` pull tokens with transferFrom, so the UI must first obtain an
 *     ERC-20 allowance on the token for the VAULT address — see `erc20Abi` below.
 *   - viem decodes int24 fields as `number` and uint64/uint128/uint256 as `bigint`.
 */

const POOL_KEY_COMPONENTS = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

export const molePositionsAbi = [
  /* ------------------------------------------------------------- writes */
  {
    type: "function",
    name: "open",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "tuple", components: POOL_KEY_COMPONENTS },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0Max", type: "uint256" },
      { name: "amount1Max", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "zapOpen",
    // payable on-chain (accepts native ETH); the ZapParams tuple carries amountOutMin — the REAL swap
    // slippage bound. Omitting it (as an earlier ABI did) changes the selector and every deposit reverts.
    stateMutability: "payable",
    inputs: [
      {
        name: "z",
        type: "tuple",
        components: [
          { name: "key", type: "tuple", components: POOL_KEY_COMPONENTS },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint256" },
          { name: "swapAmount", type: "uint256" },
          { name: "minLiquidity", type: "uint128" },
          { name: "amountOutMin", type: "uint256" },
        ],
      },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "liquidityToRemove", type: "uint128" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawAll",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    // The exit WITH a floor. Not an overload of `withdraw` — the contract gave it its own name so that
    // `withdraw.selector` stays unambiguous for integrators, so the name here must match exactly or the
    // call encodes to a selector that exists nowhere. Passing (0, 0) makes it identical to `withdraw`;
    // the numbers that make it worth calling come from ./withdrawPlan.
    type: "function",
    name: "withdrawWithMinimums",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "liquidityToRemove", type: "uint128" },
      { name: "amount0Min", type: "uint256" },
      { name: "amount1Min", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setKeeperRevoked",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "revoked", type: "bool" },
    ],
    outputs: [],
  },
  /* -------------------------------------------------------------- views */
  {
    type: "function",
    name: "getPosition",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "poolId", type: "bytes32" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "liquidity", type: "uint128" },
          { name: "openedAtL1Block", type: "uint64" },
          { name: "lastRebalancedAt", type: "uint64" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "positionsOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "isWhitelisted",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "performanceFeeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "keeperRevoked",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * Minimal ERC-20 surface the UI needs around deposits: `open`/`zapOpen` pull tokens
 * via transferFrom, so the vault must be approved on the token first.
 */
export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;
