/**
 * Chain & Token API — Robinhood Chain (4663).
 *
 * The token selector was originally multi-chain (grouped by origin). MoleSwap runs on one chain now,
 * so this returns a single "Robinhood Chain" entry whose tokens are the indexed universe (ETH, WETH,
 * USDG). Interfaces are unchanged so the exchange/swap screens consume it exactly as before.
 */
import { TOKENS, PUSHCHAIN_CHAIN_ID, type TokenInfo } from "@/lib/pushchain/contracts";

export interface RelayCurrency {
  id: string;
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  logoURI?: string;
  sourceChain?: string;
  displaySymbol?: string;
  displaySubtitle?: string;
  originChainName?: string;
  originSymbol?: string;
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

const RH_ICON = "/tokens/eth.svg";

export async function getChains(): Promise<RelayChain[]> {
  const swappable = TOKENS.filter((t) => t.swappable !== false && !t.hidden);

  const featuredTokens = swappable.map((t: TokenInfo) => ({
    id: t.address,
    symbol: t.symbol,
    name: t.name,
    address: t.address,
    decimals: t.decimals,
    logoURI: t.logoURI,
    sourceChain: t.sourceChain,
    metadata: { logoURI: t.logoURI },
    displaySymbol: t.displaySymbol,
    displaySubtitle: t.displaySubtitle,
    originChainName: t.sourceChain,
    originSymbol: t.originSymbol,
    bridgeable: t.bridgeable,
  }));

  return [
    {
      id: PUSHCHAIN_CHAIN_ID,
      name: "Robinhood Chain",
      displayName: "Robinhood Chain",
      iconUrl: RH_ICON,
      logoUrl: RH_ICON,
      vmType: "evm",
      currency: {
        id: "eth",
        symbol: "ETH",
        name: "Ether",
        address: "0x0000000000000000000000000000000000000000",
        decimals: 18,
        displaySymbol: "ETH",
        displaySubtitle: "Robinhood Chain",
      },
      featuredTokens,
    },
  ];
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
