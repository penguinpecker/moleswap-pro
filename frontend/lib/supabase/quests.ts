import { createClient } from "./client";

const supabase = typeof window !== "undefined" ? createClient() : null;

// ============================================
// QUEST PROGRESSION (auto-triggered on user actions)
// ============================================

/**
 * Called after any trackable user action (swap, game, social, etc.)
 * Automatically progresses all matching quests for the user.
 * Uses the DB function `progress_quest` which handles:
 *  - matching action_type to active quests
 *  - prerequisite checks
 *  - cooldown/repeat logic
 *  - auto-awarding XP on completion
 */
export async function progressQuestsForAction(
  userId: string,
  actionType: string,
  actionData: Record<string, any> = {}
): Promise<{
  progressed: { questId: string; title: string; newProgress: number; completed: boolean; xpReward: number }[];
}> {
  if (!supabase) return { progressed: [] };

  try {
    const { data, error } = await supabase.rpc("progress_quest", {
      p_user_id: userId,
      p_action_type: actionType,
      p_action_data: actionData,
    });

    if (error) {
      console.error("Quest progression error:", error);
      return { progressed: [] };
    }

    return {
      progressed: (data || []).map((r: any) => ({
        questId: r.quest_id,
        title: r.quest_title,
        newProgress: r.new_progress,
        completed: r.is_completed,
        xpReward: r.xp_reward,
      })),
    };
  } catch (err) {
    console.error("progressQuestsForAction error:", err);
    return { progressed: [] };
  }
}

// ============================================
// QUEST READ API (enhanced)
// ============================================

export interface QuestWithProgress {
  id: string;
  title: string;
  description: string | null;
  quest_type: string;
  action_type: string;
  category: string;
  difficulty: string;
  xp_reward: number;
  ticket_reward: number;
  mole_reward: number;
  required_count: number;
  image_url: string | null;
  badge_image_url: string | null;
  is_active: boolean;
  start_date: string | null;
  end_date: string | null;
  cooldown_hours: number;
  sort_order: number;
  // User progress (joined)
  progress: number;
  is_completed: boolean;
  is_claimed: boolean;
  completed_at: string | null;
}

/**
 * Get all quests with user progress (if userId provided)
 */
export async function getQuestsWithProgress(
  userId?: string,
  filters?: { category?: string; active_only?: boolean }
): Promise<QuestWithProgress[]> {
  if (!supabase) return [];

  const activeOnly = filters?.active_only !== false; // default true

  let query = supabase
    .from("quests")
    .select("*")
    .order("sort_order");

  if (activeOnly) {
    query = query.eq("is_active", true);
  }
  if (filters?.category) {
    query = query.eq("category", filters.category);
  }

  const { data: quests, error } = await query;
  if (error || !quests) return [];

  // If no userId, return quests without progress
  if (!userId) {
    return quests.map((q: any) => ({
      ...q,
      progress: 0,
      is_completed: false,
      is_claimed: false,
      completed_at: null,
    }));
  }

  // Fetch user progress for all quests
  const { data: userQuests } = await supabase
    .from("user_quests")
    .select("quest_id, progress, is_completed, is_claimed, completed_at")
    .eq("user_id", userId);

  const progressMap = new Map(
    (userQuests || []).map((uq: any) => [uq.quest_id, uq])
  );

  return quests.map((q: any) => {
    const uq = progressMap.get(q.id);
    return {
      ...q,
      progress: uq?.progress || 0,
      is_completed: uq?.is_completed || false,
      is_claimed: uq?.is_claimed || false,
      completed_at: uq?.completed_at || null,
    };
  });
}

/**
 * Get quest completion log for a user
 */
export async function getQuestLog(userId: string, limit = 50) {
  if (!supabase) return [];

  const { data } = await supabase
    .from("quest_completion_log")
    .select("*, quest:quests(title, xp_reward, image_url)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  return data || [];
}

// ============================================
// ADMIN QUEST CRUD (for future admin panel)
// ============================================

export interface CreateQuestInput {
  title: string;
  description?: string;
  quest_type: string;           // 'main', 'dapp', 'game'
  action_type: string;           // 'swap', 'game_play', 'social_follow', etc.
  action_target?: string;
  action_params?: Record<string, any>;
  verification_type?: string;    // 'auto', 'manual', 'proof'
  category?: string;             // 'main', 'dapp', 'game', 'social', 'seasonal'
  difficulty?: string;           // 'easy', 'medium', 'hard', 'legendary'
  xp_reward: number;
  ticket_reward?: number;
  mole_reward?: number;
  required_count?: number;
  image_url?: string;
  badge_image_url?: string;
  is_active?: boolean;
  start_date?: string;
  end_date?: string;
  max_completions?: number;
  cooldown_hours?: number;
  prerequisite_quest_id?: string;
  sort_order?: number;
  created_by?: string;
}

export interface UpdateQuestInput extends Partial<CreateQuestInput> {
  id: string;
}

/**
 * Create a new quest (admin)
 */
export async function createQuest(input: CreateQuestInput, adminId: string) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("quests")
    .insert({
      title: input.title,
      description: input.description || null,
      quest_type: input.quest_type,
      action_type: input.action_type || "manual",
      action_target: input.action_target || null,
      action_params: input.action_params || {},
      verification_type: input.verification_type || "auto",
      category: input.category || input.quest_type,
      difficulty: input.difficulty || "easy",
      xp_reward: input.xp_reward,
      ticket_reward: input.ticket_reward || 0,
      mole_reward: input.mole_reward || 0,
      required_count: input.required_count || 1,
      image_url: input.image_url || null,
      badge_image_url: input.badge_image_url || null,
      is_active: input.is_active !== false,
      start_date: input.start_date || null,
      end_date: input.end_date || null,
      max_completions: input.max_completions || 0,
      cooldown_hours: input.cooldown_hours || 0,
      prerequisite_quest_id: input.prerequisite_quest_id || null,
      sort_order: input.sort_order || 0,
      created_by: adminId,
    })
    .select()
    .single();

  if (error) {
    console.error("Create quest error:", error);
    return null;
  }

  // Audit log
  await supabase.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "create_quest",
    target_type: "quest",
    target_id: data.id,
    new_value: data,
  });

  return data;
}

/**
 * Update an existing quest (admin)
 */
export async function updateQuest(input: UpdateQuestInput, adminId: string) {
  if (!supabase) return null;

  // Get old value for audit
  const { data: oldQuest } = await supabase
    .from("quests")
    .select("*")
    .eq("id", input.id)
    .single();

  const updateData: Record<string, any> = { updated_at: new Date().toISOString() };
  const fields = [
    "title", "description", "quest_type", "action_type", "action_target",
    "action_params", "verification_type", "category", "difficulty",
    "xp_reward", "ticket_reward", "mole_reward", "required_count",
    "image_url", "badge_image_url", "is_active", "start_date", "end_date",
    "max_completions", "cooldown_hours", "prerequisite_quest_id", "sort_order",
  ];
  for (const f of fields) {
    if ((input as any)[f] !== undefined) {
      updateData[f] = (input as any)[f];
    }
  }

  const { data, error } = await supabase
    .from("quests")
    .update(updateData)
    .eq("id", input.id)
    .select()
    .single();

  if (error) {
    console.error("Update quest error:", error);
    return null;
  }

  // Audit log
  await supabase.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "update_quest",
    target_type: "quest",
    target_id: input.id,
    old_value: oldQuest,
    new_value: data,
  });

  return data;
}

/**
 * Delete (soft-deactivate) a quest (admin)
 */
export async function deleteQuest(questId: string, adminId: string, hard = false) {
  if (!supabase) return false;

  const { data: oldQuest } = await supabase
    .from("quests")
    .select("*")
    .eq("id", questId)
    .single();

  if (hard) {
    const { error } = await supabase.from("quests").delete().eq("id", questId);
    if (error) { console.error("Delete quest error:", error); return false; }
  } else {
    const { error } = await supabase
      .from("quests")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", questId);
    if (error) { console.error("Deactivate quest error:", error); return false; }
  }

  await supabase.from("admin_audit_log").insert({
    admin_id: adminId,
    action: hard ? "delete_quest" : "deactivate_quest",
    target_type: "quest",
    target_id: questId,
    old_value: oldQuest,
  });

  return true;
}

/**
 * Reorder quests (admin)
 */
export async function reorderQuests(
  orderedIds: { id: string; sort_order: number }[],
  adminId: string
) {
  if (!supabase) return false;

  for (const item of orderedIds) {
    await supabase
      .from("quests")
      .update({ sort_order: item.sort_order, updated_at: new Date().toISOString() })
      .eq("id", item.id);
  }

  await supabase.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "reorder_quests",
    target_type: "quest",
    target_id: null,
    new_value: orderedIds,
  });

  return true;
}

/**
 * Get all quests for admin (including inactive)
 */
export async function getAllQuestsAdmin() {
  if (!supabase) return [];

  const { data } = await supabase
    .from("quests")
    .select("*")
    .order("sort_order");

  return data || [];
}

/**
 * Get admin audit log
 */
export async function getAdminAuditLog(limit = 100) {
  if (!supabase) return [];

  const { data } = await supabase
    .from("admin_audit_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  return data || [];
}

/**
 * Manually complete a quest for a user (admin)
 */
export async function adminCompleteQuest(
  userId: string,
  questId: string,
  adminId: string
) {
  if (!supabase) return null;

  // Get quest for XP
  const { data: quest } = await supabase
    .from("quests")
    .select("*")
    .eq("id", questId)
    .single();
  if (!quest) return null;

  // Upsert user_quest
  const { data, error } = await supabase
    .from("user_quests")
    .upsert({
      user_id: userId,
      quest_id: questId,
      progress: quest.required_count,
      is_completed: true,
      is_claimed: true,
      completed_at: new Date().toISOString(),
      claimed_at: new Date().toISOString(),
      metadata: { completed_by_admin: adminId },
    }, { onConflict: "user_id,quest_id" })
    .select()
    .single();

  if (error) { console.error("Admin complete quest error:", error); return null; }

  // Award XP
  await supabase.rpc("award_xp", {
    p_user_id: userId,
    p_amount: quest.xp_reward,
    p_source: "quest",
    p_description: `Quest: ${quest.title} (admin)`,
  });

  // Audit
  await supabase.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "admin_complete_quest",
    target_type: "user_quest",
    target_id: `${userId}:${questId}`,
    new_value: data,
  });

  return data;
}
