\set ON_ERROR_STOP 1
SET TIME ZONE 'UTC';
-- Migration 055, part 3: eval_pair_phase2_apply(run_id, max_pairs) (spec 5, 6.1, 6.2, 6.3).
-- Runs on the throwaway DB of scripts/verify-eval-pairs.sh after phase2-plan-checks.sql, so the
-- DB also holds every family the earlier check files left behind: apply links those too, and
-- the run-wide checks below hold for every pair it links, not only the p2x_ cases.
-- One family per case: games 'p2x_<case>a' (android) / 'p2x_<case>i' (ios), family
-- 'fam.p2x_<case>'. Rows are inserted before the family is set (054's insert trigger does not
-- link them) with updated_at 2026-01-01, so an updated_at moved by apply shows.

-- ===== fixtures =====
DO $$
BEGIN
  INSERT INTO game_info (game_id, os, initial_release) VALUES
    ('p2x_a1a', 'android', '2026-01-01'), ('p2x_a1i', 'ios', '2026-02-01'),
    ('p2x_a2a', 'android', '2026-01-01'), ('p2x_a2i', 'ios', '2026-02-01'),
    ('p2x_b1a', 'android', '2026-01-10'), ('p2x_b1i', 'ios', '2026-01-20'),
    ('p2x_b2a', 'android', '2026-01-10'), ('p2x_b2i', 'ios', '2026-01-20'),
    ('p2x_b3a', 'android', '2026-01-10'), ('p2x_b3i', 'ios', '2026-01-20'),
    ('p2x_ca',  'android', '2026-01-01'), ('p2x_ci',  'ios', '2026-02-01'),
    ('p2x_da',  'android', '2026-01-01'), ('p2x_di',  'ios', '2026-03-01'),
    ('p2x_ea',  'android', '2026-01-01'), ('p2x_ei',  'ios', '2026-03-01'),
    ('p2x_fa',  'android', '2026-01-01'), ('p2x_fi',  'ios', '2026-03-01'),
    ('p2x_ga',  'android', '2026-01-01'), ('p2x_gi',  'ios', '2026-02-01'),
    ('p2x_cra', 'android', '2026-01-01'), ('p2x_cri', 'ios', '2026-02-01'),
    ('p2x_za',  'android', '2026-01-01'), ('p2x_zi',  'ios', '2026-02-01');

  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator, assigned_date, first_assigned_date,
      batch, initial_note, initial_conclusion, evaluate_date, final_conclusion, final_evaluator,
      drive_link, youtube_link, record_5min_assignee, record_5min_drive, updated_at) VALUES
    -- A1: equal backlogs (1 pending each) -> the earlier assigned_date: the BACK row holds.
    --     Both have a draft note: the holder's wins. The front lacks the demo link: it takes it.
    --     Only the front changes: the log row is on the front.
    ('p2x_a1a', 'puzzle', 'P2xA1f', '2026-03-05', '2026-03-05', 'W1', 'front draft a1', NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, '2026-01-01Z'),
    ('p2x_a1i', 'arcade', 'P2xA1b', '2026-03-01', '2026-02-28', 'W0', 'draft from back', NULL, NULL, NULL, NULL,
       'https://x/a1', NULL, NULL, NULL, '2026-01-01Z'),
    -- A2: the FRONT row holds; the notes differ: the holder's (front) wins, the back's is in the
    --     snapshot; the holder lacks the gameplay brief: it takes the back's (below). Both rows
    --     change, the back's holder changes: the log row is on the back.
    ('p2x_a2a', 'puzzle', 'P2xA2f', '2026-03-01', '2026-03-01', 'W5', 'front note', NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, '2026-01-01Z'),
    ('p2x_a2i', 'puzzle', 'P2xA2b', '2026-03-04', '2026-03-04', 'W6', 'back note', NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, '2026-01-01Z'),
    -- B1: the judged row is the BACK row (later release): the waiting front takes its whole eval group
    ('p2x_b1a', 'arcade', 'P2xB1w', '2026-03-02', '2026-03-02', 'W2', NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, '2026-01-01Z'),
    ('p2x_b1i', 'puzzle', 'P2xB1j', '2026-03-01', '2026-03-01', 'W1', 'judged note 1', 'Bypass', '2026-03-03 10:00Z',
       'Watch List', 'P2xMgr', NULL, NULL, NULL, NULL, '2026-01-01Z'),
    -- B2: the judged row is the FRONT row: the waiting back row takes it (holder change -> pair_merge)
    ('p2x_b2a', 'puzzle', 'P2xB2j', '2026-03-01', '2026-03-01', 'W1', 'judged note 2', 'List_Idea', '2026-03-04 10:00Z',
       NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01Z'),
    ('p2x_b2i', 'puzzle', 'P2xB2w', '2026-03-02', '2026-03-02', 'W2', NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, '2026-01-01Z'),
    -- B3: the waiting front has a frozen 5' record batch; the judged back row's Priority IV final
    --     moves the front's Record bucket: the front's 5' batch stays its own (batches below)
    ('p2x_b3a', 'puzzle', 'P2xB3w', '2026-03-02', '2026-03-02', 'W2', NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, '2026-01-01Z'),
    ('p2x_b3i', 'puzzle', 'P2xB3j', '2026-03-01', '2026-03-01', 'W1', 'judged note 3', 'List_Idea', '2026-03-05 10:00Z',
       'Priority IV', 'P2xMgr', NULL, NULL, NULL, NULL, '2026-01-01Z'),
    -- C: the Link_dead store (earlier release) is the back; the live front keeps its holder and
    --    group, and takes the dead store's recording (media)
    ('p2x_ca',  'puzzle', 'P2xCd', '2026-03-01', '2026-03-01', 'W1', 'dead', 'Link_dead', '2026-03-02 10:00Z',
       NULL, NULL, NULL, NULL, 'P2xRec', 'https://r/c', '2026-01-01Z'),
    ('p2x_ci',  'arcade', 'P2xCl', '2026-03-02', '2026-03-02', 'W2', NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, '2026-01-01Z'),
    -- D: both Bypass with a final (both reach 5) -> release-first: android is the front. Two finals
    --    (front's kept), two demo links (front's kept), a YouTube link only on the back (moved)
    ('p2x_da',  'puzzle', 'P2xDf', '2026-03-01', '2026-03-01', 'W1', 'front note d', 'Bypass', '2026-03-05 10:00Z',
       'Watch List', 'P2xMgr', 'https://d/f', NULL, NULL, NULL, '2026-01-01Z'),
    ('p2x_di',  'arcade', 'P2xDb', '2026-02-20', '2026-02-20', 'W0', 'back note d', 'Bypass', '2026-03-01 10:00Z',
       'Insight', 'P2xMgr2', 'https://d/b', 'https://y/b', NULL, NULL, '2026-01-01Z'),
    -- E: List_Idea (no final) vs Bypass with a final: the List_Idea store is the front; the back's
    --    Bypass, evaluator and final live on in credit
    ('p2x_ea',  'puzzle', 'P2xEb', '2026-03-01', '2026-03-01', 'W1', 'bypass note', 'Bypass', '2026-03-02 10:00Z',
       'Bypass', 'P2xMgr', NULL, NULL, NULL, NULL, '2026-01-01Z'),
    ('p2x_ei',  'puzzle', 'P2xEl', '2026-03-02', '2026-03-02', 'W2', 'idea note', 'List_Idea', '2026-03-03 10:00Z',
       NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01Z'),
    -- F: Bypass vs Playtest & Bypass: the P&B store is the front
    ('p2x_fa',  'puzzle', 'P2xFb', '2026-03-01', '2026-03-01', 'W1', 'f bypass', 'Bypass', '2026-03-02 10:00Z',
       NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01Z'),
    ('p2x_fi',  'puzzle', 'P2xFp', '2026-03-02', '2026-03-02', 'W2', 'f pb', 'Playtest & Bypass', '2026-03-03 10:00Z',
       NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01Z'),
    -- G: unjudged pair (group A in the preview), judged before apply runs (group B then)
    ('p2x_ga',  'puzzle', 'P2xGa', '2026-03-01', '2026-03-01', 'W1', NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, '2026-01-01Z'),
    ('p2x_gi',  'puzzle', 'P2xGi', '2026-03-02', '2026-03-02', 'W2', NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, '2026-01-01Z'),
    -- CR: a pair unlinked after an earlier phase 2 run: its credit stays, apply leaves the family alone
    ('p2x_cra', 'puzzle', 'P2xCr', '2026-03-01', '2026-03-01', 'W1', NULL, 'Bypass', '2026-03-02 10:00Z',
       NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01Z'),
    ('p2x_cri', 'puzzle', 'P2xCr', '2026-03-01', '2026-03-01', 'W1', NULL, 'Bypass', '2026-03-02 10:00Z',
       NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01Z'),
    -- Z: two results outside D / E / F: group G, never linked
    ('p2x_za',  'puzzle', 'P2xZ', '2026-03-01', '2026-03-01', 'W1', NULL, 'Good', '2026-03-02 10:00Z',
       NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01Z'),
    ('p2x_zi',  'puzzle', 'P2xZ', '2026-03-01', '2026-03-01', 'W1', NULL, 'Bypass', '2026-03-02 10:00Z',
       NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01Z');

  UPDATE game_evaluations SET credit = '{"initial_evaluator": "P2xCrOld", "initial_conclusion": "List_Idea"}'
   WHERE game_id = 'p2x_cri';
  UPDATE game_evaluations SET initial_gameplay = 'gp back' WHERE game_id = 'p2x_a2i';
  UPDATE game_evaluations SET record_5min_batch = 'WF5' WHERE game_id = 'p2x_b3a';
  UPDATE game_evaluations SET record_20min_batch = 'WJ20' WHERE game_id = 'p2x_b3i';
  ASSERT (SELECT record_5min_batch = 'WF5' AND record_20min_batch IS NULL FROM game_evaluations WHERE game_id = 'p2x_b3a')
     AND (SELECT record_5min_batch IS NULL AND record_20min_batch = 'WJ20' FROM game_evaluations WHERE game_id = 'p2x_b3i'),
    'fixture B3 batches';
  UPDATE game_info SET family_id = 'fam.' || left(game_id, length(game_id) - 1) WHERE game_id LIKE 'p2x\_%';
END $$;

-- ===== the preview, before anything is applied =====
DO $$
DECLARE r record;
BEGIN
  ASSERT (SELECT pg_get_function_identity_arguments('eval_pair_phase2_apply(text, integer)'::regprocedure))
       = 'p_run_id text, p_max_pairs integer', 'apply signature';
  ASSERT (SELECT pg_get_function_arguments('eval_pair_phase2_apply(text, integer)'::regprocedure))
       = 'p_run_id text, p_max_pairs integer DEFAULT 500', 'apply max_pairs defaults to 500';
  ASSERT (SELECT pg_get_function_result('eval_pair_phase2_apply(text, integer)'::regprocedure))
       = 'TABLE(grp text, linked integer, flagged integer)', 'apply result';

  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2x_a1');
  ASSERT r.grp = 'A' AND r.front_id = (SELECT id FROM game_evaluations WHERE game_id = 'p2x_a1a')
     AND r.holder_row = r.back_id AND r.holder = 'P2xA1b', format('fixture A1: %s', r);
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2x_a2');
  ASSERT r.grp = 'A' AND r.holder_row = r.front_id AND r.holder = 'P2xA2f', format('fixture A2: %s', r);
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2x_b1');
  ASSERT r.grp = 'B' AND r.front_id = (SELECT id FROM game_evaluations WHERE game_id = 'p2x_b1a')
     AND r.holder_row = r.back_id, format('fixture B1: %s', r);
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2x_b2');
  ASSERT r.grp = 'B' AND r.holder_row = r.front_id, format('fixture B2: %s', r);
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2x_b3');
  ASSERT r.grp = 'B' AND r.front_id = (SELECT id FROM game_evaluations WHERE game_id = 'p2x_b3a')
     AND r.holder_row = r.back_id, format('fixture B3: %s', r);
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2x_c');
  ASSERT r.grp = 'C' AND r.back_id = (SELECT id FROM game_evaluations WHERE game_id = 'p2x_ca'), format('fixture C: %s', r);
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2x_d');
  ASSERT r.grp = 'D' AND r.front_id = (SELECT id FROM game_evaluations WHERE game_id = 'p2x_da')
     AND r.flags = '{final_conflict,media_conflict,group_differs}', format('fixture D: %s', r);
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2x_e');
  ASSERT r.grp = 'E' AND r.front_id = (SELECT id FROM game_evaluations WHERE game_id = 'p2x_ei')
     AND r.flags = '{final_only_on_back}', format('fixture E: %s', r);
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2x_f');
  ASSERT r.grp = 'F' AND r.front_id = (SELECT id FROM game_evaluations WHERE game_id = 'p2x_fi'), format('fixture F: %s', r);
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2x_g');
  ASSERT r.grp = 'A', format('fixture G is group A in the preview: %s', r);
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2x_z');
  ASSERT r.grp = 'G', format('fixture Z: %s', r);
  -- a family with credit: listed by the preview as G (flag credited), never linked
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2x_cr');
  ASSERT r.grp = 'G' AND r.front_id IS NULL AND r.back_id IS NULL AND r.flags = '{credited}', format('fixture CR: %s', r);
END $$;

-- edited between the preview and the apply: G's android row is judged (a normal save of a lone row)
UPDATE game_evaluations SET initial_conclusion = 'Bypass', evaluate_date = '2026-03-09 10:00Z', initial_note = 'judged late'
 WHERE game_id = 'p2x_ga';

-- What apply should do: the plan's A..F as it is now; and the state every row is in before it runs.
CREATE TEMP TABLE p2x_expected AS
  SELECT p.*, row_number() OVER (ORDER BY p.family_id) AS ord
    FROM eval_pair_phase2_plan() p
   WHERE p.grp <> 'G';
CREATE TEMP TABLE p2x_before AS SELECT id, to_jsonb(g) AS j, updated_at FROM game_evaluations g;
CREATE TEMP TABLE p2x_log_before AS SELECT max(id) AS max_id FROM evaluation_log;

-- Audit: any UPDATE of a linked row that keeps its pair_eval_id (the copy trigger's WHEN
-- clause) during apply means trg_eval_pair_sync ran a copy of its own.
CREATE TEMP TABLE p2x_sync_audit (id int, depth int);
CREATE FUNCTION p2x_audit() RETURNS trigger LANGUAGE plpgsql AS
  $f$ BEGIN INSERT INTO p2x_sync_audit VALUES (NEW.id, pg_trigger_depth()); RETURN NULL; END $f$;
CREATE TRIGGER p2x_audit AFTER UPDATE ON game_evaluations FOR EACH ROW
  WHEN (NEW.pair_eval_id IS NOT NULL AND OLD.pair_eval_id IS NOT DISTINCT FROM NEW.pair_eval_id)
  EXECUTE FUNCTION p2x_audit();

-- ===== no SET clause with eval_pairs.keep_updated_at on any function =====
-- A SET clause on CREATE FUNCTION for a custom setting needs superuser (or GRANT SET, PG15+):
-- Neon's owner role got "permission denied to set parameter" applying 055. apply / rollback
-- set it with set_config at run time instead.
DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c
                      WHERE p.pronamespace = 'public'::regnamespace AND c LIKE 'eval_pairs.%'),
    format('a function SETs eval_pairs.*: %s', (SELECT string_agg(p.oid::regprocedure::text || ' ' || array_to_string(p.proconfig, ','), '; ')
                                                  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                                                   AND p.proconfig::text LIKE '%eval_pairs.%'));
END $$;

-- ===== run 1: two pairs; run 2: the rest =====
-- each in a transaction of its own that goes on after the call: the setting is back to what it
-- was before the call (run 1: never set in this session; run 2: 'off', set by the caller)
BEGIN;
DO $$ BEGIN
  ASSERT COALESCE(current_setting('eval_pairs.keep_updated_at', true), '') = '',
    format('run 1: the setting starts unset: %s', current_setting('eval_pairs.keep_updated_at', true));
END $$;
CREATE TEMP TABLE p2x_res1 AS SELECT * FROM eval_pair_phase2_apply('p2x_r1', 2);
DO $$ BEGIN
  ASSERT (SELECT sum(linked) FROM p2x_res1) = 2, 'run 1 wrote (the setting was on while it did)';
  ASSERT COALESCE(current_setting('eval_pairs.keep_updated_at', true), '') = '',
    format('run 1: the setting is back to unset in the caller''s transaction: %s', current_setting('eval_pairs.keep_updated_at', true));
END $$;
COMMIT;
BEGIN;
SELECT set_config('eval_pairs.keep_updated_at', 'off', true) \g /dev/null
CREATE TEMP TABLE p2x_res2 AS SELECT * FROM eval_pair_phase2_apply('p2x_r2', 100000);
DO $$ BEGIN
  ASSERT current_setting('eval_pairs.keep_updated_at', true) = 'off',
    format('run 2: the caller''s value is back: %s', current_setting('eval_pairs.keep_updated_at', true));
END $$;
COMMIT;

DROP TRIGGER p2x_audit ON game_evaluations;
DROP FUNCTION p2x_audit();

DO $$
DECLARE want text; got text;
BEGIN
  ASSERT (SELECT count(*) FROM p2x_expected) >= 12, 'fixture: the plan has pairs to link';
  ASSERT (SELECT count(*) FROM p2x_sync_audit) = 0,
    format('the copy trigger ran during apply: %s', (SELECT string_agg(id || '@' || depth, ',') FROM p2x_sync_audit));

  -- run 1: the first 2 families in family_id order, nothing else
  ASSERT (SELECT sum(linked) FROM p2x_res1) = 2, format('run 1 linked 2: %s', (SELECT string_agg(r::text, ' ') FROM p2x_res1 r));
  ASSERT (SELECT array_agg(DISTINCT family_id ORDER BY family_id) FROM eval_pair_merge_snapshots WHERE run_id = 'p2x_r1')
       = (SELECT array_agg(family_id ORDER BY family_id) FROM p2x_expected WHERE ord <= 2),
    'run 1 took the first 2 families by family_id';
  -- both runs: per group, the plan's counts (linked) and its flagged pairs
  SELECT string_agg(grp || ':' || n || '/' || f, ' ' ORDER BY grp) INTO want
    FROM (SELECT grp, count(*) AS n, count(*) FILTER (WHERE cardinality(flags) > 0) AS f FROM p2x_expected GROUP BY grp) x;
  SELECT string_agg(grp || ':' || n || '/' || f, ' ' ORDER BY grp) INTO got
    FROM (SELECT grp, sum(linked) AS n, sum(flagged) AS f FROM (SELECT * FROM p2x_res1 UNION ALL SELECT * FROM p2x_res2) u
           GROUP BY grp) x;
  ASSERT got = want, format(E'linked/flagged per group\n got: %s\nwant: %s', got, want);
  ASSERT NOT EXISTS (SELECT 1 FROM p2x_res2 WHERE linked = 0), 'only groups with a linked pair are returned';

  -- every planned pair is linked as planned, and nothing else was touched
  ASSERT (SELECT count(*) FROM eval_pair_merge_snapshots WHERE run_id IN ('p2x_r1', 'p2x_r2'))
       = 2 * (SELECT count(*) FROM p2x_expected), 'one snapshot per row of each linked pair';
  ASSERT NOT EXISTS (
    SELECT 1 FROM p2x_expected x
      JOIN game_evaluations f ON f.id = x.front_id JOIN game_evaluations b ON b.id = x.back_id
     WHERE f.pair_eval_id IS DISTINCT FROM b.id OR b.pair_eval_id IS DISTINCT FROM f.id
        OR f.pair_back OR NOT b.pair_back), 'every planned pair linked both ways, back row as planned';
  ASSERT NOT EXISTS (
    SELECT 1 FROM p2x_expected x JOIN eval_pair_merge_snapshots s ON s.family_id = x.family_id
     WHERE s.run_id IN ('p2x_r1', 'p2x_r2')
       AND (s.pair_group IS DISTINCT FROM x.grp OR s.game_evaluation_id NOT IN (x.front_id, x.back_id))),
    'snapshots carry the group and the pair''s rows';
  ASSERT NOT EXISTS (
    SELECT 1 FROM game_evaluations g JOIN p2x_before b ON b.id = g.id
     WHERE (to_jsonb(g) - 'updated_at') <> (b.j - 'updated_at')
       AND g.id NOT IN (SELECT front_id FROM p2x_expected UNION ALL SELECT back_id FROM p2x_expected)),
    'rows outside the planned pairs are unchanged';
  ASSERT NOT EXISTS (SELECT 1 FROM game_evaluations g JOIN p2x_before b ON b.id = g.id
                      WHERE g.updated_at IS DISTINCT FROM b.updated_at), 'updated_at unchanged on every row';

  -- snapshot: row_before is the row before the run; written = what the run set (every other
  -- column as before); pair_eval_id / pair_back always listed
  ASSERT NOT EXISTS (
    SELECT 1 FROM eval_pair_merge_snapshots s JOIN p2x_before b ON b.id = s.game_evaluation_id
     WHERE s.run_id IN ('p2x_r1', 'p2x_r2') AND s.row_before <> b.j), 'row_before = the row before the run';
  ASSERT NOT EXISTS (
    SELECT 1 FROM eval_pair_merge_snapshots s JOIN game_evaluations g ON g.id = s.game_evaluation_id
     WHERE s.run_id IN ('p2x_r1', 'p2x_r2')
       AND ((s.row_before || s.written) - 'updated_at') <> (to_jsonb(g) - 'updated_at')),
    'row_before + written = the row now';
  ASSERT NOT EXISTS (
    SELECT 1 FROM eval_pair_merge_snapshots s, jsonb_each(s.written) w
     WHERE s.run_id IN ('p2x_r1', 'p2x_r2')
       AND (w.key = 'updated_at'
            OR (w.key NOT IN ('pair_eval_id', 'pair_back') AND w.value IS NOT DISTINCT FROM s.row_before -> w.key))),
    'written lists only the columns the run changed (+ pair_eval_id, pair_back)';
  ASSERT NOT EXISTS (
    SELECT 1 FROM eval_pair_merge_snapshots s
     WHERE s.run_id IN ('p2x_r1', 'p2x_r2') AND NOT (s.written ? 'pair_eval_id' AND s.written ? 'pair_back')),
    'written always has pair_eval_id and pair_back';

  -- the shared columns are equal across every pair (C: media only, each store keeps its result)
  ASSERT NOT EXISTS (
    SELECT 1 FROM p2x_expected x
      JOIN game_evaluations f ON f.id = x.front_id JOIN game_evaluations b ON b.id = x.back_id,
      unnest(CASE WHEN x.grp = 'C' THEN eval_pair_media_cols() ELSE eval_pair_eval_cols() || eval_pair_media_cols() END) c
     WHERE to_jsonb(f) -> c IS DISTINCT FROM to_jsonb(b) -> c), 'shared columns equal across each pair';
  -- the front row's eval group is never taken from the back in D / E / F
  ASSERT NOT EXISTS (
    SELECT 1 FROM p2x_expected x JOIN game_evaluations f ON f.id = x.front_id JOIN p2x_before b ON b.id = x.front_id,
      unnest(eval_pair_eval_cols()) c
     WHERE x.grp IN ('D', 'E', 'F') AND to_jsonb(f) -> c IS DISTINCT FROM b.j -> c), 'D/E/F: front eval group untouched';
  ASSERT NOT EXISTS (
    SELECT 1 FROM p2x_expected x JOIN game_evaluations f ON f.id = x.front_id
     WHERE x.grp IN ('E', 'F') AND f.initial_conclusion IS DISTINCT FROM x.result_conclusion), 'E/F: front holds the result';

  -- credit: D/E/F back rows only = the whole row before + _moved
  ASSERT NOT EXISTS (
    SELECT 1 FROM p2x_expected x JOIN game_evaluations g ON g.id IN (x.front_id, x.back_id)
     WHERE (g.credit IS NOT NULL) IS DISTINCT FROM (x.grp IN ('D', 'E', 'F') AND g.id = x.back_id)), 'credit on D/E/F back rows only';
  ASSERT NOT EXISTS (
    SELECT 1 FROM p2x_expected x JOIN game_evaluations g ON g.id = x.back_id JOIN p2x_before b ON b.id = g.id
     WHERE x.grp IN ('D', 'E', 'F')
       AND ((g.credit - '_moved') <> b.j OR jsonb_typeof(g.credit -> '_moved') <> 'array'
            OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(g.credit -> '_moved') m
                        WHERE m <> ALL (eval_pair_media_cols())))),
    'credit = the back row before + _moved (media columns)';

  -- evaluation_log: one row per pair, context = run_id, on the row whose shared values changed
  -- (both: the one whose holder changed; neither, or both holders: the back row)
  ASSERT (SELECT count(*) FROM evaluation_log WHERE id > (SELECT max_id FROM p2x_log_before))
       = (SELECT count(*) FROM p2x_expected), 'one evaluation_log row per pair, nothing else';
  CREATE TEMP TABLE p2x_logpick AS
    SELECT x.family_id, x.front_id, x.back_id,
           CASE WHEN c.f_chg AND (NOT c.k_chg OR (c.f_own AND NOT c.k_own)) THEN x.front_id ELSE x.back_id END AS log_id,
           (c.f_chg OR c.k_chg) AS any_chg,
           c.f_chg AND (NOT c.k_chg OR (c.f_own AND NOT c.k_own)) AS on_front, c.k_chg
      FROM p2x_expected x
      JOIN p2x_before fb ON fb.id = x.front_id JOIN game_evaluations f ON f.id = x.front_id
      JOIN p2x_before kb ON kb.id = x.back_id JOIN game_evaluations k ON k.id = x.back_id
      CROSS JOIN LATERAL (SELECT
        EXISTS (SELECT 1 FROM unnest(eval_pair_eval_cols() || eval_pair_media_cols()) c WHERE fb.j -> c IS DISTINCT FROM to_jsonb(f) -> c) AS f_chg,
        EXISTS (SELECT 1 FROM unnest(eval_pair_eval_cols() || eval_pair_media_cols()) c WHERE kb.j -> c IS DISTINCT FROM to_jsonb(k) -> c) AS k_chg,
        (fb.j ->> 'initial_evaluator') IS DISTINCT FROM f.initial_evaluator AS f_own,
        (kb.j ->> 'initial_evaluator') IS DISTINCT FROM k.initial_evaluator AS k_own) c;
  ASSERT NOT EXISTS (
    SELECT 1 FROM p2x_logpick x
     WHERE (SELECT count(*) FROM evaluation_log l
             WHERE l.id > (SELECT max_id FROM p2x_log_before) AND l.game_evaluation_id = x.log_id
               AND l.context IN ('p2x_r1', 'p2x_r2') AND l.actor = 'System' AND l.source = 'other'
               AND l.pair_scope = 'store') <> 1), 'the log row is on the row that changed';
  ASSERT EXISTS (SELECT 1 FROM p2x_logpick WHERE on_front) AND EXISTS (SELECT 1 FROM p2x_logpick WHERE NOT on_front),
    'fixture: log rows on fronts and on backs';
  ASSERT NOT EXISTS (
    SELECT 1 FROM p2x_logpick x
      JOIN evaluation_log l ON l.game_evaluation_id = x.log_id AND l.id > (SELECT max_id FROM p2x_log_before)
      JOIN p2x_before b ON b.id = x.log_id JOIN game_evaluations g ON g.id = x.log_id
     WHERE l.kind IS DISTINCT FROM CASE WHEN x.any_chg THEN 'pair_merge' ELSE 'pair_link' END
        OR l.owner IS DISTINCT FROM b.j ->> 'initial_evaluator' OR l.owner_after IS DISTINCT FROM g.initial_evaluator
        OR l.conclusion_before IS DISTINCT FROM b.j ->> 'initial_conclusion' OR l.conclusion_after IS DISTINCT FROM g.initial_conclusion
        OR l.final_before IS DISTINCT FROM b.j ->> 'final_conclusion' OR l.final_after IS DISTINCT FROM g.final_conclusion
        OR l.batch_before IS DISTINCT FROM b.j ->> 'batch' OR l.batch_after IS DISTINCT FROM g.batch
        OR l.changed IS DISTINCT FROM (b.j ->> 'initial_conclusion' IS DISTINCT FROM g.initial_conclusion)),
    'log kind / before / after';
  DROP TABLE p2x_logpick;
END $$;

-- ===== per case =====
CREATE FUNCTION pg_temp.p2x_log(fam text) RETURNS evaluation_log LANGUAGE sql AS $f$
  SELECT l.* FROM evaluation_log l JOIN game_info g ON g.game_id = l.game_id
   WHERE g.family_id = fam AND l.context IN ('p2x_r1', 'p2x_r2') ORDER BY l.id DESC LIMIT 1
$f$;
DO $$
DECLARE f game_evaluations; b game_evaluations; v eval_stats_rows; l evaluation_log; s eval_pair_merge_snapshots;
BEGIN
  -- A1: the back row holds: the front takes holder, assign dates, batch, group; and the draft note
  -- and demo link it lacked. The back row changes nothing -> pair_link.
  SELECT * INTO f FROM game_evaluations WHERE game_id = 'p2x_a1a';
  SELECT * INTO b FROM game_evaluations WHERE game_id = 'p2x_a1i';
  ASSERT f.initial_evaluator = 'P2xA1b' AND f.assigned_date = '2026-03-01' AND f.first_assigned_date = '2026-02-28'
     AND f.batch = 'W0' AND f.category_group = 'arcade', format('A1 front took the holder row: %s', to_jsonb(f));
  ASSERT f.initial_note = 'draft from back' AND b.initial_note = 'draft from back' AND f.drive_link = 'https://x/a1',
    'A1 the holder''s draft wins, the front fills the demo link';
  ASSERT NOT f.pair_back AND b.pair_back AND f.credit IS NULL AND b.credit IS NULL, 'A1 link, no credit';
  SELECT * INTO l FROM pg_temp.p2x_log('fam.p2x_a1');
  ASSERT l.game_evaluation_id = f.id AND l.kind = 'pair_merge' AND l.owner = 'P2xA1f' AND l.owner_after = 'P2xA1b'
     AND l.batch_before = 'W1' AND l.batch_after = 'W0', format('A1 log on the front: %s', to_jsonb(l));
  SELECT * INTO s FROM eval_pair_merge_snapshots WHERE game_evaluation_id = f.id;
  ASSERT s.pair_group = 'A' AND s.family_id = 'fam.p2x_a1'
     AND s.written - ARRAY['pair_eval_id', 'pair_back'] = jsonb_build_object(
           'initial_evaluator', 'P2xA1b', 'assigned_date', '2026-03-01', 'first_assigned_date', '2026-02-28',
           'batch', 'W0', 'category_group', 'arcade', 'initial_note', 'draft from back', 'drive_link', 'https://x/a1'),
    format('A1 front written: %s', s.written);
  ASSERT s.written -> 'pair_eval_id' = to_jsonb(b.id) AND s.written -> 'pair_back' = 'false', 'A1 written pair columns';

  -- A2: the front row holds; the back takes holder, dates, batch and the front's note -> pair_merge
  SELECT * INTO f FROM game_evaluations WHERE game_id = 'p2x_a2a';
  SELECT * INTO b FROM game_evaluations WHERE game_id = 'p2x_a2i';
  ASSERT b.initial_evaluator = 'P2xA2f' AND b.assigned_date = '2026-03-01' AND b.batch = 'W5'
     AND b.initial_note = 'front note' AND f.initial_note = 'front note', format('A2: %s', to_jsonb(b));
  ASSERT f.initial_gameplay = 'gp back' AND b.initial_gameplay = 'gp back', 'A2 the holder fills what it lacks';
  SELECT * INTO l FROM pg_temp.p2x_log('fam.p2x_a2');
  ASSERT l.game_evaluation_id = b.id AND l.kind = 'pair_merge' AND l.owner = 'P2xA2b' AND l.owner_after = 'P2xA2f'
     AND l.batch_before = 'W6' AND l.batch_after = 'W5' AND NOT l.changed, format('A2 log: %s', to_jsonb(l));
  SELECT * INTO s FROM eval_pair_merge_snapshots WHERE game_evaluation_id = b.id;
  ASSERT s.row_before ->> 'initial_note' = 'back note' AND s.written ->> 'initial_note' = 'front note', 'A2 snapshot keeps the back note';

  -- B1: the waiting front takes the judged back row's whole eval group (holder, group, final ...)
  SELECT * INTO f FROM game_evaluations WHERE game_id = 'p2x_b1a';
  SELECT * INTO b FROM game_evaluations WHERE game_id = 'p2x_b1i';
  ASSERT f.initial_evaluator = 'P2xB1j' AND f.initial_conclusion = 'Bypass' AND f.final_conclusion = 'Watch List'
     AND f.final_evaluator = 'P2xMgr' AND f.initial_note = 'judged note 1' AND f.evaluate_date = '2026-03-03 10:00Z'
     AND f.category_group = 'puzzle' AND f.batch = 'W1' AND f.assigned_date = '2026-03-01', format('B1 front: %s', to_jsonb(f));
  ASSERT NOT f.pair_back AND b.pair_back AND f.credit IS NULL AND b.credit IS NULL, 'B1 link, no credit';
  SELECT * INTO l FROM pg_temp.p2x_log('fam.p2x_b1');
  ASSERT l.game_evaluation_id = f.id AND l.kind = 'pair_merge' AND l.owner = 'P2xB1w' AND l.owner_after = 'P2xB1j'
     AND l.conclusion_before IS NULL AND l.conclusion_after = 'Bypass' AND l.changed
     AND l.final_before IS NULL AND l.final_after = 'Watch List', format('B1 log on the waiting front: %s', to_jsonb(l));
  -- the counts: the judged work now counts on the front row, once
  ASSERT (SELECT count(*) FROM eval_stats_rows WHERE game_id IN ('p2x_b1a', 'p2x_b1i') AND eval_row
            AND initial_evaluator = 'P2xB1j' AND initial_conclusion = 'Bypass') = 1, 'B1 counted once';

  -- B2: the waiting back row takes the judged front's group -> pair_merge, holder change logged
  SELECT * INTO b FROM game_evaluations WHERE game_id = 'p2x_b2i';
  ASSERT b.initial_evaluator = 'P2xB2j' AND b.initial_conclusion = 'List_Idea' AND b.initial_note = 'judged note 2',
    format('B2 back: %s', to_jsonb(b));
  SELECT * INTO l FROM pg_temp.p2x_log('fam.p2x_b2');
  ASSERT l.game_evaluation_id = b.id AND l.kind = 'pair_merge' AND l.owner = 'P2xB2w' AND l.owner_after = 'P2xB2j'
     AND l.conclusion_before IS NULL AND l.conclusion_after = 'List_Idea' AND l.changed AND l.context = 'p2x_r2',
    format('B2 log: %s', to_jsonb(l));

  -- B3: the front keeps its own frozen 5' batch; its empty 20' batch is filled from the back
  SELECT * INTO f FROM game_evaluations WHERE game_id = 'p2x_b3a';
  SELECT * INTO b FROM game_evaluations WHERE game_id = 'p2x_b3i';
  ASSERT f.final_conclusion = 'Priority IV' AND f.initial_conclusion = 'List_Idea', format('B3 front judged: %s', to_jsonb(f));
  ASSERT f.record_5min_batch = 'WF5' AND f.record_20min_batch = 'WJ20'
     AND b.record_5min_batch = 'WF5' AND b.record_20min_batch = 'WJ20',
    format('B3 record batches: front %s/%s back %s/%s', f.record_5min_batch, f.record_20min_batch,
           b.record_5min_batch, b.record_20min_batch);

  -- C: each store keeps its result, holder and group; the live front takes the dead store's recording
  SELECT * INTO f FROM game_evaluations WHERE game_id = 'p2x_ci';
  SELECT * INTO b FROM game_evaluations WHERE game_id = 'p2x_ca';
  ASSERT f.initial_evaluator = 'P2xCl' AND f.initial_conclusion IS NULL AND f.category_group = 'arcade' AND f.batch = 'W2',
    format('C front keeps its eval group: %s', to_jsonb(f));
  ASSERT b.initial_evaluator = 'P2xCd' AND b.initial_conclusion = 'Link_dead' AND b.category_group = 'puzzle'
     AND b.initial_note = 'dead', format('C back keeps its result: %s', to_jsonb(b));
  ASSERT f.record_5min_assignee = 'P2xRec' AND f.record_5min_drive = 'https://r/c', 'C media filled from the dead store';
  ASSERT NOT f.pair_back AND b.pair_back AND f.credit IS NULL AND b.credit IS NULL, 'C link, no credit';
  SELECT * INTO l FROM pg_temp.p2x_log('fam.p2x_c');
  ASSERT l.game_evaluation_id = f.id AND l.kind = 'pair_merge' AND l.owner = 'P2xCl' AND l.owner_after = 'P2xCl'
     AND NOT l.changed, format('C log on the front (it took the recording): %s', to_jsonb(l));

  -- D: front's final and demo link kept; the back's YouTube link moved to the front; the back
  -- row takes the front's group; its own work lives on in credit
  SELECT * INTO f FROM game_evaluations WHERE game_id = 'p2x_da';
  SELECT * INTO b FROM game_evaluations WHERE game_id = 'p2x_di';
  ASSERT f.final_conclusion = 'Watch List' AND f.final_evaluator = 'P2xMgr' AND f.drive_link = 'https://d/f'
     AND f.youtube_link = 'https://y/b' AND f.initial_evaluator = 'P2xDf', format('D front: %s', to_jsonb(f));
  ASSERT b.final_conclusion = 'Watch List' AND b.initial_evaluator = 'P2xDf' AND b.drive_link = 'https://d/f'
     AND b.youtube_link = 'https://y/b' AND b.initial_note = 'front note d' AND b.category_group = 'puzzle',
    format('D back took the front: %s', to_jsonb(b));
  ASSERT b.credit ->> 'initial_evaluator' = 'P2xDb' AND b.credit ->> 'final_conclusion' = 'Insight'
     AND b.credit ->> 'initial_note' = 'back note d' AND b.credit ->> 'category_group' = 'arcade'
     AND b.credit -> '_moved' = '["youtube_link"]', format('D credit: %s', b.credit);
  SELECT * INTO v FROM eval_stats_rows WHERE id = b.id;
  ASSERT v.eval_row AND v.media_row AND v.initial_evaluator = 'P2xDb' AND v.final_conclusion = 'Insight'
     AND v.final_evaluator = 'P2xMgr2' AND v.drive_link = 'https://d/b' AND v.youtube_link IS NULL
     AND v.evaluate_date = '2026-03-01 10:00Z' AND v.category_group = 'arcade' AND v.batch = 'W0',
    format('D back counts as before, the moved video once: %s', to_jsonb(v));
  ASSERT (SELECT count(*) FROM eval_stats_rows WHERE game_id IN ('p2x_da', 'p2x_di') AND media_row
            AND youtube_link = 'https://y/b') = 1, 'D the moved YouTube link counted once';
  SELECT * INTO l FROM pg_temp.p2x_log('fam.p2x_d');
  ASSERT l.game_evaluation_id = b.id AND l.kind = 'pair_merge' AND l.owner = 'P2xDb' AND l.owner_after = 'P2xDf'
     AND l.final_before = 'Insight' AND l.final_after = 'Watch List' AND l.batch_before = 'W0' AND l.batch_after = 'W1'
     AND NOT l.changed, format('D log: %s', to_jsonb(l));
  SELECT * INTO s FROM eval_pair_merge_snapshots WHERE game_evaluation_id = b.id;
  ASSERT s.written -> 'credit' = b.credit AND s.written -> 'pair_back' = 'true', 'D written has credit and pair_back';

  -- E: the back store becomes List_Idea; credit keeps its Bypass verdict, evaluator and final;
  -- the front's (empty) final stays empty
  SELECT * INTO f FROM game_evaluations WHERE game_id = 'p2x_ei';
  SELECT * INTO b FROM game_evaluations WHERE game_id = 'p2x_ea';
  ASSERT f.initial_conclusion = 'List_Idea' AND f.final_conclusion IS NULL AND f.initial_evaluator = 'P2xEl',
    format('E front: %s', to_jsonb(f));
  ASSERT b.initial_conclusion = 'List_Idea' AND b.initial_evaluator = 'P2xEl' AND b.final_conclusion IS NULL,
    format('E back: %s', to_jsonb(b));
  ASSERT b.credit ->> 'initial_conclusion' = 'Bypass' AND b.credit ->> 'initial_evaluator' = 'P2xEb'
     AND b.credit ->> 'final_conclusion' = 'Bypass' AND b.credit -> '_moved' = '[]', format('E credit: %s', b.credit);
  SELECT * INTO v FROM eval_stats_rows WHERE id = b.id;
  ASSERT v.initial_conclusion = 'Bypass' AND v.initial_evaluator = 'P2xEb' AND v.evaluate_date = '2026-03-02 10:00Z',
    'E back counts as the Bypass it was';
  SELECT * INTO l FROM pg_temp.p2x_log('fam.p2x_e');
  ASSERT l.game_evaluation_id = b.id AND l.kind = 'pair_merge' AND l.conclusion_before = 'Bypass' AND l.conclusion_after = 'List_Idea' AND l.changed
     AND l.final_before = 'Bypass' AND l.final_after IS NULL, format('E log: %s', to_jsonb(l));

  -- F: the back store becomes Playtest & Bypass
  SELECT * INTO b FROM game_evaluations WHERE game_id = 'p2x_fa';
  ASSERT b.initial_conclusion = 'Playtest & Bypass' AND b.initial_evaluator = 'P2xFp' AND b.pair_back
     AND b.credit ->> 'initial_conclusion' = 'Bypass', format('F back: %s', to_jsonb(b));

  -- G: judged between the preview (A) and the apply: applied as group B
  SELECT * INTO f FROM game_evaluations WHERE game_id = 'p2x_ga';
  SELECT * INTO b FROM game_evaluations WHERE game_id = 'p2x_gi';
  ASSERT (SELECT DISTINCT pair_group FROM eval_pair_merge_snapshots WHERE family_id = 'fam.p2x_g') = 'B', 'G applied as B';
  ASSERT b.initial_conclusion = 'Bypass' AND b.initial_evaluator = 'P2xGa' AND b.initial_note = 'judged late'
     AND b.pair_back AND f.pair_eval_id = b.id AND b.credit IS NULL, format('G back took the late verdict: %s', to_jsonb(b));

  -- CR (credited) and Z (group G): untouched
  ASSERT NOT EXISTS (SELECT 1 FROM eval_pair_merge_snapshots WHERE family_id IN ('fam.p2x_cr', 'fam.p2x_z')), 'CR / Z: no snapshot';
  ASSERT NOT EXISTS (SELECT 1 FROM game_evaluations WHERE game_id IN ('p2x_cra', 'p2x_cri', 'p2x_za', 'p2x_zi')
                       AND (pair_eval_id IS NOT NULL OR pair_back)), 'CR / Z: not linked';
  ASSERT (SELECT credit FROM game_evaluations WHERE game_id = 'p2x_cri')
       = '{"initial_evaluator": "P2xCrOld", "initial_conclusion": "List_Idea"}', 'CR: the old credit kept';
END $$;

-- ===== after the link, the pair behaves like a 054 pair =====
DO $$
DECLARE f game_evaluations; b game_evaluations; t0 timestamptz;
BEGIN
  -- a save on the front reaches the back, and stamps updated_at again (apply's setting is gone)
  UPDATE game_evaluations SET final_note = 'after apply' WHERE game_id = 'p2x_da';
  SELECT * INTO f FROM game_evaluations WHERE game_id = 'p2x_da';
  SELECT * INTO b FROM game_evaluations WHERE game_id = 'p2x_di';
  ASSERT b.final_note = 'after apply' AND f.updated_at = now(), 'a save after apply copies and stamps updated_at';
  ASSERT b.credit ->> 'initial_evaluator' = 'P2xDb', 'credit survives a later save';
  ASSERT NOT f.pair_back AND b.pair_back, 'the front row stays (sticky)';
  ASSERT COALESCE(current_setting('eval_pairs.keep_updated_at', true), '') <> 'on', 'the setting is local to apply';
END $$;

-- ===== apply refuses to run when the touch function ignores the setting (054 re-run) =====
DO $$
DECLARE msg text; ran boolean := false;
BEGIN
  BEGIN
    -- 054's body, as a re-run of 054 would put it back
    EXECUTE $q$CREATE OR REPLACE FUNCTION game_evaluations_touch_updated() RETURNS trigger
      LANGUAGE plpgsql AS $f$
      BEGIN
        IF (NEW.pair_eval_id IS DISTINCT FROM OLD.pair_eval_id OR NEW.pair_back IS DISTINCT FROM OLD.pair_back)
           AND to_jsonb(NEW) - ARRAY['pair_eval_id', 'pair_back', 'updated_at']
             = to_jsonb(OLD) - ARRAY['pair_eval_id', 'pair_back', 'updated_at'] THEN
          RETURN NEW;
        END IF;
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $f$ $q$;
    BEGIN
      PERFORM eval_pair_phase2_apply('p2x_guard', 10);
      ran := true;
    EXCEPTION WHEN raise_exception THEN
      msg := SQLERRM;
    END;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'undo the replaced touch function';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  ASSERT NOT ran AND msg LIKE '%eval_pairs.keep_updated_at%', format('apply guard: ran %s, %s', ran, msg);
  ASSERT (SELECT position('eval_pairs.keep_updated_at' IN prosrc) > 0 FROM pg_proc
           WHERE oid = 'game_evaluations_touch_updated()'::regprocedure), 'the 055 touch function is back';
END $$;

-- ===== a third run finds nothing and writes nothing =====
CREATE TEMP TABLE p2x_snap AS
  SELECT (SELECT md5(string_agg(to_jsonb(g)::text, ',' ORDER BY id)) FROM game_evaluations g) AS ge,
         (SELECT count(*) FROM evaluation_log) AS logs,
         (SELECT count(*) FROM eval_pair_merge_snapshots) AS snaps;
CREATE TEMP TABLE p2x_res3 AS SELECT * FROM eval_pair_phase2_apply('p2x_r3', 100000);
DO $$
DECLARE ran boolean := false;
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM p2x_res3), format('run 3 returns no rows: %s', (SELECT string_agg(r::text, ' ') FROM p2x_res3 r));
  ASSERT (SELECT md5(string_agg(to_jsonb(g)::text, ',' ORDER BY id)) FROM game_evaluations g) = (SELECT ge FROM p2x_snap),
    'run 3 changed game_evaluations';
  ASSERT (SELECT count(*) FROM evaluation_log) = (SELECT logs FROM p2x_snap), 'run 3 wrote evaluation_log';
  ASSERT (SELECT count(*) FROM eval_pair_merge_snapshots) = (SELECT snaps FROM p2x_snap), 'run 3 wrote snapshots';
  -- argument checks
  ASSERT NOT EXISTS (SELECT 1 FROM eval_pair_phase2_apply('p2x_r4', 0)), 'max_pairs 0 does nothing';
  BEGIN
    PERFORM eval_pair_phase2_apply(NULL, 10);
    ran := true;
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM LIKE '%run_id%', format('apply without a run_id: %s', SQLERRM);
  END;
  ASSERT NOT ran, 'apply without a run_id must fail';
END $$;

DROP TABLE p2x_expected, p2x_before, p2x_log_before, p2x_sync_audit, p2x_res1, p2x_res2, p2x_res3, p2x_snap;
