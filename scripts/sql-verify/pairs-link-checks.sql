\set ON_ERROR_STOP 1
SET TIME ZONE 'UTC';
-- Migration 054, part 1: columns, link on insert, link the safe pairs already there.
-- Runs on the throwaway DB built by scripts/verify-eval-pairs.sh (pairs-schema.sql + 046 +
-- 047 + 054 twice). Every block makes its own game_info rows (family 'fam.N').

-- ===== schema =====
DO $$
DECLARE missing text[]; unlisted text[];
BEGIN
  ASSERT (SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'game_evaluations' AND column_name = 'pair_eval_id') = 'YES', 'pair_eval_id column';
  ASSERT (SELECT is_nullable || ':' || column_default FROM information_schema.columns
          WHERE table_name = 'game_evaluations' AND column_name = 'pair_back') = 'NO:false', 'pair_back NOT NULL DEFAULT false';
  ASSERT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'evaluation_log' AND column_name = 'pair_scope'), 'evaluation_log.pair_scope';
  -- run twice, still one FK and one unique index
  ASSERT (SELECT count(*) FROM pg_constraint
          WHERE conrelid = 'game_evaluations'::regclass AND contype = 'f'
            AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                WHERE attrelid = 'game_evaluations'::regclass AND attname = 'pair_eval_id')]
            AND confdeltype = 'n') = 1, 'one ON DELETE SET NULL FK on pair_eval_id';
  ASSERT (SELECT count(*) FROM pg_indexes WHERE tablename = 'game_evaluations'
            AND indexdef ILIKE 'CREATE UNIQUE INDEX%(pair_eval_id) WHERE (pair_eval_id IS NOT NULL)') = 1, 'partial unique index';

  ASSERT eval_store_specific('Link_dead') AND eval_store_specific('Stale_release'), 'store-specific results';
  ASSERT NOT eval_store_specific('List_Idea') AND NOT eval_store_specific(NULL), 'not store-specific';

  ASSERT cardinality(eval_pair_eval_cols()) = 18, 'evaluation group has 18 columns';
  ASSERT cardinality(eval_pair_media_cols()) = 24, 'media group has 24 columns';
  SELECT array_agg(c) INTO missing FROM unnest(eval_pair_eval_cols() || eval_pair_media_cols()) c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'game_evaluations' AND column_name = c);
  ASSERT missing IS NULL, format('listed columns that do not exist: %s', missing);
  -- every column is shared (one of the 2 groups), per store, or the pair link itself:
  -- a column added later fails here until someone decides which it is
  SELECT array_agg(column_name::text) INTO unlisted FROM information_schema.columns
   WHERE table_name = 'game_evaluations'
     AND column_name <> ALL (eval_pair_eval_cols() || eval_pair_media_cols()
           || ARRAY['id','game_id','genre_1','genre_2','imported_at','updated_at','pair_eval_id','pair_back']);
  ASSERT unlisted IS NULL, format('columns in no group: %s', unlisted);
  ASSERT NOT EXISTS (SELECT 1 FROM unnest(eval_pair_eval_cols()) c WHERE c = ANY (eval_pair_media_cols())),
    'a column is in both groups';
END $$;

-- ===== insert_twin_judged: store 1 judged, store 2 arrives and takes the result =====
DO $$
DECLARE t int; n int; nr game_evaluations; tr game_evaluations; lg evaluation_log;
BEGIN
  INSERT INTO game_info (game_id, os, family_id) VALUES ('a1', 'android', 'fam.1'), ('i1', 'ios', 'fam.1');
  INSERT INTO game_evaluations (game_id, category_group, initial_conclusion, initial_evaluator, batch,
      initial_note, evaluate_date, assigned_date, first_assigned_date, game_alike, drive_link)
    VALUES ('a1', 'puzzle', 'List_Idea', 'ThuDT', 'W4 Nov', 'abcdefghijk', '2026-11-20 03:00Z',
      '2026-11-18', '2026-11-17', '["Royal Match"]', 'https://drive/a1')
    RETURNING id INTO t;
  ASSERT (SELECT pair_eval_id FROM game_evaluations WHERE id = t) IS NULL, 'store 1 alone stays unlinked';
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('i1', 'arcade') RETURNING id INTO n;
  SELECT * INTO nr FROM game_evaluations WHERE id = n;
  SELECT * INTO tr FROM game_evaluations WHERE id = t;
  ASSERT nr.pair_eval_id = t, 'N points to T';
  ASSERT tr.pair_eval_id = n, 'T points to N';
  ASSERT nr.pair_back AND NOT tr.pair_back, 'N is the back row';
  ASSERT nr.initial_conclusion = 'List_Idea', 'N took the conclusion';
  ASSERT nr.initial_evaluator = 'ThuDT' AND nr.batch = 'W4 Nov' AND nr.initial_note = 'abcdefghijk', 'N took evaluator, batch, note';
  ASSERT nr.evaluate_date = tr.evaluate_date AND nr.assigned_date = tr.assigned_date
     AND nr.first_assigned_date = tr.first_assigned_date, 'N took the dates';
  ASSERT nr.game_alike = '["Royal Match"]'::jsonb, 'N took game_alike (empty [] counts as empty)';
  ASSERT nr.category_group = tr.category_group AND nr.category_group = 'puzzle', 'N moved to T''s category_group';
  ASSERT nr.drive_link = 'https://drive/a1', 'N took the demo link';
  ASSERT (SELECT count(*) FROM evaluation_log WHERE kind = 'pair_link' AND game_id IN ('a1', 'i1')) = 1, 'one pair_link log';
  SELECT * INTO lg FROM evaluation_log WHERE kind = 'pair_link' AND game_id IN ('a1', 'i1');
  ASSERT lg.actor = 'System' AND lg.game_id = 'i1' AND lg.game_evaluation_id = n AND lg.pair_scope = 'store',
    format('log row: %s', to_jsonb(lg));
  ASSERT lg.conclusion_before IS NULL AND lg.conclusion_after = 'List_Idea' AND lg.changed, 'log conclusion before/after';
  ASSERT lg.owner IS NULL AND lg.owner_after = 'ThuDT', format('log owner before/after: %s / %s', lg.owner, lg.owner_after);
END $$;

-- ===== insert_twin_pending: store 1 held by a tester, not judged yet =====
DO $$
DECLARE t int; n int; nr game_evaluations; tr game_evaluations;
BEGIN
  INSERT INTO game_info (game_id, os, family_id) VALUES ('a2', 'android', 'fam.2'), ('i2', 'ios', 'fam.2');
  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator, assigned_date, first_assigned_date, batch)
    VALUES ('a2', 'simulation', 'QuangVN', '2026-11-19', '2026-11-18', 'W4 Nov') RETURNING id INTO t;
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('i2', 'puzzle') RETURNING id INTO n;
  SELECT * INTO nr FROM game_evaluations WHERE id = n;
  SELECT * INTO tr FROM game_evaluations WHERE id = t;
  ASSERT nr.pair_eval_id = t AND tr.pair_eval_id = n, 'linked both ways';
  ASSERT nr.initial_evaluator = 'QuangVN', 'N follows the holder';
  ASSERT nr.assigned_date = '2026-11-19' AND nr.first_assigned_date = '2026-11-18', 'N took the assign dates';
  ASSERT nr.batch = 'W4 Nov', 'N took the batch';
  ASSERT nr.category_group = 'simulation', 'N moved to T''s category_group';
  ASSERT nr.initial_conclusion IS NULL, 'nothing judged yet';
  ASSERT nr.pair_back AND NOT tr.pair_back, 'N is the back row';
  -- History shows the holder change
  ASSERT (SELECT owner IS NULL AND owner_after = 'QuangVN' FROM evaluation_log
          WHERE kind = 'pair_link' AND game_evaluation_id = n), 'pair_link log owner_after is the holder N took';
END $$;

-- ===== insert_twin_dead: store 1 is Link_dead, store 2 is a game to judge =====
DO $$
DECLARE t int; n int; nr game_evaluations; tr game_evaluations; leaked text[];
BEGIN
  INSERT INTO game_info (game_id, os, family_id) VALUES ('a3', 'android', 'fam.3'), ('i3', 'ios', 'fam.3');
  INSERT INTO game_evaluations (game_id, category_group, initial_conclusion, initial_evaluator, batch,
      initial_note, evaluate_date, assigned_date, first_assigned_date, drive_link)
    VALUES ('a3', 'puzzle', 'Link_dead', 'ThuDT', 'W4 Nov', 'store gone', '2026-11-20 03:00Z',
      '2026-11-18', '2026-11-17', 'https://drive/a3')
    RETURNING id INTO t;
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('i3', 'arcade') RETURNING id INTO n;
  SELECT * INTO nr FROM game_evaluations WHERE id = n;
  SELECT * INTO tr FROM game_evaluations WHERE id = t;
  ASSERT nr.pair_eval_id = t AND tr.pair_eval_id = n, 'linked both ways';
  SELECT array_agg(c) INTO leaked FROM unnest(eval_pair_eval_cols()) c
   WHERE c NOT IN ('category_group', 'game_alike') AND to_jsonb(nr) ->> c IS NOT NULL;
  ASSERT leaked IS NULL, format('N took evaluation columns from a Link_dead twin: %s', leaked);
  ASSERT nr.category_group = 'arcade', 'N keeps its own category_group';
  ASSERT NOT nr.pair_back AND tr.pair_back, 'N is the front row, the dead store is the back row';
  -- same answer whichever row is passed first
  PERFORM eval_pair_refresh_back(t, n);
  ASSERT NOT (SELECT pair_back FROM game_evaluations WHERE id = n)
     AND (SELECT pair_back FROM game_evaluations WHERE id = t), 'refresh_back(dead, live) keeps the dead row at the back';
  -- media is the pair's (spec 6.1): the demo link does not stay stuck on the dead row
  ASSERT nr.drive_link = 'https://drive/a3', 'media copied even from a dead twin';
END $$;

-- ===== insert_keeps_own_values: values written by the INSERT itself are kept =====
DO $$
DECLARE t int; n int; nr game_evaluations;
BEGIN
  INSERT INTO game_info (game_id, os, family_id) VALUES ('a4', 'android', 'fam.4'), ('i4', 'ios', 'fam.4');
  INSERT INTO game_evaluations (game_id, category_group, initial_conclusion, initial_evaluator, final_conclusion,
      batch, record_bucket)
    VALUES ('a4', 'puzzle', 'List_Idea', 'ThuDT', 'Insight', 'W3 Nov', '20min') RETURNING id INTO t;
  INSERT INTO game_evaluations (game_id, category_group, batch, record_bucket)
    VALUES ('i4', 'puzzle', 'W1 Dec', '5min') RETURNING id INTO n;
  SELECT * INTO nr FROM game_evaluations WHERE id = n;
  ASSERT nr.pair_eval_id = t, 'linked';
  ASSERT nr.record_bucket = '5min', 'N keeps its own record_bucket';
  ASSERT nr.batch = 'W1 Dec', 'N keeps its own batch';
  ASSERT nr.final_conclusion = 'Insight', 'N still takes the NULL columns';
END $$;

-- ===== add_to_record_batch_reaches_twin: insert without batch, then UPDATE it =====
-- add-to-record pulls a new store of a pair into a Record week. Its INSERT leaves batch NULL
-- (the link fills it from the twin), then its UPDATE stamps the week; the copy trigger takes
-- that change to the twin, so the front row the lists show is in the week too.
DO $$
DECLARE t int; n int; nr game_evaluations; tr game_evaluations;
BEGIN
  INSERT INTO game_info (game_id, os, family_id) VALUES ('aar1', 'android', 'fam.ar1'), ('iar1', 'ios', 'fam.ar1');
  INSERT INTO game_evaluations (game_id, category_group, initial_conclusion, initial_evaluator, final_conclusion,
      batch, record_bucket)
    VALUES ('aar1', 'arcade', 'List_Idea', 'ThuDT', 'Insight', 'W1 Nov', '5min') RETURNING id INTO t;
  -- the route's INSERT: no batch; asked for puzzle, the link moves it to the twin's group
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('iar1', 'puzzle') RETURNING id INTO n;
  SELECT * INTO nr FROM game_evaluations WHERE id = n;
  ASSERT nr.pair_eval_id = t, 'linked at insert';
  ASSERT nr.category_group = 'arcade', 'moved to the twin''s group';
  ASSERT nr.batch = 'W1 Nov', 'took the twin''s batch';
  -- the route's UPDATE (by id)
  UPDATE game_evaluations ge SET record_bucket = '20min', batch = COALESCE('W3 Nov', ge.batch) WHERE ge.id = n;
  SELECT * INTO nr FROM game_evaluations WHERE id = n;
  SELECT * INTO tr FROM game_evaluations WHERE id = t;
  ASSERT nr.batch = 'W3 Nov' AND tr.batch = 'W3 Nov', format('both rows in the new week: %s / %s', nr.batch, tr.batch);
  ASSERT nr.record_bucket = '20min' AND tr.record_bucket = '20min', 'bucket on both rows';
  -- a second add with the first-asked group finds the one row of the game (no second row)
  ASSERT (SELECT count(*) FROM game_evaluations WHERE game_id = 'iar1') = 1, 'one row for the game';
END $$;

-- ===== insert_copy_keeps_record_batches: the record_slots trigger does not rewrite the copy =====
-- N's own bucket flips 5min -> 20min when it takes 'Priority IV'; 051 would then freeze
-- record_5min_batch from N's old batch (NULL). The copy must end equal to T's.
DO $$
DECLARE t int; n int; nr game_evaluations; tr game_evaluations;
BEGIN
  INSERT INTO game_info (game_id, os, family_id) VALUES ('a10', 'android', 'fam.10'), ('i10', 'ios', 'fam.10');
  INSERT INTO game_evaluations (game_id, category_group, initial_conclusion, initial_evaluator, final_conclusion,
      batch, record_5min_batch, record_20min_batch, record_20min_confirmed_at, record_confirmed_at)
    VALUES ('a10', 'puzzle', 'List_Idea', 'ThuDT', 'Priority IV', 'W3 Nov', 'W1 Nov', 'W3 Nov',
      '2026-11-15 03:00Z', '2026-11-15 03:00Z')
    RETURNING id INTO t;
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('i10', 'puzzle') RETURNING id INTO n;
  SELECT * INTO nr FROM game_evaluations WHERE id = n;
  SELECT * INTO tr FROM game_evaluations WHERE id = t;
  ASSERT nr.final_conclusion = 'Priority IV', 'N took the final conclusion';
  ASSERT nr.record_5min_batch = 'W1 Nov' AND nr.record_20min_batch = 'W3 Nov',
    format('record batches %s / %s', nr.record_5min_batch, nr.record_20min_batch);
  ASSERT nr.record_confirmed_at = tr.record_confirmed_at AND nr.record_20min_confirmed_at = tr.record_20min_confirmed_at,
    'confirmations copied';
END $$;

-- ===== insert_both_same_statement: push adds both stores in one INSERT =====
DO $$
DECLARE a int; i int;
BEGIN
  INSERT INTO game_info (game_id, os, family_id) VALUES ('a5', 'android', 'fam.5'), ('i5', 'ios', 'fam.5');
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('a5', 'puzzle'), ('i5', 'puzzle');
  SELECT id INTO a FROM game_evaluations WHERE game_id = 'a5';
  SELECT id INTO i FROM game_evaluations WHERE game_id = 'i5';
  ASSERT (SELECT pair_eval_id FROM game_evaluations WHERE id = a) = i, 'android -> ios';
  ASSERT (SELECT pair_eval_id FROM game_evaluations WHERE id = i) = a, 'ios -> android';
  ASSERT (SELECT count(*) FILTER (WHERE pair_back) FROM game_evaluations WHERE id IN (a, i)) = 1, 'exactly one back row';
  ASSERT (SELECT count(*) FROM evaluation_log WHERE kind = 'pair_link' AND game_id IN ('a5', 'i5')) = 1, 'linked once';
END $$;

-- ===== insert_no_link: unlinked family, twin with 2 rows, no family =====
DO $$
BEGIN
  -- the twin is family_unlinked
  INSERT INTO game_info (game_id, os, family_id, family_unlinked) VALUES ('a6', 'android', 'fam.6', false), ('i6', 'ios', 'fam.6', true);
  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator) VALUES ('a6', 'puzzle', 'ThuDT');
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('i6', 'puzzle');
  -- the twin has 2 rows
  INSERT INTO game_info (game_id, os, family_id) VALUES ('a7', 'android', 'fam.7'), ('i7', 'ios', 'fam.7');
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('a7', 'puzzle'), ('a7', 'arcade');
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('i7', 'puzzle');
  -- no family
  INSERT INTO game_info (game_id, os) VALUES ('x8', 'ios');
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('x8', 'puzzle');

  ASSERT NOT EXISTS (SELECT 1 FROM game_evaluations
                     WHERE game_id IN ('a6', 'i6', 'a7', 'i7', 'x8') AND (pair_eval_id IS NOT NULL OR pair_back)),
    'nothing linked';
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE game_id IN ('a6', 'i6', 'a7', 'i7', 'x8')), 'no log';
  ASSERT (SELECT initial_evaluator FROM game_evaluations WHERE game_id = 'i6') IS NULL, 'nothing copied';
  -- link_eval_pair itself refuses an invalid pair and an already linked row
  ASSERT NOT link_eval_pair((SELECT id FROM game_evaluations WHERE game_id = 'i6'),
                            (SELECT id FROM game_evaluations WHERE game_id = 'a6')), 'refuses an unlinked family';
  ASSERT NOT link_eval_pair((SELECT id FROM game_evaluations WHERE game_id = 'i1'),
                            (SELECT id FROM game_evaluations WHERE game_id = 'a1')), 'refuses a linked pair';
  ASSERT (SELECT count(*) FROM evaluation_log WHERE kind = 'pair_link' AND game_id IN ('a1', 'i1')) = 1, 'no second log';
END $$;

-- ===== the partial unique index: a row is linked to at most one row =====
DO $$
BEGIN
  BEGIN
    UPDATE game_evaluations SET pair_eval_id = (SELECT id FROM game_evaluations WHERE game_id = 'a1')
     WHERE game_id = 'x8';
    ASSERT false, 'second row pointing at a1 was allowed';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- ===== ON DELETE SET NULL =====
DO $$
DECLARE t int;
BEGIN
  INSERT INTO game_info (game_id, os, family_id) VALUES ('a9', 'android', 'fam.9'), ('i9', 'ios', 'fam.9');
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('a9', 'puzzle') RETURNING id INTO t;
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('i9', 'puzzle');
  ASSERT (SELECT pair_eval_id FROM game_evaluations WHERE game_id = 'i9') = t, 'linked';
  DELETE FROM game_evaluations WHERE id = t;
  ASSERT (SELECT pair_eval_id FROM game_evaluations WHERE game_id = 'i9') IS NULL, 'pointer cleared on delete';
END $$;

-- ===== safe_backfill: link_safe_eval_pairs() (spec 6.2 d) =====
-- Families form after both rows exist (the insert trigger saw no family), as on prod.
DO $$
DECLARE linked int; f int; b int;
BEGIN
  INSERT INTO game_info (game_id, os) VALUES
    ('as1', 'android'), ('is1', 'ios'),   -- both unjudged, same holder       -> link
    ('as2', 'android'), ('is2', 'ios'),   -- one side holds                   -> link
    ('as3', 'android'), ('is3', 'ios'),   -- two different holders            -> no
    ('as4', 'android'), ('is4', 'ios'),   -- different category_group         -> no
    ('as5', 'android'), ('is5', 'ios'),   -- different batch                  -> no
    ('as6', 'android'), ('is6', 'ios'),   -- one side judged                  -> no
    ('as7', 'android'), ('is7', 'ios');   -- different demo links             -> no
  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator, batch, assigned_date, first_assigned_date) VALUES
    ('as1', 'puzzle', 'ThuDT', 'W4 Nov', '2026-11-12', '2026-11-08'),
    ('is1', 'puzzle', 'ThuDT', 'W4 Nov', '2026-11-11', '2026-11-06'),
    ('as2', 'puzzle', NULL, NULL, NULL, NULL),
    ('is2', 'puzzle', 'QuangVN', 'W2 Nov', '2026-11-10', '2026-11-09'),
    ('as3', 'puzzle', 'ThuDT', NULL, NULL, NULL),
    ('is3', 'puzzle', 'QuangVN', NULL, NULL, NULL),
    ('as4', 'puzzle', NULL, NULL, NULL, NULL),
    ('is4', 'arcade', NULL, NULL, NULL, NULL),
    ('as5', 'puzzle', NULL, 'W1 Nov', NULL, NULL),
    ('is5', 'puzzle', NULL, 'W2 Nov', NULL, NULL),
    ('as6', 'puzzle', 'ThuDT', NULL, NULL, NULL),
    ('is6', 'puzzle', NULL, NULL, NULL, NULL),
    ('as7', 'puzzle', NULL, NULL, NULL, NULL),
    ('is7', 'puzzle', NULL, NULL, NULL, NULL);
  UPDATE game_evaluations SET initial_conclusion = 'List_Idea' WHERE game_id = 'as6';
  UPDATE game_evaluations SET drive_link = 'https://drive/as7' WHERE game_id = 'as7';
  UPDATE game_evaluations SET drive_link = 'https://drive/is7' WHERE game_id = 'is7';
  UPDATE game_info SET family_id = 'fam.s' || substr(game_id, 3) WHERE game_id ~ '^[ai]s[1-7]$';
  ASSERT NOT EXISTS (SELECT 1 FROM game_evaluations WHERE game_id ~ '^[ai]s[1-7]$' AND pair_eval_id IS NOT NULL),
    'fixtures start unlinked';

  linked := link_safe_eval_pairs();
  ASSERT linked = 2, format('link_safe_eval_pairs returned %s, expected 2', linked);
  ASSERT (SELECT array_agg(DISTINCT substr(game_id, 3) ORDER BY substr(game_id, 3)) FROM game_evaluations
          WHERE game_id ~ '^[ai]s[1-7]$' AND pair_eval_id IS NOT NULL) = ARRAY['1', '2'], 'the right pairs';

  -- s1: first_assigned_date is the earlier one, assigned_date the front row's
  SELECT id INTO f FROM game_evaluations WHERE game_id = 'as1';
  SELECT id INTO b FROM game_evaluations WHERE game_id = 'is1';
  ASSERT (SELECT pair_eval_id FROM game_evaluations WHERE id = f) = b
     AND (SELECT pair_eval_id FROM game_evaluations WHERE id = b) = f, 's1 linked both ways';
  ASSERT (SELECT bool_and(first_assigned_date = '2026-11-06' AND assigned_date = '2026-11-12')
          FROM game_evaluations WHERE id IN (f, b)), 's1 dates';
  ASSERT NOT (SELECT pair_back FROM game_evaluations WHERE id = f) AND (SELECT pair_back FROM game_evaluations WHERE id = b),
    's1: lower id is the front row';
  -- s2: the side without a holder takes it
  ASSERT (SELECT bool_and(initial_evaluator = 'QuangVN' AND batch = 'W2 Nov' AND assigned_date = '2026-11-10'
                          AND first_assigned_date = '2026-11-09')
          FROM game_evaluations WHERE game_id IN ('as2', 'is2')), 's2 holder copied';
  ASSERT (SELECT count(*) FILTER (WHERE pair_back) FROM game_evaluations WHERE game_id IN ('as2', 'is2')) = 1, 's2 one back';
  ASSERT (SELECT count(*) FROM evaluation_log WHERE kind = 'pair_link' AND game_id ~ '^[ai]s[1-7]$') = 2, 'one log per pair';
  -- the rejected pairs are untouched
  ASSERT (SELECT initial_evaluator FROM game_evaluations WHERE game_id = 'is6') IS NULL, 's6 untouched';
  ASSERT (SELECT batch FROM game_evaluations WHERE game_id = 'as5') = 'W1 Nov', 's5 untouched';

  ASSERT link_safe_eval_pairs() = 0, 'second run links nothing';
END $$;
