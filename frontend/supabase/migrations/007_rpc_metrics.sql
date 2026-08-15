-- Usage counters for the public Arc RPC at /rpc/v1/arc.
-- (Applied to the live project via the Supabase MCP; recorded here for reproducibility.)
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- THE PRIVACY GUARANTEE IS THE SCHEMA, NOT A POLICY DOCUMENT.
--
-- There is no column here for an IP address, a wallet address, a method's parameters, or a response.
-- An RPC endpoint sees every address a user asks about; the only durable way to promise we are not
-- building a profile out of that is to have nowhere to put one. If a future change needs a new column,
-- that is the moment to re-read this paragraph.
--
-- mp_rpc_visitors holds a SALTED HASH, never an address of any kind. The salt combines the day with a
-- server-side secret, so:
--   • rows cannot be reversed to an IP — without the secret, brute-forcing the whole IPv4 space is the
--     attack, and the secret defeats it (a date-only salt would NOT, which is why the secret is required
--     and visitor counting is disabled outright when it is missing);
--   • the same visitor on two days produces two unrelated hashes, so nobody can be followed over time.
-- Rows are pruned after 90 days on every write.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────

-- ── per-method counters ───────────────────────────────────────────────────────────────────────────────
create table if not exists public.mp_rpc_usage (
  day      date   not null,
  method   text   not null,
  requests bigint not null default 0,
  errors   bigint not null default 0,   -- JSON-RPC error replies, incl. legitimate reverts
  primary key (day, method)
);

-- ── daily unique visitors (salted hashes only — see the header) ───────────────────────────────────────
create table if not exists public.mp_rpc_visitors (
  day          date not null,
  visitor_hash text not null,
  primary key (day, visitor_hash)
);

-- ── transactions actually broadcast through us ────────────────────────────────────────────────────────
-- Counted only when eth_sendRawTransaction came back with a transaction hash, so a rejected or
-- malformed broadcast is not counted as a transaction.
create table if not exists public.mp_rpc_transactions (
  day          date   not null primary key,
  transactions bigint not null default 0
);

alter table public.mp_rpc_usage        enable row level security;
alter table public.mp_rpc_visitors     enable row level security;
alter table public.mp_rpc_transactions enable row level security;
-- Deliberately NO policies: Postgres default-denies, so the anon key can neither read nor write these.
-- Both paths below are SECURITY DEFINER and gated on the shared write secret.

-- ── write path ────────────────────────────────────────────────────────────────────────────────────────
-- One call per flush from the RPC route. Counters are added, not overwritten, so concurrent serverless
-- instances flushing the same day compose instead of clobbering each other.
create or replace function public.mp_rpc_record(
  p_secret       text,
  p_day          date,
  p_methods      jsonb,        -- [{"method":"eth_call","requests":12,"errors":1}, …]
  p_visitors     text[],       -- salted hashes, already computed server-side
  p_transactions integer
) returns void language plpgsql security definer set search_path to '' as $fn$
begin
  if p_secret is null or p_secret <> (select write_secret from mp_private.indexer_config where id = 1) then
    raise exception 'unauthorized';
  end if;

  if p_methods is not null and jsonb_typeof(p_methods) = 'array' then
    insert into public.mp_rpc_usage (day, method, requests, errors)
    select p_day,
           left(x->>'method', 128),
           greatest(0, coalesce((x->>'requests')::bigint, 0)),
           greatest(0, coalesce((x->>'errors')::bigint, 0))
    from jsonb_array_elements(p_methods) as x
    where nullif(x->>'method','') is not null
    on conflict (day, method) do update
      set requests = public.mp_rpc_usage.requests + excluded.requests,
          errors   = public.mp_rpc_usage.errors   + excluded.errors;
  end if;

  if p_visitors is not null and array_length(p_visitors, 1) is not null then
    insert into public.mp_rpc_visitors (day, visitor_hash)
    select p_day, v from unnest(p_visitors) as v where v is not null and v <> ''
    on conflict (day, visitor_hash) do nothing;   -- second visit of the day is not a second visitor
  end if;

  if coalesce(p_transactions, 0) > 0 then
    insert into public.mp_rpc_transactions (day, transactions)
    values (p_day, p_transactions)
    on conflict (day) do update
      set transactions = public.mp_rpc_transactions.transactions + excluded.transactions;
  end if;

  -- Bounded retention: a hash nobody can reverse is still not worth keeping forever.
  delete from public.mp_rpc_visitors where day < (p_day - 90);
end; $fn$;

-- ── read path ─────────────────────────────────────────────────────────────────────────────────────────
-- Secret-gated too: these are aggregates with no personal data in them, but they are also MoleSwap's
-- traffic figures, and nobody asked for those to be public.
create or replace function public.mp_rpc_stats(p_secret text, p_days integer default 30)
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare v_from date; v_out jsonb;
begin
  if p_secret is null or p_secret <> (select write_secret from mp_private.indexer_config where id = 1) then
    raise exception 'unauthorized';
  end if;

  v_from := current_date - greatest(0, least(365, coalesce(p_days, 30)));

  select jsonb_build_object(
    'since', v_from,
    'totals', jsonb_build_object(
      'requests',     coalesce((select sum(requests) from public.mp_rpc_usage        where day >= v_from), 0),
      'errors',       coalesce((select sum(errors)   from public.mp_rpc_usage        where day >= v_from), 0),
      'transactions', coalesce((select sum(transactions) from public.mp_rpc_transactions where day >= v_from), 0),
      -- Distinct people cannot be summed across days (the same visitor hashes differently each day),
      -- so this is the peak single-day figure, and the daily series below is the honest view.
      'peak_daily_visitors', coalesce((select max(c) from (
          select count(*) c from public.mp_rpc_visitors where day >= v_from group by day) s), 0)
    ),
    'daily', coalesce((
      select jsonb_agg(r order by r->>'day' desc) from (
        select jsonb_build_object(
          'day', d.day,
          'requests',     coalesce(u.requests, 0),
          'errors',       coalesce(u.errors, 0),
          'visitors',     coalesce(v.visitors, 0),
          'transactions', coalesce(t.transactions, 0)
        ) r
        from (
          select day from public.mp_rpc_usage where day >= v_from
          union select day from public.mp_rpc_visitors where day >= v_from
          union select day from public.mp_rpc_transactions where day >= v_from
        ) d
        left join (select day, sum(requests) requests, sum(errors) errors
                     from public.mp_rpc_usage where day >= v_from group by day) u on u.day = d.day
        left join (select day, count(*) visitors
                     from public.mp_rpc_visitors where day >= v_from group by day) v on v.day = d.day
        left join (select day, transactions
                     from public.mp_rpc_transactions where day >= v_from) t on t.day = d.day
      ) x
    ), '[]'::jsonb),
    'methods', coalesce((
      select jsonb_agg(jsonb_build_object('method', method, 'requests', requests, 'errors', errors)
                       order by requests desc)
      from (select method, sum(requests) requests, sum(errors) errors
              from public.mp_rpc_usage where day >= v_from group by method) m
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end; $fn$;
