-- MoleSwap Pro aggregator registry (applied to Supabase project pgraqmnsabnatyzmlycx).
-- Namespaced mp_* beside the existing game tables. Recorded here for reproducibility; the actual apply
-- was done via the Supabase migration API. NO SECRET VALUES appear in this file — the indexer write
-- secret lives only in Railway env and a private DB table, never in the repo.

create table if not exists public.mp_tokens (
  address text primary key, chain_id integer not null default 4663, symbol text not null, name text not null,
  decimals integer not null check (decimals between 0 and 36), logo_url text,
  is_native boolean not null default false, is_stable boolean not null default false,
  sort_rank integer not null default 100, created_at timestamptz not null default now()
);
create table if not exists public.mp_pools (
  id text primary key, chain_id integer not null default 4663,
  venue text not null check (venue in ('pancake_v3','mole_v4')),
  token0 text not null, token1 text not null, fee integer not null, tick_spacing integer not null,
  hooks text, address text, active boolean not null default true, created_at timestamptz not null default now()
);
create table if not exists public.mp_swaps (
  id bigint generated always as identity primary key, tx_hash text not null unique, wallet text,
  token_in text not null, token_out text not null, amount_in numeric(78,0) not null,
  amount_out numeric(78,0), min_out numeric(78,0), route jsonb, block_number bigint,
  created_at timestamptz not null default now()
);
alter table public.mp_tokens enable row level security;
alter table public.mp_pools  enable row level security;
alter table public.mp_swaps  enable row level security;
create policy mp_tokens_read on public.mp_tokens for select using (true);
create policy mp_pools_read  on public.mp_pools  for select using (true);
create policy mp_swaps_insert on public.mp_swaps for insert with check (true);

-- Secret-gated indexer write path: the indexer (Railway) calls this with the ANON key; it does nothing
-- unless the shared secret matches the one in mp_private.indexer_config. Keeps a service-role key off the
-- platform entirely. Registry poisoning is bounded — minAmountOut still protects funds on-chain.
create schema if not exists mp_private;
create table if not exists mp_private.indexer_config (id int primary key default 1, write_secret text not null, constraint one_row check (id=1));
-- (write_secret value set out-of-band; never committed)
create or replace function public.mp_upsert_pools(p_secret text, p_pools jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer := 0;
begin
  if p_secret is null or p_secret <> (select write_secret from mp_private.indexer_config where id=1) then
    raise exception 'unauthorized';
  end if;
  insert into public.mp_pools (id,chain_id,venue,token0,token1,fee,tick_spacing,hooks,address,active)
  select lower(x->>'id'),4663,x->>'venue',lower(x->>'token0'),lower(x->>'token1'),
    (x->>'fee')::int,(x->>'tick_spacing')::int,nullif(lower(x->>'hooks'),''),nullif(lower(x->>'address'),''),(x->>'active')::boolean
  from jsonb_array_elements(p_pools) as x
  on conflict (id) do update set active=excluded.active, fee=excluded.fee, tick_spacing=excluded.tick_spacing;
  get diagnostics n = row_count; return n;
end; $$;
revoke all on function public.mp_upsert_pools(text,jsonb) from public;
grant execute on function public.mp_upsert_pools(text,jsonb) to anon;

-- 2026-08-08 security-audit fix: mp_swaps must not be anon-writable (was `with check (true)` = spammable).
-- Analytics should come from the on-chain Swapped event, not client claims.
drop policy if exists mp_swaps_insert on public.mp_swaps;
