\set ON_ERROR_STOP 1
SET TIME ZONE 'UTC';
-- Migration 054, part 3: Signal Sense unlinks or re-families a game (spec 6.2 c), and
-- unlink_eval_pair(). Runs after pairs-sync-checks.sql on the throwaway DB of
-- scripts/verify-eval-pairs.sh. Every block builds its own linked pair with
-- pg_temp.mkpair: game 'ua<tag>' (android, lower id) is R, game 'ui<tag>' (ios) is T.
-- A pair left split on a still-valid family is judged, so it is not a "safe pair" that
-- the script's later re-run of 054 would link again.

CREATE FUNCTION pg_temp.mkpair(tag text, r jsonb, t jsonb) RETURNS integer[]
LANGUAGE plpgsql AS $$
DECLARE rid int; tid int;
BEGIN
  INSERT INTO game_info (game_id, os) VALUES ('ua' || tag, 'android'), ('ui' || tag, 'ios');
  INSERT INTO game_evaluations
    SELECT * FROM jsonb_populate_record(NULL::game_evaluations,
      jsonb_build_object('id', nextval('game_evaluations_id_seq'), 'game_id', 'ua' || tag,
        'category_group', 'puzzle', 'game_alike', '[]'::jsonb, 'pair_back', false) || r)
    RETURNING id INTO rid;
  INSERT INTO game_evaluations
    SELECT * FROM jsonb_populate_record(NULL::game_evaluations,
      jsonb_build_object('id', nextval('game_evaluations_id_seq'), 'game_id', 'ui' || tag,
        'category_group', 'puzzle', 'game_alike', '[]'::jsonb, 'pair_back', false) || t)
    RETURNING id INTO tid;
  UPDATE game_info SET family_id = 'fam.u' || tag WHERE game_id IN ('ua' || tag, 'ui' || tag);
  ASSERT link_eval_pair(tid, rid), format('fixture pair %s links', tag);
  RETURN ARRAY[rid, tid];
END $$;

-- Both rows as json without the pair link: what an unlink must leave as it was.
CREATE FUNCTION pg_temp.data(p integer[]) RETURNS text
LANGUAGE sql AS $$
  SELECT string_agg((to_jsonb(g) - ARRAY['pair_eval_id', 'pair_back'])::text, ',' ORDER BY id)
  FROM game_evaluations g WHERE id = ANY (p)
$$;

CREATE FUNCTION pg_temp.linked(p integer[]) RETURNS boolean
LANGUAGE sql AS $$
  SELECT (SELECT pair_eval_id FROM game_evaluations WHERE id = p[1]) = p[2]
     AND (SELECT pair_eval_id FROM game_evaluations WHERE id = p[2]) = p[1]
     AND (SELECT count(*) FILTER (WHERE pair_back) FROM game_evaluations WHERE id = ANY (p)) = 1
$$;

CREATE FUNCTION pg_temp.split(p integer[]) RETURNS boolean
LANGUAGE sql AS $$
  SELECT NOT EXISTS (SELECT 1 FROM game_evaluations WHERE id = ANY (p) AND (pair_eval_id IS NOT NULL OR pair_back))
$$;

-- The pair_unlink log rows of the rows in p: one per row, written by System.
CREATE FUNCTION pg_temp.unlink_logs(p integer[]) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*) FROM evaluation_log l JOIN game_evaluations g ON g.id = l.game_evaluation_id
  WHERE l.game_evaluation_id = ANY (p) AND l.kind = 'pair_unlink' AND l.game_id = g.game_id
    AND l.actor = 'System' AND l.pair_scope = 'store' AND l.source = 'other'
$$;

CREATE FUNCTION pg_temp.any_unlink_logs(p integer[]) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*) FROM evaluation_log WHERE game_evaluation_id = ANY (p) AND kind = 'pair_unlink'
$$;

-- ===== unlink_splits: Signal Sense unlinks T; the pair splits and keeps its data =====
DO $$
DECLARE p int[]; before text;
BEGIN
  p := pg_temp.mkpair('1', '{"initial_conclusion": "List_Idea", "initial_evaluator": "ThuDT",
                             "initial_note": "pair note 12345", "drive_link": "https://drive/u1"}', '{}');
  ASSERT pg_temp.linked(p), 'fixture: linked';
  before := pg_temp.data(p);
  UPDATE game_info SET family_unlinked = true WHERE game_id = 'ui1';
  ASSERT pg_temp.split(p), 'both rows unlinked, no back row';
  ASSERT pg_temp.data(p) = before, 'both rows keep their data (updated_at included)';
  ASSERT pg_temp.unlink_logs(p) = 2, format('one pair_unlink log per row, got %s', pg_temp.any_unlink_logs(p));
  -- split for good: a write on one row no longer reaches the other
  UPDATE game_evaluations SET initial_note = 'after the split' WHERE id = p[1];
  ASSERT (SELECT initial_note FROM game_evaluations WHERE id = p[2]) = 'pair note 12345', 'T no longer follows R';
END $$;

-- ===== family_change_splits: one store moves to another family =====
DO $$
DECLARE p int[]; before text;
BEGIN
  p := pg_temp.mkpair('2', '{"initial_evaluator": "ThuDT", "batch": "W4 Nov"}', '{}');
  before := pg_temp.data(p);
  UPDATE game_info SET family_id = 'fam.other2' WHERE game_id = 'ua2';
  ASSERT pg_temp.split(p), 'both rows unlinked';
  ASSERT pg_temp.data(p) = before, 'both rows keep their data';
  ASSERT pg_temp.unlink_logs(p) = 2, 'one pair_unlink log per row';
  -- family_id to NULL splits too
  p := pg_temp.mkpair('3', '{"initial_evaluator": "ThuDT"}', '{}');
  UPDATE game_info SET family_id = NULL WHERE game_id = 'ui3';
  ASSERT pg_temp.split(p) AND pg_temp.unlink_logs(p) = 2, 'family_id NULL splits';
END $$;

-- ===== family_rename_keeps: both stores move to a new family in one statement =====
DO $$
DECLARE p int[];
BEGIN
  p := pg_temp.mkpair('4', '{"initial_evaluator": "ThuDT"}', '{}');
  UPDATE game_info SET family_id = 'fam.renamed4' WHERE game_id IN ('ua4', 'ui4');
  ASSERT pg_temp.linked(p), 'still one game';
  ASSERT pg_temp.any_unlink_logs(p) = 0, 'no unlink log';
END $$;

-- ===== unrelated_update_noop: other game_info writes leave the pair alone =====
DO $$
DECLARE p int[]; before text;
BEGIN
  p := pg_temp.mkpair('5', '{"initial_evaluator": "ThuDT"}', '{}');
  before := pg_temp.data(p);
  UPDATE game_info SET title = 'New title' WHERE game_id IN ('ua5', 'ui5');
  UPDATE game_info SET family_id = family_id, family_unlinked = family_unlinked WHERE game_id = 'ui5';
  UPDATE game_info SET is_active = false WHERE game_id = 'ui5';
  ASSERT pg_temp.linked(p), 'still linked';
  ASSERT pg_temp.data(p) = before, 'nothing written';
  ASSERT pg_temp.any_unlink_logs(p) = 0, 'no unlink log';
END $$;

-- ===== relink_is_phase_2: turning family_unlinked off again does not relink =====
DO $$
DECLARE p int[];
BEGIN
  p := pg_temp.mkpair('6', '{"initial_conclusion": "List_Idea", "initial_evaluator": "ThuDT"}', '{}');
  UPDATE game_info SET family_unlinked = true WHERE game_id = 'ua6';
  UPDATE game_info SET family_unlinked = false WHERE game_id = 'ua6';
  ASSERT pg_temp.split(p), 'stays split';
  ASSERT pg_temp.unlink_logs(p) = 2, 'logged once';
END $$;

-- ===== unlink_eval_pair: the one unlink, for either row, heals a half-linked pair =====
DO $$
DECLARE p int[]; before text;
BEGIN
  p := pg_temp.mkpair('7', '{"initial_conclusion": "List_Idea", "initial_evaluator": "ThuDT"}', '{}');
  before := pg_temp.data(p);
  ASSERT unlink_eval_pair(p[2]), 'unlinked from the back row';
  ASSERT pg_temp.split(p) AND pg_temp.data(p) = before, 'both rows unlinked, data kept';
  ASSERT pg_temp.unlink_logs(p) = 2, 'one log per row';
  ASSERT NOT unlink_eval_pair(p[1]), 'a lone row: nothing to do';
  ASSERT NOT unlink_eval_pair(NULL), 'NULL: nothing to do';
  ASSERT pg_temp.unlink_logs(p) = 2, 'no extra log';
  -- a manual UPDATE that clears one side leaves the twin half-linked; the function cleans it
  p := pg_temp.mkpair('8', '{"initial_conclusion": "List_Idea", "initial_evaluator": "ThuDT"}', '{}');
  UPDATE game_evaluations SET pair_eval_id = NULL, pair_back = false WHERE id = p[1];
  ASSERT (SELECT pair_eval_id FROM game_evaluations WHERE id = p[2]) = p[1], 'fixture: T half-linked';
  ASSERT unlink_eval_pair(p[1]), 'heals from the cleared side';
  ASSERT pg_temp.split(p), 'T unlinked too';
  ASSERT pg_temp.unlink_logs(p) = 1, 'one log, for the row that still pointed';
END $$;

-- ===== never_breaks_signal_sense: an error in the trigger is a WARNING, the
-- game_info UPDATE stands =====
BEGIN;
SET LOCAL client_min_messages = error;
DO $$
DECLARE p int[];
BEGIN
  p := pg_temp.mkpair('9', '{"initial_evaluator": "ThuDT"}', '{}');
END $$;
ALTER TABLE game_evaluations RENAME COLUMN pair_back TO pair_back_x;
UPDATE game_info SET family_unlinked = true WHERE game_id = 'ui9';
DO $$
BEGIN
  ASSERT (SELECT family_unlinked FROM game_info WHERE game_id = 'ui9'), 'the Signal Sense UPDATE went through';
  ASSERT (SELECT count(*) FROM game_evaluations WHERE game_id IN ('ua9', 'ui9') AND pair_eval_id IS NOT NULL) = 2,
    'the failed unlink left the pair as it was';
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE game_id IN ('ua9', 'ui9') AND kind = 'pair_unlink'),
    'no half-written log';
END $$;
-- the transaction is still usable
UPDATE game_info SET title = 'still works' WHERE game_id = 'ui9';
ROLLBACK;
DO $$
BEGIN
  ASSERT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'game_evaluations' AND column_name = 'pair_back'), 'rename rolled back';
END $$;

-- ===== schema: one game_info trigger, AFTER UPDATE OF family_id, family_unlinked =====
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'game_info'::regclass AND NOT tgisinternal) = 1,
    'one trigger on game_info';
  ASSERT (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'trg_game_info_eval_pair_unlink')
         LIKE 'CREATE TRIGGER trg_game_info_eval_pair_unlink AFTER UPDATE OF family_id, family_unlinked ON public.game_info FOR EACH ROW WHEN (%',
    'trigger shape';
END $$;
