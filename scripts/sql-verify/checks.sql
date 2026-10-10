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

-- ===== Task 4: add-to-record legacy branch logs and keeps auto-fill =====
INSERT INTO game_info VALUES ('r1'), ('r2');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, initial_conclusion, evaluate_date) VALUES
 (41, 'r1', 'HuyDD', 'Bypass', '2026-10-01 10:00+07'),
 (42, 'r2', 'HuyDD', 'List_Idea', '2026-10-01 10:00+07');
PREPARE atr(unknown, unknown) AS
WITH old AS (
  SELECT id, game_id, initial_conclusion, initial_evaluator, final_conclusion, evaluate_date
  FROM game_evaluations WHERE game_id = $1 AND category_group = 'puzzle' FOR UPDATE
), upd AS (
  UPDATE game_evaluations ge SET
    initial_evaluator = CASE WHEN (ge.initial_conclusion IS NULL OR ge.initial_conclusion ILIKE '%bypass%') THEN 'Shortcut' ELSE ge.initial_evaluator END,
    initial_conclusion = CASE WHEN (ge.initial_conclusion IS NULL OR ge.initial_conclusion ILIKE '%bypass%') THEN 'List_Idea' ELSE ge.initial_conclusion END
  FROM old WHERE ge.id = old.id
  RETURNING ge.id, ge.initial_conclusion, ge.final_conclusion
), logged AS (
  INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, owner, source, kind,
    conclusion_before, conclusion_after, changed)
  SELECT old.id, old.game_id, $2::text, old.initial_evaluator, 'add_to_record', 'revise',
    old.initial_conclusion, upd.initial_conclusion, old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion
  FROM old JOIN upd ON upd.id = old.id
)
SELECT id FROM upd;
EXECUTE atr('r1', 'VinhTD');
EXECUTE atr('r2', 'VinhTD');
DO $$ BEGIN
  ASSERT (SELECT initial_evaluator FROM game_evaluations WHERE id = 41) = 'Shortcut', 'r1 auto-filled';
  ASSERT (SELECT initial_evaluator FROM game_evaluations WHERE id = 42) = 'HuyDD', 'r2 kept';
  ASSERT (SELECT owner || ':' || conclusion_before || '>' || conclusion_after FROM evaluation_log WHERE game_evaluation_id = 41)
         = 'HuyDD:Bypass>List_Idea', 'r1 log shows what was overridden';
  ASSERT (SELECT changed FROM evaluation_log WHERE game_evaluation_id = 42) = false, 'r2 logged, unchanged';
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
WITH iv AS (
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
