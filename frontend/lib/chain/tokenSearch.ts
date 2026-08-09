/**
 * tokenSearch.ts — search the whole-chain token index and detect what the connected wallet holds.
 *
 * The index (`mp_tokens`, populated from every executable factory's PoolCreated logs) is the name/symbol
 * lookup the on-chain address-paste import can't provide. `searchIndex` queries it; `heldTokens` reads the
 * user's live balance across the indexed universe via one Multicall3 batch so the picker can surface the
 * tokens they actually own on Robinhood Chain.
 */
import { createPublicClient, http, type Address } from "viem";
import { robinhoodChain, ROBINHOOD_RPC_URL } from "@/lib/mole/chain";
import { createClient } from "@/lib/supabase/client";
import { tokenFallbackIcon } from "@/lib/chain/tokenList";
import { getTokenByAddress } from "@/lib/chain/contracts";

export interface IndexedToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI: string;
  displaySymbol: string;
  displaySubtitle: string;
  isStable?: boolean;
  sourceChain: string;
  /** Has meaningful pool liquidity (>= ~0.05 WETH). Junk/dead tokens are unverified. */
  verified?: boolean;
  /** Best-pool liquidity in WETH-equivalent, for ranking. */
  liquidity?: number;
}

function rpcUrl() {
  return (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) || ROBINHOOD_RPC_URL;
}
function client() {
  return createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl()) });
}

function toEntry(row: { address: string; symbol: string; name: string; decimals: number; logo_url?: string | null; is_stable?: boolean; verified?: boolean; liquidity?: number }): IndexedToken {
  const curated = getTokenByAddress(row.address);
  const logo = curated?.logoURI || row.logo_url || tokenFallbackIcon(row.address, row.symbol);
  return {
    address: row.address,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    logoURI: logo,
    displaySymbol: row.symbol,
    displaySubtitle: row.name && row.name !== row.symbol ? row.name : "Robinhood Chain",
    isStable: row.is_stable,
    sourceChain: "Robinhood Chain",
    verified: !!curated || !!row.verified,
    liquidity: Number(row.liquidity ?? 0),
  };
}

const SELECT_COLS = "address,symbol,name,decimals,logo_url,is_stable,verified,liquidity";

/**
 * Name/symbol search over the Robinhood Chain VERIFIED token list — the tokens with real RH pool
 * liquidity (this chain's equivalent of Uniswap's curated Token List, derived from RH's own pools
 * because a new chain has no external list to import). Junk/dead tokens are excluded from name search;
 * they remain reachable by pasting their contract address (a live on-chain import, no index needed).
 *
 * `includeUnverified` opens it up to the full index (used only if the caller wants a "show all" mode).
 */
export async function searchIndex(query: string, limit = 40, includeUnverified = false): Promise<IndexedToken[]> {
  const q = query.trim();
  if (q.length < 1) return [];
  try {
    const sb = createClient();
    const esc = q.replace(/[%,()*]/g, " ").trim();
    if (!esc) return [];
    let sel = sb
      .from("mp_tokens")
      .select(SELECT_COLS)
      .or(`symbol.ilike.%${esc}%,name.ilike.%${esc}%,address.ilike.%${esc}%`);
    if (!includeUnverified) sel = sel.eq("verified", true);
    const { data } = await sel
      .order("verified", { ascending: false })
      .order("liquidity", { ascending: false })
      .limit(limit);
    const rows = (data as any[]) || [];
    const ql = esc.toLowerCase();
    // Verified first, then exact/prefix symbol match, then liquidity.
    rows.sort((a, b) => {
      if (!!a.verified !== !!b.verified) return a.verified ? -1 : 1;
      const ax = a.symbol?.toLowerCase() === ql ? 0 : a.symbol?.toLowerCase().startsWith(ql) ? 1 : 2;
      const bx = b.symbol?.toLowerCase() === ql ? 0 : b.symbol?.toLowerCase().startsWith(ql) ? 1 : 2;
      return ax - bx || (Number(b.liquidity ?? 0) - Number(a.liquidity ?? 0));
    });
    return rows.map(toEntry);
  } catch {
    return [];
  }
}

/**
 * The default picker list: the most liquid verified tokens on the chain (Uniswap/Jupiter-style
 * "verified" list), most-liquid first. Cached for the session.
 */
let _popularCache: { at: number; rows: IndexedToken[] } | null = null;
export async function popularTokens(limit = 30): Promise<IndexedToken[]> {
  if (_popularCache && Date.now() - _popularCache.at < 300_000) return _popularCache.rows;
  try {
    const sb = createClient();
    const { data } = await sb
      .from("mp_tokens")
      .select(SELECT_COLS)
      .eq("verified", true)
      .order("liquidity", { ascending: false })
      .limit(limit);
    const rows = ((data as any[]) || []).map(toEntry);
    _popularCache = { at: Date.now(), rows };
    return rows;
  } catch {
    return _popularCache?.rows ?? [];
  }
}

export interface HeldToken extends IndexedToken {
  balanceRaw: bigint;
  balance: string; // human, trimmed
}

function humanize(raw: bigint, decimals: number): string {
  const s = raw.toString();
  const pad = decimals - Math.min(decimals, s.length);
  const full = pad > 0 ? "0".repeat(pad) + s : s;
  const i = full.slice(0, full.length - decimals) || "0";
  const f = full.slice(-decimals).replace(/0+$/, "").slice(0, 6);
  return f ? `${i}.${f}` : i;
}

const symbolAbi = [{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const;
const decimalsAbi = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;

/**
 * The tokens the wallet actually holds on Robinhood Chain. With ~258k tokens on chain, a balanceOf sweep
 * is infeasible, so this uses Alchemy's `alchemy_getTokenBalances` (one call → every non-zero ERC-20
 * balance) plus native ETH, then resolves metadata for just those few tokens from the mp_tokens index
 * (falling back to on-chain reads for anything unindexed).
 */
export async function heldTokens(user: string): Promise<HeldToken[]> {
  if (!user) return [];
  const c = client();
  const held: HeldToken[] = [];

  // Native ETH first.
  try {
    const bal = await c.getBalance({ address: user as Address });
    if (bal > 0n) {
      const eth = getTokenByAddress("0x0000000000000000000000000000000000000000");
      held.push({
        address: "0x0000000000000000000000000000000000000000",
        symbol: "ETH", name: "Ether", decimals: 18,
        logoURI: eth?.logoURI || "/tokens/eth.svg",
        displaySymbol: "ETH", displaySubtitle: "Robinhood Chain",
        sourceChain: "Robinhood Chain",
        balanceRaw: bal, balance: humanize(bal, 18),
      });
    }
  } catch {}

  // Every non-zero ERC-20 balance in one Alchemy call.
  let balances: { address: string; raw: bigint }[] = [];
  try {
    const res = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getTokenBalances", params: [user, "erc20"] }),
    });
    const j = await res.json();
    for (const t of j?.result?.tokenBalances ?? []) {
      const raw = BigInt(t.tokenBalance || "0x0");
      if (raw > 0n) balances.push({ address: (t.contractAddress as string).toLowerCase(), raw });
    }
  } catch {
    return held; // native-only if the enhanced method is unavailable
  }
  if (balances.length === 0) return held;

  // Resolve metadata from the index in one query; fall back to on-chain for any misses.
  const byAddr = new Map<string, any>();
  try {
    const sb = createClient();
    const { data } = await sb
      .from("mp_tokens")
      .select("address,symbol,name,decimals,logo_url,is_stable")
      .in("address", balances.map((b) => b.address));
    for (const r of (data as any[]) || []) byAddr.set(r.address.toLowerCase(), r);
  } catch {}

  for (const b of balances) {
    let meta = byAddr.get(b.address);
    if (!meta) {
      try {
        const [sym, dec] = await Promise.all([
          c.readContract({ address: b.address as Address, abi: symbolAbi, functionName: "symbol" }).catch(() => b.address.slice(0, 8)),
          c.readContract({ address: b.address as Address, abi: decimalsAbi, functionName: "decimals" }).catch(() => 18),
        ]);
        meta = { address: b.address, symbol: String(sym), name: String(sym), decimals: Number(dec) };
      } catch {
        meta = { address: b.address, symbol: b.address.slice(0, 8), name: b.address.slice(0, 8), decimals: 18 };
      }
    }
    held.push({ ...toEntry(meta), balanceRaw: b.raw, balance: humanize(b.raw, meta.decimals) });
  }

  held.sort((a, b) => (a.isStable === b.isStable ? 0 : a.isStable ? -1 : 1) || (b.balanceRaw > a.balanceRaw ? 1 : -1));
  return held;
}
