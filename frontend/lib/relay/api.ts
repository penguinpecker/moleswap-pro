/**
 * Chain & Token API — powered by PushChain AMM
 * Returns real PRC-20 tokens deployed on Push Chain Donut Testnet,
 * grouped by their source chain for a multi-chain UX.
 *
 * All tokens live on PushChain (42101) — the source chain grouping is
 * cosmetic so the token selector feels multi-chain.
 */
import { TOKENS, CONTRACTS, PUSHCHAIN_CHAIN_ID, type TokenInfo } from "@/lib/pushchain/contracts";

export interface RelayCurrency {
  id: string;
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  logoURI?: string;
  sourceChain?: string;
  /**
   * User-facing ticker (e.g. "ETH", "SOL", "USDT"). Falls back to `symbol`
   * if absent. UI components should prefer this to avoid showing users
   * internal names like "pETH" or "USDT.eth".
   */
  displaySymbol?: string;
  /**
   * Subtitle shown under the symbol to disambiguate which chain's ETH/USDT/etc.
   * this is (e.g. "on Push · Ethereum"). Falls back to `name`.
   */
  displaySubtitle?: string;
  /**
   * Origin chain this PRC-20 can be bridged to/from via Push's Universal
   * Gateway. Null for non-bridgeable tokens (e.g. WPC, USDC on any chain).
   * Used by the UI to show per-token origin-chain balances and to trigger
   * the auto bridge-out flow.
   */
  originChainName?: string;
  /** Symbol of the origin-chain asset (e.g. "ETH", "SOL", "USDT"). */
  originSymbol?: string;
  /** Whether this token is bridgeable at all. */
  bridgeable?: boolean;
}

export interface RelayChain {
  id: number;
  name: string;
  displayName: string;
  iconUrl?: string;
  logoUrl?: string;
  vmType?: string;
  currency?: {
    id: string;
    symbol: string;
    name: string;
    address?: string;
    decimals: number;
    displaySymbol?: string;
    displaySubtitle?: string;
  };
  erc20Currencies?: RelayCurrency[];
  featuredTokens?: (RelayCurrency & { metadata?: { logoURI?: string } })[];
}

// Source chain metadata for the network selector
const SOURCE_CHAINS: Record<string, { displayName: string; icon: string; order: number }> = {
  "Push Chain": { displayName: "Push Chain", icon: "/push-chain-logo.png", order: 0 },
  "Ethereum":   { displayName: "Ethereum",   icon: "https://assets.coingecko.com/coins/images/279/small/ethereum.png", order: 1 },
  "Base":       { displayName: "Base",       icon: "https://icons.llamao.fi/icons/chains/rsz_base.jpg", order: 2 },
  "Arbitrum":   { displayName: "Arbitrum",   icon: "https://assets.coingecko.com/coins/images/16547/small/photo_2023-03-29_21.47.00.jpeg", order: 3 },
  "BNB Chain":  { displayName: "BNB Chain",  icon: "https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png", order: 4 },
  "Solana":     { displayName: "Solana",     icon: "https://assets.coingecko.com/coins/images/4128/small/solana.png", order: 5 },
};

export async function getChains(): Promise<RelayChain[]> {
  // Filter out `hidden:true` tokens (e.g. the legacy "pBNB" entry which is
  // actually pETH_BNB per the SDK and confuses users). Also keep the existing
  // `swappable !== false` filter.
  const swappable = TOKENS.filter(t => t.swappable !== false && !t.hidden);

  // Group tokens by sourceChain
  const groups: Record<string, TokenInfo[]> = {};
  for (const t of swappable) {
    const chain = t.sourceChain || "Push Chain";
    if (!groups[chain]) groups[chain] = [];
    groups[chain].push(t);
  }

  // Build a virtual "chain" entry per source chain, all with real chainId = 42101
  const chains: RelayChain[] = [];
  for (const [chainName, tokens] of Object.entries(groups)) {
    const meta = SOURCE_CHAINS[chainName] || { displayName: chainName, icon: "/push-chain-logo.png", order: 99 };
    chains.push({
      id: PUSHCHAIN_CHAIN_ID,  // All tokens are on PushChain — swap routing stays the same
      name: chainName,
      displayName: meta.displayName,
      iconUrl: meta.icon,
      logoUrl: meta.icon,
      vmType: "evm",
      currency: chainName === "Push Chain" ? {
        id: "pc",
        symbol: "PC",
        name: "Push Chain",
        address: "0x0000000000000000000000000000000000000000",
        decimals: 18,
        displaySymbol: "PC",
        displaySubtitle: "Push Chain native",
      } : undefined,
      featuredTokens: tokens.map((t) => ({
        id: t.address,
        symbol: t.symbol,
        name: t.name,
        address: t.address,
        decimals: t.decimals,
        logoURI: t.logoURI,
        sourceChain: t.sourceChain,
        metadata: { logoURI: t.logoURI },
        // Propagate display + bridge fields so UI can render real asset names
        // and offer the auto bridge-in/out flows. Null when absent on TokenInfo.
        displaySymbol: t.displaySymbol,
        displaySubtitle: t.displaySubtitle,
        originChainName: t.sourceChain,
        originSymbol: t.originSymbol,
        bridgeable: t.bridgeable,
      })),
    });
  }

  // Sort by defined order
  chains.sort((a, b) => {
    const oa = SOURCE_CHAINS[a.name]?.order ?? 99;
    const ob = SOURCE_CHAINS[b.name]?.order ?? 99;
    return oa - ob;
  });

  return chains;
}

export function getTokensForChain(chain: RelayChain): RelayCurrency[] {
  return (chain.featuredTokens || []).map((t) => ({
    id: t.address,
    symbol: t.symbol,
    name: t.name,
    address: t.address,
    decimals: t.decimals,
    logoURI: t.metadata?.logoURI || t.logoURI,
    sourceChain: (t as any).sourceChain,
    displaySymbol: (t as any).displaySymbol,
    displaySubtitle: (t as any).displaySubtitle,
    originChainName: (t as any).originChainName,
    originSymbol: (t as any).originSymbol,
    bridgeable: (t as any).bridgeable,
  }));
}
