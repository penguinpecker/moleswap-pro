-- mp_pools_simulate_pair_index — make the return-delta-hook (simulate-eligible) pair lookup fast.
--
-- WHY. Hook-aware quoting loads, per pair, the INACTIVE uniswap_v4 rows whose hook can move tokens the
-- tick math cannot see (return-delta hooks), so the aggregator can price them by on-chain simulation
-- instead of leaving them unquotable. The query is:
--
--   select * from mp_pools
--   where venue = 'uniswap_v4' and active = false
--     and token0 in (:pairTokens) and token1 in (:pairTokens);
--
-- Without a supporting index that predicate scans the ~335k INACTIVE uniswap_v4 rows; measured ~2.8s cold
-- on the IO-strained database (2026-08-22 incident), slower than the active-rows query it runs beside. The
-- frontend TIME-BOXES that read (SIMULATE_ROWS_TIMEOUT_MS) so a slow database never delays a quote — this
-- index is what lets the read actually finish inside that budget rather than being dropped.
--
-- A PARTIAL index keyed on (token0, token1) over exactly the rows the query selects — the inactive
-- uniswap_v4 rows — is tiny relative to the table and matches the predicate directly.
--
-- Run in the Supabase SQL editor (CONCURRENTLY cannot run inside the migration transaction, and every
-- remote channel has historically killed long DDL on this database — see records.txt):
--
--   create index concurrently if not exists mp_pools_simulate_pair
--     on public.mp_pools (token0, token1)
--     where venue = 'uniswap_v4' and active = false;
--
-- NOTE: the standing recommendation to delete the ~360k inactive uniswap_v4 rows and VACUUM ANALYZE
-- mp_pools (open since 2026-08-14) would shrink this set further; this index helps regardless of whether
-- that cleanup has run.

create index concurrently if not exists mp_pools_simulate_pair
  on public.mp_pools (token0, token1)
  where venue = 'uniswap_v4' and active = false;
