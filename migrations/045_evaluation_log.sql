-- Migration 045: evaluation_log — one append-only row per successful evaluation save.
-- Spec: docs/superpowers/specs/2026-10-10-evaluation-time-log-design.md
--
-- APPLY BEFORE REPUBLISH. The PATCH handler writes this table in the same statement as
-- its UPDATE, so without it every panel save fails. Then re-run this file once, right
-- after Republish, to seed games judged in between. The file is idempotent.

CREATE TABLE IF NOT EXISTS evaluation_log (
  id                 BIGSERIAL PRIMARY KEY,
  -- SET NULL, not CASCADE: an append-only time log must survive row cleanups; game_id still names the game
  game_evaluation_id INT REFERENCES game_evaluations(id) ON DELETE SET NULL,
  game_id            TEXT NOT NULL,
  actor              TEXT,          -- session user name; NULL for seed rows and SKIP_AUTH
  actor_role         TEXT,          -- admin | moderator | evaluator (audit only)
  owner              TEXT,          -- initial_evaluator before the write
  source             TEXT NOT NULL, -- panel | other | add_to_record | seed
  context            TEXT,          -- evaluate | shortlist | record | tagging (source = panel only)
  kind               TEXT NOT NULL, -- first | revise | clear | final | other
  conclusion_before  TEXT,
  conclusion_after   TEXT,
  final_before       TEXT,          -- audit only
  final_after        TEXT,          -- audit only
  batch_before       TEXT,          -- audit: game_evaluations.batch before/after the write
  batch_after        TEXT,          -- audit: game_evaluations.batch before/after the write
  changed            BOOLEAN NOT NULL DEFAULT FALSE, -- initial conclusion changed
  view_s             INT,           -- seconds the game was the current game in the panel
  hidden_s           INT,           -- of which the tab was hidden (<= view_s)
  idle_s             INT,           -- of which no input for > 2 min stretches (<= view_s)
  confidence         TEXT,          -- seed rows only: ok | low | corrected
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Covers a database that already ran an earlier 045 (without the batch columns).
ALTER TABLE evaluation_log ADD COLUMN IF NOT EXISTS batch_before TEXT, ADD COLUMN IF NOT EXISTS batch_after TEXT;

CREATE INDEX IF NOT EXISTS idx_evaluation_log_actor_time ON evaluation_log (actor, created_at);
CREATE INDEX IF NOT EXISTS idx_evaluation_log_game ON evaluation_log (game_evaluation_id, created_at);
-- the panel's History modal reads by game_id (survives deleted evaluation rows)
CREATE INDEX IF NOT EXISTS idx_evaluation_log_game_id ON evaluation_log (game_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_evaluation_log_seed
  ON evaluation_log (game_evaluation_id) WHERE source = 'seed';

-- Seed: copy the one timestamp each judged game already has. Adds no precision;
-- `confidence` says how far to trust it.
WITH cutover AS (
  -- first live panel row; before Republish there is none, so NOW()
  SELECT COALESCE(MIN(created_at), NOW()) AS t FROM evaluation_log WHERE source = 'panel'
), tag AS (
  -- independent clock: trend tags are saved in the same click as the evaluation (~3 s apart)
  SELECT pt.game_id, lower(du.name) AS who, MIN(pt.tagged_at) AS tagged_at
  FROM playtest_tags pt JOIN dashboard_users du ON lower(du.email) = lower(pt.tagged_by)
  GROUP BY 1, 2
), src AS (
  SELECT ge.id, ge.game_id, ge.initial_evaluator, ge.initial_conclusion, ge.final_conclusion,
    ge.evaluate_date, tag.tagged_at,
    (tag.tagged_at IS NOT NULL AND ge.evaluate_date > tag.tagged_at + INTERVAL '30 minutes') AS restamped,
    EXISTS (SELECT 1 FROM dashboard_users m
            WHERE lower(m.name) = lower(ge.updated_by) AND m.role IN ('admin', 'moderator')
              AND lower(ge.updated_by) IS DISTINCT FROM lower(ge.initial_evaluator)) AS manager_touched
  FROM game_evaluations ge
  LEFT JOIN tag ON tag.game_id = ge.game_id AND tag.who = lower(ge.initial_evaluator)
  WHERE ge.initial_conclusion IS NOT NULL AND ge.evaluate_date IS NOT NULL
)
INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, owner, source, kind,
  conclusion_after, final_after, changed, confidence, created_at)
SELECT s.id, s.game_id, NULL, s.initial_evaluator, 'seed', 'first',
  s.initial_conclusion, s.final_conclusion, TRUE,
  CASE WHEN s.restamped THEN 'corrected'
       WHEN s.manager_touched THEN 'low'
       WHEN s.evaluate_date < '2026-09-28 00:00+07' AND s.tagged_at IS NULL THEN 'low'
       ELSE 'ok' END,
  CASE WHEN s.restamped THEN s.tagged_at ELSE s.evaluate_date END
FROM src s, cutover c
WHERE s.evaluate_date < c.t
ON CONFLICT (game_evaluation_id) WHERE source = 'seed' DO NOTHING;
