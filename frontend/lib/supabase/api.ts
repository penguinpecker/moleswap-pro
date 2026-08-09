import { createClient } from "./client";

const supabase = typeof window !== "undefined" ? createClient() : null;

// ============================================
// USER
// ============================================

export async function getOrCreateUser(walletAddress: string) {
  if (!supabase) return null;
  
  // Try to find existing user
  const { data: existing } = await supabase
    .from("users")
    .select("*")
    .eq("wallet_address", walletAddress.toLowerCase())
    .single();

  if (existing) return existing;

  // Create new user
  const { data: newUser, error } = await supabase
    .from("users")
    .insert({ wallet_address: walletAddress.toLowerCase() })
    .select()
    .single();

  if (error) {
    console.error("Error creating user:", error);
    return null;
  }
  return newUser;
}

export async function getUserProfile(walletAddress: string) {
  if (!supabase) return null;
  
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("wallet_address", walletAddress.toLowerCase())
    .single();

  return data;
}

// ============================================
// LEADERBOARD
// ============================================

export async function getLeaderboard(limit = 50, offset = 0) {
  if (!supabase) return [];
  
  const { data } = await supabase
    .from("users")
    .select("id, wallet_address, username, avatar_url, total_xp, current_rank")
    .order("total_xp", { ascending: false })
    .range(offset, offset + limit - 1);

  return data || [];
}

export async function getUserRank(walletAddress: string) {
  if (!supabase) return null;
  
  // Fetch all users sorted by XP to compute rank dynamically
  // This matches how the leaderboard page computes ranks
  const { data: allUsers } = await supabase
    .from("users")
    .select("wallet_address, total_xp")
    .gt("total_xp", 0)
    .order("total_xp", { ascending: false });

  if (!allUsers || allUsers.length === 0) return null;

  const idx = allUsers.findIndex(
    (u: any) => u.wallet_address?.toLowerCase() === walletAddress.toLowerCase()
  );

  if (idx === -1) return null;

  return {
    current_rank: idx + 1,
    best_rank: idx + 1,
    total_xp: allUsers[idx].total_xp || 0,
  };
}

// ============================================
// QUESTS
// ============================================

export async function getQuests(questType?: string) {
  if (!supabase) return [];
  
  let query = supabase
    .from("quests")
    .select("*")
    .eq("is_active", true)
    .order("sort_order");

  if (questType) {
    query = query.eq("quest_type", questType);
  }

  const { data } = await query;
  return data || [];
}

export async function getUserQuestProgress(userId: string) {
  if (!supabase) return [];
  
  const { data } = await supabase
    .from("user_quests")
    .select("*, quest:quests(*)")
    .eq("user_id", userId);

  return data || [];
}

export async function claimQuestReward(userId: string, questId: string) {
  if (!supabase) return null;
  
  const { data, error } = await supabase
    .from("user_quests")
    .update({ is_claimed: true, claimed_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("quest_id", questId)
    .eq("is_completed", true)
    .eq("is_claimed", false)
    .select()
    .single();

  if (error) {
    console.error("Error claiming quest:", error);
    return null;
  }
  return data;
}

// ============================================
// SWAP HISTORY
// ============================================

export async function recordSwap(params: {
  userId: string;
  fromChainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
  txHash?: string;
  status?: string;
}) {
  if (!supabase) return null;
  
  const { data, error } = await supabase
    .from("swap_history")
    .insert({
      user_id: params.userId,
      from_chain_id: params.fromChainId,
      to_chain_id: params.toChainId,
      from_token: params.fromToken,
      to_token: params.toToken,
      from_amount: params.fromAmount,
      to_amount: params.toAmount,
      tx_hash: params.txHash,
      status: params.status || "pending",
    })
    .select()
    .single();

  if (error) console.error("Error recording swap:", error);

  // ═══ Auto-progress quests on successful swap ═══
  if (data && params.status === "success" && params.userId) {
    try {
      const { progressQuestsForAction } = await import("./quests");
      const isBridge = params.fromChainId !== params.toChainId;
      
      await progressQuestsForAction(params.userId, "swap", {
        tx_hash: params.txHash,
        from_token: params.fromToken,
        to_token: params.toToken,
        amount: params.fromAmount,
      });

      if (isBridge) {
        await progressQuestsForAction(params.userId, "bridge", {
          tx_hash: params.txHash,
          from_chain: params.fromChainId,
          to_chain: params.toChainId,
        });
      }
    } catch (e) {
      console.error("Quest progression after swap error:", e);
    }
  }

  return data;
}

export async function getUserSwapHistory(userId: string, limit = 20) {
  if (!supabase) return [];
  
  const { data } = await supabase
    .from("swap_history")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  return data || [];
}

// ============================================
// DAILY SPIN
// ============================================

export async function canSpinToday(userId: string): Promise<boolean> {
  if (!supabase) return false;
  
  const today = new Date().toISOString().split("T")[0];
  const { data } = await supabase
    .from("daily_spins")
    .select("id")
    .eq("user_id", userId)
    .gte("spun_at", `${today}T00:00:00Z`)
    .lte("spun_at", `${today}T23:59:59Z`)
    .limit(1);

  return !data || data.length === 0;
}

export async function recordSpin(userId: string, rewardType: string, rewardAmount: number) {
  if (!supabase) return null;
  
  const { data, error } = await supabase
    .from("daily_spins")
    .insert({
      user_id: userId,
      reward_type: rewardType,
      reward_amount: rewardAmount,
    })
    .select()
    .single();

  if (error) console.error("Error recording spin:", error);
  return data;
}

// ============================================
// GAME SCORES
// ============================================

export async function recordGameScore(params: {
  userId: string;
  gameType: string;
  score: number;
  xpEarned?: number;
  ticketsUsed?: number;
}) {
  if (!supabase) return null;
  
  const { data, error } = await supabase
    .from("game_scores")
    .insert({
      user_id: params.userId,
      game_type: params.gameType,
      score: params.score,
      xp_earned: params.xpEarned || 0,
      tickets_used: params.ticketsUsed || 0,
    })
    .select()
    .single();

  if (error) console.error("Error recording game score:", error);

  // ═══ Auto-progress quests on game play ═══
  if (data && params.userId) {
    try {
      const { progressQuestsForAction } = await import("./quests");
      await progressQuestsForAction(params.userId, "game_play", {
        game: params.gameType,
        score: params.score,
      });

      // If high score, also trigger game_score action
      if (params.score > 0) {
        await progressQuestsForAction(params.userId, "game_score", {
          game: params.gameType,
          score: params.score,
        });
      }
    } catch (e) {
      console.error("Quest progression after game error:", e);
    }
  }

  return data;
}

export async function getGameLeaderboard(gameType: string, limit = 20) {
  if (!supabase) return [];
  
  const { data } = await supabase
    .from("game_scores")
    .select("*, user:users(wallet_address, username, avatar_url)")
    .eq("game_type", gameType)
    .order("score", { ascending: false })
    .limit(limit);

  return data || [];
}

// ============================================
// XP
// ============================================

export async function awardXP(userId: string, amount: number, source: string, description?: string) {
  if (!supabase) return null;
  
  // Insert XP transaction
  await supabase.from("xp_transactions").insert({
    user_id: userId,
    amount,
    source,
    description,
  });

  // Update user total
  const { data } = await supabase.rpc("award_xp", {
    p_user_id: userId,
    p_amount: amount,
    p_source: source,
    p_description: description,
  });

  return data;
}
