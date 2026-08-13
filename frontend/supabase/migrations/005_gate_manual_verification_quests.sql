-- 005 — stop the generic quest-progression path from completing quests that require
-- real verification. Mirrors the migration applied to production on 2026-08-13
-- (gate_progress_quest_to_auto_verified_actions).
--
-- WHY
-- Migration 004 moved quest progression behind a server route holding the write secret,
-- which killed arbitrary-VALUE XP forgery. An adversarial re-test the same day showed that
-- was not enough: the route is unauthenticated and takes a caller-supplied user id, so an
-- unauthenticated POST of
--     {"userId": "<any id from the public users table>", "actionType": "twitter_follow"}
-- was credited the FOLLOW @MOLESWAPCOM reward of 500 XP with no social action having
-- happened — on its own more than 7x the entire legitimate leaderboard top of 70.
--
-- The two social quests are verification_type='manual' and have their own dedicated route
-- (/api/quests/verify-social). They must never be reachable through the generic path.
--
-- WHERE THE CHECK LIVES
-- Inside the SECURITY DEFINER function, not in the route, so no present or future caller
-- can bypass it. It is data-driven rather than a hardcoded action-type list, so any
-- 'manual' or 'proof' quest added later is protected with no code change — and, just as
-- importantly, the next ordinary 'auto' quest keeps working without anyone remembering to
-- update an allowlist.
--
-- VERIFIED ON PRODUCTION after applying:
--   twitter_follow   -> 23514 'action_type twitter_follow requires verification'   (was: paid 500 XP)
--   twitter_like_rt  -> 23514                                                       (was: paid 100 XP)
--   game_play        -> still returns WHACK A MOLE progression                      (no regression)
--   swap             -> still returns both SWAP TOKENS quests                       (no regression)
--   wrong secret     -> P0001 'unauthorized'                                        (gate intact)
-- and through the live route: twitter_follow -> HTTP 403 {"error":"action requires verification"},
-- game_play -> HTTP 200 with the quest progressed.
--
-- Return type stays jsonb; the body is otherwise the previous definition unchanged.

create or replace function public.progress_quest_gated(
  p_secret text,
  p_user_id uuid,
  p_action_type text,
  p_action_data jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '15s'
as $function$
declare
  v_result jsonb;
begin
  if p_secret is null or p_secret <> (select write_secret from mp_private.indexer_config where id = 1) then
    raise exception 'unauthorized';
  end if;

  if exists (
    select 1 from public.quests
    where action_type = p_action_type
      and coalesce(verification_type, 'auto') <> 'auto'
  ) then
    raise exception 'action_type % requires verification', p_action_type
      using errcode = 'check_violation';
  end if;

  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
    into v_result
    from public.progress_quest(p_user_id, p_action_type, p_action_data) t;

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STILL OPEN after this migration — recorded so it is not mistaken for closed:
--
-- 1. IDENTITY IS STILL UNAUTHENTICATED. /api/game/progress-quest accepts a caller-supplied
--    userId with no wallet-ownership proof, and public.users is anon-readable, so the id
--    roster is public. An unauthenticated caller can still drive 'auto' quest progression
--    for ANY account. What this migration removes is the high-value unverifiable payouts;
--    what remains is bounded by each quest's own xp_reward and by one-time completion
--    (max ~70 XP of auto quests, i.e. no longer enough to beat the legitimate top).
--    The real fix is a signed-nonce wallet session. That adds a signature prompt, so it is
--    a product decision, not a silent hardening step.
--
-- 2. Self-farming is NOT addressed and cannot be by any identity scheme: an attacker
--    controls their own wallet, so proving ownership does not prove the swap/game happened.
--    Closing that needs the action itself verified (on-chain proof for swap/bridge,
--    a real Twitter/X API check for the social quests).
--
-- 3. /api/quests/verify-social has been returning HTTP 500 on every call since long before
--    this work — `.catch()` is called on a PostgrestFilterBuilder, which is a thenable, not
--    a Promise. It is byte-identical to the pre-burrow-ui tag, so social quests have never
--    actually been claimable in this deployment. Left alone deliberately: fixing it would
--    newly start paying out 500/100 XP and reshuffle the leaderboard, which is a product
--    call. Note it would ALSO need write access restored (004 dropped the user_quests
--    INSERT/UPDATE policies it relied on, and SUPABASE_SERVICE_ROLE_KEY is not set in
--    Vercel production, so it falls back to the anon key).
--
-- 4. Tables remain anon-READABLE (wallet roster, referral codes, XP ledger, swap history).
-- ─────────────────────────────────────────────────────────────────────────────
