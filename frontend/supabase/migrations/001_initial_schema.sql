-- ============================================
-- MoleSwap Database Schema
-- Supabase PostgreSQL
-- ============================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- USERS
-- ============================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_address TEXT UNIQUE NOT NULL,
  username TEXT,
  avatar_url TEXT,
  twitter_handle TEXT,
  twitter_id TEXT UNIQUE,
  referral_code TEXT UNIQUE DEFAULT encode(gen_random_bytes(4), 'hex'),
  referred_by UUID REFERENCES users(id),
  total_xp INTEGER DEFAULT 0,
  current_rank INTEGER,
  best_rank INTEGER,
  mole_balance NUMERIC(20, 8) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_wallet ON users(wallet_address);
CREATE INDEX idx_users_xp ON users(total_xp DESC);
CREATE INDEX idx_users_referral ON users(referral_code);

-- ============================================
-- XP TRANSACTIONS
-- ============================================
CREATE TABLE IF NOT EXISTS xp_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  source TEXT NOT NULL, -- 'swap', 'quest', 'game', 'referral', 'daily', 'social'
  description TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_xp_user ON xp_transactions(user_id);
CREATE INDEX idx_xp_source ON xp_transactions(source);
CREATE INDEX idx_xp_created ON xp_transactions(created_at DESC);

-- ============================================
-- QUESTS
-- ============================================
CREATE TABLE IF NOT EXISTS quests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  description TEXT,
  quest_type TEXT NOT NULL, -- 'main', 'dapp', 'game'
  xp_reward INTEGER NOT NULL DEFAULT 10,
  required_count INTEGER DEFAULT 1,
  image_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Default quests matching Figma designs
INSERT INTO quests (title, description, quest_type, xp_reward, required_count, image_url, sort_order) VALUES
  ('SWAP TOKENS', 'Complete a token swap', 'main', 10, 1, '/quest/main-quest-1.png', 1),
  ('BRIDGE TOKENS', 'Bridge tokens cross-chain', 'main', 10, 1, '/quest/main-quest-2.png', 2),
  ('TAP A GOLDEN MOLE', 'Find and tap a golden mole', 'main', 10, 1, '/quest/main-quest-3.png', 3),
  ('PLAY 5 DAYS IN A ROW', 'Log in for 5 consecutive days', 'main', 50, 5, '/quest/main-quest-4.png', 4),
  ('INVITE A FRIEND', 'Refer a friend to MoleSwap', 'main', 20, 1, '/quest/main-quest-5.png', 5),
  ('EDIT YOUR PROFILE', 'Customize your profile', 'main', 20, 1, '/quest/main-quest-6.png', 6),
  ('SWAP TOKENS x5', 'Complete 5 token swaps', 'dapp', 50, 5, '/quest/main-quest-7.png', 7),
  ('TAP A GOLDEN MOLE x3', 'Tap 3 golden moles', 'game', 30, 3, '/quest/main-quest-8.png', 8);

-- ============================================
-- USER QUEST PROGRESS
-- ============================================
CREATE TABLE IF NOT EXISTS user_quests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quest_id UUID NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  progress INTEGER DEFAULT 0,
  is_completed BOOLEAN DEFAULT FALSE,
  is_claimed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, quest_id)
);

CREATE INDEX idx_uq_user ON user_quests(user_id);
CREATE INDEX idx_uq_quest ON user_quests(quest_id);

-- ============================================
-- SWAP HISTORY
-- ============================================
CREATE TABLE IF NOT EXISTS swap_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_chain_id INTEGER NOT NULL,
  to_chain_id INTEGER NOT NULL,
  from_token TEXT NOT NULL,
  to_token TEXT NOT NULL,
  from_amount TEXT NOT NULL,
  to_amount TEXT NOT NULL,
  tx_hash TEXT,
  status TEXT DEFAULT 'pending', -- 'pending', 'success', 'failed'
  xp_earned INTEGER DEFAULT 0,
  tickets_earned INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_swaps_user ON swap_history(user_id);
CREATE INDEX idx_swaps_status ON swap_history(status);
CREATE INDEX idx_swaps_created ON swap_history(created_at DESC);

-- ============================================
-- DAILY SPIN
-- ============================================
CREATE TABLE IF NOT EXISTS daily_spins (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_type TEXT NOT NULL, -- 'xp', 'tickets', 'mole', 'nothing'
  reward_amount INTEGER DEFAULT 0,
  spun_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_spins_user ON daily_spins(user_id);
CREATE INDEX idx_spins_date ON daily_spins(spun_at DESC);

-- ============================================
-- GAME SCORES (Whack-a-Mole, Diamond Miner)
-- ============================================
CREATE TABLE IF NOT EXISTS game_scores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_type TEXT NOT NULL, -- 'whack_a_mole', 'diamond_miner'
  score INTEGER NOT NULL DEFAULT 0,
  xp_earned INTEGER DEFAULT 0,
  tickets_used INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  played_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_games_user ON game_scores(user_id);
CREATE INDEX idx_games_type ON game_scores(game_type);
CREATE INDEX idx_games_score ON game_scores(score DESC);

-- ============================================
-- LEADERBOARD VIEW
-- ============================================
CREATE OR REPLACE VIEW leaderboard AS
SELECT
  u.id,
  u.wallet_address,
  u.username,
  u.avatar_url,
  u.total_xp,
  u.current_rank,
  RANK() OVER (ORDER BY u.total_xp DESC) as calculated_rank,
  COUNT(DISTINCT sh.id) as total_swaps,
  COUNT(DISTINCT gs.id) as total_games
FROM users u
LEFT JOIN swap_history sh ON sh.user_id = u.id AND sh.status = 'success'
LEFT JOIN game_scores gs ON gs.user_id = u.id
GROUP BY u.id
ORDER BY u.total_xp DESC;

-- ============================================
-- FUNCTIONS
-- ============================================

-- Auto-update user rank after XP change
CREATE OR REPLACE FUNCTION update_user_rank()
RETURNS TRIGGER AS $$
BEGIN
  -- Update ranks for all users
  WITH ranked AS (
    SELECT id, RANK() OVER (ORDER BY total_xp DESC) as new_rank
    FROM users
  )
  UPDATE users u
  SET 
    current_rank = r.new_rank,
    best_rank = LEAST(COALESCE(u.best_rank, r.new_rank), r.new_rank),
    updated_at = NOW()
  FROM ranked r
  WHERE u.id = r.id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trigger_update_ranks
  AFTER INSERT OR UPDATE OF total_xp ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_user_rank();

-- Award XP and update total
CREATE OR REPLACE FUNCTION award_xp(
  p_user_id UUID,
  p_amount INTEGER,
  p_source TEXT,
  p_description TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'
) RETURNS INTEGER AS $$
DECLARE
  new_total INTEGER;
BEGIN
  -- Insert XP transaction
  INSERT INTO xp_transactions (user_id, amount, source, description, metadata)
  VALUES (p_user_id, p_amount, p_source, p_description, p_metadata);
  
  -- Update user total
  UPDATE users
  SET total_xp = total_xp + p_amount, updated_at = NOW()
  WHERE id = p_user_id
  RETURNING total_xp INTO new_total;
  
  RETURN new_total;
END;
$$ LANGUAGE plpgsql;

-- Check if user can spin daily wheel
CREATE OR REPLACE FUNCTION can_spin_today(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN NOT EXISTS (
    SELECT 1 FROM daily_spins
    WHERE user_id = p_user_id
    AND spun_at::date = CURRENT_DATE
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE xp_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_quests ENABLE ROW LEVEL SECURITY;
ALTER TABLE swap_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_spins ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_scores ENABLE ROW LEVEL SECURITY;

-- Users can read all users (for leaderboard) but only update their own
CREATE POLICY "Users are viewable by everyone" ON users FOR SELECT USING (true);
CREATE POLICY "Users can update own record" ON users FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own record" ON users FOR INSERT WITH CHECK (auth.uid() = id);

-- XP transactions readable by owner
CREATE POLICY "XP viewable by owner" ON xp_transactions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "XP insertable by system" ON xp_transactions FOR INSERT WITH CHECK (true);

-- Quests readable by everyone
CREATE POLICY "Quests viewable by everyone" ON quests FOR SELECT USING (true);

-- User quests by owner
CREATE POLICY "User quests viewable by owner" ON user_quests FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "User quests modifiable by owner" ON user_quests FOR ALL USING (auth.uid() = user_id);

-- Swap history by owner
CREATE POLICY "Swaps viewable by owner" ON swap_history FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Swaps insertable" ON swap_history FOR INSERT WITH CHECK (true);

-- Daily spins by owner
CREATE POLICY "Spins viewable by owner" ON daily_spins FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Spins insertable" ON daily_spins FOR INSERT WITH CHECK (true);

-- Game scores viewable by everyone (for leaderboard)
CREATE POLICY "Game scores viewable by everyone" ON game_scores FOR SELECT USING (true);
CREATE POLICY "Game scores insertable" ON game_scores FOR INSERT WITH CHECK (true);
