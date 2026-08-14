import { createClient } from "@supabase/supabase-js";
import type { PoolRow } from "./client";
import { USDG } from "../mole/chain";

/**
 * Loading the `mp_pools` registry.
 *
 * HOW THIS BROKE, AND WHY THE SHAPE CHANGED. Both loaders (this one and `loadPoolRows` in
 * lib/chain/amm.ts) used to answer the question "give me the pool registry" by selecting the whole
 * table. That worked when the registry was small. It is now ~94k active rows: PostgREST caps an
 * unranged select at 1000, and paging through the rest costs ~0.5-3s PER PAGE against a 3s
 * statement_timeout on the `anon` role — measured, not assumed — so a full load either times out
 * halfway or takes half a minute. The old paging loop collapsed `error` and "end of data" into the same
 * `break` and then cached whatever it had as the complete, authoritative registry for 30s, which is how
 * a database timeout turned into a confident quote built on a fraction of the venues.
 *
 * The registry is only ever consulted for ONE question: which pools can sit on a route between two
 * tokens? So ask the database that question instead of downloading the table. A pair-scoped query
 * returns ~40-90 rows in ~150-600ms, which is both correct and faster than the truncated select it
 * replaces.
 *
 * THIS MATTERS MOST FOR v4. A v4 pool has no address, so it can never be found by asking a factory for
 * one — the on-chain discovery probe (discover.ts) rescues v3 and only v3. Every v4 pool is reachable
 * ONLY through these registry rows, and v4 is ~85% of the registry, so truncation silently deleted the
 * venue class that has no fallback.
 */

const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/** The pair a quote is being built for. `weth` is the hub the router 2-hops through. */
export interface PoolPair {
  tokenIn: string;
  tokenOut: string;
  weth: string;
}

/** A Supabase client (browser or server); both expose `.from()`, which is all this needs. */
export type PoolRegistryClient = { from: (table: string) => any };

const lc = (a: string) => (a || "").toLowerCase();

/**
 * The tokens whose pools can appear on a route between `tokenIn` and `tokenOut`.
 *
 * Mirrors exactly what client.ts keeps after loading: the direct pair, both WETH hub legs (2-hop), and
 * — for MoleHook v4 — the USDG legs as well. Native markers resolve to WETH, since that is the token the
 * pools are actually denominated in.
 */
export function poolPairTokens(pair: PoolPair): string[] {
  const w = lc(pair.weth);
  const resolve = (a: string) => {
    const x = lc(a);
    return x === "" || x === ZERO || x === NATIVE_SENTINEL || x === "native" || x === "eth" ? w : x;
  };
  return [...new Set([resolve(pair.tokenIn), resolve(pair.tokenOut), w, lc(USDG.address)])];
}

/**
 * A PostgREST `or()` expression matching every pool whose two tokens are both drawn from
 * {tokenIn, tokenOut, WETH, USDG} — i.e. every pool that could carry this route, and nothing else.
 *
 * Written as explicit `and(token0.eq.X,token1.eq.Y)` pairs in both column orders rather than two `in.()`
 * filters: the pair form is what the planner handles best on this table (no index on token0/token1 yet),
 * and it cannot accidentally match a pool that merely touches one of these tokens.
 */
export function poolPairOrFilter(pair: PoolPair): string {
  const tokens = poolPairTokens(pair);
  const clauses: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      const a = tokens[i]!;
      const b = tokens[j]!;
      clauses.push(`and(token0.eq.${a},token1.eq.${b})`);
      clauses.push(`and(token0.eq.${b},token1.eq.${a})`);
    }
  }
  return clauses.join(",");
}

/** Page size; PostgREST caps a single response at 1000 rows regardless of what we ask for. */
const PAGE = 1000;
/** A pair with more pools than this is pathological; client.ts caps the state fetch at 48 anyway. */
const MAX_PAIR_ROWS = 4000;

/**
 * Every ACTIVE registry row that can carry a route for this pair, complete — no silent truncation.
 *
 * Throws on a database error rather than returning a short list. A short list is indistinguishable from
 * "this pair has few pools", and that indistinguishability is the whole bug: the caller has to be able
 * to tell "the registry says there are 3 pools" from "the registry did not answer".
 */
export async function fetchPoolRowsByPair(
  sb: PoolRegistryClient,
  pair: PoolPair,
): Promise<PoolRow[]> {
  const or = poolPairOrFilter(pair);
  const rows: PoolRow[] = [];
  for (let from = 0; from < MAX_PAIR_ROWS; from += PAGE) {
    // mp_pools has no index on token0/token1 yet, so this is a sequential scan against the `anon` role's
    // 3s statement_timeout: warm it is ~150-600ms, cold it can just miss. Measured behaviour is that the
    // immediate retry lands, so retry once before declaring the registry unreadable.
    let data: unknown[] | null = null;
    let error: { message?: string } | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await sb
        .from("mp_pools")
        .select("*")
        .eq("active", true)
        .or(or)
        .range(from, from + PAGE - 1);
      data = res.data;
      error = res.error;
      if (!error) break;
    }
    // supabase-js does NOT throw on a query or network failure — it RETURNS {data:null, error}. Reading
    // `error` is the only way to know, which is precisely what both loaders used to skip.
    if (error) {
      throw new Error(
        `mp_pools query failed for ${pair.tokenIn} -> ${pair.tokenOut} (page from ${from}): ${
          error.message || String(error)
        }`,
      );
    }
    if (!data?.length) break;
    rows.push(...(data as PoolRow[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

/**
 * The whole-table load, kept working for callers that do not yet name a pair.
 *
 * IT IS TRUNCATED AND IT SAYS SO. There is no honest way to load ~94k rows inside a request — deep
 * offset paging costs ~0.5-3s per page against a 3s statement_timeout — so this returns a bounded window
 * and reports whether it is complete. Callers that can name their pair should pass one; they then get
 * the complete, correct set. This path exists so that not passing a pair degrades exactly as it does
 * today instead of breaking, never so that a truncated registry can pass itself off as complete.
 */
export async function fetchPoolRowsWindow(
  sb: PoolRegistryClient,
  maxRows: number,
): Promise<{ rows: PoolRow[]; complete: boolean; error?: string }> {
  const rows: PoolRow[] = [];
  for (let from = 0; from < maxRows; from += PAGE) {
    const { data, error } = await sb
      .from("mp_pools")
      .select("*")
      .eq("active", true)
      .range(from, from + PAGE - 1);
    // An error and "end of data" are NOT the same thing. Collapsing them is what let a database timeout
    // on page 5 pass itself off as a 14-page registry.
    if (error) {
      return { rows, complete: false, error: error.message || String(error) };
    }
    if (!data?.length) return { rows, complete: true };
    rows.push(...(data as PoolRow[]));
    if (data.length < PAGE) return { rows, complete: true };
  }
  return { rows, complete: false, error: `window capped at ${maxRows} rows` };
}

/** How many rows the pairless window pulls before giving up. Unchanged from the previous loader. */
const WINDOW_MAX_ROWS = 20_000;

/* ------------------------------------------------------------------ server-side entry point */

/**
 * Server-side loader for the `mp_pools` registry (public data, anon key). The API routes run in the
 * Node runtime where the browser Supabase client's cookie/session machinery is not available, so this
 * uses a plain persistSession:false client. Twin of loadPoolRows() in lib/chain/amm.ts — both now share
 * the query itself (fetchPoolRowsByPair) so the two can no longer drift apart, which is how the browser
 * copy missed the last fix. Cached 30s, per pair.
 *
 * Pass `pair` to get the complete, correct set for a route. Omitting it returns the bounded window and
 * logs that it did.
 */
interface CacheEntry {
  at: number;
  rows: PoolRow[];
  /** False = a known-truncated window. Recorded so the truncation is legible rather than implied. */
  complete: boolean;
}
let _cache: CacheEntry | null = null;
const _pairCache = new Map<string, CacheEntry>();
const CACHE_MS = 30_000;

function pairKey(pair: PoolPair): string {
  return poolPairTokens(pair).slice().sort().join("|");
}

export async function loadPoolRowsServer(nowMs: number, pair?: PoolPair): Promise<PoolRow[]> {
  const key = pair ? pairKey(pair) : null;
  const hit = key ? _pairCache.get(key) : _cache;
  if (hit && nowMs - hit.at < CACHE_MS) return hit.rows;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // A missing env var is a deployment fault, not an empty market. Returning [] here made it surface as
    // "Pool registry unavailable — try again shortly", which will never stop being true on its own.
    console.error(
      "[aggregator] mp_pools registry cannot be read: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY is not set in this environment",
    );
    if (hit) return hit.rows;
    throw new Error("Pool registry is not configured (Supabase env vars missing)");
  }

  const sb = createClient(url, anonKey, { auth: { persistSession: false } });
  try {
    if (pair && key) {
      const rows = await fetchPoolRowsByPair(sb, pair);
      _pairCache.set(key, { at: nowMs, rows, complete: true });
      return rows;
    }
    const win = await fetchPoolRowsWindow(sb, WINDOW_MAX_ROWS);
    if (!win.complete) {
      // Truncated. It is still served and still cached — a route that answers with fewer venues beats
      // one that does not answer at all, and re-running a 20-page scan per request would be worse than
      // the bug. What changes is that it is recorded AS truncated and says so out loud: the old loop
      // stamped whatever it had as the authoritative registry with nothing logged anywhere, so a single
      // database timeout silently priced 30 seconds of quotes off a fraction of the venues.
      console.warn(
        `[aggregator] loadPoolRowsServer read an INCOMPLETE registry (${win.rows.length} rows${
          win.error ? `; ${win.error}` : ""
        }); quotes built on it may be missing venues, v4 above all. Pass { tokenIn, tokenOut, weth } to load the complete set for the route.`,
      );
      _cache = { at: nowMs, rows: win.rows, complete: false };
      return win.rows;
    }
    _cache = { at: nowMs, rows: win.rows, complete: true };
    return win.rows;
  } catch (err) {
    // Serve the last known-good answer if we have one — that is what the old `catch` was reaching for,
    // and it never ran because supabase-js returns its errors instead of throwing them.
    console.error(
      `[aggregator] mp_pools registry read failed${pair ? ` for ${pair.tokenIn} -> ${pair.tokenOut}` : ""}:`,
      err instanceof Error ? `${err.name}: ${err.message}` : err,
    );
    if (hit) return hit.rows;
    throw err;
  }
}
