-- Migration 048: drive_link_suggestions -- a Drive file the auto-sync matched to a game by
-- title, but did NOT write to game_evaluations.drive_link because the title is shared by
-- different games (different bundle_id). The missing-demo prompt shows it prefilled so the
-- evaluator can open the video and confirm; confirming is an ordinary PATCH of drive_link.
--
-- Titles that belong to one game (or to one game's iOS + Android pair, same bundle_id) are
-- still written straight to drive_link by the n8n workflow, as before.
--
-- Apply BEFORE Republish is preferred, but not required: GET /api/evaluations/missing-demo
-- falls back to the plain list when this table is missing. Idempotent.

CREATE TABLE IF NOT EXISTS drive_link_suggestions (
  -- CASCADE: a suggestion is only meaningful next to its evaluation row
  game_evaluation_id INT PRIMARY KEY REFERENCES game_evaluations(id) ON DELETE CASCADE,
  link               TEXT NOT NULL,                 -- Drive webViewLink of the matched file
  file_name          TEXT,                          -- file name as uploaded, shown so the evaluator can check it
  shared_with        INT  NOT NULL DEFAULT 1,       -- how many OTHER games (different bundle_id) have this title
  suggested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
