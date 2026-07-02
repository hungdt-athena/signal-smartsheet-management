-- Migration 027: backfill assignment_history (action='assign') from game_evaluations.
--
-- assignment_history (migration 025) only started accruing on 2026-07-02, when the
-- daily auto-assign + manual reassign/handover began writing to it. This backfills
-- the earlier days so the Team Operations → Assign → History view has depth.
--
-- CAVEAT — approximate. game_evaluations.assigned_date is OVERWRITTEN to "today" on
-- every reassign/handover, so we can only reconstruct the *current* assignment per
-- game, grouped by (assigned_date, initial_evaluator, category_group). Past reassign
-- and handover events left no trace and are NOT reconstructed. Rows are tagged
-- created_by='backfill' so this is distinguishable from real cron/manual history.
--
-- Idempotent: re-running replaces the backfill rows (DELETE then INSERT). Only days
-- strictly before today (VN) are touched, so live rows written by cron are untouched.

DELETE FROM assignment_history WHERE created_by = 'backfill';

INSERT INTO assignment_history
  (run_date, run_at, category_group, action, evaluator_name, from_evaluator, game_count, game_ids, created_by)
SELECT
  assigned_date,
  assigned_date::timestamptz,
  category_group,
  'assign',
  initial_evaluator,
  NULL,
  COUNT(*),
  array_agg(game_id ORDER BY game_id),
  'backfill'
FROM game_evaluations
WHERE assigned_date IS NOT NULL
  AND initial_evaluator IS NOT NULL
  AND assigned_date < (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
GROUP BY assigned_date, category_group, initial_evaluator;
