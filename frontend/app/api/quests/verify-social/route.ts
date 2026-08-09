import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// NOTE ON TRUST: this credits off-chain XP (leaderboard only, no funds). It cannot cryptographically
// prove the social action happened — real verification needs the Twitter/X API, and the app does not
// establish a Supabase auth session for wallet users, so there is no session to bind `userId` to. The
// rate limit below is the anti-abuse control; treat XP as advisory, not a trust signal.

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function POST(req: NextRequest) {
  const blocked = withRateLimit(req, "write");
  if (blocked) return blocked;

  try {
    const { userId, questId } = await req.json();
    if (!userId || !questId) {
      return NextResponse.json({ error: "Missing userId or questId" }, { status: 400 });
    }

    const { data: quest } = await supabase
      .from("quests")
      .select("*")
      .eq("id", questId)
      .eq("category", "social")
      .eq("is_active", true)
      .single();

    if (!quest) {
      return NextResponse.json({ error: "Quest not found or not a social quest" }, { status: 404 });
    }

    const { data: existing } = await supabase
      .from("user_quests")
      .select("*")
      .eq("user_id", userId)
      .eq("quest_id", questId)
      .maybeSingle();

    if (existing?.is_completed) {
      return NextResponse.json({ success: true, already: true, xp_earned: 0 });
    }

    const now = new Date().toISOString();

    if (existing) {
      await supabase
        .from("user_quests")
        .update({ progress: 1, is_completed: true, is_claimed: true, completed_at: now, claimed_at: now, updated_at: now })
        .eq("user_id", userId)
        .eq("quest_id", questId);
    } else {
      await supabase.from("user_quests").insert({
        user_id: userId,
        quest_id: questId,
        progress: 1,
        is_completed: true,
        is_claimed: true,
        completed_at: now,
        claimed_at: now,
      });
    }

    const reward = Number(quest.xp_reward) || 0; // null/undefined column would write NaN otherwise

    const { data: userData } = await supabase.from("users").select("total_xp").eq("id", userId).single();
    if (!userData) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    await supabase.from("users").update({ total_xp: (userData.total_xp || 0) + reward }).eq("id", userId);

    await supabase.from("xp_transactions").insert({
      user_id: userId,
      amount: reward,
      source: "quest",
      description: quest.title,
    }).catch(() => {});

    return NextResponse.json({ success: true, xp_earned: reward });
  } catch (err: any) {
    console.error("Social quest verify error:", err);
    return NextResponse.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
