-- ============================================================================
-- 004 — Harden the game/XP data layer against anonymous forgery.
-- Applied to production 2026-08-13. Mirrors the live database state.
--
-- The 2026-08-13 audit proved, using only the PUBLIC anon key:
--   * users INSERT (check=true)      -> create a user with total_xp = 987654321 (rank #1)
--   * progress_quest (SECURITY DEFINER, granted to anon/PUBLIC)
--                                    -> award XP to ANY user id, bypassing users-UPDATE RLS
--   * user_quests INSERT + UPDATE    -> forge / overwrite any user's quest state
--   * game_scores / daily_spins INSERT -> fabricate activity feeding the public leaderboard
--
-- Constraint honoured: the client legitimately creates users and records swaps with the
-- anon key, so those paths stay open; only the writes the client never makes are removed,
-- and quest progression moves behind the project's existing secret-gated RPC pattern.
-- ============================================================================

-- users: signup stays open (getOrCreateUser inserts wallet_address only), but the
-- caller can no longer choose their own XP or rank.
drop policy if exists users_insert on public.users;
create policy users_insert on public.users
  for insert to public
  with check (
    coalesce(total_xp, 0) = 0
    and current_rank is null
    and best_rank is null
  );

-- user_quests: client only SELECTs; progress_quest is SECURITY DEFINER and bypasses RLS.
drop policy if exists user_quests_insert on public.user_quests;
drop policy if exists user_quests_update on public.user_quests;

-- game_scores / daily_spins: no client code path writes these.
drop policy if exists game_scores_insert on public.game_scores;
drop policy if exists daily_spins_insert on public.daily_spins;

-- Quest progression behind the shared write secret (same shape as the mp_* indexer RPCs).
create or replace function public.progress_quest_gated(
  p_secret text,
  p_user_id uuid,
  p_action_type text,
  p_action_data jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to ''
set statement_timeout to '15s'
as $function$
declare
  v_result jsonb;
begin
  if p_secret is null or p_secret <> (select write_secret from mp_private.indexer_config where id = 1) then
    raise exception 'unauthorized';
  end if;

  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
    into v_result
    from public.progress_quest(p_user_id, p_action_type, p_action_data) t;

  return v_result;
end;
$function$;

revoke all on function public.progress_quest_gated(text, uuid, text, jsonb) from public;
grant execute on function public.progress_quest_gated(text, uuid, text, jsonb) to anon, authenticated, service_role;

-- Close the ungated entry point to the browser.
revoke execute on function public.progress_quest(uuid, text, jsonb) from public;
revoke execute on function public.progress_quest(uuid, text, jsonb) from anon;
revoke execute on function public.progress_quest(uuid, text, jsonb) from authenticated;

-- STILL OPEN after this migration (tracked, needs a client change or wallet auth):
--   * users / xp_transactions / user_quests / swap_history are anon-READABLE
--     (SELECT using=true) -> the 15-wallet roster, referral codes and XP ledger are public.
--   * swap_history INSERT stays open (recordSwap needs it) -> counters are still forgeable.
--   * Identity is an unauthenticated user id; this migration removes arbitrary-value and
--     cross-user forgery, not wallet-ownership proof. That needs a signed-nonce session.
