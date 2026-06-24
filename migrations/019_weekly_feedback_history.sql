-- Migration 019: Weekly Feedback history (safety net against accidental overwrite)
-- The editor auto-saves, so a mistaken edit can clobber good content. Before each
-- overwrite that crosses a "session boundary" (the existing row hasn't been
-- touched for >60s), the API snapshots the PREVIOUS sections here. Restores read
-- from this table. Snapshots are pruned to the most recent 30 per (batch, evaluator).

CREATE TABLE IF NOT EXISTS weekly_feedback_history (
  id         SERIAL PRIMARY KEY,
  batch      VARCHAR(40)  NOT NULL,
  evaluator  VARCHAR(100) NOT NULL,
  sections   JSONB        NOT NULL,
  saved_at   TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wf_history_key
  ON weekly_feedback_history (batch, lower(evaluator), saved_at DESC);
