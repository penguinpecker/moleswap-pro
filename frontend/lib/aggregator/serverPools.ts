import { createClient } from "@supabase/supabase-js";
import type { PoolRow } from "./client";

/**
 * Server-side loader for the `mp_pools` registry (public data, anon key). The API routes run in the
 * Node runtime where the browser Supabase client's cookie/session machinery is not available, so this
 * uses a plain persistSession:false client. Mirrors loadPoolRows() in lib/chain/amm.ts. Cached 30s.
 */
let _cache: { at: number; rows: PoolRow[] } | null = null;

export async function loadPoolRowsServer(nowMs: number): Promise<PoolRow[]> {
  if (_cache && nowMs - _cache.at < 30_000) return _cache.rows;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return _cache?.rows ?? [];
  try {
    const sb = createClient(url, key, { auth: { persistSession: false } });
    // Supabase REST caps an unranged select at 1000 rows. This registry holds ~13.6k active pools,
    // so the loader was silently seeing ~7% of it — an arbitrary slice — and any pool outside that
    // window could only ever be found by the live per-pair discovery probe. Page explicitly.
    const PAGE = 1000;
    const rows: PoolRow[] = [];
    for (let from = 0; from < 20000; from += PAGE) {
      const { data, error } = await sb
        .from("mp_pools")
        .select("*")
        .eq("active", true)
        .range(from, from + PAGE - 1);
      if (error || !data?.length) break;
      rows.push(...(data as PoolRow[]));
      if (data.length < PAGE) break;
    }

    _cache = { at: nowMs, rows };
    return rows;
  } catch {
    return _cache?.rows ?? [];
  }
}
