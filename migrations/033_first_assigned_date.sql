-- Migration 033: first_assigned_date — the day a game FIRST entered evaluation.
--
-- game_evaluations.assigned_date is overwritten to "today" on every reassign and
-- handover (lib/reassign-core.ts commitAssignment), so team-level intake counted
-- on assigned_date double-counts games that merely changed hands. Example: 6 Aug
-- 2026 showed 866 "assigned" in the Report while the real assign run was 466 —
-- the rest were reassigned games restamped to that day.
--
-- first_assigned_date is stamped once (COALESCE, never overwritten) and is the
-- axis for TEAM intake metrics. Per-person metrics keep using assigned_date,
-- because a reassign genuinely moves the game onto the receiver's plate. As a
-- result SUM(per-person assigned) != team assigned — that is intended.
--
-- Backfill order of preference per game:
--   1. earliest assignment_history row with action='assign' containing the game
--   2. current assigned_date (best effort for pre-2026-07-02 rows, where reassign
--      events left no trace — see the caveat in migration 027)
-- Idempotent: only fills rows where the column is still NULL.

ALTER TABLE game_evaluations ADD COLUMN IF NOT EXISTS first_assigned_date DATE;

WITH first_assign AS (
  SELECT gid AS game_id, MIN(ah.run_date) AS d
  FROM assignment_history ah, unnest(ah.game_ids) AS gid
  WHERE ah.action = 'assign'
  GROUP BY gid
)
UPDATE game_evaluations ge
SET first_assigned_date = LEAST(fa.d, ge.assigned_date)
FROM first_assign fa
WHERE ge.game_id = fa.game_id
  AND ge.first_assigned_date IS NULL
  AND ge.assigned_date IS NOT NULL;

UPDATE game_evaluations
SET first_assigned_date = assigned_date
WHERE first_assigned_date IS NULL
  AND assigned_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_game_evaluations_first_assigned
  ON game_evaluations (first_assigned_date)
  WHERE first_assigned_date IS NOT NULL;
