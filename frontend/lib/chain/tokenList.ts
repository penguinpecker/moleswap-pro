/**
 * Chain & Token API — Robinhood Chain (4663).
 *
 * The token selector was originally multi-chain (grouped by origin). MoleSwap runs on one chain now,
 * so this returns a single "Robinhood Chain" entry whose tokens are the indexed universe (ETH, WETH,
 * USDG). Interfaces are unchanged so the exchange/swap screens consume it exactly as before.
 */
import { TOKENS, RH_CHAIN_ID, type TokenInfo } from "@/lib/chain/contracts";

export interface TokenEntry {
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

export interface ChainEntry {
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
  erc20Currencies?: TokenEntry[];
  featuredTokens?: (TokenEntry & { metadata?: { logoURI?: string } })[];
}

const RH_ICON = "/tokens/rh.svg";

/**
 * Deterministic per-token identicon for tokens without a hosted logo: a colored
 * coin with the symbol's first letters, hue derived from the address. Rendered
 * as an inline SVG data URI so it needs no asset and never 404s. This replaces
 * the old behaviour of showing the ETH logo for every unknown token, which
 * made imported tokens indistinguishable from ETH.
 */
export function tokenFallbackIcon(address?: string | null, symbol?: string | null): string {
  const addr = (address || "0x0").toLowerCase();
  let h = 0;
  for (let i = 2; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const label = (symbol || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "?";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">` +
    `<rect width="48" height="48" rx="10" fill="hsl(${hue},55%,28%)"/>` +
    `<rect x="3" y="3" width="42" height="42" rx="8" fill="hsl(${hue},65%,42%)"/>` +
    `<text x="24" y="30" font-family="monospace" font-size="${label.length > 2 ? 14 : 18}" font-weight="bold" fill="#fff" text-anchor="middle">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export async function getChains(): Promise<ChainEntry[]> {
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
      id: RH_CHAIN_ID,
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

export function getTokensForChain(chain: ChainEntry): TokenEntry[] {
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
