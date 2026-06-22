-- Migration 017: Weekly Feedback
-- One feedback record per (batch, evaluator). `batch` reuses the weekly labels
-- from game_evaluations.batch (e.g. "W1 Jun, 2026"). `feedback` stores a Tiptap
-- document (rich text + inline game hyperlinks). `game_alike` stores structured
-- sections: [{ name: string|null, games: [{ game_id, title, app_link, icon_url, manual }] }].

CREATE TABLE IF NOT EXISTS weekly_feedback (
  id          SERIAL PRIMARY KEY,
  batch       VARCHAR(40)  NOT NULL,
  evaluator   VARCHAR(100) NOT NULL,
  feedback    JSONB,
  game_alike  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (batch, evaluator)
);

CREATE INDEX IF NOT EXISTS idx_weekly_feedback_evaluator ON weekly_feedback (lower(evaluator));
CREATE INDEX IF NOT EXISTS idx_weekly_feedback_batch     ON weekly_feedback (batch);

DROP TRIGGER IF EXISTS trg_weekly_feedback_updated ON weekly_feedback;
CREATE TRIGGER trg_weekly_feedback_updated
  BEFORE UPDATE ON weekly_feedback
  FOR EACH ROW
  EXECUTE FUNCTION update_game_evaluations_timestamp();
