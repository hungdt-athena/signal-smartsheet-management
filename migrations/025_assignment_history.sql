-- Migration 025: assignment_history — per-run audit of who received which games.
--
-- Replaces the Google Chat / flow_log summary that the n8n auto-assign + handover
-- flows emitted. One row per (run, evaluator): the daily auto-assign writes
-- action='assign', manual re-assign writes 'reassign', handover writes 'handover'.
-- run_date is the VN calendar date so "history per person per day" is a simple
-- GROUP BY run_date, evaluator_name. game_ids holds the game_info.game_id values
-- (not the game_evaluations.id) so a human can trace straight back to the store game.

CREATE TABLE IF NOT EXISTS assignment_history (
  id             SERIAL PRIMARY KEY,
  run_date       DATE NOT NULL,                       -- VN date of the run (daily grouping)
  run_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  category_group TEXT NOT NULL,                        -- puzzle | arcade | simulation
  action         TEXT NOT NULL,                        -- 'assign' | 'reassign' | 'handover'
  evaluator_name TEXT NOT NULL,                        -- who received the games
  from_evaluator TEXT,                                 -- source evaluator (reassign/handover); NULL for assign
  game_count     INT NOT NULL,
  game_ids       TEXT[] NOT NULL DEFAULT '{}',         -- game_info.game_id values moved in this run
  created_by     TEXT,                                 -- session user email, or 'cron' for the scheduled run
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assignment_history_daily
  ON assignment_history (run_date DESC, evaluator_name);
CREATE INDEX IF NOT EXISTS idx_assignment_history_evaluator
  ON assignment_history (evaluator_name, run_date DESC);
CREATE INDEX IF NOT EXISTS idx_assignment_history_from
  ON assignment_history (from_evaluator, run_date DESC) WHERE from_evaluator IS NOT NULL;
