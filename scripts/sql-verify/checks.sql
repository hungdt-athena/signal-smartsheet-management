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

-- ===== Task 3: PATCH CTE pattern, kind, evaluate_date rule, untyped params =====
\i scripts/sql-verify/prepare-save.sql

INSERT INTO game_info VALUES ('p1'),('p2'),('p3'),('p4'),('p5'),('p6');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, initial_conclusion, evaluate_date, batch) VALUES
 (31,'p1','Alice',NULL,NULL,NULL),
 (32,'p2','Alice','Bypass','2026-09-01 10:00+07',NULL),
 (33,'p3','Alice','Stale_release',NULL,NULL),
 (34,'p4','Alice','Bypass','2026-08-01 10:00+07','W1 Aug, 2026'),
 (35,'p5','Alice','Bypass',NULL,NULL),   -- imported: conclusion, no date
 (36,'p6','Alice',NULL,NULL,NULL);

EXECUTE save(31, true, 'Bypass', NULL, NULL, 'alice', 'evaluator', 'panel', 'evaluate', 60, 0, 0, true, false);
EXECUTE save(31, true, 'Bypass', NULL, NULL, 'Alice', 'evaluator', 'panel', 'evaluate', 30, 0, 0, true, false);
EXECUTE save(32, true, 'Link_dead', NULL, NULL, 'HungDT', 'admin', 'panel', 'evaluate', 40, 0, 0, true, false);
EXECUTE save(33, true, 'Bypass', NULL, NULL, 'HungDT', 'admin', 'panel', 'shortlist', 50, 0, 0, true, false);
EXECUTE save(34, true, 'List_Idea', 'W2 Oct, 2026', NULL, 'HungDT', 'admin', 'panel', 'evaluate', 20, 0, 0, true, false);
EXECUTE save(35, true, 'Bypass', NULL, NULL, 'Alice', 'evaluator', 'panel', 'evaluate', 10, 0, 0, true, false);
EXECUTE save(32, false, NULL, NULL, 'Priority I', 'HungDT', 'admin', 'other', NULL, NULL, NULL, NULL, false, true);
EXECUTE save(32, false, NULL, NULL, NULL, 'Rec', 'evaluator', 'panel', 'record', 15, 0, 0, false, false);
EXECUTE save(31, true, NULL, NULL, NULL, 'HungDT', 'admin', 'panel', 'evaluate', 5, 0, 0, true, false);
EXECUTE save(31, true, 'Bypass', NULL, NULL, NULL, NULL, 'other', NULL, NULL, NULL, NULL, true, false);
EXECUTE save(36, true, 'Stale_release', NULL, NULL, 'Alice', 'evaluator', 'panel', 'evaluate', 5, 0, 0, true, false); -- never 'first'

DO $$
DECLARE k text[];
BEGIN
  SELECT array_agg(kind ORDER BY id) INTO k FROM evaluation_log;
  ASSERT k = ARRAY['first','revise','revise','first','revise','revise','final','other','clear','first','revise'],
    format('kinds: %s', k);
  -- admin correcting a judged game keeps the owner's date
  ASSERT (SELECT evaluate_date FROM game_evaluations WHERE id = 32) = '2026-09-01 10:00+07', 'p2 date kept';
  -- admin judging Stale_release moves it (unjudged)
  ASSERT (SELECT evaluate_date FROM game_evaluations WHERE id = 33) > now() - interval '1 hour', 'p3 date moved';
  -- List_Idea promotion with a batch moves it (batch windows stay stable)
  ASSERT (SELECT evaluate_date FROM game_evaluations WHERE id = 34) > now() - interval '1 hour', 'p4 date moved';
  -- imported row re-saved unchanged keeps NULL
  ASSERT (SELECT evaluate_date FROM game_evaluations WHERE id = 35) IS NULL, 'p5 date stays NULL';
  -- typed ints landed as ints
  ASSERT (SELECT view_s FROM evaluation_log ORDER BY id LIMIT 1) = 60, 'view_s is an int';
END $$;

-- Without the join the log is empty: proves `UPDATE ... FROM old` is required.
PREPARE nojoin(unknown) AS
WITH old AS (SELECT id, game_id FROM game_evaluations WHERE id = $1 FOR UPDATE),
upd AS (UPDATE game_evaluations ge SET updated_by = 'x' WHERE ge.id = $1 RETURNING ge.*),
logged AS (INSERT INTO evaluation_log (game_evaluation_id, game_id, source, kind)
           SELECT old.id, old.game_id, 'other', 'other' FROM old)
SELECT id FROM upd;
-- (the server's EXECUTE cannot run inside PL/pgSQL, so it runs at top level)
CREATE TEMP TABLE c0 AS SELECT count(*) AS n FROM evaluation_log;
EXECUTE nojoin(31);
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM evaluation_log) = (SELECT n FROM c0),
    'expected no log row without the join (if this fails, Postgres changed; keep the join anyway)';
END $$;
DELETE FROM evaluation_log;
