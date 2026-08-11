-- mp_indexer_timeout_and_index — fix the Railway indexer's Supabase statement timeouts.
-- Applied to project pgraqmnsabnatyzmlycx on 2026-08-11.
--
-- ROOT CAUSE: the indexer authenticates as `anon` (statement_timeout = 3s), but mp_tokens had grown to
-- ~264k rows / 180MB (every launchpad/junk token across 9.7k pools). Its per-cycle batch writes
-- (mp_refresh_tokens updates up to 2000 indexed rows) and reads were killed at 3s and retried every cycle
-- forever — the indexer never completed a cycle (health ok=false, lastRun=null) and the DB stayed busy,
-- which also tripped the server-side quote's registry read ("Pool registry unavailable").
--
-- These RPCs are SECURITY DEFINER and secret-gated (only the indexer calls them), so a per-function
-- statement budget is safe and does NOT change the global 3s anon cap that protects the public REST API.
alter function public.mp_refresh_tokens(text, jsonb)      set statement_timeout = '25s';
alter function public.mp_upsert_pools(text, jsonb)        set statement_timeout = '25s';
alter function public.mp_upsert_tokens(text, jsonb)       set statement_timeout = '25s';
alter function public.mp_set_token_liquidity(text, jsonb) set statement_timeout = '25s';

-- The verified-liquidity refresh runs `where verified=true and pool is not null order by last_refreshed`
-- every cycle. Only ~4.9k of 264k rows are verified, so a partial index on exactly that predicate makes it
-- a tiny ordered index scan instead of a filter over the whole table.
create index if not exists mp_tokens_verified_refresh
  on public.mp_tokens (last_refreshed nulls first)
  where verified = true and pool is not null;

-- Also reduced sustained load via Railway env (not SQL): REFRESH_SECONDS 60 -> 300,
-- UNVERIFIED_REFRESH_BATCH 4000 -> 2000. Together these took the indexer from failing every cycle to
-- completing cleanly (health ok=true).
