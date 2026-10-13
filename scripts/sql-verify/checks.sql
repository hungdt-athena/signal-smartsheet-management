\set ON_ERROR_STOP 1
SET TIME ZONE 'UTC';

-- ===== Task 1: DDL + seed =====
-- The runner loads seed fixtures BEFORE the first 046 run (see verify-evaluation-log.sh),
-- so here we only assert outcomes.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM evaluation_log WHERE source = 'seed' AND kind = 'first';
  ASSERT n = 7, format('verdict seed rows: expected 7, got %s', n);

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
  ASSERT (SELECT created_at FROM evaluation_log WHERE game_evaluation_id = 7 AND kind = 'first') = '2026-10-02 08:00+07', 'g7 MIN tag';
  -- not seeded: no conclusion / no date
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id IN (8, 9)), 'g8/g9 not seeded';
END $$;

-- Record seed: one record_assign per confirmed game with a recorder in its effective bucket.
DO $$
DECLARE r record;
BEGIN
  ASSERT (SELECT count(*) FROM evaluation_log WHERE source = 'seed' AND kind = 'record_assign') = 2, 'record seed rows: 2';
  -- g7 has both seeds (the unique seed index allows one per kind)
  ASSERT (SELECT array_agg(kind ORDER BY kind) FROM evaluation_log WHERE game_evaluation_id = 7) = ARRAY['first','record_assign'], 'g7 verdict + record seed';
  SELECT * INTO r FROM evaluation_log WHERE game_evaluation_id = 7 AND kind = 'record_assign';
  ASSERT r.actor IS NULL AND r.owner = 'Alice' AND r.bucket_after = '20min' AND r.recorder_after = 'MyTL'
     AND r.recorder_before IS NULL AND r.bucket_before IS NULL, 'g7 record seed shape';
  ASSERT r.batch_before = 'W1 Oct, 2026' AND r.batch_after = 'W1 Oct, 2026' AND r.confidence = 'ok'
     AND r.created_at = '2026-10-03 10:00+07' AND r.view_s IS NULL, 'g7 record seed batch/confidence/time';
  -- manual bucket wins over the final conclusion
  SELECT * INTO r FROM evaluation_log WHERE game_evaluation_id = 10;
  ASSERT r.kind = 'record_assign' AND r.bucket_after = '5min' AND r.recorder_after = 'Bob' AND r.owner = 'Shortcut', 'g10 5min Bob';
  -- recorder outside the effective bucket / draft / no bucket: not seeded
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id IN (11, 12, 13)), 'g11/g12/g13 not seeded';
END $$;

-- Re-running 046 inserts nothing.
CREATE TEMP TABLE seed_n AS SELECT count(*) AS n FROM evaluation_log;
\i migrations/046_evaluation_log.sql
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM evaluation_log WHERE source = 'seed') = 9, 'seed is idempotent (7 verdict + 2 record)';
  ASSERT (SELECT count(*) FROM evaluation_log) = (SELECT n FROM seed_n), 'second run adds 0 rows';
  -- the old one-seed-per-game index is gone, the per-kind one is there
  ASSERT NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_evaluation_log_seed'), 'old seed index dropped';
  ASSERT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_evaluation_log_seed_kind'), 'per-kind seed index';
END $$;

-- After a live panel row exists, only games judged before it are seeded.
INSERT INTO game_info VALUES ('c1'), ('c2'), ('c3'), ('c4'), ('c5');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, initial_conclusion, evaluate_date) VALUES
  (20, 'c1', 'Alice', 'Bypass', '2026-10-09 11:59+07'),
  (21, 'c2', 'Alice', 'Bypass', '2026-10-09 12:05+07');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, final_conclusion, record_20min_assignee, record_confirmed_at) VALUES
  (23, 'c3', 'Alice', 'Priority IV', 'MyTL', '2026-10-09 11:59+07'),
  (24, 'c4', 'Alice', 'Priority IV', 'MyTL', '2026-10-09 12:05+07'),
  (25, 'c5', 'Alice', 'Priority IV', 'Bob',  '2026-10-09 11:00+07');
INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, source, context, kind, view_s, created_at)
  VALUES (2, 'g2', 'Alice', 'panel', 'evaluate', 'revise', 30, '2026-10-09 12:00+07');
-- c5 already has a live Record row: a seed added after it would become the "latest" one
INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, source, kind, bucket_after, recorder_after, created_at)
  VALUES (25, 'c5', 'VinhTD', 'record_tab', 'record_assign', '20min', 'Bob', '2026-10-09 11:00+07');
\i migrations/046_evaluation_log.sql
DO $$ BEGIN
  ASSERT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id = 20 AND source = 'seed'), 'c1 seeded (before cutover)';
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id = 21 AND source = 'seed'), 'c2 skipped (after cutover)';
  ASSERT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id = 23 AND source = 'seed' AND kind = 'record_assign'), 'c3 record seeded (before cutover)';
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id = 24 AND source = 'seed'), 'c4 record skipped (after cutover)';
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id = 25 AND source = 'seed'), 'c5 skipped (has a live Record row)';
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

-- Batch is logged next to the verdict. p4 (id 34) went 'W1 Aug, 2026' -> 'W2 Oct, 2026' above.
DO $$ BEGIN
  ASSERT (SELECT batch_before || '>' || batch_after FROM evaluation_log WHERE game_evaluation_id = 34)
         = 'W1 Aug, 2026>W2 Oct, 2026', 'batch change logged';
  -- a save that does not touch batch logs equal before/after (NULL stays NULL)
  ASSERT (SELECT batch_before IS NOT DISTINCT FROM batch_after FROM evaluation_log WHERE game_evaluation_id = 32 AND kind = 'final'), 'untouched NULL batch logs equal';
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id <> 34 AND batch_before IS DISTINCT FROM batch_after),
    'only the batch-changing save has batch_before <> batch_after';
END $$;
-- a non-NULL batch that a save leaves alone (concluding without sending a batch)
EXECUTE save(34, true, 'List_Idea', NULL, NULL, 'HungDT', 'admin', 'panel', 'evaluate', 7, 0, 0, true, false);
-- a manager moving only the batch (same verdict): kind 'revise', changed false
EXECUTE save(34, false, NULL, 'W3 Oct, 2026', NULL, 'HungDT', 'admin', 'panel', 'evaluate', 8, 0, 0, true, false);
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM (SELECT * FROM evaluation_log WHERE game_evaluation_id = 34 ORDER BY id DESC OFFSET 1 LIMIT 1) x;
  ASSERT r.batch_before = 'W2 Oct, 2026' AND r.batch_after = 'W2 Oct, 2026', 'untouched non-NULL batch logs equal';
  SELECT * INTO r FROM evaluation_log WHERE game_evaluation_id = 34 ORDER BY id DESC LIMIT 1;
  ASSERT r.batch_before = 'W2 Oct, 2026' AND r.batch_after = 'W3 Oct, 2026', 'W2 -> W3 logged';
  ASSERT r.changed = false AND r.kind = 'revise', 'batch-only save is a revise without a verdict change';
END $$;

-- Without the join the log is empty: proves `UPDATE ... FROM old` is required.
PREPARE nojoin(unknown) AS
WITH old AS (SELECT id, game_id FROM game_evaluations WHERE id = $1 FOR NO KEY UPDATE),
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

-- ===== Task 4: add-to-record legacy branch logs and keeps auto-fill =====
INSERT INTO game_info VALUES ('r1'), ('r2');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, initial_conclusion, evaluate_date) VALUES
 (41, 'r1', 'HuyDD', 'Bypass', '2026-10-01 10:00+07'),
 (42, 'r2', 'HuyDD', 'List_Idea', '2026-10-01 10:00+07');
PREPARE atr(unknown, unknown, unknown) AS
WITH old AS (
  SELECT id, game_id, initial_conclusion, initial_evaluator, final_conclusion, evaluate_date, batch
  FROM game_evaluations WHERE game_id = $1 AND category_group = 'puzzle' FOR NO KEY UPDATE
), upd AS (
  UPDATE game_evaluations ge SET
    initial_evaluator = CASE WHEN (ge.initial_conclusion IS NULL OR ge.initial_conclusion ILIKE '%bypass%') THEN 'Shortcut' ELSE ge.initial_evaluator END,
    initial_conclusion = CASE WHEN (ge.initial_conclusion IS NULL OR ge.initial_conclusion ILIKE '%bypass%') THEN 'List_Idea' ELSE ge.initial_conclusion END
  FROM old WHERE ge.id = old.id
  RETURNING ge.id, ge.initial_evaluator, ge.initial_conclusion, ge.final_conclusion, ge.batch
), logged AS (
  INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, owner, source, kind,
    conclusion_before, conclusion_after, changed, batch_before, batch_after, bucket_after, owner_after)
  SELECT old.id, old.game_id, $2::text, old.initial_evaluator, 'add_to_record', 'record_add',
    old.initial_conclusion, upd.initial_conclusion, old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion,
    old.batch, upd.batch, $3::text, upd.initial_evaluator
  FROM old JOIN upd ON upd.id = old.id
)
SELECT id FROM upd;
EXECUTE atr('r1', 'VinhTD', '20min');
EXECUTE atr('r2', 'VinhTD', '5min');
DO $$ BEGIN
  ASSERT (SELECT initial_evaluator FROM game_evaluations WHERE id = 41) = 'Shortcut', 'r1 auto-filled';
  ASSERT (SELECT initial_evaluator FROM game_evaluations WHERE id = 42) = 'HuyDD', 'r2 kept';
  ASSERT (SELECT owner || ':' || conclusion_before || '>' || conclusion_after FROM evaluation_log WHERE game_evaluation_id = 41)
         = 'HuyDD:Bypass>List_Idea', 'r1 log shows what was overridden';
  ASSERT (SELECT changed FROM evaluation_log WHERE game_evaluation_id = 42) = false, 'r2 logged, unchanged';
  ASSERT (SELECT batch_before IS NOT DISTINCT FROM batch_after FROM evaluation_log WHERE game_evaluation_id = 41), 'r1 batch equal';
  ASSERT (SELECT kind || ':' || bucket_after || ':' || owner || '>' || owner_after FROM evaluation_log WHERE game_evaluation_id = 41)
         = 'record_add:20min:HuyDD>Shortcut', 'r1 record_add with bucket and owner change';
  ASSERT (SELECT kind || ':' || bucket_after || ':' || owner || '>' || owner_after FROM evaluation_log WHERE game_evaluation_id = 42)
         = 'record_add:5min:HuyDD>HuyDD', 'r2 record_add, owner kept';
  ASSERT (SELECT bool_and(bucket_before IS NULL AND recorder_before IS NULL AND recorder_after IS NULL AND view_s IS NULL)
          FROM evaluation_log WHERE game_evaluation_id IN (41, 42)), 'record_add carries no recorder and no time';
END $$;
DELETE FROM evaluation_log;

-- ===== Record events: confirm, move, remove, PATCH side rows =====
-- Hand copies of the statements in confirm-records/route.ts, record-bucket/route.ts and
-- the PATCH's logged_rec CTE. Parameters stay untyped, as postgres.js sends them.

-- EXECUTE of a data-modifying statement cannot feed CREATE TABLE AS, so the confirm
-- count comes back through \gset and is checked here.
CREATE FUNCTION pg_temp.check_eq(got int, want int, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  ASSERT got = want, format('%s: expected %s, got %s', msg, want, got);
END $$;

-- confirm-records (set branch). $1..$3 the ids (sql(list) expands to a list), $4 actor, $5 role.
PREPARE confirm(unknown, unknown, unknown, unknown, unknown) AS
WITH old AS (
  SELECT id, game_id, initial_evaluator, batch, record_bucket, final_conclusion,
    record_5min_assignee, record_20min_assignee
  FROM game_evaluations
  WHERE id IN ($1, $2, $3) AND record_confirmed_at IS NULL
  FOR NO KEY UPDATE
), upd AS (
  UPDATE game_evaluations ge
  SET record_confirmed_at = NOW()
  FROM old WHERE ge.id = old.id
  RETURNING ge.id
), cur AS (
  SELECT old.id, old.game_id, old.initial_evaluator, old.batch, eb.bucket,
    CASE eb.bucket WHEN '5min' THEN old.record_5min_assignee
                   WHEN '20min' THEN old.record_20min_assignee END AS recorder,
    (SELECT l.recorder_after FROM evaluation_log l
     WHERE l.game_evaluation_id = old.id
       AND l.kind IN ('record_assign', 'record_move', 'record_remove')
     ORDER BY l.id DESC LIMIT 1) AS prev_recorder
  FROM old JOIN upd ON upd.id = old.id
  CROSS JOIN LATERAL (SELECT CASE
    WHEN old.record_bucket IN ('5min', '20min') THEN old.record_bucket
    WHEN old.final_conclusion = 'Priority IV' THEN '20min'
    WHEN old.final_conclusion = 'Insight' THEN '5min'
  END AS bucket) eb
), logged AS (
  INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, actor_role, owner, source,
    kind, bucket_after, recorder_before, recorder_after, batch_before, batch_after)
  SELECT cur.id, cur.game_id, $4::text, $5::text, cur.initial_evaluator, 'record_tab',
    'record_assign', cur.bucket, cur.prev_recorder, cur.recorder, cur.batch, cur.batch
  FROM cur
  WHERE cur.recorder IS NOT NULL AND lower(cur.recorder) IS DISTINCT FROM lower(cur.prev_recorder)
)
SELECT count(*)::int AS confirmed FROM upd;

-- confirm-records (unset branch): unchanged, logs nothing.
PREPARE reset_rec(unknown) AS
UPDATE game_evaluations SET record_confirmed_at = NULL WHERE id IN ($1) AND record_confirmed_at IS NOT NULL;

-- assign-records (draft): not logged; a plain write of the recorder column is enough here.
-- record-bucket move. The route computes cur / curAssignee in JS; the harness passes them.
-- $1 id, $2 bucket, $3 5min col, $4 20min col, $5 actor, $6 role, $7 kind, $8 cur,
-- $9 bucketAfter, $10 curAssignee, $11 recorderAfter
PREPARE rb_move(unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown) AS
WITH upd AS (
  UPDATE game_evaluations SET
    record_bucket = $2,
    record_5min_assignee = $3,
    record_20min_assignee = $4
  WHERE id = $1
  RETURNING *
), logged AS (
  INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, actor_role, owner, source,
    kind, bucket_before, bucket_after, recorder_before, recorder_after, batch_before, batch_after)
  SELECT upd.id, upd.game_id, $5::text, $6::text, upd.initial_evaluator, 'record_tab',
    $7::text, $8::text, $9::text, $10::text, $11::text,
    upd.batch, upd.batch
  FROM upd
)
SELECT * FROM upd;
-- record-bucket remove. $1 id, $2 actor, $3 role, $4 kind, $5 cur, $6 bucketAfter, $7 curAssignee, $8 recorderAfter
PREPARE rb_remove(unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown) AS
WITH upd AS (
  UPDATE game_evaluations SET
    record_bucket = 'none',
    record_5min_assignee = NULL,
    record_20min_assignee = NULL,
    record_confirmed_at = NULL
  WHERE id = $1
  RETURNING *
), logged AS (
  INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, actor_role, owner, source,
    kind, bucket_before, bucket_after, recorder_before, recorder_after, batch_before, batch_after)
  SELECT upd.id, upd.game_id, $2::text, $3::text, upd.initial_evaluator, 'record_tab',
    $4::text, $5::text, $6::text, $7::text, $8::text,
    upd.batch, upd.batch
  FROM upd
)
SELECT * FROM upd;
-- record-bucket no-op: the plain UPDATE path (same bucket picked again).
PREPARE rb_plain(unknown, unknown, unknown, unknown) AS
UPDATE game_evaluations SET record_bucket = $2, record_5min_assignee = $3, record_20min_assignee = $4
WHERE id = $1 RETURNING *;

INSERT INTO game_info VALUES ('k1'), ('k2'), ('k3'), ('k4'), ('k5'), ('k6');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, initial_conclusion, final_conclusion, batch,
  record_bucket, record_5min_assignee, record_20min_assignee, record_confirmed_at) VALUES
 (61, 'k1', 'Alice', 'List_Idea', 'Priority IV', 'W2 Oct, 2026', NULL, NULL, 'MyTL', NULL),
 (62, 'k2', 'Alice', 'List_Idea', 'Insight', 'W2 Oct, 2026', NULL, NULL, NULL, NULL),   -- no recorder
 (63, 'k3', 'Bob', 'List_Idea', 'Insight', NULL, NULL, 'Carol', NULL, NULL),
 (64, 'k4', 'Bob', 'List_Idea', 'Priority IV', NULL, NULL, NULL, 'Dave', NULL),
 (65, 'k5', 'Bob', 'List_Idea', NULL, NULL, '5min', 'Carol', NULL, NULL);

-- 1. First confirm logs the assignment once.
EXECUTE confirm(61, 61, 61, 'VinhTD', 'moderator') \gset cf1_
SELECT pg_temp.check_eq(:cf1_confirmed, 1, 'confirm returns rows updated') \g /dev/null
DO $$
DECLARE r record;
BEGIN
  ASSERT (SELECT count(*) FROM evaluation_log WHERE game_evaluation_id = 61) = 1, 'assign logged once at confirm';
  SELECT * INTO r FROM evaluation_log WHERE game_evaluation_id = 61;
  ASSERT r.kind = 'record_assign' AND r.source = 'record_tab' AND r.actor = 'VinhTD' AND r.actor_role = 'moderator'
     AND r.owner = 'Alice', 'confirm row: kind/source/actor/owner';
  ASSERT r.bucket_before IS NULL AND r.bucket_after = '20min' AND r.recorder_before IS NULL AND r.recorder_after = 'MyTL',
    'confirm row: bucket + recorder';
  ASSERT r.batch_before = 'W2 Oct, 2026' AND r.batch_after = 'W2 Oct, 2026' AND r.view_s IS NULL AND r.context IS NULL,
    'confirm row: batch, no time';
END $$;
-- 2. Confirming a row that is already confirmed updates nothing and logs nothing.
EXECUTE confirm(61, 61, 61, 'VinhTD', 'moderator') \gset cf2_
SELECT pg_temp.check_eq(:cf2_confirmed, 0, 'already confirmed: 0 updated') \g /dev/null
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM evaluation_log WHERE game_evaluation_id = 61) = 1, 'already confirmed: no new row';
END $$;
-- 3. Reset (not logged), confirm again with the same recorder: confirmed, nothing logged.
EXECUTE reset_rec(61);
EXECUTE confirm(61, 61, 61, 'VinhTD', 'moderator') \gset cf3_
SELECT pg_temp.check_eq(:cf3_confirmed, 1, 're-confirm after reset updates the row') \g /dev/null
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM evaluation_log WHERE game_evaluation_id = 61) = 1, 'second confirm of the same recorder logs nothing';
  ASSERT (SELECT record_confirmed_at FROM game_evaluations WHERE id = 61) IS NOT NULL, 'confirmed again';
END $$;
-- 3b. Same person typed with other casing (MyTL / mytl) is still the same person: nothing logged.
EXECUTE reset_rec(61);
UPDATE game_evaluations SET record_20min_assignee = 'mytl' WHERE id = 61;
EXECUTE confirm(61, 61, 61, 'VinhTD', 'moderator') \gset cf3b_
SELECT pg_temp.check_eq(:cf3b_confirmed, 1, 'recasing: confirmed again') \g /dev/null
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM evaluation_log WHERE game_evaluation_id = 61) = 1, 'MyTL vs mytl logs nothing';
END $$;
-- 4. Reset, draft-assign someone else (assign-records: not logged), confirm: reassign MyTL -> Bob.
EXECUTE reset_rec(61);
UPDATE game_evaluations SET record_20min_assignee = 'Bob' WHERE id = 61;
EXECUTE confirm(61, 61, 61, 'HungDT', 'admin') \gset cf4_
DO $$
DECLARE r record;
BEGIN
  ASSERT (SELECT count(*) FROM evaluation_log WHERE game_evaluation_id = 61) = 2, 'reassign logged';
  SELECT * INTO r FROM evaluation_log WHERE game_evaluation_id = 61 ORDER BY id DESC LIMIT 1;
  ASSERT r.recorder_before = 'MyTL' AND r.recorder_after = 'Bob' AND r.actor = 'HungDT' AND r.bucket_after = '20min',
    'reassign after reset logs before -> after';
END $$;
-- 5. Bulk confirm of 3: all 3 confirmed; 62 has no recorder (no row), 63 (5min Carol) and 64 (20min Dave) log.
EXECUTE confirm(62, 63, 64, 'VinhTD', 'moderator') \gset cf5_
SELECT pg_temp.check_eq(:cf5_confirmed, 3, 'bulk: 3 confirmed') \g /dev/null
DO $$ BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id = 62), 'no recorder: no row';
  ASSERT (SELECT bucket_after || ':' || recorder_after FROM evaluation_log WHERE game_evaluation_id = 63) = '5min:Carol', '63 logged';
  ASSERT (SELECT bucket_after || ':' || recorder_after FROM evaluation_log WHERE game_evaluation_id = 64) = '20min:Dave', '64 logged';
END $$;
-- manual bucket (record_bucket '5min', no final) is the effective bucket
EXECUTE confirm(65, 65, 65, 'VinhTD', 'moderator') \gset cf6_
DO $$ BEGIN
  ASSERT (SELECT bucket_after || ':' || recorder_after FROM evaluation_log WHERE game_evaluation_id = 65) = '5min:Carol', 'manual bucket wins';
END $$;

-- 6. Move 61 from 20min to 5min, recorder Bob carried.
EXECUTE rb_move(61, '5min', 'Bob', NULL, 'VinhTD', 'moderator', 'record_move', '20min', '5min', 'Bob', 'Bob') \g /dev/null
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM evaluation_log WHERE game_evaluation_id = 61 ORDER BY id DESC LIMIT 1;
  ASSERT r.kind = 'record_move' AND r.source = 'record_tab' AND r.bucket_before = '20min' AND r.bucket_after = '5min'
     AND r.recorder_before = 'Bob' AND r.recorder_after = 'Bob' AND r.owner = 'Alice' AND r.batch_after = 'W2 Oct, 2026',
    'move row';
  ASSERT (SELECT record_bucket || ':' || record_5min_assignee FROM game_evaluations WHERE id = 61) = '5min:Bob', 'moved';
  ASSERT (SELECT record_20min_assignee FROM game_evaluations WHERE id = 61) IS NULL, 'old column cleared';
  ASSERT (SELECT record_confirmed_at FROM game_evaluations WHERE id = 61) IS NOT NULL, 'move keeps confirmation';
END $$;
-- after a move, reset + confirm Bob again: the previous recorder is read from the move row, so nothing is logged
EXECUTE reset_rec(61);
EXECUTE confirm(61, 61, 61, 'VinhTD', 'moderator') \gset cf7_
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM evaluation_log WHERE game_evaluation_id = 61) = 3, 'previous recorder comes from the move row';
END $$;
-- 7. No-op: picking the same bucket again is the plain UPDATE, no row.
CREATE TEMP TABLE c_noop AS SELECT count(*) AS n FROM evaluation_log;
EXECUTE rb_plain(61, '5min', 'Bob', NULL) \g /dev/null
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM evaluation_log) = (SELECT n FROM c_noop), 'no-op logs nothing';
END $$;
-- 8. Remove 61 from Record.
EXECUTE rb_remove(61, 'VinhTD', 'moderator', 'record_remove', '5min', NULL, 'Bob', NULL) \g /dev/null
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM evaluation_log WHERE game_evaluation_id = 61 ORDER BY id DESC LIMIT 1;
  ASSERT r.kind = 'record_remove' AND r.bucket_before = '5min' AND r.bucket_after IS NULL
     AND r.recorder_before = 'Bob' AND r.recorder_after IS NULL AND r.view_s IS NULL, 'remove row';
  ASSERT (SELECT record_bucket FROM game_evaluations WHERE id = 61) = 'none', 'removed';
  ASSERT (SELECT record_confirmed_at IS NULL AND record_5min_assignee IS NULL FROM game_evaluations WHERE id = 61), 'remove clears';
END $$;

-- 9. PATCH side rows (logged_rec). Minimal PATCH copy: recorder columns + the main log row + logged_rec.
-- $1 id, $2 record_5min_assignee, $3 record_20min_assignee, $4 actor, $5 role, $6 source, $7 context
PREPARE save_rec(unknown, unknown, unknown, unknown, unknown, unknown, unknown) AS
WITH old AS (
  SELECT id, game_id, initial_conclusion, initial_evaluator, final_conclusion, evaluate_date, batch,
    record_5min_assignee, record_20min_assignee, record_confirmed_at
  FROM game_evaluations WHERE id = $1
  FOR NO KEY UPDATE
), upd AS (
  UPDATE game_evaluations ge SET
    record_5min_assignee = COALESCE($2::text, ge.record_5min_assignee),
    record_5min_date = CASE WHEN $2::text IS NOT NULL AND ge.record_5min_assignee IS NULL THEN NOW() ELSE ge.record_5min_date END,
    record_20min_assignee = COALESCE($3::text, ge.record_20min_assignee),
    record_20min_date = CASE WHEN $3::text IS NOT NULL AND ge.record_20min_assignee IS NULL THEN NOW() ELSE ge.record_20min_date END,
    updated_by = $4::text
  FROM old WHERE ge.id = old.id
  RETURNING ge.*
), logged AS (
  INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, actor_role, owner, source,
    context, kind, conclusion_before, conclusion_after, final_before, final_after, changed,
    view_s, hidden_s, idle_s, batch_before, batch_after)
  SELECT old.id, old.game_id, $4::text, $5::text, old.initial_evaluator, $6::text, $7::text,
    'other', old.initial_conclusion, upd.initial_conclusion, old.final_conclusion, upd.final_conclusion,
    old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion,
    NULL::int, NULL::int, NULL::int, old.batch, upd.batch
  FROM old JOIN upd ON upd.id = old.id
), logged_rec AS (
  INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, actor_role, owner, source,
    context, kind, bucket_after, recorder_before, recorder_after,
    view_s, hidden_s, idle_s, batch_before, batch_after)
  SELECT old.id, old.game_id, $4::text, $5::text, old.initial_evaluator, $6::text, $7::text,
    'record_assign', v.bucket, v.before, v.after,
    NULL::int, NULL::int, NULL::int, old.batch, upd.batch
  FROM old JOIN upd ON upd.id = old.id
  CROSS JOIN LATERAL (VALUES ('5min', old.record_5min_assignee, upd.record_5min_assignee),
                             ('20min', old.record_20min_assignee, upd.record_20min_assignee)) AS v(bucket, before, after)
  WHERE old.record_confirmed_at IS NOT NULL
    AND v.after IS NOT NULL
    AND lower(v.before) IS DISTINCT FROM lower(v.after)
)
SELECT id FROM upd;

INSERT INTO game_info VALUES ('k7'), ('k8');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, final_conclusion, batch, record_20min_assignee, record_confirmed_at) VALUES
 (67, 'k7', 'Alice', 'Priority IV', 'W2 Oct, 2026', 'MyTL', NULL),                      -- draft
 (68, 'k8', 'Alice', 'Priority IV', 'W2 Oct, 2026', 'MyTL', '2026-10-10 10:00+07');    -- confirmed
EXECUTE save_rec(67, NULL, 'Bob', 'VinhTD', 'moderator', 'other', NULL);
EXECUTE save_rec(68, NULL, 'Bob', 'VinhTD', 'moderator', 'other', NULL);
EXECUTE save_rec(68, NULL, 'Bob', 'VinhTD', 'moderator', 'panel', 'record');   -- same recorder again
DO $$
DECLARE r record;
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id = 67 AND kind = 'record_assign'), 'PATCH on a draft logs no record row';
  ASSERT (SELECT count(*) FROM evaluation_log WHERE game_evaluation_id = 67) = 1, 'draft: only the save row';
  ASSERT (SELECT count(*) FROM evaluation_log WHERE game_evaluation_id = 68 AND kind = 'record_assign') = 1, 'PATCH on a confirmed row logs one';
  SELECT * INTO r FROM evaluation_log WHERE game_evaluation_id = 68 AND kind = 'record_assign';
  ASSERT r.bucket_after = '20min' AND r.recorder_before = 'MyTL' AND r.recorder_after = 'Bob' AND r.source = 'other'
     AND r.context IS NULL AND r.actor = 'VinhTD' AND r.view_s IS NULL AND r.hidden_s IS NULL AND r.idle_s IS NULL
     AND r.batch_after = 'W2 Oct, 2026', 'PATCH record row shape';
END $$;
-- PATCH that only re-cases the recorder on a confirmed row logs no record row.
INSERT INTO game_info VALUES ('k9');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, final_conclusion, batch, record_20min_assignee, record_confirmed_at)
  VALUES (69, 'k9', 'Alice', 'Priority IV', 'W2 Oct, 2026', 'MyTL', '2026-10-10 10:00+07');
EXECUTE save_rec(69, NULL, 'mytl', 'VinhTD', 'moderator', 'other', NULL);
DO $$ BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id = 69 AND kind = 'record_assign'), 'PATCH re-casing a recorder logs nothing';
END $$;
DELETE FROM evaluation_log;

-- ===== Task 8: panel time query (keep identical to lib/evaluation-hours.ts) =====
INSERT INTO game_info SELECT 'h'||i FROM generate_series(1,20) i;
INSERT INTO game_evaluations (id, game_id) SELECT 100+i, 'h'||i FROM generate_series(1,20) i;
INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, source, context, kind, view_s, idle_s, hidden_s, created_at) VALUES
 (101,'h1','Carol','panel','evaluate','first', 600,0,0,'2026-10-05 09:10+07'),
 (102,'h2','Carol','panel','evaluate','first', 600,0,0,'2026-10-05 09:15+07'),
 (103,'h3','Carol','panel','evaluate','first',1800,0,0,'2026-10-05 09:50+07'),
 (104,'h4','Carol','panel','evaluate','first', 300,0,0,'2026-10-05 09:30+07'),
 (105,'h5','Carol','panel','evaluate','first', 900,0,0,'2026-10-05 10:00+07'),
 (106,'h6','Carol','panel','evaluate','first', 300,0,0,'2026-10-05 10:30:00+07'),
 (106,'h6','Carol','panel','evaluate','revise',302,0,0,'2026-10-05 10:30:02+07'),
 (107,'h7','Carol','panel','evaluate','first',4800,4000,0,'2026-10-05 12:00+07'),
 (108,'h8','Carol','panel','evaluate','first', 300,0,0,'2026-10-05 13:05:00+07'),
 (108,'h8','Carol','panel','evaluate','revise',  2,0,0,'2026-10-05 13:05:02+07'),
 (108,'h8','Carol','panel','evaluate','revise',  3,0,0,'2026-10-05 13:05:05+07'),
 (113,'h13','Carol','panel','record','other',3000,0,0,'2026-10-05 16:00+07'),
 (114,'h14','Carol','panel','evaluate','final',600,0,0,'2026-10-05 17:00+07'),
 (115,'h15','Carol','other','evaluate','first',600,0,0,'2026-10-05 18:00+07'),
 (109,'h9','Carol','panel','evaluate','first', 600,0,0,'2026-10-05 23:55+07'),
 (110,'h10','Carol','panel','evaluate','first',1200,0,0,'2026-10-06 00:10+07'),
 (111,'h11','Shortcut','panel','evaluate','first',600,0,0,'2026-10-05 09:10+07'),
 (112,'h12','VinhTD','panel','evaluate','first',600,0,0,'2026-10-05 09:10+07'),
 (116,'h16',NULL,'panel','evaluate','first',600,0,0,'2026-10-05 09:10+07'),
 (117,'h17','Dave','panel','evaluate','first',600,0,0,'2026-10-05 09:10+07'),
 (118,'h18','Dave','panel','evaluate','first',NULL,0,0,'2026-10-05 11:10+07'),
 (119,'h19','HungDT','panel','evaluate','revise',600,0,0,'2026-10-05 09:10+07');

PREPARE panel_time(unknown, unknown, text[]) AS
WITH first_demo AS (
  SELECT * FROM (
    SELECT l.*, ROW_NUMBER() OVER (
             PARTITION BY COALESCE(l.game_evaluation_id::text, 'g:' || l.game_id)
             ORDER BY l.created_at, l.id) AS rn
    FROM evaluation_log l WHERE l.demo_added
  ) d WHERE d.rn = 1
), iv AS (
  SELECT lower(l.actor) AS who,
         l.created_at - make_interval(secs => LEAST(l.view_s, 1800)) AS s,
         l.created_at AS e,
         l.view_s > 1800 AS capped,
         l.idle_s, l.hidden_s
  FROM evaluation_log l
  JOIN dashboard_users du ON lower(du.name) = lower(l.actor)
  WHERE l.source = 'panel'
    AND l.view_s IS NOT NULL
    AND du.title = ANY($3)
    AND l.created_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
    AND l.created_at <  ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
  UNION ALL
  SELECT lower(l.actor), l.created_at - make_interval(secs => 300), l.created_at, FALSE, 0, 0
  FROM first_demo l
  JOIN dashboard_users du ON lower(du.name) = lower(l.actor)
  WHERE l.source = 'other'
    AND l.kind IN ('revise', 'other')
    AND l.conclusion_before IS NOT NULL AND l.conclusion_before <> 'Stale_release'
    AND du.title = ANY($3)
    AND l.created_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
    AND l.created_at <  ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
), ord AS (
  SELECT *, MAX(e) OVER (PARTITION BY who ORDER BY s, e
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_e
  FROM iv
), grp AS (
  SELECT *, SUM(CASE WHEN prev_e IS NULL OR s > prev_e THEN 1 ELSE 0 END)
              OVER (PARTITION BY who ORDER BY s, e) AS g
  FROM ord
), blocks AS (
  SELECT who, g, MIN(s) AS block_start, MAX(e) AS block_end,
         COUNT(*) FILTER (WHERE capped) AS n_capped,
         SUM(idle_s) AS idle_s, SUM(hidden_s) AS hidden_s
  FROM grp GROUP BY who, g
)
SELECT who, to_char((block_end AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS day,
       round(SUM(EXTRACT(EPOCH FROM (block_end - block_start))) / 3600.0, 4)::float8 AS hours,
       SUM(n_capped)::int AS capped_saves,
       COALESCE(SUM(idle_s), 0)::int AS idle_s, COALESCE(SUM(hidden_s), 0)::int AS hidden_s
FROM blocks
GROUP BY 1, 2
ORDER BY 1, 2;

CREATE TEMP TABLE got AS EXECUTE panel_time('2026-10-01', '2026-10-09', ARRAY['Fulltime','Freelancer']);
DO $$ BEGIN
  -- 15 + 40 + 5.033 + 30 (capped) + 5.083 + 30 (record, capped) + 10 (final) = 135.117 min
  -- hours is rounded to 4 decimals, so compare minutes with a small tolerance
  ASSERT (SELECT abs(hours * 60 - 135.1167) < 0.01 FROM got WHERE who = 'carol' AND day = '2026-10-05'), 'carol 10-05';
  ASSERT (SELECT capped_saves FROM got WHERE who = 'carol' AND day = '2026-10-05') = 2, 'carol capped';
  ASSERT (SELECT idle_s FROM got WHERE who = 'carol' AND day = '2026-10-05') = 4000, 'carol idle';
  -- 23:45-23:55 and 23:50-00:10 merge into one 25-min block, credited to 10-06
  ASSERT (SELECT abs(hours * 60 - 25) < 0.01 FROM got WHERE who = 'carol' AND day = '2026-10-06'), 'midnight merge';
  -- NULL view_s is excluded (not a silent 30 min)
  ASSERT (SELECT abs(hours * 60 - 10) < 0.01 FROM got WHERE who = 'dave'), 'dave 10 (NULL view_s excluded)';
  -- admins, moderators, system accounts and NULL actors never appear
  ASSERT NOT EXISTS (SELECT 1 FROM got WHERE who IN ('hungdt', 'vinhtd', 'shortcut') OR who IS NULL), 'only titled people';
END $$;

-- ---------- Demo-link credit (migration 047; mirrors the PATCH `demo_added` column) ----------
-- Trimmed copy of the route's save: only drive_link, so the demo_added expression runs for real.
-- $1 id, $2 drive_link (NULL = clear), $3 actor, $4 source, $5 view_s
PREPARE save_demo(unknown, unknown, unknown, unknown, unknown) AS
WITH old AS (
  SELECT id, game_id, initial_conclusion, initial_evaluator, drive_link FROM game_evaluations
  WHERE id = $1 FOR NO KEY UPDATE
), upd AS (
  UPDATE game_evaluations ge SET drive_link = $2::text, updated_by = $3::text
  FROM old WHERE ge.id = old.id RETURNING ge.*
), logged AS (
  INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, owner, source, kind,
    conclusion_before, conclusion_after, changed, view_s, demo_added)
  SELECT old.id, old.game_id, $3::text, old.initial_evaluator, $4::text, 'revise',
    old.initial_conclusion, upd.initial_conclusion, FALSE, $5::int,
    COALESCE(old.drive_link, '') = '' AND COALESCE(upd.drive_link, '') <> ''
  FROM old JOIN upd ON upd.id = old.id
)
SELECT id FROM upd;

INSERT INTO game_info VALUES ('d200'),('d201'),('d202'),('d203');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, initial_conclusion, evaluate_date) VALUES
  (200,'d200','Alice','Bypass','2026-10-12 09:00+07'),   -- judged, link added off-panel
  (201,'d201','Alice','Bypass','2026-10-12 09:00+07'),   -- judged, link added in the panel
  (202,'d202','Alice',NULL,NULL),                        -- never judged
  (203,'d203','Alice','Bypass','2026-10-12 09:00+07');   -- link added off-panel by a manager
EXECUTE save_demo(200, 'https://d/200', 'Alice', 'other', NULL);
EXECUTE save_demo(200, 'https://d/200', 'Alice', 'other', NULL);   -- same link again: not "added"
EXECUTE save_demo(200, NULL, 'Alice', 'other', NULL);              -- cleared
EXECUTE save_demo(200, 'https://d/200b', 'Alice', 'other', NULL);  -- re-added: still one credit
EXECUTE save_demo(201, 'https://d/201', 'Alice', 'panel', 120);
EXECUTE save_demo(202, 'https://d/202', 'Alice', 'other', NULL);
EXECUTE save_demo(203, 'https://d/203', 'HungDT', 'other', NULL);
-- pin the timestamps (the saves above all ran "now")
UPDATE evaluation_log SET created_at = '2026-10-12 10:00+07' WHERE game_id = 'd200' AND id = (SELECT min(id) FROM evaluation_log WHERE game_id = 'd200');
UPDATE evaluation_log SET created_at = '2026-10-12 10:30+07' WHERE game_id = 'd200' AND created_at > NOW() - INTERVAL '1 hour';
UPDATE evaluation_log SET created_at = '2026-10-12 14:00+07' WHERE game_id = 'd201';
UPDATE evaluation_log SET created_at = '2026-10-12 16:00+07' WHERE game_id IN ('d202', 'd203');
DO $$ BEGIN
  ASSERT (SELECT array_agg(demo_added ORDER BY id) FROM evaluation_log WHERE game_id = 'd200') = ARRAY[true, false, false, true],
    'demo_added: empty->value only';
  ASSERT (SELECT demo_added FROM evaluation_log WHERE game_id = 'd201'), 'panel save adding the link is demo_added';
END $$;
CREATE TEMP TABLE got_demo AS EXECUTE panel_time('2026-10-12', '2026-10-12', ARRAY['Fulltime','Freelancer']);
DO $$ BEGIN
  -- d200: +5 (off-panel, judged, first link). d201: 2 min panel time, no credit on top.
  -- d200 re-add: no second credit. d202: never judged. d203: HungDT is not a titled person.
  ASSERT (SELECT abs(hours * 60 - 7) < 0.01 FROM got_demo WHERE who = 'alice' AND day = '2026-10-12'),
    'alice 10-12: 5 (off-panel first link) + 2 (panel) = 7 min';
  ASSERT NOT EXISTS (SELECT 1 FROM got_demo WHERE who = 'hungdt'), 'manager credit excluded';
END $$;
-- The credit merges with panel time instead of adding to it: Bob's off-panel link at 11:05 gets
-- the window 11:00-11:05, which is exactly his 5-minute panel block, so the day totals 5 min.
INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, source, context, kind, view_s, created_at)
  VALUES (NULL, 'ov1', 'Bob', 'panel', 'evaluate', 'first', 300, '2026-10-12 11:05+07');
INSERT INTO game_info VALUES ('d204');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, initial_conclusion, evaluate_date)
  VALUES (204,'d204','Bob','Bypass','2026-10-12 09:00+07');
EXECUTE save_demo(204, 'https://d/204', 'Bob', 'other', NULL);
UPDATE evaluation_log SET created_at = '2026-10-12 11:05+07' WHERE game_id = 'd204';
CREATE TEMP TABLE got_demo2 AS EXECUTE panel_time('2026-10-12', '2026-10-12', ARRAY['Fulltime','Freelancer']);
DO $$ BEGIN
  ASSERT (SELECT abs(hours * 60 - 5) < 0.01 FROM got_demo2 WHERE who = 'bob'),
    'credit window 11:00-11:05 equals the panel block 11:00-11:05: merged, 5 min not 10';
END $$;

-- Games per day (mirrors lib/evaluation-hours.ts): a 'first' row whose game_evaluations
-- row was deleted (game_evaluation_id NULL) still counts as one game.
INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, source, context, kind, view_s, created_at)
  VALUES (NULL, 'gone1', 'Carol', 'panel', 'evaluate', 'first', 60, '2026-10-07 10:00+07'),
         (NULL, 'gone2', 'Carol', 'panel', 'evaluate', 'first', 60, '2026-10-07 10:05+07'),
         (NULL, 'gone2', 'Carol', 'panel', 'evaluate', 'first', 60, '2026-10-07 10:06+07');
DO $$ BEGIN
  ASSERT (SELECT count(DISTINCT COALESCE(l.game_evaluation_id::text, 'g:' || l.game_id))::int
          FROM evaluation_log l
          WHERE l.kind = 'first' AND lower(l.actor) = 'carol'
            AND (l.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = '2026-10-07') = 2,
    'NULL game_evaluation_id first rows still count: 2 distinct games';
END $$;

-- ---------- History modal (mirrors app/api/evaluations/[gameId]/history/route.ts) ----------
-- Untyped params, as postgres.js sends strings: `$1 = ANY(text[])` must resolve to text.
INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, owner, source, context, kind,
  conclusion_before, conclusion_after, changed, view_s, created_at, batch_before, batch_after) VALUES
  (NULL, 'hist1', NULL, 'Alice', 'seed', NULL, 'first', NULL, 'Bypass', TRUE, NULL, '2026-10-01 10:00+07', NULL, NULL),
  (NULL, 'hist1', 'Alice', 'Alice', 'panel', 'evaluate', 'revise', 'Bypass', 'List_Idea', TRUE, 300, '2026-10-03 10:00+07', 'W1 Oct, 2026', 'W2 Oct, 2026'),
  (NULL, 'hist2', 'Bob', 'Bob', 'panel', 'evaluate', 'first', NULL, 'Bypass', TRUE, 60, '2026-10-03 11:00+07', NULL, NULL);
INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, owner, source, kind, bucket_before, bucket_after,
  recorder_before, recorder_after, owner_after, created_at) VALUES
  (NULL, 'hist1', 'VinhTD', 'Alice', 'record_tab', 'record_move', '20min', '5min', 'MyTL', 'MyTL', NULL, '2026-10-04 10:00+07'),
  (NULL, 'hist1', 'VinhTD', 'Alice', 'add_to_record', 'record_add', NULL, '20min', NULL, NULL, 'Shortcut', '2026-10-03 12:00+07');
INSERT INTO assignment_history (run_date, run_at, category_group, action, evaluator_name, from_evaluator, game_count, game_ids, created_by) VALUES
  ('2026-09-30', '2026-09-30 09:00+07', 'puzzle', 'assign', 'Bob', NULL, 2, ARRAY['hist1','hist2'], 'cron'),
  ('2026-10-02', '2026-10-02 09:00+07', 'puzzle', 'reassign', 'Alice', 'Bob', 1, ARRAY['hist1'], 'hung@x'),
  ('2026-10-02', '2026-10-02 09:30+07', 'puzzle', 'rescue', 'Carol', 'Dave', 1, ARRAY['other'], 'nobody@x');
PREPARE hist_log AS
  SELECT l.id::text AS id, l.created_at AS at, l.actor, l.owner, l.source, l.context, l.kind,
         l.conclusion_before, l.conclusion_after, l.final_before, l.final_after,
         l.changed, l.view_s, l.confidence, l.batch_before, l.batch_after,
         l.bucket_before, l.bucket_after, l.recorder_before, l.recorder_after, l.owner_after
  FROM evaluation_log l
  WHERE l.game_id = $1
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT 200;
PREPARE hist_asg AS
  SELECT ah.id, ah.run_at AS at, ah.action, ah.evaluator_name, ah.from_evaluator,
         COALESCE(du.name, ah.created_by) AS by
  FROM assignment_history ah
  LEFT JOIN dashboard_users du ON lower(du.email) = lower(ah.created_by)
  WHERE $1 = ANY(ah.game_ids)
  ORDER BY ah.run_at DESC
  LIMIT 100;
CREATE TEMP TABLE hl AS EXECUTE hist_log('hist1');
CREATE TEMP TABLE ha AS EXECUTE hist_asg('hist1');
DO $$ BEGIN
  ASSERT (SELECT array_agg(source ORDER BY at DESC) FROM hl) = ARRAY['record_tab','add_to_record','panel','seed'], 'hist1 log rows only, newest first';
  ASSERT (SELECT bucket_before || '>' || bucket_after || ':' || recorder_before || '>' || recorder_after FROM hl WHERE kind = 'record_move')
         = '20min>5min:MyTL>MyTL', 'history query returns the bucket/recorder columns';
  ASSERT (SELECT owner || '>' || owner_after FROM hl WHERE kind = 'record_add') = 'Alice>Shortcut', 'history query returns owner_after';
  ASSERT (SELECT array_agg(action ORDER BY at DESC) FROM ha) = ARRAY['reassign','assign'], 'hist1 assignment rows only';
  ASSERT (SELECT batch_before || '>' || batch_after FROM hl WHERE source = 'panel') = 'W1 Oct, 2026>W2 Oct, 2026', 'history query returns the batch columns';
  ASSERT (SELECT by FROM ha WHERE action = 'reassign') = 'HungDT', 'created_by email resolves to the user name';
  ASSERT (SELECT by FROM ha WHERE action = 'assign') = 'cron', 'cron stays cron';
END $$;
DEALLOCATE hist_log;
DEALLOCATE hist_asg;
