-- Token index + incremental-indexer support for the MoleSwap aggregator on Robinhood Chain.
-- (Applied to the live project via the Supabase MCP; recorded here for reproducibility.)
--
-- mp_tokens is the chain's token list: every token that has a pool, with on-chain metadata, plus a
-- liquidity-derived `verified` flag (Uniswap/Jupiter-style curated list, built from RH's own pools).
-- The services/indexer service keeps liquidity/verified fresh every REFRESH_SECONDS.

-- ── mp_tokens columns ────────────────────────────────────────────────────────────────────────────────
alter table public.mp_tokens add column if not exists liquidity numeric not null default 0;   -- WETH-equiv depth of the best pool
alter table public.mp_tokens add column if not exists verified boolean not null default false; -- liquidity >= 0.05 WETH
alter table public.mp_tokens add column if not exists pool text;         -- the deepest hub pool (for cheap refresh)
alter table public.mp_tokens add column if not exists pool_hub text;     -- 'weth' | 'usdg'
alter table public.mp_tokens add column if not exists last_refreshed timestamptz;

-- curated tokens are always verified
update public.mp_tokens set verified = true where address in (
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168');

-- ── indexes ──────────────────────────────────────────────────────────────────────────────────────────
create extension if not exists pg_trgm;
create index if not exists mp_tokens_symbol_trgm on public.mp_tokens using gin (lower(symbol) gin_trgm_ops);
create index if not exists mp_tokens_name_trgm   on public.mp_tokens using gin (lower(name)   gin_trgm_ops);
create index if not exists mp_tokens_symbol_lower on public.mp_tokens (lower(symbol));
create index if not exists mp_tokens_verified_liq on public.mp_tokens (verified, liquidity desc);
create index if not exists mp_tokens_refresh_order on public.mp_tokens (last_refreshed asc nulls first);

-- ── block cursor for the incremental indexer ─────────────────────────────────────────────────────────
alter table mp_private.indexer_config add column if not exists last_block bigint not null default 0;

-- ── secret-gated write RPCs (SECURITY DEFINER; the indexer holds only the anon key + write_secret) ────
create or replace function public.mp_upsert_tokens(p_secret text, p_tokens jsonb)
returns integer language plpgsql security definer set search_path to '' as $fn$
declare n integer := 0;
begin
  if p_secret is null or p_secret <> (select write_secret from mp_private.indexer_config where id = 1) then raise exception 'unauthorized'; end if;
  insert into public.mp_tokens (address, chain_id, symbol, name, decimals, is_native, is_stable, sort_rank)
  select lower(x->>'address'), 4663,
    left(coalesce(nullif(x->>'symbol',''), left(x->>'address',8)), 40),
    left(coalesce(nullif(x->>'name',''), x->>'symbol', left(x->>'address',8)), 120),
    greatest(0, least(36, coalesce((x->>'decimals')::int, 18))), false, false, 1000
  from jsonb_array_elements(p_tokens) as x
  where x->>'address' is not null
  on conflict (address) do nothing;
  get diagnostics n = row_count; return n;
end; $fn$;

create or replace function public.mp_refresh_tokens(p_secret text, p_rows jsonb)
returns integer language plpgsql security definer set search_path to '' as $fn$
declare n integer := 0;
begin
  if p_secret is null or p_secret <> (select write_secret from mp_private.indexer_config where id = 1) then raise exception 'unauthorized'; end if;
  update public.mp_tokens t
  set liquidity = (x->>'liquidity')::numeric,
      verified = (x->>'liquidity')::numeric >= 0.05,
      pool = coalesce(nullif(lower(x->>'pool'),''), t.pool),
      pool_hub = coalesce(nullif(lower(x->>'hub'),''), t.pool_hub),
      last_refreshed = now()
  from jsonb_array_elements(p_rows) as x
  where t.address = lower(x->>'address');
  get diagnostics n = row_count; return n;
end; $fn$;

create or replace function public.mp_indexer_cursor(p_secret text)
returns bigint language plpgsql security definer set search_path to '' as $fn$
declare v bigint;
begin
  if p_secret is null or p_secret <> (select write_secret from mp_private.indexer_config where id = 1) then raise exception 'unauthorized'; end if;
  select last_block into v from mp_private.indexer_config where id = 1; return coalesce(v, 0);
end; $fn$;

create or replace function public.mp_indexer_advance(p_secret text, p_block bigint)
returns void language plpgsql security definer set search_path to '' as $fn$
begin
  if p_secret is null or p_secret <> (select write_secret from mp_private.indexer_config where id = 1) then raise exception 'unauthorized'; end if;
  update mp_private.indexer_config set last_block = p_block where id = 1;
end; $fn$;
