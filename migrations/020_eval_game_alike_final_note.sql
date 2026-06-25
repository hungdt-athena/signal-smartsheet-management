-- 020: Evaluation Game Alike (flat list of similar games, reusing the
-- weekly-feedback GameAlikeGame shape) + manager-only Final Note.
ALTER TABLE game_evaluations
  ADD COLUMN IF NOT EXISTS game_alike JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS final_note TEXT;
