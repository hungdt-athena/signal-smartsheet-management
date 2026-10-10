\set ON_ERROR_STOP 1
SET TIME ZONE 'UTC';

-- ===== Task 1: DDL + seed =====
-- The runner loads seed fixtures BEFORE the first 045 run (see verify-evaluation-log.sh),
-- so here we only assert outcomes.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM evaluation_log WHERE source = 'seed';
  ASSERT n = 7, format('seed rows: expected 7, got %s', n);

  -- corrected: owner tagged 09:00, evaluate_date 10:00 -> created_at = tag time
  ASSERT (SELECT confidence FROM evaluation_log WHERE game_evaluation_id = 1) = 'corrected', 'g1 corrected';
  ASSERT (SELECT created_at FROM evaluation_log WHERE game_evaluation_id = 1) = '2026-10-01 09:00+07', 'g1 uses tag time';
  -- ok: tag within 30 min
  ASSERT (SELECT confidence FROM evaluation_log WHERE game_evaluation_id = 2) = 'ok', 'g2 ok';
  -- low: last written by an admin who is not the owner
  ASSERT (SELECT confidence FROM evaluation_log WHERE game_evaluation_id = 3) = 'low', 'g3 low (manager touched)';
  -- low: before 28/9 VN, no tag
  ASSERT (SELECT confidence FROM evaluation_log WHERE game_evaluation_id = 4) = 'low', 'g4 low (pre-28/9)';
  -- ok: 00:30 on 28/9 VN, untagged, is after the boundary
  ASSERT (SELECT confidence FROM evaluation_log WHERE game_evaluation_id = 5) = 'ok', 'g5 ok (boundary)';
  -- a tag by someone other than the owner is ignored
  ASSERT (SELECT confidence FROM evaluation_log WHERE game_evaluation_id = 6) = 'ok', 'g6 other-person tag ignored';
  -- earliest owner tag wins
  ASSERT (SELECT created_at FROM evaluation_log WHERE game_evaluation_id = 7) = '2026-10-02 08:00+07', 'g7 MIN tag';
  -- not seeded: no conclusion / no date
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id IN (8, 9)), 'g8/g9 not seeded';
END $$;

-- Re-running 045 inserts nothing.
\i migrations/045_evaluation_log.sql
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM evaluation_log WHERE source = 'seed') = 7, 'seed is idempotent';
END $$;

-- After a live panel row exists, only games judged before it are seeded.
INSERT INTO game_info VALUES ('c1'), ('c2');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, initial_conclusion, evaluate_date) VALUES
  (20, 'c1', 'Alice', 'Bypass', '2026-10-09 11:59+07'),
  (21, 'c2', 'Alice', 'Bypass', '2026-10-09 12:05+07');
INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, source, context, kind, view_s, created_at)
  VALUES (2, 'g2', 'Alice', 'panel', 'evaluate', 'revise', 30, '2026-10-09 12:00+07');
\i migrations/045_evaluation_log.sql
DO $$ BEGIN
  ASSERT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id = 20 AND source = 'seed'), 'c1 seeded (before cutover)';
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id = 21 AND source = 'seed'), 'c2 skipped (after cutover)';
END $$;
-- Deleting a game_evaluations row (duplicate-row cleanups do this) keeps its log row.
INSERT INTO game_info VALUES ('d1');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, initial_conclusion, evaluate_date) VALUES
  (22, 'd1', 'Alice', 'Bypass', '2026-10-09 09:00+07');
INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, source, context, kind, view_s)
  VALUES (22, 'd1', 'Alice', 'panel', 'evaluate', 'first', 30);
DELETE FROM game_evaluations WHERE id = 22;
DO $$ BEGIN
  ASSERT EXISTS (SELECT 1 FROM evaluation_log WHERE game_id = 'd1' AND game_evaluation_id IS NULL),
    'log row survives deleting its game_evaluations row, with NULL id and game_id intact';
END $$;
DELETE FROM evaluation_log;   -- clean slate for later sections
