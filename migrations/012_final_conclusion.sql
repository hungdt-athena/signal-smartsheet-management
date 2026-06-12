-- Migration 012: Add final_conclusion to game_evaluations
-- Moderators enter this on the Short List tab to decide which games move to Assign Record.

ALTER TABLE game_evaluations
  ADD COLUMN IF NOT EXISTS final_conclusion VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_game_evaluations_final_conclusion
  ON game_evaluations(final_conclusion)
  WHERE final_conclusion IS NOT NULL;
