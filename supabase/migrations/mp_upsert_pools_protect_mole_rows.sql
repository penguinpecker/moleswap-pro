-- mp_upsert_pools_protect_mole_rows — stop the generic v4 scan from unrouting MoleSwap's own pools.
--
-- APPLIED 2026-08-15 (MCP, during the registry incident).
--
-- WHAT HAPPENED. MoleSwap's three pools live on the same PoolManager as every external v4 pool, so
-- the v4 history backfill saw their Initialize events too. Classified under the generic hook rules
-- (MoleHook's address carries a return-delta permission bit, which the generic router path cannot
-- price), they came out active=false — and `on conflict (id) do update set active=excluded.active`
-- happily wrote that over the operator-registered mole_v4 rows. The DEX's own pools were silently
-- unrouted; redundant quote paths masked it for a day until a database incident removed the masks.
--
-- THE RULE. Rows with venue='mole_v4' are operator-owned (registered by the create-pool flow,
-- routed through the hook-aware path). The indexer's generic scan may create rows and update its
-- own, but may never overwrite the state of a mole_v4 row. The indexer additionally skips
-- MoleHook pools at the scanner level; this constraint holds even if that skip regresses.

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
  on conflict (id) do update set
    active       = case when mp_pools.venue = 'mole_v4' then mp_pools.active       else excluded.active       end,
    fee          = case when mp_pools.venue = 'mole_v4' then mp_pools.fee          else excluded.fee          end,
    tick_spacing = case when mp_pools.venue = 'mole_v4' then mp_pools.tick_spacing else excluded.tick_spacing end;
  get diagnostics n = row_count; return n;
end; $$;
