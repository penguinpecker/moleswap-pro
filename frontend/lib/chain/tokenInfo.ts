/**
 * tokenInfo.ts — live market data for Robinhood Chain tokens from DexScreener (which indexes chainId
 * "robinhood"). One batched call (up to 30 addresses) returns each token's real logo, price, liquidity,
 * market cap, 24h volume/change, and a DexScreener link — everything the picker rows show beyond the name.
 *
 * On-demand + cached: the picker enriches only the ~visible rows, so a search costs one or two requests.
 */

export interface TokenMarketInfo {
  address: string;
  logo?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  marketCap?: number;
  volume24?: number;
  priceChange24?: number;
  dexUrl?: string;
  /**
   * Whether the project has actually filled in its DexScreener listing — a website, socials or a
   * banner. It proves nothing about the contract, but a token with real backing almost always has
   * it and a throwaway drainer almost never does, so it is a useful (not sufficient) risk signal.
   */
  hasProjectInfo?: boolean;
  /** Age of the token's deepest pair. Brand-new pairs carry most of the rug risk. */
  pairCreatedAt?: number;
}

const DEX = "https://api.dexscreener.com/latest/dex/tokens/";
const TTL = 120_000;
const cache = new Map<string, { at: number; info: TokenMarketInfo | null }>();

/** Batch-fetch market info for `addresses`. Cached per-address for TTL; returns only the resolved ones. */
export async function fetchTokenInfo(addresses: string[]): Promise<Map<string, TokenMarketInfo>> {
  const out = new Map<string, TokenMarketInfo>();
  const need: string[] = [];
  const now = Date.now();
  for (const a of addresses) {
    const lc = (a || "").toLowerCase();
    if (!lc) continue;
    const c = cache.get(lc);
    if (c && now - c.at < TTL) {
      if (c.info) out.set(lc, c.info);
    } else if (!need.includes(lc)) {
      need.push(lc);
    }
  }

  for (let i = 0; i < need.length; i += 30) {
    const chunk = need.slice(i, i + 30);
    try {
      const res = await fetch(DEX + chunk.join(","), { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const j = await res.json();
      // Keep the deepest robinhood pair per base token.
      const best = new Map<string, any>();
      for (const p of j?.pairs || []) {
        if (p?.chainId !== "robinhood") continue;
        const b = p?.baseToken?.address?.toLowerCase();
        if (!b) continue;
        const liq = p?.liquidity?.usd || 0;
        const prev = best.get(b);
        if (!prev || liq > (prev.liquidity?.usd || 0)) best.set(b, p);
      }
      for (const a of chunk) {
        const p = best.get(a);
        const info: TokenMarketInfo | null = p
          ? {
              address: a,
              logo: p.info?.imageUrl || undefined,
              priceUsd: p.priceUsd ? Number(p.priceUsd) : undefined,
              liquidityUsd: p.liquidity?.usd,
              marketCap: p.marketCap ?? p.fdv,
              volume24: p.volume?.h24,
              priceChange24: p.priceChange?.h24,
              dexUrl: p.url,
              hasProjectInfo: !!(
                p.info?.websites?.length ||
                p.info?.socials?.length ||
                p.info?.header ||
                p.info?.openGraph
              ),
              pairCreatedAt: p.pairCreatedAt || undefined,
            }
          : null;
        cache.set(a, { at: Date.now(), info });
        if (info) out.set(a, info);
      }
    } catch {
      // leave these unresolved; a later render retries
    }
  }
  return out;
}

/** Compact USD ("$131M", "$4.8M", "$12.3K", "$0.00"). */
export function fmtUsd(n?: number): string {
  if (n === undefined || n === null || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(2)}`;
}

export function shortAddr(a?: string): string {
  return a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "";
}
