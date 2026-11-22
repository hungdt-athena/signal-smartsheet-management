\set ON_ERROR_STOP 1
SET TIME ZONE 'UTC';
-- Migration 055, part 1: credit column, merge snapshots table, sticky front row, eval_stats_rows.
-- Runs on the throwaway DB of scripts/verify-eval-pairs.sh, after every 054 check (054 + 055
-- applied, 055 twice). Every block makes its own game_info rows (games 'p2s...', family 'fam.p2s...').

-- ===== schema =====
DO $$
DECLARE want text; got text;
BEGIN
  ASSERT (SELECT data_type || ':' || is_nullable || ':' || COALESCE(column_default, '-')
          FROM information_schema.columns
          WHERE table_name = 'game_evaluations' AND column_name = 'credit') = 'jsonb:YES:-',
    'game_evaluations.credit jsonb, NULL by default';

  SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                    || COALESCE(' default ' || pg_get_expr(d.adbin, d.adrelid), ''), ', ' ORDER BY a.attnum)
    INTO got
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'eval_pair_merge_snapshots'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  want := 'id bigint default nextval(''eval_pair_merge_snapshots_id_seq''::regclass), run_id text, '
       || 'game_evaluation_id integer, family_id text, pair_group text, row_before jsonb, written jsonb, '
       || 'created_at timestamp with time zone default now()';
  ASSERT got = want, format('eval_pair_merge_snapshots columns: %s', got);
  ASSERT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'eval_pair_merge_snapshots'
                   AND indexdef ILIKE '%USING btree (run_id)'), 'index on run_id';
  ASSERT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'eval_pair_merge_snapshots'
                   AND indexdef ILIKE '%USING btree (game_evaluation_id)'), 'index on game_evaluation_id';
  ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'eval_pair_merge_snapshots'::regclass
                   AND contype = 'p'), 'snapshots primary key';

  -- the view lists every column of game_evaluations, in table order and with the table's
  -- type, then eval_row and media_row: a column added to the table later fails here until
  -- it is added to the view
  ASSERT (SELECT relkind FROM pg_class WHERE oid = 'eval_stats_rows'::regclass) = 'v', 'eval_stats_rows is a view';
  SELECT string_agg(attname || ' ' || format_type(atttypid, atttypmod), ', ' ORDER BY attnum) || ', eval_row boolean, media_row boolean'
    INTO want FROM pg_attribute WHERE attrelid = 'game_evaluations'::regclass AND attnum > 0 AND NOT attisdropped;
  SELECT string_agg(attname || ' ' || format_type(atttypid, atttypmod), ', ' ORDER BY attnum)
    INTO got FROM pg_attribute WHERE attrelid = 'eval_stats_rows'::regclass AND attnum > 0 AND NOT attisdropped;
  ASSERT got = want, format(E'eval_stats_rows columns\n got: %s\nwant: %s', got, want);
END $$;

-- ===== stats_rows_fixture: which rows the counts take, and with whose values =====
-- lone game, a plain pair, a pair whose back row is Link_dead, a pair whose back row has credit
DO $$
DECLARE lone int; pf int; pb int; df int; db int; cf int; cb int; vr eval_stats_rows; gr game_evaluations;
BEGIN
  INSERT INTO game_info (game_id, os, family_id) VALUES
    ('p2s_lone', 'android', NULL),
    ('p2s_pa', 'android', 'fam.p2s_p'), ('p2s_pi', 'ios', 'fam.p2s_p'),
    ('p2s_da', 'android', 'fam.p2s_d'), ('p2s_di', 'ios', 'fam.p2s_d'),
    ('p2s_ca', 'android', 'fam.p2s_c'), ('p2s_ci', 'ios', 'fam.p2s_c');
  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator) VALUES ('p2s_lone', 'puzzle', 'ThuDT')
    RETURNING id INTO lone;
  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator) VALUES ('p2s_pa', 'puzzle', 'ThuDT')
    RETURNING id INTO pf;
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('p2s_pi', 'puzzle') RETURNING id INTO pb;
  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator, initial_conclusion)
    VALUES ('p2s_da', 'puzzle', 'ThuDT', 'Link_dead') RETURNING id INTO db;
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('p2s_di', 'puzzle') RETURNING id INTO df;
  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator, initial_conclusion, initial_note,
      evaluate_date, final_conclusion, batch, drive_link, record_5min_assignee, assigned_date)
    VALUES ('p2s_ca', 'puzzle', 'ThuDT', 'List_Idea', 'front note 12345', '2026-11-20 03:00Z', 'Insight', 'W4 Nov',
      'https://drive/p2s_c', 'VinhTD', '2026-11-19')
    RETURNING id INTO cf;
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('p2s_ci', 'puzzle') RETURNING id INTO cb;
  ASSERT (SELECT count(*) FROM game_evaluations WHERE id IN (pf, pb, df, db, cf, cb) AND pair_eval_id IS NOT NULL) = 6,
    'fixture: three linked pairs';
  ASSERT (SELECT array_agg(id ORDER BY id) FROM game_evaluations WHERE id IN (pf, pb, df, db, cf, cb) AND pair_back)
         = ARRAY[pb, db, cb], 'fixture: back rows';
  -- the back row's own work, frozen before the merge; plumbing keys in credit are ignored
  UPDATE game_evaluations SET credit = jsonb_build_object(
      'initial_evaluator', 'HaNP', 'initial_conclusion', 'Bypass', 'evaluate_date', '2026-10-01T03:00:00+00:00',
      'assigned_date', '2026-09-30', 'first_assigned_date', '2026-09-29', 'category_group', 'arcade',
      'batch', 'W1 Oct', 'game_alike', '["Alike 1"]'::jsonb, 'final_conclusion', NULL,
      'record_5min_assignee', 'QuangVN', 'noted', true, '_moved', '["drive_link"]'::jsonb,
      'id', 0, 'game_id', 'zz', 'pair_eval_id', 0, 'pair_back', false, 'credit', 'x',
      'updated_at', '2000-01-01T00:00:00Z', 'imported_at', '2000-01-01T00:00:00Z')
   WHERE id = cb;

  -- every row is in the view, one view row per table row
  ASSERT (SELECT count(*) FROM eval_stats_rows) = (SELECT count(*) FROM game_evaluations), 'view keeps every row';
  ASSERT (SELECT count(*) FROM eval_stats_rows WHERE game_id LIKE 'p2s\_%') = 7, 'fixture rows in the view';
  -- evaluation counts take: front rows + store-specific back rows + credited rows
  ASSERT (SELECT array_agg(id ORDER BY id) FROM eval_stats_rows WHERE game_id LIKE 'p2s\_%' AND eval_row)
         = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[lone, pf, df, db, cf, cb]) x),
    'eval_row: lone, fronts, the dead back row, the credited back row';
  -- media counts take: front rows + credited rows (the dead back row's video is the pair's)
  ASSERT (SELECT array_agg(id ORDER BY id) FROM eval_stats_rows WHERE game_id LIKE 'p2s\_%' AND media_row)
         = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[lone, pf, df, cf, cb]) x),
    'media_row: lone, fronts, the credited back row';
  -- the same rule on the whole table (rows the 054 checks left behind)
  ASSERT NOT EXISTS (SELECT 1 FROM eval_stats_rows v JOIN game_evaluations g USING (id)
                     WHERE v.eval_row IS DISTINCT FROM (NOT g.pair_back OR eval_store_specific(g.initial_conclusion)
                                                         OR g.credit IS NOT NULL)
                        OR v.media_row IS DISTINCT FROM (NOT g.pair_back OR g.credit IS NOT NULL)), 'eval_row / media_row rule';
  -- a row without credit reads exactly as the table row
  ASSERT NOT EXISTS (SELECT 1 FROM eval_stats_rows v JOIN game_evaluations g USING (id)
                     WHERE g.credit IS NULL AND to_jsonb(v) - ARRAY['eval_row', 'media_row'] <> to_jsonb(g)),
    'rows without credit are unchanged';

  SELECT * INTO vr FROM eval_stats_rows WHERE id = cb;
  SELECT * INTO gr FROM game_evaluations WHERE id = cb;
  ASSERT gr.initial_evaluator = 'ThuDT' AND gr.initial_conclusion = 'List_Idea' AND gr.drive_link = 'https://drive/p2s_c',
    'fixture: the credited row itself carries the pair''s values';
  ASSERT vr.eval_row AND vr.media_row, 'credited back row counts';
  ASSERT vr.initial_evaluator = 'HaNP', format('credit evaluator: %s', vr.initial_evaluator);
  ASSERT vr.initial_conclusion = 'Bypass', format('credit conclusion: %s', vr.initial_conclusion);
  ASSERT vr.evaluate_date = '2026-10-01 03:00Z'::timestamptz, format('credit evaluate_date: %s', vr.evaluate_date);
  ASSERT vr.assigned_date = '2026-09-30'::date AND vr.first_assigned_date = '2026-09-29'::date, 'credit assign dates';
  ASSERT vr.category_group = 'arcade' AND gr.category_group = 'puzzle', 'credit category_group';
  ASSERT vr.batch = 'W1 Oct', 'credit batch';
  ASSERT vr.game_alike = '["Alike 1"]'::jsonb, format('credit game_alike: %s', vr.game_alike);
  ASSERT vr.final_conclusion IS NULL AND gr.final_conclusion = 'Insight', 'a JSON null in credit reads as NULL';
  ASSERT vr.record_5min_assignee = 'QuangVN', 'media column from credit';
  ASSERT vr.drive_link IS NULL, 'a _moved column reads as NULL (counted on the front row)';
  ASSERT vr.initial_note = gr.initial_note AND vr.evaluate_date IS DISTINCT FROM gr.evaluate_date,
    'a column absent from credit reads the real column';
  ASSERT vr.id = gr.id AND vr.game_id = gr.game_id AND vr.pair_eval_id = gr.pair_eval_id AND vr.pair_back = gr.pair_back
     AND vr.credit = gr.credit AND vr.updated_at = gr.updated_at AND vr.imported_at IS NOT DISTINCT FROM gr.imported_at,
    'plumbing columns come from the real row';

  -- a plain back row: neither count; a dead back row: evaluation counts only
  ASSERT (SELECT NOT eval_row AND NOT media_row FROM eval_stats_rows WHERE id = pb), 'plain back row';
  ASSERT (SELECT eval_row AND NOT media_row FROM eval_stats_rows WHERE id = db), 'store-specific back row';
  ASSERT (SELECT eval_row AND media_row FROM eval_stats_rows WHERE id = cf), 'front row';

  -- credit keeps counting after the pair is unlinked
  PERFORM unlink_eval_pair(cb);
  ASSERT (SELECT eval_row AND media_row AND initial_evaluator = 'HaNP' FROM eval_stats_rows WHERE id = cb),
    'credit still read after unlink';
END $$;

-- ===== sticky_front: the front row stays put unless a store-only result forces it =====
DO $$
DECLARE lo int; hi int;
BEGIN
  INSERT INTO game_info (game_id, os, family_id) VALUES ('p2s_sa', 'android', 'fam.p2s_s'), ('p2s_si', 'ios', 'fam.p2s_s');
  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator, initial_conclusion)
    VALUES ('p2s_sa', 'puzzle', 'ThuDT', 'List_Idea') RETURNING id INTO lo;
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('p2s_si', 'puzzle') RETURNING id INTO hi;
  ASSERT (SELECT pair_eval_id FROM game_evaluations WHERE id = hi) = lo, 'fixture linked';
  ASSERT NOT (SELECT pair_back FROM game_evaluations WHERE id = lo) AND (SELECT pair_back FROM game_evaluations WHERE id = hi),
    'fresh link: the lower id is the front row';

  -- the front goes dead: the live store becomes the front row (as in 054)
  UPDATE game_evaluations SET initial_conclusion = 'Link_dead' WHERE id = lo;
  ASSERT (SELECT pair_back FROM game_evaluations WHERE id = lo) AND NOT (SELECT pair_back FROM game_evaluations WHERE id = hi),
    'the dead row moved to the back';
  -- reopened: the front does NOT go back to the lower id
  UPDATE game_evaluations SET initial_conclusion = NULL WHERE id = lo;
  ASSERT (SELECT initial_conclusion FROM game_evaluations WHERE id = lo) = 'List_Idea', 'fixture: reopened took the verdict';
  ASSERT (SELECT pair_back FROM game_evaluations WHERE id = lo) AND NOT (SELECT pair_back FROM game_evaluations WHERE id = hi),
    'reopened: the front row stays the higher id';
  -- an ordinary save, and a direct call in either order, keep it
  UPDATE game_evaluations SET initial_note = 'sticky note 12345' WHERE id = lo;
  PERFORM eval_pair_refresh_back(lo, hi);
  PERFORM eval_pair_refresh_back(hi, lo);
  ASSERT (SELECT pair_back FROM game_evaluations WHERE id = lo) AND NOT (SELECT pair_back FROM game_evaluations WHERE id = hi),
    'saves and refreshes keep the front row';

  -- the back row goes dead: nothing moves; then the front goes dead too: both store-only,
  -- the current front row stays (054 picked the lower id here)
  UPDATE game_evaluations SET initial_conclusion = 'Stale_release' WHERE id = lo;
  ASSERT (SELECT pair_back FROM game_evaluations WHERE id = lo) AND NOT (SELECT pair_back FROM game_evaluations WHERE id = hi),
    'dead back row stays back';
  UPDATE game_evaluations SET initial_conclusion = 'Link_dead' WHERE id = hi;
  ASSERT (SELECT pair_back FROM game_evaluations WHERE id = lo) AND NOT (SELECT pair_back FROM game_evaluations WHERE id = hi),
    'both store-only: the front row stays';
  -- the back store reopens alone: exactly one store-only result, the live one is the front
  UPDATE game_evaluations SET initial_conclusion = NULL WHERE id = lo;
  ASSERT NOT (SELECT pair_back FROM game_evaluations WHERE id = lo) AND (SELECT pair_back FROM game_evaluations WHERE id = hi),
    'the only live store is the front row';
END $$;

-- ===== sticky_fresh_link: a new pair still takes the lower id, whichever row joins =====
DO $$
DECLARE lo int; hi int;
BEGIN
  -- both rows exist before the family: link_eval_pair(lower, higher), the lower id joins
  INSERT INTO game_info (game_id, os) VALUES ('p2s_fa', 'android'), ('p2s_fi', 'ios');
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('p2s_fa', 'puzzle') RETURNING id INTO lo;
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('p2s_fi', 'puzzle') RETURNING id INTO hi;
  UPDATE game_info SET family_id = 'fam.p2s_f' WHERE game_id IN ('p2s_fa', 'p2s_fi');
  ASSERT link_eval_pair(lo, hi), 'fixture links';
  ASSERT NOT (SELECT pair_back FROM game_evaluations WHERE id = lo) AND (SELECT pair_back FROM game_evaluations WHERE id = hi),
    'lower id joined: lower id is the front row';

  INSERT INTO game_info (game_id, os) VALUES ('p2s_ga', 'android'), ('p2s_gi', 'ios');
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('p2s_ga', 'puzzle') RETURNING id INTO lo;
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('p2s_gi', 'puzzle') RETURNING id INTO hi;
  UPDATE game_info SET family_id = 'fam.p2s_g' WHERE game_id IN ('p2s_ga', 'p2s_gi');
  ASSERT link_eval_pair(hi, lo), 'fixture links';
  ASSERT NOT (SELECT pair_back FROM game_evaluations WHERE id = lo) AND (SELECT pair_back FROM game_evaluations WHERE id = hi),
    'higher id joined: lower id is the front row';

  -- a fresh link with one store-only row: the other row is the front, even the higher id
  INSERT INTO game_info (game_id, os) VALUES ('p2s_ha', 'android'), ('p2s_hi', 'ios');
  INSERT INTO game_evaluations (game_id, category_group, initial_conclusion) VALUES ('p2s_ha', 'puzzle', 'Stale_release')
    RETURNING id INTO lo;
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('p2s_hi', 'puzzle') RETURNING id INTO hi;
  UPDATE game_info SET family_id = 'fam.p2s_h' WHERE game_id IN ('p2s_ha', 'p2s_hi');
  ASSERT link_eval_pair(hi, lo), 'fixture links';
  ASSERT (SELECT pair_back FROM game_evaluations WHERE id = lo) AND NOT (SELECT pair_back FROM game_evaluations WHERE id = hi),
    'store-only row is the back row';

  -- rows that do not point at each other: no-op (as 054)
  PERFORM eval_pair_refresh_back(lo, (SELECT id FROM game_evaluations WHERE game_id = 'p2s_ga'));
  ASSERT (SELECT pair_back FROM game_evaluations WHERE id = lo), 'refresh of a non-pair changes nothing';
END $$;
