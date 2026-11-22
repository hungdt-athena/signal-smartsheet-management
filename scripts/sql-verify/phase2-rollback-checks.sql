\set ON_ERROR_STOP 1
SET TIME ZONE 'UTC';
-- Migration 055, part 4: eval_pair_phase2_rollback(run_id) (spec 6.3, rollback).
-- Runs on the throwaway DB of scripts/verify-eval-pairs.sh after every apply check (the runs
-- p2x_r1, p2x_r2, p2w_run and p2v_run are still in place). Part 1: a run of its own (p2y_r1)
-- with edits after the run, rolled back in another session time zone. Part 2: every other run
-- rolled back, checked by the general rule. One family per case: games 'p2y_<case>a'
-- (android) / 'p2y_<case>i' (ios), family 'fam.p2y_<case>'; rows inserted before the family
-- is set, updated_at 2026-01-01.

-- ===== fixtures =====
DO $$
BEGIN
  INSERT INTO game_info (game_id, os, initial_release) VALUES
    ('p2y_aa', 'android', '2026-01-01'), ('p2y_ai', 'ios', '2026-02-01'),
    ('p2y_ba', 'android', '2026-01-10'), ('p2y_bi', 'ios', '2026-01-20'),
    ('p2y_ca', 'android', '2026-01-01'), ('p2y_ci', 'ios', '2026-02-01'),
    ('p2y_da', 'android', '2026-01-01'), ('p2y_di', 'ios', '2026-03-01'),
    ('p2y_ea', 'android', '2026-01-01'), ('p2y_ei', 'ios', '2026-03-01'),
    ('p2y_xa', 'android', '2026-01-10'), ('p2y_xi', 'ios', '2026-01-20'),
    ('p2y_lone', 'android', '2026-01-01');

  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator, assigned_date, first_assigned_date,
      batch, initial_note, initial_conclusion, evaluate_date, final_conclusion, final_evaluator,
      drive_link, youtube_link, record_5min_assignee, record_5min_drive, updated_at) VALUES
    -- A: the back row holds (earlier assigned_date): the front takes holder, dates, batch,
    --    group, the holder's draft note and the demo link it lacks
    ('p2y_aa', 'puzzle', 'P2yAf', '2026-03-05', '2026-03-05', 'W1', 'a front draft', NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, '2026-01-01Z'),
    ('p2y_ai', 'arcade', 'P2yAb', '2026-03-01', '2026-02-28', 'W0', 'a back draft', NULL, NULL, NULL, NULL,
       'https://y/a', NULL, NULL, NULL, '2026-01-01Z'),
    -- B: the waiting front takes the judged back's Priority IV final: its Record bucket moves
    --    (5' -> 20'); rolling the final back moves it again, and its own 5' batch must survive
    ('p2y_ba', 'puzzle', 'P2yBw', '2026-03-02', '2026-03-02', 'W2', NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, '2026-01-01Z'),
    ('p2y_bi', 'puzzle', 'P2yBj', '2026-03-01', '2026-03-01', 'W1', 'b judged', 'List_Idea', '2026-03-05 10:00Z',
       'Priority IV', 'P2yMgr', NULL, NULL, NULL, NULL, '2026-01-01Z'),
    -- C: the dead back store's recording (with its confirm time) fills the live front: the
    --    front's record_confirmed_at (051 derives it) changes with it
    ('p2y_ca', 'puzzle', 'P2yCd', '2026-03-01', '2026-03-01', 'W1', 'dead', 'Link_dead', '2026-03-02 10:00Z',
       NULL, NULL, NULL, NULL, 'P2yRec', 'https://r/y', '2026-01-01Z'),
    ('p2y_ci', 'arcade', 'P2yCl', '2026-03-02', '2026-03-02', 'W2', NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, '2026-01-01Z'),
    -- D: both Bypass, android is the front; the back gets credit, the front takes the back's
    --    YouTube link; after the run the front's final note is edited (copied to the back)
    ('p2y_da', 'puzzle', 'P2yDf', '2026-03-01', '2026-03-01', 'W1', 'yd front', 'Bypass', '2026-03-05 10:00Z',
       'Watch List', 'P2yMgr', 'https://d/yf', NULL, NULL, NULL, '2026-01-01Z'),
    ('p2y_di', 'arcade', 'P2yDb', '2026-02-20', '2026-02-20', 'W0', 'yd back', 'Bypass', '2026-03-01 10:00Z',
       'Insight', 'P2yMgr2', 'https://d/yb', 'https://y/yb', NULL, NULL, '2026-01-01Z'),
    -- E: List_Idea (ios, front) vs Bypass; after the run a video lands on the back row (n8n)
    ('p2y_ea', 'puzzle', 'P2yEb', '2026-03-01', '2026-03-01', 'W1', 'ye bypass', 'Bypass', '2026-03-02 10:00Z',
       'Bypass', 'P2yMgr', NULL, NULL, NULL, NULL, '2026-01-01Z'),
    ('p2y_ei', 'puzzle', 'P2yEl', '2026-03-02', '2026-03-02', 'W2', 'ye idea', 'List_Idea', '2026-03-03 10:00Z',
       NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01Z'),
    -- X: group B; after the run the pair is unlinked and the front linked (by hand) to a lone row
    ('p2y_xa', 'puzzle', 'P2yXw', '2026-03-02', '2026-03-02', 'W2', NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, '2026-01-01Z'),
    ('p2y_xi', 'puzzle', 'P2yXj', '2026-03-01', '2026-03-01', 'W1', 'x judged', 'Bypass', '2026-03-04 10:00Z',
       NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01Z'),
    ('p2y_lone', 'puzzle', 'P2yLone', '2026-03-01', '2026-03-01', 'W1', NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, '2026-01-01Z');

  UPDATE game_evaluations SET record_5min_batch = 'YF5' WHERE game_id = 'p2y_ba';
  UPDATE game_evaluations SET record_20min_batch = 'YJ20' WHERE game_id = 'p2y_bi';
  UPDATE game_evaluations SET record_5min_confirmed_at = '2026-03-03 10:00Z' WHERE game_id = 'p2y_ca';
  UPDATE game_evaluations SET final_note = CASE game_id WHEN 'p2y_da' THEN 'fn front' ELSE 'fn back' END
   WHERE game_id IN ('p2y_da', 'p2y_di');
  UPDATE game_evaluations SET updated_at = '2026-01-01Z' WHERE game_id LIKE 'p2y\_%';
  ASSERT (SELECT record_confirmed_at = '2026-03-03 10:00Z' FROM game_evaluations WHERE game_id = 'p2y_ca'),
    'fixture C: 051 derives record_confirmed_at';
  UPDATE game_info SET family_id = 'fam.' || left(game_id, length(game_id) - 1)
   WHERE game_id LIKE 'p2y\_%' AND game_id <> 'p2y_lone';
END $$;

-- ===== signature =====
DO $$
BEGIN
  ASSERT (SELECT pg_get_function_identity_arguments('eval_pair_phase2_rollback(text, integer)'::regprocedure))
       = 'p_run_id text, p_max_families integer', 'rollback signature';
  ASSERT (SELECT pg_get_function_arguments('eval_pair_phase2_rollback(text, integer)'::regprocedure))
       = 'p_run_id text, p_max_families integer DEFAULT 500', 'rollback max_families defaults to 500';
  ASSERT (SELECT pg_get_function_result('eval_pair_phase2_rollback(text, integer)'::regprocedure))
       = 'TABLE(game_evaluation_id integer, kept_columns text[], linked_to integer)', 'rollback result';
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname = 'eval_pair_phase2_rollback') = 1, 'one rollback function';
END $$;

-- ===== part 1: run p2y_r1, edits after it, rollback =====
CREATE TEMP TABLE p2y_before AS SELECT id, to_jsonb(g) AS j FROM game_evaluations g;
CREATE TEMP TABLE p2y_apply AS SELECT * FROM eval_pair_phase2_apply('p2y_r1', 100000);
CREATE TEMP TABLE p2y_snaps AS SELECT * FROM eval_pair_merge_snapshots WHERE run_id = 'p2y_r1';
DO $$
BEGIN
  ASSERT (SELECT array_agg(DISTINCT family_id ORDER BY family_id) FROM p2y_snaps)
       = '{fam.p2y_a,fam.p2y_b,fam.p2y_c,fam.p2y_d,fam.p2y_e,fam.p2y_x}',
    format('fixture: p2y_r1 linked the p2y families only: %s', (SELECT array_agg(DISTINCT family_id) FROM p2y_snaps));
  ASSERT (SELECT string_agg(DISTINCT family_id || '=' || pair_group, ' ' ORDER BY family_id || '=' || pair_group) FROM p2y_snaps)
       = 'fam.p2y_a=A fam.p2y_b=B fam.p2y_c=C fam.p2y_d=D fam.p2y_e=E fam.p2y_x=B', 'fixture groups';
  ASSERT (SELECT final_conclusion = 'Priority IV' AND record_5min_batch = 'YF5' FROM game_evaluations WHERE game_id = 'p2y_ba'),
    'fixture B: the front took the Priority IV final and kept its 5'' batch';
  ASSERT (SELECT record_confirmed_at = '2026-03-03 10:00Z' FROM game_evaluations WHERE game_id = 'p2y_ci'),
    'fixture C: the front took the recording and its confirm time';
  ASSERT (SELECT credit IS NOT NULL FROM game_evaluations WHERE game_id = 'p2y_di'), 'fixture D: credit on the back';
  ASSERT (SELECT count(*) FROM evaluation_log WHERE context = 'p2y_r1') = 6, 'fixture: one log row per pair';
END $$;

-- edits after the run (ordinary saves, each its own transaction: updated_at moves)
UPDATE game_evaluations SET final_note = 'fn later' WHERE game_id = 'p2y_da';
UPDATE game_evaluations SET youtube_link = 'https://y/late' WHERE game_id = 'p2y_ea';
SELECT unlink_eval_pair(id) FROM game_evaluations WHERE game_id = 'p2y_xa';
UPDATE game_evaluations g
   SET pair_eval_id = CASE g.game_id WHEN 'p2y_xa' THEN o.lone ELSE o.xa END
  FROM (SELECT (SELECT id FROM game_evaluations WHERE game_id = 'p2y_xa') AS xa,
               (SELECT id FROM game_evaluations WHERE game_id = 'p2y_lone') AS lone) o
 WHERE g.game_id IN ('p2y_xa', 'p2y_lone');
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM game_evaluations WHERE game_id IN ('p2y_da', 'p2y_di') AND final_note = 'fn later') = 2,
    'fixture D edit reached both rows';
  ASSERT (SELECT count(*) FROM game_evaluations WHERE game_id IN ('p2y_ea', 'p2y_ei') AND youtube_link = 'https://y/late') = 2,
    'fixture E video reached both rows';
  ASSERT (SELECT pair_eval_id FROM game_evaluations WHERE game_id = 'p2y_xa')
       = (SELECT id FROM game_evaluations WHERE game_id = 'p2y_lone'), 'fixture X relinked to the lone row';
END $$;

CREATE TEMP TABLE p2y_pre AS SELECT id, to_jsonb(g) AS j, updated_at FROM game_evaluations g;
CREATE TEMP TABLE p2y_log_pre AS SELECT max(id) AS max_id, count(*) AS n FROM evaluation_log;

-- Audit: an UPDATE of a linked row that keeps its pair_eval_id (the copy trigger's WHEN clause)
-- during the rollback means trg_eval_pair_sync copied to a twin.
CREATE TEMP TABLE p2y_sync_audit (id int, depth int);
CREATE FUNCTION p2y_audit() RETURNS trigger LANGUAGE plpgsql AS
  $f$ BEGIN INSERT INTO p2y_sync_audit VALUES (NEW.id, pg_trigger_depth()); RETURN NULL; END $f$;
CREATE TRIGGER p2y_audit AFTER UPDATE ON game_evaluations FOR EACH ROW
  WHEN (NEW.pair_eval_id IS NOT NULL AND OLD.pair_eval_id IS NOT DISTINCT FROM NEW.pair_eval_id)
  EXECUTE FUNCTION p2y_audit();

-- Rolled back in another time zone than the run (timestamps in the snapshot are compared as
-- values, not as text), in batches of 4 families (6 families: 4, 2, then nothing), each call
-- deleting the snapshots and log rows of the families it restored. The reference: the same
-- rollback in ONE call, undone again (subtransaction); the batched one must end identical.
SET TIME ZONE 'Asia/Ho_Chi_Minh';
CREATE TEMP TABLE p2y_rb (call integer, game_evaluation_id integer, kept_columns text[], linked_to integer);
CREATE TEMP TABLE p2y_batch (call integer, n integer, snaps_left integer, logs_left integer);
CREATE TEMP TABLE p2y_digest (one text, batched text);
CREATE FUNCTION pg_temp.p2y_state() RETURNS text LANGUAGE sql AS $f$
  SELECT md5((SELECT string_agg(to_jsonb(g)::text, ',' ORDER BY id) FROM game_evaluations g)
             || (SELECT string_agg(to_jsonb(l)::text, ',' ORDER BY id) FROM evaluation_log l)
             || (SELECT count(*) FROM eval_pair_merge_snapshots)::text)
$f$;
DO $$
DECLARE one text; i integer := 0; n integer;
BEGIN
  BEGIN
    PERFORM eval_pair_phase2_rollback('p2y_r1', 100000);
    one := pg_temp.p2y_state();
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'undo the one-call reference';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  ASSERT EXISTS (SELECT 1 FROM eval_pair_merge_snapshots WHERE run_id = 'p2y_r1'), 'the reference was undone';
  LOOP
    i := i + 1;
    PERFORM set_config('eval_pairs.keep_updated_at', 'before' || i, true);
    INSERT INTO p2y_rb SELECT i, x.* FROM eval_pair_phase2_rollback('p2y_r1', 4) x;
    GET DIAGNOSTICS n = ROW_COUNT;
    -- set at run time, not by a SET clause: the caller's value is back after each call
    ASSERT current_setting('eval_pairs.keep_updated_at', true) = 'before' || i,
      format('rollback call %s: setting not put back: %s', i, current_setting('eval_pairs.keep_updated_at', true));
    INSERT INTO p2y_batch VALUES (i, n, (SELECT count(*) FROM eval_pair_merge_snapshots WHERE run_id = 'p2y_r1'),
                                       (SELECT count(*) FROM evaluation_log WHERE context = 'p2y_r1'));
    EXIT WHEN n = 0 OR i >= 10;
  END LOOP;
  INSERT INTO p2y_digest VALUES (one, pg_temp.p2y_state());
END $$;
SET TIME ZONE 'UTC';

DROP TRIGGER p2y_audit ON game_evaluations;
DROP FUNCTION p2y_audit();

CREATE FUNCTION pg_temp.p2y_id(g text) RETURNS integer LANGUAGE sql AS
  $f$ SELECT id FROM game_evaluations WHERE game_id = g $f$;
CREATE FUNCTION pg_temp.p2y_kept(g text) RETURNS text[] LANGUAGE sql AS
  $f$ SELECT kept_columns FROM p2y_rb WHERE game_evaluation_id = pg_temp.p2y_id(g) $f$;
-- the row now vs before the run, minus updated_at, as the set of differing columns
CREATE FUNCTION pg_temp.p2y_diff(g text) RETURNS text[] LANGUAGE sql AS $f$
  SELECT COALESCE(array_agg(n.key ORDER BY n.key), '{}')
    FROM game_evaluations x JOIN p2y_before b ON b.id = x.id, jsonb_each(to_jsonb(x)) n
   WHERE x.game_id = g AND n.key <> 'updated_at' AND n.value IS DISTINCT FROM b.j -> n.key
$f$;

DO $$
BEGIN
  ASSERT (SELECT one = batched FROM p2y_digest), 'the batched rollback ends identical to the one-call rollback';
  ASSERT (SELECT string_agg(call || ':' || n || ':' || snaps_left || ':' || logs_left, ' ' ORDER BY call) FROM p2y_batch)
       = '1:8:4:2 2:4:0:0 3:0:0:0',
    format('batches (call:rows:snapshots left:log rows left): %s',
           (SELECT string_agg(call || ':' || n || ':' || snaps_left || ':' || logs_left, ' ' ORDER BY call) FROM p2y_batch));
  ASSERT (SELECT array_agg(DISTINCT s.family_id ORDER BY s.family_id) FROM p2y_rb r JOIN p2y_snaps s USING (game_evaluation_id)
           WHERE r.call = 1) = '{fam.p2y_a,fam.p2y_b,fam.p2y_c,fam.p2y_d}', 'batch 1 took the first 4 families';
  ASSERT (SELECT count(*) FROM p2y_sync_audit) = 0,
    format('the copy trigger ran during the rollback: %s', (SELECT string_agg(id || '@' || depth, ',') FROM p2y_sync_audit));
  -- one result row per snapshot row
  ASSERT (SELECT array_agg(game_evaluation_id ORDER BY game_evaluation_id) FROM p2y_rb)
       = (SELECT array_agg(game_evaluation_id ORDER BY game_evaluation_id) FROM p2y_snaps),
    format('one result row per snapshot row: %s', (SELECT string_agg(r::text, ' ') FROM p2y_rb r));
  -- the run is gone: snapshots, its log rows; and the rollback logs nothing (no pair_unlink)
  ASSERT NOT EXISTS (SELECT 1 FROM eval_pair_merge_snapshots WHERE run_id = 'p2y_r1'), 'snapshots of the run deleted';
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE context = 'p2y_r1'), 'log rows of the run deleted';
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE id > (SELECT max_id FROM p2y_log_pre)), 'the rollback wrote no log row';
  ASSERT (SELECT count(*) FROM evaluation_log) = (SELECT n FROM p2y_log_pre) - 6, 'exactly the run''s 6 log rows deleted';
  -- updated_at: not one row's moved
  ASSERT NOT EXISTS (SELECT 1 FROM game_evaluations g JOIN p2y_pre p ON p.id = g.id WHERE g.updated_at IS DISTINCT FROM p.updated_at),
    'updated_at unchanged by the rollback';
  -- rows outside the run: untouched (the lone row linked to X's front included)
  ASSERT NOT EXISTS (SELECT 1 FROM game_evaluations g JOIN p2y_pre p ON p.id = g.id
                      WHERE g.id NOT IN (SELECT game_evaluation_id FROM p2y_snaps) AND to_jsonb(g) <> p.j),
    'rows outside the run unchanged';

  -- A, B, C: no edit after the run: every row exactly as before the run, nothing kept
  ASSERT NOT EXISTS (
    SELECT 1 FROM game_evaluations g JOIN p2y_before b ON b.id = g.id
     WHERE g.game_id IN ('p2y_aa', 'p2y_ai', 'p2y_ba', 'p2y_bi', 'p2y_ca', 'p2y_ci')
       AND (to_jsonb(g) - 'updated_at') <> (b.j - 'updated_at')),
    format('A/B/C back to before: %s', (SELECT string_agg(x || '=' || pg_temp.p2y_diff(x)::text, ' ')
      FROM unnest('{p2y_aa,p2y_ai,p2y_ba,p2y_bi,p2y_ca,p2y_ci}'::text[]) x));
  ASSERT (SELECT bool_and(kept_columns = '{}') FROM p2y_rb
           WHERE game_evaluation_id IN (SELECT id FROM game_evaluations
                                         WHERE game_id IN ('p2y_aa', 'p2y_ai', 'p2y_ba', 'p2y_bi', 'p2y_ca', 'p2y_ci'))),
    'A/B/C nothing kept';
  ASSERT (SELECT final_conclusion IS NULL AND record_5min_batch = 'YF5' AND record_20min_batch IS NULL
            FROM game_evaluations WHERE game_id = 'p2y_ba'), 'B the front''s Record bucket and batches are back';
  ASSERT (SELECT record_confirmed_at IS NULL AND record_5min_confirmed_at IS NULL FROM game_evaluations WHERE game_id = 'p2y_ci'),
    'C the front''s recording and confirm time are gone';

  -- D: the final note edited after the run stays on both rows; on the back the run had written
  -- it (front's 'fn front' over 'fn back'): kept and reported. Everything else as before,
  -- credit gone, unlinked.
  ASSERT pg_temp.p2y_diff('p2y_da') = '{final_note}' AND pg_temp.p2y_diff('p2y_di') = '{final_note}',
    format('D only final_note differs: %s / %s', pg_temp.p2y_diff('p2y_da'), pg_temp.p2y_diff('p2y_di'));
  ASSERT (SELECT count(*) FROM game_evaluations WHERE game_id IN ('p2y_da', 'p2y_di') AND final_note = 'fn later'
            AND credit IS NULL AND pair_eval_id IS NULL AND NOT pair_back) = 2, 'D edit kept, credit cleared, unlinked';
  ASSERT pg_temp.p2y_kept('p2y_da') = '{}' AND pg_temp.p2y_kept('p2y_di') = '{final_note}',
    format('D kept: front %s back %s', pg_temp.p2y_kept('p2y_da'), pg_temp.p2y_kept('p2y_di'));
  ASSERT (SELECT youtube_link IS NULL FROM game_evaluations WHERE game_id = 'p2y_da')
     AND (SELECT youtube_link = 'https://y/yb' FROM game_evaluations WHERE game_id = 'p2y_di'),
    'D the moved YouTube link is back on the back store only';

  -- E: the video that landed after the run was never written by the run: it stays on both rows
  -- and is not reported
  ASSERT pg_temp.p2y_diff('p2y_ea') = '{youtube_link}' AND pg_temp.p2y_diff('p2y_ei') = '{youtube_link}',
    format('E only youtube_link differs: %s / %s', pg_temp.p2y_diff('p2y_ea'), pg_temp.p2y_diff('p2y_ei'));
  ASSERT pg_temp.p2y_kept('p2y_ea') = '{}' AND pg_temp.p2y_kept('p2y_ei') = '{}', 'E nothing reported';
  ASSERT (SELECT initial_conclusion = 'Bypass' AND credit IS NULL FROM game_evaluations WHERE game_id = 'p2y_ea'),
    'E the back store is Bypass again';

  -- X: the front, now linked to another row, keeps that link (reported); its eval group is
  -- back to its own, and the lone row it is linked to got no copy (rows outside the run, above)
  ASSERT pg_temp.p2y_diff('p2y_xa') = '{pair_eval_id}' AND pg_temp.p2y_diff('p2y_xi') = '{}',
    format('X: %s / %s', pg_temp.p2y_diff('p2y_xa'), pg_temp.p2y_diff('p2y_xi'));
  ASSERT pg_temp.p2y_kept('p2y_xa') = '{pair_eval_id}' AND pg_temp.p2y_kept('p2y_xi') = '{}',
    format('X kept: %s / %s', pg_temp.p2y_kept('p2y_xa'), pg_temp.p2y_kept('p2y_xi'));
  ASSERT (SELECT pair_eval_id = pg_temp.p2y_id('p2y_lone') AND initial_evaluator = 'P2yXw' AND initial_conclusion IS NULL
            FROM game_evaluations WHERE game_id = 'p2y_xa'), 'X front: its own eval group, the new link kept';
  -- linked_to names the row it is still linked to (that pair needs a save); NULL elsewhere
  ASSERT (SELECT string_agg(r.game_evaluation_id || '>' || r.linked_to, ' ') FROM p2y_rb r WHERE r.linked_to IS NOT NULL)
       = pg_temp.p2y_id('p2y_xa') || '>' || pg_temp.p2y_id('p2y_lone'), 'linked_to: only X''s front, to the lone row';
END $$;

-- ===== a second call, an unknown run, no run =====
CREATE TEMP TABLE p2y_snap AS
  SELECT (SELECT md5(string_agg(to_jsonb(g)::text, ',' ORDER BY id)) FROM game_evaluations g) AS ge,
         (SELECT count(*) FROM evaluation_log) AS logs,
         (SELECT count(*) FROM eval_pair_merge_snapshots) AS snaps;
DO $$
DECLARE ran boolean := false;
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM eval_pair_phase2_rollback('p2y_r1')), 'a second rollback of the run returns nothing';
  ASSERT NOT EXISTS (SELECT 1 FROM eval_pair_phase2_rollback('p2y_no_such_run')), 'an unknown run returns nothing';
  ASSERT NOT EXISTS (SELECT 1 FROM eval_pair_phase2_rollback('p2y_r1', 0)), 'max_families 0 returns nothing';
  ASSERT (SELECT md5(string_agg(to_jsonb(g)::text, ',' ORDER BY id)) FROM game_evaluations g) = (SELECT ge FROM p2y_snap),
    'second / unknown rollback changed game_evaluations';
  ASSERT (SELECT count(*) FROM evaluation_log) = (SELECT logs FROM p2y_snap), 'second / unknown rollback changed evaluation_log';
  ASSERT (SELECT count(*) FROM eval_pair_merge_snapshots) = (SELECT snaps FROM p2y_snap), 'second / unknown rollback changed snapshots';
  BEGIN
    PERFORM eval_pair_phase2_rollback('');
    ran := true;
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM LIKE '%run_id%', format('rollback without a run_id: %s', SQLERRM);
  END;
  ASSERT NOT ran, 'rollback without a run_id must fail';
END $$;

-- ===== part 2: every other run (the apply checks' p2x_r1, p2x_r2, p2w_run, p2v_run) =====
-- Their pairs saw edits after the run (a save on p2x_da, p2v's family change that split the
-- pair). The rule, per snapshot row, against the row just before the rollback (cur):
--   a column the run wrote  -> before-run value where cur still has the written value, else cur
--   (pair_back follows an unlinked row: false; 051's derived record_confirmed_at /
--    youtube_uploaded_at are not compared, the trigger sets them)
--   any other column        -> cur;   updated_at -> cur
--   kept_columns            = the written columns whose value is not the before-run one.
-- one more edit after a run, of a column the run wrote: D's back row took the front's note
-- (p2x_r1 / p2x_r2); a new save on the front copies a new one to it
UPDATE game_evaluations SET initial_note = 'edited after the run' WHERE game_id = 'p2x_da';
CREATE TEMP TABLE p2y_runs AS SELECT DISTINCT run_id FROM eval_pair_merge_snapshots;
CREATE TEMP TABLE p2y_snaps2 AS SELECT * FROM eval_pair_merge_snapshots;
CREATE TEMP TABLE p2y_pre2 AS SELECT id, to_jsonb(g) AS j, updated_at FROM game_evaluations g;
CREATE TEMP TABLE p2y_log2 AS SELECT count(*) AS n, max(id) AS max_id FROM evaluation_log;
CREATE TEMP TABLE p2y_rb2 (run_id text, game_evaluation_id integer, kept_columns text[], linked_to integer);
DO $$
DECLARE r text; n integer; calls integer := 0;
BEGIN
  ASSERT (SELECT array_agg(run_id ORDER BY run_id) FROM p2y_runs) = '{p2v_run,p2w_run,p2x_r1,p2x_r2}',
    format('fixture: the runs left by the apply checks: %s', (SELECT array_agg(run_id) FROM p2y_runs));
  -- 3 families per call, until a call returns nothing
  FOR r IN SELECT run_id FROM p2y_runs ORDER BY run_id DESC LOOP
    LOOP
      INSERT INTO p2y_rb2 SELECT r, x.* FROM eval_pair_phase2_rollback(r, 3) x;
      GET DIAGNOSTICS n = ROW_COUNT;
      calls := calls + 1;
      EXIT WHEN n = 0 OR calls > 100;
    END LOOP;
  END LOOP;
  ASSERT calls > (SELECT count(*) FROM p2y_runs) * 2, format('fixture: runs rolled back over several calls (%s)', calls);
END $$;
DO $$
DECLARE bad text;
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM eval_pair_merge_snapshots), 'every snapshot deleted';
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE context IN (SELECT run_id FROM p2y_runs)), 'every run''s log rows deleted';
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE id > (SELECT max_id FROM p2y_log2)), 'no log row written';
  ASSERT (SELECT count(*) FROM p2y_rb2) = (SELECT count(*) FROM p2y_snaps2), 'one result row per snapshot row';
  ASSERT NOT EXISTS (SELECT 1 FROM game_evaluations g JOIN p2y_pre2 p ON p.id = g.id WHERE g.updated_at IS DISTINCT FROM p.updated_at),
    'updated_at unchanged';
  ASSERT NOT EXISTS (SELECT 1 FROM game_evaluations g JOIN p2y_pre2 p ON p.id = g.id
                      WHERE g.id NOT IN (SELECT game_evaluation_id FROM p2y_snaps2) AND to_jsonb(g) <> p.j),
    'rows outside the runs unchanged';
  ASSERT NOT EXISTS (SELECT 1 FROM game_evaluations WHERE credit IS NOT NULL
                       AND id IN (SELECT game_evaluation_id FROM p2y_snaps2 WHERE written ? 'credit')), 'credit cleared';

  SELECT string_agg(format('%s.%s got %s want %s', s.game_evaluation_id, c.key, n.j -> c.key, c.want), '; ') INTO bad
    FROM p2y_snaps2 s
    JOIN p2y_pre2 p ON p.id = s.game_evaluation_id
    CROSS JOIN LATERAL (SELECT to_jsonb(g) AS j FROM game_evaluations g WHERE g.id = s.game_evaluation_id) n
    CROSS JOIN LATERAL (
      SELECT k.key,
             CASE WHEN k.key = 'pair_back' AND n.j -> 'pair_eval_id' = 'null' THEN 'false'::jsonb
                  WHEN s.written ? k.key AND p.j -> k.key IS NOT DISTINCT FROM s.written -> k.key THEN s.row_before -> k.key
                  ELSE p.j -> k.key END AS want
        FROM jsonb_object_keys(p.j) k(key)
       WHERE k.key NOT IN ('updated_at', 'record_confirmed_at', 'youtube_uploaded_at')) c
   WHERE n.j -> c.key IS DISTINCT FROM c.want;
  ASSERT bad IS NULL, format('the general rule: %s', bad);

  SELECT string_agg(format('%s kept %s want %s', r.game_evaluation_id, r.kept_columns, w.want), '; ') INTO bad
    FROM p2y_rb2 r JOIN p2y_snaps2 s ON s.game_evaluation_id = r.game_evaluation_id AND s.run_id = r.run_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(array_agg(k ORDER BY k), '{}') AS want
        FROM jsonb_object_keys(s.written) k, game_evaluations g
       WHERE g.id = s.game_evaluation_id AND k <> 'updated_at' AND to_jsonb(g) -> k IS DISTINCT FROM s.row_before -> k) w
   WHERE r.kept_columns IS DISTINCT FROM w.want;
  ASSERT bad IS NULL, format('kept_columns: %s', bad);
  ASSERT (SELECT kept_columns FROM p2y_rb2 r JOIN game_evaluations g ON g.id = r.game_evaluation_id
           WHERE g.game_id = 'p2x_di') = '{initial_note}', 'the note edited after the run is reported on D''s back row';
  ASSERT (SELECT count(*) FROM game_evaluations WHERE game_id IN ('p2x_da', 'p2x_di')
            AND initial_note = 'edited after the run') = 2, 'the note edited after the run stays on both rows';
END $$;

DROP TABLE p2y_before, p2y_apply, p2y_snaps, p2y_pre, p2y_log_pre, p2y_sync_audit, p2y_rb, p2y_batch, p2y_digest, p2y_snap,
           p2y_runs, p2y_snaps2, p2y_pre2, p2y_log2, p2y_rb2;
