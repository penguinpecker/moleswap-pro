/**
 * PRC-20 ↔ Origin Chain Bridge Map
 * ─────────────────────────────────────────────────────────────────────────
 * Maps each Push Chain PRC-20 (synthetic token) to its origin-chain asset.
 *
 * When a user's wallet origin matches a token's origin chain, we can inject
 * `funds: { amount, token }` into the swap's first step — the SDK will then
 * auto-bridge the origin asset into the user's UEA as part of the same tx.
 *
 * This is how RamenFi achieves the "connect Phantom, swap SOL directly" UX:
 * instead of requiring the user to pre-bridge SOL → pSOL, the swap's first
 * step carries `funds: { token: MOVEABLE.TOKEN.SOLANA_DEVNET.SOL }` and the
 * SDK handles both the lock-on-Solana and mint-on-Push atomically.
 *
 * The values in this map come directly from @pushchain/core's
 * `PushChain.utils.tokens.getPRC20Address()`. DO NOT guess these — they are
 * deterministic derivations from the origin chain + origin token address
 * registered in the SDK. Adding a token here only works if the SDK itself
 * recognizes the mapping.
 *
 * Regenerate this map whenever @pushchain/core is upgraded:
 *   scripts/regenerate-prc20-map.mjs  (see docs)
 */

export interface Prc20BridgeInfo {
  /** Push Chain PRC-20 address (checksummed) */
  prc20Address: `0x${string}`;
  /** CAIP-style origin chain identifier, e.g. "eip155:11155111" or "solana:EtWTRAB..." */
  originChain: string;
  /** SDK constant name, e.g. "ETHEREUM_SEPOLIA", used as a lookup key into MOVEABLE.TOKEN */
  originChainSdkName: "ETHEREUM_SEPOLIA" | "ARBITRUM_SEPOLIA" | "BASE_SEPOLIA" | "BNB_TESTNET" | "SOLANA_DEVNET";
  /** Canonical token symbol on the origin chain, e.g. "ETH", "USDT", "SOL" — used as the key into MOVEABLE.TOKEN.{CHAIN} */
  originSymbol: "ETH" | "SOL" | "USDT" | "USDC" | "WETH" | "stETH";
  /** Number of decimals on the origin chain (may differ from PRC-20 decimals) */
  originDecimals: number;
  /** Origin address — for native tokens this is `0x0000...0000`, for ERC-20 it's the contract, for SPL it's the mint string */
  originAddress: string;
  /** How the Universal Gateway moves the asset: 'native' for ETH/SOL, 'approve' for ERC-20/SPL */
  mechanism: "approve" | "permit2" | "native";
  /** Human label for the UI selector (e.g. "Ethereum", "Solana") */
  uiLabel: string;
}

/**
 * Keyed by PRC-20 address (always lowercased for O(1) lookup).
 * Generated from @pushchain/core v5.1.2 SDK constants.
 */
export const PRC20_BRIDGE_MAP: Record<string, Prc20BridgeInfo> = {
  // ─── Ethereum Sepolia ─────────────────────────────────────────────────
  "0x2971824db68229d087931155c2b8bb820b275809": {
    prc20Address: "0x2971824Db68229D087931155C2b8bB820B275809",
    originChain: "eip155:11155111",
    originChainSdkName: "ETHEREUM_SEPOLIA",
    originSymbol: "ETH",
    originDecimals: 18,
    originAddress: "0x0000000000000000000000000000000000000000",
    mechanism: "native",
    uiLabel: "Ethereum",
  },
  "0xca0c5e6f002a389e1580f0db7cd06e4549b5f9d3": {
    prc20Address: "0xCA0C5E6F002A389E1580F0DB7cd06e4549B5F9d3",
    originChain: "eip155:11155111",
    originChainSdkName: "ETHEREUM_SEPOLIA",
    originSymbol: "USDT",
    originDecimals: 6,
    originAddress: "0x7169D38820dfd117C3FA1f22a697dBA58d90BA06",
    mechanism: "approve",
    uiLabel: "Ethereum",
  },

  // ─── Arbitrum Sepolia ─────────────────────────────────────────────────
  "0xc0a821a1afed1322c5e15f1f4586c0b8ce65400e": {
    prc20Address: "0xc0a821a1AfEd1322c5e15f1F4586C0B8cE65400e",
    originChain: "eip155:421614",
    originChainSdkName: "ARBITRUM_SEPOLIA",
    originSymbol: "ETH",
    originDecimals: 18,
    originAddress: "0x0000000000000000000000000000000000000000",
    mechanism: "native",
    uiLabel: "Arbitrum",
  },
  "0x76ad08339df606beede06f90e3faf82c5b2fb2e9": {
    prc20Address: "0x76Ad08339dF606BeEDe06f90e3FaF82c5b2fb2E9",
    originChain: "eip155:421614",
    originChainSdkName: "ARBITRUM_SEPOLIA",
    originSymbol: "USDT",
    originDecimals: 6,
    originAddress: "0x1419d7C74D234fA6B73E06A2ce7822C1d37922f0",
    mechanism: "approve",
    uiLabel: "Arbitrum",
  },

  // ─── Base Sepolia ─────────────────────────────────────────────────────
  "0xc7007af2b24d4eb963fc9633b0c66e1d2d90fc21": {
    prc20Address: "0xc7007af2B24D4eb963fc9633B0c66e1d2D90Fc21",
    originChain: "eip155:84532",
    originChainSdkName: "BASE_SEPOLIA",
    originSymbol: "ETH",
    originDecimals: 18,
    originAddress: "0x0000000000000000000000000000000000000000",
    mechanism: "native",
    uiLabel: "Base",
  },
  "0x2c455189d2af6643b924a981a9080ccc63d5a567": {
    prc20Address: "0x2C455189D2af6643B924A981a9080CcC63d5a567",
    originChain: "eip155:84532",
    originChainSdkName: "BASE_SEPOLIA",
    originSymbol: "USDT",
    originDecimals: 6,
    originAddress: "0x9FF5a186f53F6E6964B00320Da1D2024DE11E0cB",
    mechanism: "approve",
    uiLabel: "Base",
  },

  // ─── BNB Testnet ──────────────────────────────────────────────────────
  "0x7a9082da308f3fa005bea7db0d203b3b86664e36": {
    prc20Address: "0x7a9082dA308f3fa005beA7dB0d203b3b86664E36",
    originChain: "eip155:97",
    originChainSdkName: "BNB_TESTNET",
    originSymbol: "ETH",
    originDecimals: 18,
    originAddress: "0x0000000000000000000000000000000000000000",
    mechanism: "native",
    uiLabel: "BNB Chain",
  },
  "0x2f98b4235fd2ba0173a2b056d722879360b12e7b": {
    prc20Address: "0x2f98B4235FD2BA0173a2B056D722879360B12E7b",
    originChain: "eip155:97",
    originChainSdkName: "BNB_TESTNET",
    originSymbol: "USDT",
    originDecimals: 6,
    originAddress: "0xBC14F348BC9667be46b35Edc9B68653d86013DC5",
    mechanism: "approve",
    uiLabel: "BNB Chain",
  },

  // ─── Solana Devnet ────────────────────────────────────────────────────
  "0x5d525df2bd99a6e7ec58b76af2fd95f39874ebed": {
    prc20Address: "0x5D525Df2bD99a6e7ec58b76aF2fd95F39874EBed",
    originChain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    originChainSdkName: "SOLANA_DEVNET",
    originSymbol: "SOL",
    originDecimals: 9,
    originAddress: "0x0000000000000000000000000000000000000000",
    mechanism: "native",
    uiLabel: "Solana",
  },
  "0x4f1a3d22d170a2f4bddb37845a962322e24f4e34": {
    prc20Address: "0x4f1A3D22d170a2F4Bddb37845a962322e24f4e34",
    originChain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    originChainSdkName: "SOLANA_DEVNET",
    originSymbol: "USDT",
    originDecimals: 6,
    originAddress: "EiXDnrAg9ea2Q6vEPV7E5TpTU1vh41jcuZqKjU5Dc4ZF",
    mechanism: "approve",
    uiLabel: "Solana",
  },
};

/**
 * Look up bridge info for a PRC-20 address. Returns null if the token isn't
 * officially bridge-able via Push Chain's Universal Gateway yet (e.g. USDC
 * doesn't have a PRC-20 mapping in the SDK as of v5.1.2 — bridging USDC will
 * fail until the SDK ships the mapping).
 */
export function getBridgeInfoForPrc20(prc20Address: string): Prc20BridgeInfo | null {
  if (!prc20Address) return null;
  const key = prc20Address.toLowerCase();
  return PRC20_BRIDGE_MAP[key] || null;
}

/**
 * Does the user's connected origin chain match this PRC-20's origin chain?
 * If yes, we can inject `funds: { token: MOVEABLE.TOKEN.X.Y }` and the SDK
 * will auto-bridge the origin asset as part of the swap (1-sig cross-chain
 * swap from any supported wallet).
 *
 * Example: user is on Phantom (origin=Solana), selects pSOL as fromToken.
 *   → bridge.originChain === user's originChain → YES, inject funds for SOL
 *
 * Example: user is on MetaMask Sepolia (origin=eip155:11155111), selects pSOL.
 *   → bridge.originChain (Solana) !== user's originChain (Sepolia) → NO,
 *     user must already hold pSOL on Push Chain; direct swap works
 *     (they'd have bridged earlier via a separate funds-only tx).
 */
export function canAutoBridgeFrom(
  prc20Address: string,
  userOriginChain: string | null | undefined,
): boolean {
  if (!userOriginChain) return false;
  const bridge = getBridgeInfoForPrc20(prc20Address);
  if (!bridge) return false;
  return bridge.originChain.toLowerCase() === userOriginChain.toLowerCase();
}

/**
 * Resolve the SDK's MOVEABLE.TOKEN constant for a given PRC-20, if we have it.
 * The caller passes `PushChain.CONSTANTS.MOVEABLE.TOKEN` since we can't
 * import @pushchain/core at module-load time from some bundlers.
 *
 * Returns the actual MoveableToken object (with { symbol, decimals, address,
 * mechanism }) that the SDK's sendTransaction expects under `funds.token`.
 */
export function getSdkMoveableToken(
  prc20Address: string,
  moveableTokenConstants: any,
): any | null {
  const bridge = getBridgeInfoForPrc20(prc20Address);
  if (!bridge) return null;
  try {
    const chainAccessor = moveableTokenConstants?.[bridge.originChainSdkName];
    if (!chainAccessor) return null;
    return chainAccessor[bridge.originSymbol] || null;
  } catch {
    return null;
  }
}
