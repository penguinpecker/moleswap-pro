-- mp_pool_volume — real per-pool swap volume for the pools page's 24h volume / fees / APY.
-- Applied to project pgraqmnsabnatyzmlycx on 2026-08-11.
--
-- Mirrors the existing secret-gated indexer pattern (mp_private.indexer_config.write_secret, SECURITY
-- DEFINER, SET search_path TO ''). The Railway indexer scans Swap events for the tracked pools, converts
-- each swap's hub-token notional to USD, buckets by ~1h block windows, and writes here via the RPCs below.
-- anon may only READ (through mp_pool_volume_24h). See services/indexer/src/index.mjs refreshVolume().

create table if not exists public.mp_pool_volume (
  pool       text   not null,
  bucket     bigint not null,               -- floor(block / 36000) ~= 1 hour at RH's ~0.1s block time
  bucket_ts  bigint not null,               -- unix seconds of the bucket's start block (for the 24h window)
  volume_usd numeric not null default 0,
  fees_usd   numeric not null default 0,
  swaps      integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (pool, bucket)
);
create index if not exists mp_pool_volume_ts on public.mp_pool_volume (bucket_ts);

alter table public.mp_pool_volume enable row level security;
drop policy if exists mp_pool_volume_read on public.mp_pool_volume;
create policy mp_pool_volume_read on public.mp_pool_volume for select using (true);
grant select on public.mp_pool_volume to anon, authenticated;

-- Rolling 24h rollup per pool, read by the pools page with the anon key.
create or replace view public.mp_pool_volume_24h as
  select pool,
         sum(volume_usd) as volume_usd,
         sum(fees_usd)   as fees_usd,
         sum(swaps)::bigint as swaps
  from public.mp_pool_volume
  where bucket_ts >= (extract(epoch from now())::bigint - 86400)
  group by pool;
grant select on public.mp_pool_volume_24h to anon, authenticated;

-- Separate cursor for the volume scan (backfills only the last 24h, independent of pool discovery).
alter table mp_private.indexer_config add column if not exists volume_last_block bigint;

create or replace function public.mp_volume_cursor(p_secret text)
returns bigint language plpgsql security definer set search_path to '' as $function$
declare v bigint;
begin
  if p_secret is null or p_secret <> (select write_secret from mp_private.indexer_config where id = 1) then
    raise exception 'unauthorized';
  end if;
  select volume_last_block into v from mp_private.indexer_config where id = 1;
  return coalesce(v, 0);
end;
$function$;

-- Idempotent, atomic apply: adds each bucket's volume AND advances the cursor to p_to_block in ONE
-- transaction. A retry that re-sends an already-applied range (p_to_block <= cursor) is a no-op, so a lost
-- network ack after commit can never double-count. Ranges are contiguous (indexer marches cursor+1).
create or replace function public.mp_upsert_volume(p_secret text, p_rows jsonb, p_from_block bigint, p_to_block bigint)
returns integer language plpgsql security definer set search_path to '' as $function$
declare cur bigint; n integer := 0;
begin
  if p_secret is null or p_secret <> (select write_secret from mp_private.indexer_config where id = 1) then
    raise exception 'unauthorized';
  end if;
  select volume_last_block into cur from mp_private.indexer_config where id = 1;
  if cur is not null and p_to_block <= cur then
    return 0; -- already applied; idempotent skip
  end if;

  insert into public.mp_pool_volume (pool, bucket, bucket_ts, volume_usd, fees_usd, swaps, updated_at)
  select lower(x->>'pool'), (x->>'bucket')::bigint, (x->>'bucket_ts')::bigint,
         (x->>'volume_usd')::numeric, (x->>'fees_usd')::numeric, (x->>'swaps')::int, now()
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as x
  on conflict (pool, bucket) do update set
    volume_usd = public.mp_pool_volume.volume_usd + excluded.volume_usd,
    fees_usd   = public.mp_pool_volume.fees_usd   + excluded.fees_usd,
    swaps      = public.mp_pool_volume.swaps      + excluded.swaps,
    bucket_ts  = excluded.bucket_ts,
    updated_at = now();
  get diagnostics n = row_count;

  update mp_private.indexer_config set volume_last_block = p_to_block where id = 1;
  return n;
end;
$function$;

-- Bound the table: drop buckets older than 26h (outside the 24h window plus a small margin).
create or replace function public.mp_volume_prune(p_secret text)
returns integer language plpgsql security definer set search_path to '' as $function$
declare n integer := 0;
begin
  if p_secret is null or p_secret <> (select write_secret from mp_private.indexer_config where id = 1) then
    raise exception 'unauthorized';
  end if;
  delete from public.mp_pool_volume where bucket_ts < (extract(epoch from now())::bigint - 26*3600);
  get diagnostics n = row_count;
  return n;
end;
$function$;

-- The write RPCs run as SECURITY DEFINER but under the anon role's 3s statement_timeout; give them room.
alter function public.mp_upsert_volume(text, jsonb, bigint, bigint) set statement_timeout = '25s';
alter function public.mp_volume_prune(text)                          set statement_timeout = '15s';
