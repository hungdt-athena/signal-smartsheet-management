-- Migration 044: split the initial note into four parts
--
-- The Evaluate panel now writes the initial note as Gameplay / The game is over
-- when / The level is complete when / Self Note. The first three feed the Top
-- Pick core gameplay of the weekly report (PJ202, R-SL5), so they are kept as
-- their own columns instead of being parsed back out of free text.
--
-- initial_note stays the single-text note: PATCH /api/evaluations writes the
-- joined parts into it, so every existing reader is unchanged.
--
-- No backfill. A game noted before this migration has only initial_note; the
-- panel loads that text into Self Note (lib/eval-rules.ts notePartsFromRow).
-- Nullable columns without a default: a metadata-only change, no table rewrite.
--
-- Rollback: ALTER TABLE game_evaluations DROP COLUMN initial_gameplay,
--   DROP COLUMN initial_game_over, DROP COLUMN initial_level_complete,
--   DROP COLUMN initial_self_note;

ALTER TABLE game_evaluations
  ADD COLUMN IF NOT EXISTS initial_gameplay TEXT,
  ADD COLUMN IF NOT EXISTS initial_game_over TEXT,
  ADD COLUMN IF NOT EXISTS initial_level_complete TEXT,
  ADD COLUMN IF NOT EXISTS initial_self_note TEXT;
