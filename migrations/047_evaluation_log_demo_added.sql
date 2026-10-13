-- Migration 047: evaluation_log.demo_added — TRUE on the save that gave a game its demo link
-- (drive_link went from empty to a value). Used by the panel-time report: a link added
-- outside the panel (no view_s) after the game was judged counts as a flat 5 minutes.
--
-- APPLY BEFORE REPUBLISH. The PATCH handler inserts this column in the same statement as its
-- UPDATE, so without it every panel save fails. Idempotent; old rows stay FALSE (no backfill).

ALTER TABLE evaluation_log ADD COLUMN IF NOT EXISTS demo_added BOOLEAN NOT NULL DEFAULT FALSE;
