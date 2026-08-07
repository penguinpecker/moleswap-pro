-- ============================================
-- MoleSwap Quests — Admin Expansion
-- Adds fields for admin-configurable quests
-- ============================================

-- ═══ EXPAND QUESTS TABLE ═══
ALTER TABLE quests ADD COLUMN IF NOT EXISTS action_type TEXT DEFAULT 'manual';
-- action_type: 'swap', 'bridge', 'liquidity_add', 'liquidity_remove',
--              'game_play', 'game_score', 'social_follow', 'social_share',
--              'profile_edit', 'referral', 'daily_login', 'manual'

ALTER TABLE quests ADD COLUMN IF NOT EXISTS action_target TEXT;
-- e.g. specific token address, game type, social platform

ALTER TABLE quests ADD COLUMN IF NOT EXISTS action_params JSONB DEFAULT '{}';
-- Flexible config: { "min_amount": "0.1", "token": "pETH", "chain_id": 2442, "min_score": 100 }

ALTER TABLE quests ADD COLUMN IF NOT EXISTS verification_type TEXT DEFAULT 'auto';
-- 'auto' = system checks on action, 'manual' = admin marks complete, 'proof' = user submits proof

ALTER TABLE quests ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'main';
-- 'main', 'dapp', 'game', 'social', 'community', 'seasonal'

ALTER TABLE quests ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ;
ALTER TABLE quests ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ;
-- NULL = always active; set both for time-limited quests

ALTER TABLE quests ADD COLUMN IF NOT EXISTS max_completions INTEGER DEFAULT 0;
-- 0 = unlimited, >0 = max total completions across all users

ALTER TABLE quests ADD COLUMN IF NOT EXISTS cooldown_hours INTEGER DEFAULT 0;
-- 0 = one-time, >0 = repeatable after cooldown

ALTER TABLE quests ADD COLUMN IF NOT EXISTS ticket_reward INTEGER DEFAULT 0;
ALTER TABLE quests ADD COLUMN IF NOT EXISTS mole_reward NUMERIC(20, 8) DEFAULT 0;

ALTER TABLE quests ADD COLUMN IF NOT EXISTS prerequisite_quest_id UUID REFERENCES quests(id);
-- Chain quests: must complete prerequisite first

ALTER TABLE quests ADD COLUMN IF NOT EXISTS difficulty TEXT DEFAULT 'easy';
-- 'easy', 'medium', 'hard', 'legendary'

ALTER TABLE quests ADD COLUMN IF NOT EXISTS badge_image_url TEXT;
-- Badge/icon shown on completion

ALTER TABLE quests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE quests ADD COLUMN IF NOT EXISTS created_by TEXT;
-- Admin who created/edited the quest

-- ═══ EXPAND USER_QUESTS ═══
ALTER TABLE user_quests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE user_quests ADD COLUMN IF NOT EXISTS proof_url TEXT;
-- For 'proof' verification_type
ALTER TABLE user_quests ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
-- Store completion context: tx_hash, game_score, etc.

-- ═══ QUEST COMPLETION LOG (audit trail) ═══
CREATE TABLE IF NOT EXISTS quest_completion_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quest_id UUID NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  action_data JSONB DEFAULT '{}',
  progress_before INTEGER DEFAULT 0,
  progress_after INTEGER DEFAULT 0,
  auto_completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_qcl_user ON quest_completion_log(user_id);
CREATE INDEX idx_qcl_quest ON quest_completion_log(quest_id);
CREATE INDEX idx_qcl_created ON quest_completion_log(created_at DESC);

-- ═══ ADMIN AUDIT LOG ═══
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL, -- 'create_quest', 'update_quest', 'delete_quest', 'award_xp', 'ban_user'
  target_type TEXT NOT NULL, -- 'quest', 'user', 'config'
  target_id TEXT,
  old_value JSONB,
  new_value JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_aal_admin ON admin_audit_log(admin_id);
CREATE INDEX idx_aal_action ON admin_audit_log(action);

-- ═══ FUNCTION: Progress a quest by action ═══
CREATE OR REPLACE FUNCTION progress_quest(
  p_user_id UUID,
  p_action_type TEXT,
  p_action_data JSONB DEFAULT '{}'
) RETURNS TABLE(quest_id UUID, quest_title TEXT, new_progress INTEGER, is_completed BOOLEAN, xp_reward INTEGER) AS $$
DECLARE
  q RECORD;
  uq RECORD;
  new_prog INTEGER;
  completed BOOLEAN;
BEGIN
  -- Find all active quests matching this action_type
  FOR q IN
    SELECT * FROM quests
    WHERE is_active = TRUE
      AND action_type = p_action_type
      AND (start_date IS NULL OR start_date <= NOW())
      AND (end_date IS NULL OR end_date >= NOW())
      AND (max_completions = 0 OR (
        SELECT COUNT(*) FROM user_quests uq2
        WHERE uq2.quest_id = quests.id AND uq2.is_completed = TRUE
      ) < max_completions)
  LOOP
    -- Check prerequisite
    IF q.prerequisite_quest_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM user_quests
        WHERE user_id = p_user_id
          AND quest_id = q.prerequisite_quest_id
          AND is_completed = TRUE
      ) THEN
        CONTINUE; -- Skip — prerequisite not met
      END IF;
    END IF;

    -- Get or create user_quest record
    INSERT INTO user_quests (user_id, quest_id, progress)
    VALUES (p_user_id, q.id, 0)
    ON CONFLICT (user_id, quest_id) DO NOTHING;

    SELECT * INTO uq FROM user_quests
    WHERE user_id = p_user_id AND quest_id = q.id;

    -- Skip if already completed and not repeatable
    IF uq.is_completed AND q.cooldown_hours = 0 THEN
      CONTINUE;
    END IF;

    -- Check cooldown for repeatable quests
    IF uq.is_completed AND q.cooldown_hours > 0 THEN
      IF uq.completed_at + (q.cooldown_hours || ' hours')::INTERVAL > NOW() THEN
        CONTINUE; -- Still in cooldown
      END IF;
      -- Reset for repeat
      UPDATE user_quests SET progress = 0, is_completed = FALSE, is_claimed = FALSE,
        completed_at = NULL, claimed_at = NULL, updated_at = NOW()
      WHERE id = uq.id;
      uq.progress := 0;
      uq.is_completed := FALSE;
    END IF;

    -- Check action_params match (optional filtering)
    -- For now, simple increment; extend with JSON checks as needed
    new_prog := LEAST(uq.progress + 1, q.required_count);
    completed := new_prog >= q.required_count;

    UPDATE user_quests
    SET progress = new_prog,
        is_completed = completed,
        completed_at = CASE WHEN completed THEN NOW() ELSE completed_at END,
        updated_at = NOW(),
        metadata = p_action_data
    WHERE id = uq.id;

    -- Log the progression
    INSERT INTO quest_completion_log (user_id, quest_id, action_type, action_data, progress_before, progress_after, auto_completed)
    VALUES (p_user_id, q.id, p_action_type, p_action_data, uq.progress, new_prog, completed);

    -- Auto-award XP on completion
    IF completed AND q.verification_type = 'auto' THEN
      PERFORM award_xp(p_user_id, q.xp_reward, 'quest', 'Quest: ' || q.title);
      -- Also update claimed status for auto-verified quests
      UPDATE user_quests SET is_claimed = TRUE, claimed_at = NOW() WHERE id = uq.id;
    END IF;

    -- Return this quest's progress
    quest_id := q.id;
    quest_title := q.title;
    new_progress := new_prog;
    is_completed := completed;
    xp_reward := q.xp_reward;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ═══ UPDATE DEFAULT QUESTS WITH ACTION TYPES ═══
UPDATE quests SET action_type = 'swap', action_params = '{"min_count": 1}', verification_type = 'auto', category = 'main' WHERE title = 'SWAP TOKENS' AND sort_order = 1;
UPDATE quests SET action_type = 'bridge', action_params = '{}', verification_type = 'auto', category = 'main' WHERE title = 'BRIDGE TOKENS';
UPDATE quests SET action_type = 'game_play', action_params = '{"game": "whack_a_mole", "golden": true}', verification_type = 'auto', category = 'game' WHERE title = 'TAP A GOLDEN MOLE' AND sort_order = 3;
UPDATE quests SET action_type = 'daily_login', action_params = '{"consecutive": 5}', verification_type = 'auto', category = 'main' WHERE title = 'PLAY 5 DAYS IN A ROW';
UPDATE quests SET action_type = 'referral', action_params = '{}', verification_type = 'auto', category = 'social' WHERE title = 'INVITE A FRIEND';
UPDATE quests SET action_type = 'profile_edit', action_params = '{}', verification_type = 'auto', category = 'main' WHERE title = 'EDIT YOUR PROFILE';
UPDATE quests SET action_type = 'swap', action_params = '{"min_count": 5}', verification_type = 'auto', category = 'dapp' WHERE title = 'SWAP TOKENS x5';
UPDATE quests SET action_type = 'game_play', action_params = '{"game": "whack_a_mole", "golden": true, "min_count": 3}', verification_type = 'auto', category = 'game' WHERE title LIKE 'TAP A GOLDEN MOLE x3%';

-- ═══ RLS FOR NEW TABLES ═══
ALTER TABLE quest_completion_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Quest logs viewable by owner" ON quest_completion_log FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Quest logs insertable by system" ON quest_completion_log FOR INSERT WITH CHECK (true);

-- Admin audit log: readable by admins only (enforced at app level)
CREATE POLICY "Admin logs viewable by all" ON admin_audit_log FOR SELECT USING (true);
CREATE POLICY "Admin logs insertable" ON admin_audit_log FOR INSERT WITH CHECK (true);

-- Allow admin operations on quests table
CREATE POLICY "Quests manageable by admin" ON quests FOR ALL USING (true);
