\set ON_ERROR_STOP 1
SET TIME ZONE 'UTC';
-- Migration 054, part 2: copy on update (6.2 a), reopen, front/back row, delete.
-- Runs after pairs-link-checks.sql on the throwaway DB of scripts/verify-eval-pairs.sh.
-- Every block builds its own linked pair with pg_temp.mkpair: game 'ra<tag>' (android,
-- inserted first, so the lower id) is R, game 'ti<tag>' (ios) is T. The family is set
-- after both rows exist, then link_eval_pair(T, R) links them as a push would.

CREATE FUNCTION pg_temp.mkpair(tag text, r jsonb, t jsonb) RETURNS integer[]
LANGUAGE plpgsql AS $$
DECLARE rid int; tid int;
BEGIN
  INSERT INTO game_info (game_id, os) VALUES ('ra' || tag, 'android'), ('ti' || tag, 'ios');
  INSERT INTO game_evaluations
    SELECT * FROM jsonb_populate_record(NULL::game_evaluations,
      jsonb_build_object('id', nextval('game_evaluations_id_seq'), 'game_id', 'ra' || tag,
        'category_group', 'puzzle', 'game_alike', '[]'::jsonb, 'pair_back', false) || r)
    RETURNING id INTO rid;
  INSERT INTO game_evaluations
    SELECT * FROM jsonb_populate_record(NULL::game_evaluations,
      jsonb_build_object('id', nextval('game_evaluations_id_seq'), 'game_id', 'ti' || tag,
        'category_group', 'puzzle', 'game_alike', '[]'::jsonb, 'pair_back', false) || t)
    RETURNING id INTO tid;
  UPDATE game_info SET family_id = 'fam.y' || tag WHERE game_id IN ('ra' || tag, 'ti' || tag);
  ASSERT link_eval_pair(tid, rid), format('fixture pair %s links', tag);
  RETURN ARRAY[rid, tid];
END $$;

-- Columns of a group where rows a and b differ (NULL when they agree).
CREATE FUNCTION pg_temp.diff(a integer, b integer, cols text[]) RETURNS text[]
LANGUAGE sql AS $$
  SELECT array_agg(c) FROM unnest(cols) c,
    (SELECT to_jsonb(g) AS j FROM game_evaluations g WHERE id = a) x,
    (SELECT to_jsonb(g) AS j FROM game_evaluations g WHERE id = b) y
  WHERE x.j -> c IS DISTINCT FROM y.j -> c
$$;

CREATE FUNCTION pg_temp.back(id_ integer) RETURNS boolean
LANGUAGE sql AS $$ SELECT pair_back FROM game_evaluations WHERE id = id_ $$;

-- ===== schema =====
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'game_evaluations'::regclass
            AND tgname IN ('trg_eval_pair_sync', 'trg_eval_pair_delete')) = 2, 'sync and delete triggers';
  -- update_game_evaluations_timestamp is shared with weekly_feedback (sample DB), so 054
  -- must not teach it about pair columns
  ASSERT position('pair' IN (SELECT prosrc FROM pg_proc WHERE proname = 'update_game_evaluations_timestamp')) = 0,
    'the shared timestamp function is left alone';
END $$;

-- ===== sync_changed_only: two people save two different columns =====
DO $$
DECLARE p int[];
BEGIN
  p := pg_temp.mkpair('1', '{"initial_evaluator": "ThuDT"}', '{}');
  UPDATE game_evaluations SET initial_note = 'note from A 123' WHERE id = p[1];
  UPDATE game_evaluations SET final_note = 'final from B' WHERE id = p[2];
  ASSERT (SELECT count(*) FROM game_evaluations
          WHERE id = ANY (p) AND initial_note = 'note from A 123' AND final_note = 'final from B') = 2,
    'both rows have both values';
  ASSERT (SELECT count(*) FILTER (WHERE pair_back) FROM game_evaluations WHERE id = ANY (p)) = 1, 'one back row';
END $$;

-- ===== sync_full_result: a full verdict reaches the twin, genre stays per store =====
DO $$
DECLARE p int[]; d text[];
BEGIN
  p := pg_temp.mkpair('2', '{"initial_evaluator": "ThuDT", "genre_1": "Match3"}', '{"genre_1": "Sort"}');
  UPDATE game_evaluations SET initial_conclusion = 'List_Idea', evaluate_date = now(), batch = 'W4 Nov',
      game_alike = '[{"name": "x"}]', initial_note = 'great loop 123', updated_by = 'ThuDT', genre_1 = 'Merge'
   WHERE id = p[1];
  d := pg_temp.diff(p[1], p[2], eval_pair_eval_cols());
  ASSERT d IS NULL, format('evaluation columns differ: %s', d);
  ASSERT (SELECT initial_conclusion FROM game_evaluations WHERE id = p[2]) = 'List_Idea', 'T judged';
  ASSERT (SELECT genre_1 FROM game_evaluations WHERE id = p[2]) = 'Sort', 'T keeps its own genre';
  ASSERT NOT pg_temp.back(p[1]) AND pg_temp.back(p[2]), 'R front, T back';
END $$;

-- ===== sync_media_when_dead: n8n writes the demo link to the dead store's row =====
DO $$
DECLARE p int[]; d text[];
BEGIN
  p := pg_temp.mkpair('3', '{"initial_conclusion": "List_Idea", "initial_evaluator": "ThuDT"}',
                           '{"initial_conclusion": "Link_dead", "initial_evaluator": "ThuDT"}');
  UPDATE game_evaluations SET drive_link = 'https://drive/x', drive_date = now() WHERE id = p[2];
  ASSERT (SELECT drive_link FROM game_evaluations WHERE id = p[1]) = 'https://drive/x', 'R took the demo link';
  d := pg_temp.diff(p[1], p[2], eval_pair_media_cols());
  ASSERT d IS NULL, format('media differs: %s', d);
  ASSERT (SELECT initial_conclusion FROM game_evaluations WHERE id = p[1]) = 'List_Idea', 'R keeps its verdict';
END $$;

-- ===== no_sync_into_dead: a verdict does not overwrite the dead store =====
DO $$
DECLARE p int[];
BEGIN
  p := pg_temp.mkpair('4', '{"initial_evaluator": "ThuDT"}',
    '{"initial_conclusion": "Link_dead", "initial_evaluator": "QuangVN", "initial_note": "store 404"}');
  UPDATE game_evaluations SET initial_conclusion = 'Bypass', initial_note = 'bypass note 1', updated_by = 'ThuDT'
   WHERE id = p[1];
  ASSERT (SELECT initial_conclusion = 'Link_dead' AND initial_note = 'store 404' AND initial_evaluator = 'QuangVN'
          AND updated_by IS NULL FROM game_evaluations WHERE id = p[2]), 'T keeps Link_dead and its own columns';
  ASSERT NOT pg_temp.back(p[1]) AND pg_temp.back(p[2]), 'the dead store is the back row';
END $$;

-- ===== mark_dead_no_copy: marking one store dead leaves the other alone =====
DO $$
DECLARE p int[];
BEGIN
  p := pg_temp.mkpair('5', '{"initial_conclusion": "List_Idea", "initial_evaluator": "ThuDT", "initial_note": "good game 123"}', '{}');
  ASSERT (SELECT initial_conclusion FROM game_evaluations WHERE id = p[2]) = 'List_Idea', 'fixture: T took the verdict';
  UPDATE game_evaluations SET initial_conclusion = 'Link_dead', initial_note = 'ios 404 link', updated_by = 'QuangVN'
   WHERE id = p[2];
  ASSERT (SELECT initial_conclusion = 'List_Idea' AND initial_note = 'good game 123' AND updated_by IS NULL
          FROM game_evaluations WHERE id = p[1]), 'R keeps List_Idea';
  ASSERT NOT pg_temp.back(p[1]) AND pg_temp.back(p[2]), 'R front, T back';
END $$;

-- ===== front_moves: the lower id goes dead, the twin becomes the front row, and back =====
DO $$
DECLARE p int[];
BEGIN
  p := pg_temp.mkpair('13', '{"initial_conclusion": "List_Idea", "initial_evaluator": "ThuDT"}', '{}');
  ASSERT NOT pg_temp.back(p[1]) AND pg_temp.back(p[2]), 'lower id is the front row';
  UPDATE game_evaluations SET initial_conclusion = 'Link_dead' WHERE id = p[1];
  ASSERT pg_temp.back(p[1]) AND NOT pg_temp.back(p[2]), 'the dead row moved to the back';
  ASSERT (SELECT initial_conclusion FROM game_evaluations WHERE id = p[2]) = 'List_Idea', 'T keeps its verdict';
  UPDATE game_evaluations SET initial_conclusion = NULL WHERE id = p[1];
  ASSERT NOT pg_temp.back(p[1]) AND pg_temp.back(p[2]), 'reopened: the lower id is the front row again';
  ASSERT (SELECT initial_conclusion FROM game_evaluations WHERE id = p[1]) = 'List_Idea', 'R took the pair verdict back';
END $$;

-- ===== reopen_takes_pair_result: the dead store reopens and takes the pair's result =====
DO $$
DECLARE p int[]; d text[];
BEGIN
  p := pg_temp.mkpair('6',
    '{"initial_conclusion": "List_Idea", "initial_evaluator": "ThuDT", "initial_note": "pair note 12345",
      "batch": "W4 Nov", "evaluate_date": "2026-11-20T03:00:00Z", "category_group": "puzzle"}',
    '{"initial_conclusion": "Link_dead", "initial_evaluator": "QuangVN", "initial_note": "dead",
      "batch": "W1 Nov", "category_group": "arcade"}');
  ASSERT pg_temp.back(p[2]), 'fixture: dead T is the back row';
  UPDATE game_evaluations SET initial_conclusion = NULL, updated_by = 'QuangVN' WHERE id = p[2];
  ASSERT (SELECT initial_conclusion = 'List_Idea' AND initial_note = 'pair note 12345' AND initial_evaluator = 'ThuDT'
          FROM game_evaluations WHERE id = p[2]), 'T took verdict, note and evaluator';
  d := pg_temp.diff(p[1], p[2], eval_pair_eval_cols());
  ASSERT d IS NULL, format('evaluation columns differ after reopen: %s', d);
  ASSERT (SELECT category_group FROM game_evaluations WHERE id = p[2]) = 'puzzle', 'T moved to the pair''s category_group';
  ASSERT NOT pg_temp.back(p[1]) AND pg_temp.back(p[2]), 'T (higher id) is the back row';
  ASSERT (SELECT initial_note FROM game_evaluations WHERE id = p[1]) = 'pair note 12345', 'R untouched';
END $$;

-- ===== reopen_pending_takes_holder: the pair is not judged yet; reopen follows the holder =====
DO $$
DECLARE p int[]; d text[];
BEGIN
  p := pg_temp.mkpair('7',
    '{"initial_evaluator": "ThuDT", "assigned_date": "2026-11-19", "first_assigned_date": "2026-11-18", "batch": "W4 Nov"}',
    '{"initial_conclusion": "Link_dead", "initial_evaluator": "QuangVN", "assigned_date": "2026-11-10",
      "first_assigned_date": "2026-11-10", "initial_note": "dead link 1", "evaluate_date": "2026-11-11T03:00:00Z"}');
  UPDATE game_evaluations SET initial_conclusion = NULL WHERE id = p[2];
  ASSERT (SELECT initial_evaluator = 'ThuDT' AND assigned_date = '2026-11-19' AND first_assigned_date = '2026-11-18'
          FROM game_evaluations WHERE id = p[2]), 'T follows the holder and the assign dates';
  -- nothing of the dead store's own result is left behind on the reopened row
  d := pg_temp.diff(p[1], p[2], eval_pair_eval_cols());
  ASSERT d IS NULL, format('evaluation columns differ after reopen: %s', d);
  ASSERT (SELECT initial_evaluator FROM game_evaluations WHERE id = p[1]) = 'ThuDT', 'R keeps its holder';
END $$;

-- ===== reopen_keeps_record_batches: reopen moves T's own bucket, record batches stay the pair's =====
DO $$
DECLARE p int[]; d text[];
BEGIN
  p := pg_temp.mkpair('14',
    '{"initial_conclusion": "List_Idea", "initial_evaluator": "ThuDT", "final_conclusion": "Priority IV",
      "batch": "W3 Nov", "record_5min_batch": "W2 Nov", "record_20min_batch": "W3 Nov"}',
    '{"initial_conclusion": "Link_dead", "initial_evaluator": "ThuDT", "batch": "W1 Nov"}');
  ASSERT pg_temp.diff(p[1], p[2], eval_pair_media_cols()) IS NULL, 'fixture: media shared';
  UPDATE game_evaluations SET initial_conclusion = NULL WHERE id = p[2];
  d := pg_temp.diff(p[1], p[2], eval_pair_eval_cols() || eval_pair_media_cols());
  ASSERT d IS NULL, format('pair differs after reopen: %s', d);
END $$;

-- ===== both_dead: both stores carry a store-only result =====
DO $$
DECLARE p int[];
BEGIN
  p := pg_temp.mkpair('8', '{"initial_conclusion": "Link_dead", "initial_evaluator": "ThuDT"}',
                           '{"initial_conclusion": "Stale_release", "initial_evaluator": "QuangVN"}');
  ASSERT NOT pg_temp.back(p[1]) AND pg_temp.back(p[2]), 'lower id is the front row';
  UPDATE game_evaluations SET initial_note = 'only ios 12345' WHERE id = p[2];
  ASSERT (SELECT initial_note FROM game_evaluations WHERE id = p[1]) IS NULL, 'T''s note not copied';
  UPDATE game_evaluations SET initial_note = 'only android 1' WHERE id = p[1];
  ASSERT (SELECT initial_note FROM game_evaluations WHERE id = p[2]) = 'only ios 12345', 'R''s note not copied';
  -- R reopens while T is still dead: nothing to take, R is the front row
  UPDATE game_evaluations SET initial_conclusion = NULL WHERE id = p[1];
  ASSERT (SELECT initial_conclusion IS NULL AND initial_evaluator = 'ThuDT' FROM game_evaluations WHERE id = p[1]),
    'R took nothing from a dead twin';
  ASSERT NOT pg_temp.back(p[1]) AND pg_temp.back(p[2]), 'R front, dead T back';
END $$;

-- ===== record_slots_converge: 051's record_slots trigger runs on both rows =====
DO $$
DECLARE p int[]; d text[];
BEGIN
  p := pg_temp.mkpair('9',
    '{"initial_conclusion": "List_Idea", "initial_evaluator": "ThuDT", "final_conclusion": "Insight",
      "batch": "W3 Nov", "record_5min_assignee": "VinhTD"}', '{}');
  UPDATE game_evaluations SET record_bucket = '20min', final_conclusion = 'Priority IV', record_20min_assignee = 'VinhTD'
   WHERE id = p[1];
  d := pg_temp.diff(p[1], p[2], eval_pair_media_cols() || eval_pair_eval_cols());
  ASSERT d IS NULL, format('pair differs: %s', d);
  ASSERT (SELECT record_5min_batch FROM game_evaluations WHERE id = p[2]) = 'W3 Nov', 'the 5min round froze its batch';
  -- the batch moves with the bucket change in the same statement
  UPDATE game_evaluations SET batch = 'W4 Nov', record_bucket = '5min' WHERE id = p[2];
  d := pg_temp.diff(p[1], p[2], eval_pair_media_cols() || eval_pair_eval_cols());
  ASSERT d IS NULL, format('pair differs after the second move: %s', d);
END $$;

-- ===== sync_both_rows_one_statement: one UPDATE writes both rows of a pair =====
DO $$
DECLARE p int[]; d text[];
BEGIN
  p := pg_temp.mkpair('12', '{"initial_evaluator": "ThuDT", "batch": "W4 Nov"}', '{}');
  UPDATE game_evaluations SET initial_evaluator = 'QuangVN' WHERE id = ANY (p);
  ASSERT (SELECT count(*) FROM game_evaluations WHERE id = ANY (p) AND initial_evaluator = 'QuangVN') = 2, 'same value';
  UPDATE game_evaluations SET batch = CASE WHEN id = p[1] THEN 'W1 Dec' ELSE 'W2 Dec' END WHERE id = ANY (p);
  d := pg_temp.diff(p[1], p[2], eval_pair_eval_cols());
  ASSERT d IS NULL, format('two values in one statement still converge: %s', d);
END $$;

-- ===== unlink_on_invalid: the family no longer holds, the pair splits and keeps its data =====
DO $$
DECLARE p int[];
BEGIN
  p := pg_temp.mkpair('10', '{"initial_evaluator": "ThuDT"}', '{}');
  UPDATE game_info SET family_unlinked = true WHERE game_id = 'ti10';
  UPDATE game_evaluations SET initial_note = 'after unlink 123' WHERE id = p[1];
  ASSERT NOT EXISTS (SELECT 1 FROM game_evaluations WHERE id = ANY (p) AND (pair_eval_id IS NOT NULL OR pair_back)),
    'both rows unlinked';
  ASSERT (SELECT initial_note FROM game_evaluations WHERE id = p[2]) IS NULL, 'T did not take the note';
  ASSERT (SELECT initial_note FROM game_evaluations WHERE id = p[1]) = 'after unlink 123', 'R kept its write';
  ASSERT (SELECT initial_evaluator FROM game_evaluations WHERE id = p[2]) = 'ThuDT', 'T keeps its data';
END $$;

-- ===== delete_front: the remaining row is a lone game again =====
DO $$
DECLARE p int[];
BEGIN
  p := pg_temp.mkpair('11', '{"initial_conclusion": "List_Idea", "initial_evaluator": "ThuDT"}', '{}');
  ASSERT pg_temp.back(p[2]), 'fixture: T is the back row';
  DELETE FROM game_evaluations WHERE id = p[1];
  ASSERT (SELECT pair_eval_id IS NULL AND NOT pair_back FROM game_evaluations WHERE id = p[2]),
    'T unlinked and back to the front';
  ASSERT (SELECT initial_conclusion FROM game_evaluations WHERE id = p[2]) = 'List_Idea', 'T keeps its data';
END $$;

-- ===== updated_at: linking, front/back moves, unlinking and deleting are not edits =====
DO $$
DECLARE t int; n int; p int[];
BEGIN
  -- link on insert does not touch the row already there
  INSERT INTO game_info (game_id, os, family_id) VALUES ('au1', 'android', 'fam.u1'), ('iu1', 'ios', 'fam.u1');
  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator, updated_at)
    VALUES ('au1', 'puzzle', 'ThuDT', '2026-01-01Z') RETURNING id INTO t;
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('iu1', 'puzzle') RETURNING id INTO n;
  ASSERT (SELECT pair_eval_id FROM game_evaluations WHERE id = t) = n, 'linked';
  ASSERT (SELECT updated_at FROM game_evaluations WHERE id = t) = '2026-01-01Z', 'link on insert left T.updated_at';
  -- deleting the twin does not touch it either
  DELETE FROM game_evaluations WHERE id = n;
  ASSERT (SELECT pair_eval_id IS NULL AND updated_at = '2026-01-01Z' FROM game_evaluations WHERE id = t),
    'delete left T.updated_at';
  -- a real edit still stamps it
  UPDATE game_evaluations SET initial_note = 'edited 12345' WHERE id = t;
  ASSERT (SELECT updated_at FROM game_evaluations WHERE id = t) = now(), 'an edit stamps updated_at';

  -- the front/back move of the twin when one row goes dead or reopens
  p := pg_temp.mkpair('15', '{"initial_conclusion": "List_Idea", "initial_evaluator": "ThuDT"}', '{}');
  ALTER TABLE game_evaluations DISABLE TRIGGER trg_game_evaluations_updated;
  UPDATE game_evaluations SET updated_at = '2026-01-01Z' WHERE id = ANY (p);
  ALTER TABLE game_evaluations ENABLE TRIGGER trg_game_evaluations_updated;
  UPDATE game_evaluations SET initial_conclusion = 'Link_dead' WHERE id = p[1];
  ASSERT NOT pg_temp.back(p[2]), 'T moved to the front';
  ASSERT (SELECT updated_at FROM game_evaluations WHERE id = p[2]) = '2026-01-01Z', 'the move left T.updated_at';
  UPDATE game_evaluations SET final_note = 'copied 1' WHERE id = p[2];
  ASSERT (SELECT updated_at FROM game_evaluations WHERE id = p[2]) = now(), 'T edited';
  ASSERT (SELECT updated_at FROM game_evaluations WHERE id = p[1]) = now(), 'dead R edited when marked';
  -- unlink on an invalid pair
  p := pg_temp.mkpair('16', '{"initial_evaluator": "ThuDT"}', '{}');
  ALTER TABLE game_evaluations DISABLE TRIGGER trg_game_evaluations_updated;
  UPDATE game_evaluations SET updated_at = '2026-01-01Z' WHERE id = ANY (p);
  ALTER TABLE game_evaluations ENABLE TRIGGER trg_game_evaluations_updated;
  UPDATE game_info SET family_unlinked = true WHERE game_id = 'ti16';
  UPDATE game_evaluations SET genre_1 = 'Sort' WHERE id = p[1];
  ASSERT (SELECT pair_eval_id IS NULL AND updated_at = '2026-01-01Z' FROM game_evaluations WHERE id = p[2]),
    'unlink left T.updated_at';
END $$;

-- ===== safe_pass_with_sync: link_safe_eval_pairs() runs at trigger depth 0, so the
-- sync trigger fires on its UPDATEs. It must not copy, log or move anything extra. =====
DO $$
DECLARE linked int; f int; b int; before_other text; d text[];
BEGIN
  SELECT string_agg(to_jsonb(g)::text, ',' ORDER BY id) INTO before_other FROM game_evaluations g;
  INSERT INTO game_info (game_id, os) VALUES ('aw1', 'android'), ('iw1', 'ios');
  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator, batch, drive_link) VALUES
    ('aw1', 'puzzle', 'ThuDT', NULL, 'https://drive/aw1'),
    ('iw1', 'puzzle', NULL, 'W4 Nov', NULL);
  UPDATE game_info SET family_id = 'fam.w1' WHERE game_id IN ('aw1', 'iw1');
  linked := link_safe_eval_pairs();
  ASSERT linked = 1, format('linked %s', linked);
  SELECT id INTO f FROM game_evaluations WHERE game_id = 'aw1';
  SELECT id INTO b FROM game_evaluations WHERE game_id = 'iw1';
  d := pg_temp.diff(f, b, eval_pair_eval_cols() || eval_pair_media_cols());
  ASSERT d IS NULL, format('safe pair differs: %s', d);
  ASSERT NOT pg_temp.back(f) AND pg_temp.back(b), 'one back row';
  ASSERT (SELECT count(*) FROM evaluation_log WHERE game_id IN ('aw1', 'iw1')) = 1, 'only the pair_link log';
  -- every row that was there before is untouched
  ASSERT (SELECT string_agg(to_jsonb(g)::text, ',' ORDER BY id) FROM game_evaluations g
          WHERE game_id NOT IN ('aw1', 'iw1')) = before_other, 'other rows untouched by the pass';
END $$;

-- ===== insert_never_fails: a link that errors leaves the INSERT standing =====
BEGIN;
SET LOCAL client_min_messages = error;
-- sabotage: the pair_link log row cannot be written, so link_eval_pair fails midway
ALTER TABLE evaluation_log ADD CONSTRAINT verify_sabotage_no_pair_link CHECK (kind <> 'pair_link') NOT VALID;
DO $$
DECLARE t int; n int;
BEGIN
  INSERT INTO game_info (game_id, os, family_id) VALUES ('az1', 'android', 'fam.z1'), ('iz1', 'ios', 'fam.z1');
  INSERT INTO game_evaluations (game_id, category_group, initial_conclusion, initial_evaluator)
    VALUES ('az1', 'puzzle', 'List_Idea', 'ThuDT') RETURNING id INTO t;
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('iz1', 'arcade') RETURNING id INTO n;
  ASSERT n IS NOT NULL AND EXISTS (SELECT 1 FROM game_evaluations WHERE id = n), 'the INSERT went through';
  ASSERT NOT EXISTS (SELECT 1 FROM game_evaluations WHERE id IN (t, n) AND (pair_eval_id IS NOT NULL OR pair_back)),
    'the failed link left nothing linked';
  ASSERT (SELECT initial_conclusion IS NULL AND category_group = 'arcade' FROM game_evaluations WHERE id = n),
    'the failed link left nothing copied';
  -- the transaction is still usable
  UPDATE game_evaluations SET initial_note = 'still works' WHERE id = n;
END $$;
ROLLBACK;
DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verify_sabotage_no_pair_link'), 'sabotage rolled back';
END $$;

-- ===== forward_one_update: a save that changes media and evaluation columns reaches
-- the twin in ONE UPDATE =====
BEGIN;
CREATE TABLE verify_twin_writes (id integer);
CREATE FUNCTION verify_count_twin_writes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO verify_twin_writes VALUES (NEW.id); RETURN NULL; END $$;
CREATE TRIGGER zz_verify_count AFTER UPDATE ON game_evaluations
  FOR EACH ROW WHEN (pg_trigger_depth() > 0) EXECUTE FUNCTION verify_count_twin_writes();
DO $$
DECLARE p int[]; d text[];
BEGIN
  p := pg_temp.mkpair('17', '{"initial_evaluator": "ThuDT"}', '{}');
  DELETE FROM verify_twin_writes;
  UPDATE game_evaluations SET initial_note = 'note and link 1', drive_link = 'https://drive/17' WHERE id = p[1];
  d := pg_temp.diff(p[1], p[2], eval_pair_eval_cols() || eval_pair_media_cols());
  ASSERT d IS NULL, format('pair differs: %s', d);
  ASSERT (SELECT count(*) FROM verify_twin_writes WHERE id = p[2]) = 1,
    format('T written %s times', (SELECT count(*) FROM verify_twin_writes WHERE id = p[2]));
END $$;
ROLLBACK;

-- ===== reopen_with_own_verdict: the dead store reopens with a verdict of its own =====
DO $$
DECLARE p int[]; d text[];
BEGIN
  -- T not judged yet: R's verdict is the pair's
  p := pg_temp.mkpair('18', '{"initial_evaluator": "ThuDT", "assigned_date": "2026-11-19", "batch": "W4 Nov"}',
    '{"initial_conclusion": "Link_dead", "initial_evaluator": "QuangVN", "initial_note": "dead link 1"}');
  ASSERT pg_temp.back(p[2]), 'fixture: dead T is the back row';
  UPDATE game_evaluations SET initial_conclusion = 'List_Idea', initial_note = 'works now, good 1',
      evaluate_date = now(), updated_by = 'QuangVN' WHERE id = p[2];
  ASSERT (SELECT initial_conclusion = 'List_Idea' AND initial_note = 'works now, good 1' AND initial_evaluator = 'QuangVN'
          FROM game_evaluations WHERE id = p[2]), 'T keeps its own verdict';
  d := pg_temp.diff(p[1], p[2], eval_pair_eval_cols());
  ASSERT d IS NULL, format('pair differs after reopen with a verdict: %s', d);
  ASSERT NOT pg_temp.back(p[1]) AND pg_temp.back(p[2]), 'lower id front again';

  -- T already judged: the pair's verdict wins, as in a plain reopen
  p := pg_temp.mkpair('19', '{"initial_conclusion": "List_Idea", "initial_evaluator": "ThuDT", "initial_note": "pair note 12345"}',
    '{"initial_conclusion": "Link_dead", "initial_evaluator": "QuangVN"}');
  UPDATE game_evaluations SET initial_conclusion = 'Bypass', initial_note = 'my own 12345' WHERE id = p[2];
  ASSERT (SELECT initial_conclusion = 'List_Idea' AND initial_note = 'pair note 12345' FROM game_evaluations WHERE id = p[2]),
    'T took the pair verdict';
  ASSERT (SELECT initial_conclusion FROM game_evaluations WHERE id = p[1]) = 'List_Idea', 'R untouched';
  d := pg_temp.diff(p[1], p[2], eval_pair_eval_cols());
  ASSERT d IS NULL, format('pair differs: %s', d);
END $$;

-- ===== unlink_on_second_row: a second row for one store makes the pair invalid; the next
-- write splits it (no game_info change involved) and logs each row =====
DO $$
DECLARE p int[];
BEGIN
  p := pg_temp.mkpair('20', '{"initial_evaluator": "ThuDT"}', '{}');
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('ti20', 'arcade');
  ASSERT (SELECT pair_eval_id FROM game_evaluations WHERE id = p[2]) = p[1], 'fixture: still linked';
  UPDATE game_evaluations SET initial_note = 'after second row' WHERE id = p[1];
  ASSERT NOT EXISTS (SELECT 1 FROM game_evaluations WHERE id = ANY (p) AND (pair_eval_id IS NOT NULL OR pair_back)),
    'both rows unlinked';
  ASSERT (SELECT initial_note FROM game_evaluations WHERE id = p[2]) IS NULL, 'T did not take the note';
  ASSERT (SELECT count(*) FROM evaluation_log l JOIN game_evaluations g ON g.id = l.game_evaluation_id
          WHERE l.game_evaluation_id = ANY (p) AND l.kind = 'pair_unlink' AND l.actor = 'System'
            AND l.pair_scope = 'store' AND l.source = 'other' AND l.game_id = g.game_id) = 2,
    'one pair_unlink log per row';
END $$;

-- ===== delete_no_unlink_log: a delete splits the pair without a pair_unlink log =====
DO $$
DECLARE p int[];
BEGIN
  p := pg_temp.mkpair('21', '{"initial_evaluator": "ThuDT"}', '{}');
  DELETE FROM game_evaluations WHERE id = p[2];
  ASSERT (SELECT pair_eval_id IS NULL AND NOT pair_back FROM game_evaluations WHERE id = p[1]), 'R lone again';
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE game_id IN ('ra21', 'ti21') AND kind = 'pair_unlink'),
    'no unlink log on delete';
END $$;
