-- Migration 013: Add weekly batch label to game_evaluations
-- Moderators bucket List_Idea games into weekly batches (e.g. "W1 Jun, 2026"),
-- matching column A of the IDEA_LIST sheet. Plain text label, UI-generated.

ALTER TABLE game_evaluations
  ADD COLUMN IF NOT EXISTS batch VARCHAR(40);

CREATE INDEX IF NOT EXISTS idx_game_evaluations_batch
  ON game_evaluations(batch)
  WHERE batch IS NOT NULL;
