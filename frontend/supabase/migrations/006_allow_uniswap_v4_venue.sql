-- 006 — let the indexer record EXTERNAL Uniswap-v4 pools.
-- Mirrors the migration applied to production on 2026-08-13.
--
-- A v4 pool has no factory and no address: it is a PoolKey hashed into an id inside the PoolManager
-- singleton. Discovery had only ever asked V3-style factories for a pool ADDRESS, so this entire
-- venue was invisible and v4-only tokens quoted "no route" while trading fine on-chain. Measured on
-- Robinhood Chain: 8,490 external v4 pools, and launchpad tokens are going there.
--
-- 'mole_v4' already means OUR pools (MoleHook, made by create-pool). 'uniswap_v4' is the separate
-- venue for pools nobody here created — a third party's hook, and often a real fee tier rather than
-- the dynamic sentinel — so the two cannot share a label.
--
-- Rows the router cannot execute (native-ETH currencies) or cannot honestly price (hooks carrying
-- BEFORE/AFTER_SWAP_RETURNS_DELTA, which move tokens the tick math never sees) are written with
-- active = false: indexed and auditable, never routed.
alter table public.mp_pools drop constraint if exists mp_pools_venue_check;
alter table public.mp_pools add constraint mp_pools_venue_check
  check (venue = any (array['pancake_v3'::text, 'uniswap_v3'::text, 'mole_v4'::text, 'uniswap_v4'::text]));
