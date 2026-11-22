\set ON_ERROR_STOP 1
SET TIME ZONE 'UTC';
-- Migration 055, part 2: eval_pair_phase2_classify(family_id) / eval_pair_phase2_plan() (spec 5).
-- Runs on the throwaway DB of scripts/verify-eval-pairs.sh after phase2-schema.sql.
-- One family per case: games 'p2p_<case>a' (android) / 'p2p_<case>i' (ios), family 'fam.p2p_<case>'.
-- The rows are inserted before the family is set, so 054's insert trigger does not link them
-- (a family set later only unlinks). Evaluator names are unique to this file, so the backlog
-- counts below are exact.

-- ===== fixtures =====
DO $$
BEGIN
  -- backlog: P2pBusy holds 3 lone unjudged games (+ its rows below), P2pFree none.
  -- p2pgone / P2pGone2 are deactivated (P2pGone matched case-insensitively); P2pBusy and
  -- P2pFree have no dashboard_users row, so they count as active.
  INSERT INTO dashboard_users (email, name, role, active) VALUES
    ('p2pgone@x', 'p2pgone', 'evaluator', false),
    ('p2pgone2@x', 'P2pGone2', 'evaluator', false);
  INSERT INTO game_info (game_id, os) VALUES ('p2p_busy1', 'android'), ('p2p_busy2', 'android'), ('p2p_busy3', 'android');
  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator) VALUES
    ('p2p_busy1', 'puzzle', 'P2pBusy'), ('p2p_busy2', 'arcade', 'P2pBusy'), ('p2p_busy3', 'puzzle', 'P2pBusy');
  -- a judged game and a back row do not count as backlog
  INSERT INTO game_info (game_id, os) VALUES ('p2p_freedone', 'android');
  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator, initial_conclusion)
    VALUES ('p2p_freedone', 'puzzle', 'P2pFree', 'Bypass');

  INSERT INTO game_info (game_id, os, initial_release, temp_release, demo_code, record_code) VALUES
    -- A1: backlog decides (P2pBusy 4 pending, P2pFree 1); front = earlier release
    ('p2p_a1a', 'android', '2026-01-01', NULL, NULL, NULL), ('p2p_a1i', 'ios', '2026-02-01', NULL, NULL, NULL),
    -- A2: the deactivated holder is skipped even with the smaller backlog
    ('p2p_a2a', 'android', NULL, '2026-01-01', NULL, NULL), ('p2p_a2i', 'ios', '2026-02-01', NULL, NULL, NULL),
    -- A3: both deactivated -> earlier assigned_date; groups differ
    ('p2p_a3a', 'android', '2026-01-01', NULL, NULL, NULL), ('p2p_a3i', 'ios', '2026-02-01', NULL, NULL, NULL),
    -- A4: one deactivated holder, the other row unassigned
    ('p2p_a4a', 'android', '2026-01-01', NULL, NULL, NULL), ('p2p_a4i', 'ios', '2026-02-01', NULL, NULL, NULL),
    -- B: the judged row is the source; the front is the earlier release (the HIGHER id)
    ('p2p_bi', 'ios', '2026-01-20', NULL, NULL, NULL), ('p2p_ba', 'android', '2026-01-10', NULL, NULL, NULL),
    -- C: the Link_dead store (earlier release, lower id) is the back; the live one keeps its holder
    ('p2p_ca', 'android', '2026-01-01', NULL, NULL, NULL), ('p2p_ci', 'ios', '2026-02-01', NULL, NULL, NULL),
    -- D1: Bypass tie -> earlier release (the higher id)
    ('p2p_d1a', 'android', '2026-05-02', NULL, NULL, NULL), ('p2p_d1i', 'ios', '2026-05-01', NULL, NULL, NULL),
    -- D2: same release -> earlier first_assigned_date
    ('p2p_d2a', 'android', '2026-05-01', NULL, NULL, NULL), ('p2p_d2i', 'ios', '2026-05-01', NULL, NULL, NULL),
    -- D3: one release missing -> first_assigned_date; both missing too -> lower id (D4)
    ('p2p_d3a', 'android', NULL, NULL, NULL, NULL), ('p2p_d3i', 'ios', '2026-01-01', NULL, NULL, NULL),
    ('p2p_d4a', 'android', NULL, NULL, NULL, NULL), ('p2p_d4i', 'ios', NULL, NULL, NULL, NULL),
    -- D5: List_Idea, final only on the later store -> that store is the front; 2 demo codes; demo links differ
    ('p2p_d5a', 'android', '2026-01-01', NULL, 'P2PD5A', NULL), ('p2p_d5i', 'ios', '2026-03-01', NULL, 'P2PD5I', NULL),
    -- D6: record (5') beats demo link only
    ('p2p_d6a', 'android', '2026-01-01', NULL, NULL, NULL), ('p2p_d6i', 'ios', '2026-03-01', NULL, NULL, NULL),
    -- E1: List_Idea vs Bypass, both finals, different; 2 record codes
    ('p2p_e1a', 'android', '2026-01-01', NULL, NULL, 'P2PE1A'), ('p2p_e1i', 'ios', '2026-03-01', NULL, NULL, 'P2PE1I'),
    -- E2: List_Idea (no final) vs Playtest & Bypass (final)
    ('p2p_e2a', 'android', '2026-03-01', NULL, NULL, NULL), ('p2p_e2i', 'ios', '2026-01-01', NULL, NULL, NULL),
    -- F: Bypass vs Playtest & Bypass
    ('p2p_fa', 'android', '2026-01-01', NULL, NULL, NULL), ('p2p_fi', 'ios', '2026-03-01', NULL, NULL, NULL),
    -- G1: the android store has 2 rows; G2: two results outside D/E/F
    ('p2p_g1a', 'android', '2026-01-01', NULL, NULL, NULL), ('p2p_g1i', 'ios', '2026-03-01', NULL, NULL, NULL),
    ('p2p_g2a', 'android', '2026-01-01', NULL, NULL, NULL), ('p2p_g2i', 'ios', '2026-03-01', NULL, NULL, NULL),
    -- absent: 3 games in the family; an unlinked family; 2 games of the same os; a store without a row;
    -- an already linked pair
    ('p2p_x3a', 'android', NULL, NULL, NULL, NULL), ('p2p_x3i', 'ios', NULL, NULL, NULL, NULL),
    ('p2p_x3b', 'android', NULL, NULL, NULL, NULL),
    ('p2p_xua', 'android', NULL, NULL, NULL, NULL), ('p2p_xui', 'ios', NULL, NULL, NULL, NULL),
    ('p2p_xoa', 'android', NULL, NULL, NULL, NULL), ('p2p_xob', 'android', NULL, NULL, NULL, NULL),
    ('p2p_xea', 'android', NULL, NULL, NULL, NULL), ('p2p_xei', 'ios', NULL, NULL, NULL, NULL);

  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator, assigned_date, first_assigned_date,
                                initial_conclusion, final_conclusion, drive_link, record_5min_assignee) VALUES
    ('p2p_a1a', 'puzzle', 'P2pBusy',  '2026-03-01', '2026-03-01', NULL, NULL, NULL, NULL),
    ('p2p_a1i', 'puzzle', 'P2pFree',  '2026-03-02', '2026-03-02', NULL, NULL, NULL, NULL),
    ('p2p_a2a', 'puzzle', 'P2pGone',  '2026-03-01', '2026-03-01', NULL, NULL, NULL, NULL),
    ('p2p_a2i', 'puzzle', 'P2pBusy',  '2026-03-02', '2026-03-02', NULL, NULL, NULL, NULL),
    ('p2p_a3a', 'puzzle', 'P2pGone',  '2026-03-05', '2026-03-05', NULL, NULL, NULL, NULL),
    ('p2p_a3i', 'arcade', 'P2pGone2', '2026-03-01', '2026-03-01', NULL, NULL, NULL, NULL),
    ('p2p_a4a', 'puzzle', NULL,       NULL,         NULL,         NULL, NULL, NULL, NULL),
    ('p2p_a4i', 'puzzle', 'P2pGone2', '2026-03-01', '2026-03-01', NULL, NULL, NULL, NULL),
    ('p2p_bi',  'puzzle', 'P2pJudge', '2026-03-01', '2026-03-01', 'Bypass', 'Bypass', NULL, NULL),
    ('p2p_ba',  'arcade', 'P2pWait',  '2026-03-02', '2026-03-02', NULL, NULL, NULL, NULL),
    ('p2p_ca',  'puzzle', 'P2pDead',  '2026-03-01', '2026-03-01', 'Link_dead', NULL, NULL, NULL),
    ('p2p_ci',  'puzzle', 'P2pLive',  '2026-03-02', '2026-03-02', NULL, NULL, NULL, NULL),
    ('p2p_d1a', 'puzzle', 'P2pD1a',   '2026-03-01', '2026-03-01', 'Bypass', NULL, NULL, NULL),
    ('p2p_d1i', 'puzzle', 'P2pD1i',   '2026-03-02', '2026-03-02', 'Bypass', NULL, NULL, NULL),
    ('p2p_d2a', 'puzzle', 'P2pD2a',   '2026-03-01', '2026-03-03', 'Bypass', NULL, NULL, NULL),
    ('p2p_d2i', 'puzzle', 'P2pD2i',   '2026-03-02', '2026-03-02', 'Bypass', NULL, NULL, NULL),
    ('p2p_d3i', 'puzzle', 'P2pD3i',   '2026-03-02', '2026-03-02', 'Bypass', NULL, NULL, NULL),
    ('p2p_d3a', 'puzzle', 'P2pD3a',   '2026-03-01', '2026-03-01', 'Bypass', NULL, NULL, NULL),
    ('p2p_d4a', 'puzzle', 'P2pD4a',   '2026-03-01', NULL,         'Bypass', NULL, NULL, NULL),
    ('p2p_d4i', 'puzzle', 'P2pD4i',   '2026-03-02', '2026-03-02', 'Bypass', NULL, NULL, NULL),
    ('p2p_d5a', 'puzzle', 'P2pD5a',   '2026-03-01', '2026-03-01', 'List_Idea', NULL, 'https://d/5a', NULL),
    ('p2p_d5i', 'puzzle', 'P2pD5i',   '2026-03-02', '2026-03-02', 'List_Idea', 'Insight', 'https://d/5i', NULL),
    ('p2p_d6a', 'puzzle', 'P2pD6a',   '2026-03-01', '2026-03-01', 'Bypass', NULL, 'https://d/6a', NULL),
    ('p2p_d6i', 'puzzle', 'P2pD6i',   '2026-03-02', '2026-03-02', 'Bypass', NULL, NULL, 'P2pRec'),
    ('p2p_e1a', 'puzzle', 'P2pE1a',   '2026-03-01', '2026-03-01', 'Bypass', 'Watch List', NULL, NULL),
    ('p2p_e1i', 'puzzle', 'P2pE1i',   '2026-03-02', '2026-03-02', 'List_Idea', 'Insight', NULL, NULL),
    ('p2p_e2a', 'puzzle', 'P2pE2a',   '2026-03-01', '2026-03-01', 'List_Idea', NULL, NULL, NULL),
    ('p2p_e2i', 'puzzle', 'P2pE2i',   '2026-03-02', '2026-03-02', 'Playtest & Bypass', 'Bypass', NULL, NULL),
    ('p2p_fa',  'puzzle', 'P2pFa',    '2026-03-01', '2026-03-01', 'Bypass', NULL, NULL, NULL),
    ('p2p_fi',  'puzzle', 'P2pFi',    '2026-03-02', '2026-03-02', 'Playtest & Bypass', NULL, NULL, NULL),
    ('p2p_g1a', 'puzzle', 'P2pG',     '2026-03-01', '2026-03-01', 'Bypass', NULL, NULL, NULL),
    ('p2p_g1a', 'arcade', 'P2pG',     '2026-03-01', '2026-03-01', 'Bypass', NULL, NULL, NULL),
    ('p2p_g1i', 'puzzle', 'P2pG',     '2026-03-01', '2026-03-01', 'Bypass', NULL, NULL, NULL),
    ('p2p_g2a', 'puzzle', 'P2pG',     '2026-03-01', '2026-03-01', 'Good', NULL, NULL, NULL),
    ('p2p_g2i', 'puzzle', 'P2pG',     '2026-03-01', '2026-03-01', 'Bypass', NULL, NULL, NULL),
    ('p2p_x3a', 'puzzle', 'P2pX',     '2026-03-01', '2026-03-01', 'Bypass', NULL, NULL, NULL),
    ('p2p_x3i', 'puzzle', 'P2pX',     '2026-03-01', '2026-03-01', 'Bypass', NULL, NULL, NULL),
    ('p2p_x3b', 'puzzle', 'P2pX',     '2026-03-01', '2026-03-01', 'Bypass', NULL, NULL, NULL),
    ('p2p_xua', 'puzzle', 'P2pX',     '2026-03-01', '2026-03-01', 'Bypass', NULL, NULL, NULL),
    ('p2p_xui', 'puzzle', 'P2pX',     '2026-03-01', '2026-03-01', 'Bypass', NULL, NULL, NULL),
    ('p2p_xoa', 'puzzle', 'P2pX',     '2026-03-01', '2026-03-01', 'Bypass', NULL, NULL, NULL),
    ('p2p_xob', 'puzzle', 'P2pX',     '2026-03-01', '2026-03-01', 'Bypass', NULL, NULL, NULL),
    ('p2p_xea', 'puzzle', 'P2pX',     '2026-03-01', '2026-03-01', 'Bypass', NULL, NULL, NULL);

  UPDATE game_info SET family_id = 'fam.' || left(game_id, length(game_id) - 1)
   WHERE game_id LIKE 'p2p\_%' AND game_id NOT LIKE 'p2p\_busy%' AND game_id <> 'p2p_freedone';
  UPDATE game_info SET family_id = 'fam.p2p_x3' WHERE game_id = 'p2p_x3b';
  UPDATE game_info SET family_id = 'fam.p2p_xo' WHERE game_id = 'p2p_xob';
  UPDATE game_info SET family_unlinked = true WHERE game_id = 'p2p_xui';

  -- already linked: both stores unjudged, the second insert links (054)
  INSERT INTO game_info (game_id, os, family_id) VALUES ('p2p_xla', 'android', 'fam.p2p_xl'), ('p2p_xli', 'ios', 'fam.p2p_xl');
  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator) VALUES ('p2p_xla', 'puzzle', 'P2pX');
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('p2p_xli', 'puzzle');
  ASSERT (SELECT count(*) FROM game_evaluations WHERE game_id IN ('p2p_xla', 'p2p_xli') AND pair_eval_id IS NOT NULL) = 2,
    'fixture: the linked pair is linked';
  -- a back row of P2pFree does not count as backlog
  INSERT INTO game_info (game_id, os, family_id) VALUES ('p2p_xfa', 'android', 'fam.p2p_xf'), ('p2p_xfi', 'ios', 'fam.p2p_xf');
  INSERT INTO game_evaluations (game_id, category_group) VALUES ('p2p_xfa', 'puzzle');
  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator) VALUES ('p2p_xfi', 'puzzle', 'P2pFree');
  ASSERT (SELECT pair_back AND initial_evaluator = 'P2pFree' FROM game_evaluations WHERE game_id = 'p2p_xfi'),
    'fixture: a back row held by P2pFree';
END $$;

-- ===== classify: one family at a time =====
DO $$
DECLARE r record; id_of jsonb;
BEGIN
  SELECT jsonb_object_agg(game_id || ':' || category_group, id) INTO id_of FROM game_evaluations WHERE game_id LIKE 'p2p\_%';

  ASSERT (SELECT provolatile FROM pg_proc WHERE oid = 'eval_pair_phase2_classify(text)'::regprocedure) = 's',
    'classify is STABLE';
  ASSERT (SELECT provolatile FROM pg_proc WHERE oid = 'eval_pair_phase2_plan()'::regprocedure) = 's',
    'plan is STABLE';

  -- A1: P2pBusy has 4 pending games, P2pFree 1 (its judged game and its back row do not count)
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_a1');
  ASSERT r.family_id = 'fam.p2p_a1' AND r.grp = 'A', format('A1 group: %s', r);
  ASSERT r.front_id = (id_of ->> 'p2p_a1a:puzzle')::int AND r.back_id = (id_of ->> 'p2p_a1i:puzzle')::int,
    format('A1 front = earlier release: %s', r);
  ASSERT r.holder = 'P2pFree' AND r.holder_row = r.back_id, format('A1 holder = fewer pending: %s', r);
  ASSERT r.result_conclusion IS NULL AND r.final_from IS NULL AND r.flags = '{}', format('A1 rest: %s', r);

  -- A2: P2pGone (deactivated, matched lower-case) has the smaller backlog but is skipped
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_a2');
  ASSERT r.grp = 'A' AND r.front_id = (id_of ->> 'p2p_a2a:puzzle')::int, format('A2 front (temp_release): %s', r);
  ASSERT r.holder = 'P2pBusy' AND r.holder_row = (id_of ->> 'p2p_a2i:puzzle')::int AND r.flags = '{}',
    format('A2 deactivated holder skipped: %s', r);

  -- A3: both deactivated -> the earlier assigned_date (the ios row), flagged; groups differ
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_a3');
  ASSERT r.grp = 'A' AND r.front_id = (id_of ->> 'p2p_a3a:puzzle')::int, format('A3 front: %s', r);
  ASSERT r.holder = 'P2pGone2' AND r.holder_row = (id_of ->> 'p2p_a3i:arcade')::int, format('A3 holder: %s', r);
  ASSERT r.flags = '{group_differs,both_holders_inactive}', format('A3 flags: %s', r);

  -- A4: one deactivated holder, the other row unassigned: keep the holder, flagged
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_a4');
  ASSERT r.grp = 'A' AND r.holder = 'P2pGone2' AND r.holder_row = (id_of ->> 'p2p_a4i:puzzle')::int
     AND r.flags = '{no_active_holder}', format('A4: %s', r);

  -- B: the judged row is the source of the eval group; the front is the earlier release
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_b');
  ASSERT r.grp = 'B', format('B group: %s', r);
  ASSERT r.front_id = (id_of ->> 'p2p_ba:arcade')::int AND r.back_id = (id_of ->> 'p2p_bi:puzzle')::int
     AND r.front_id > r.back_id, format('B front = earlier release, though the higher id: %s', r);
  ASSERT r.result_conclusion = 'Bypass' AND r.holder = 'P2pJudge' AND r.holder_row = r.back_id
     AND r.final_from = r.back_id, format('B source = judged row: %s', r);
  ASSERT r.flags = '{group_differs}', format('B flags: %s', r);

  -- C: the live store is the front, keeps its own holder; nothing copied
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_c');
  ASSERT r.grp = 'C' AND r.front_id = (id_of ->> 'p2p_ci:puzzle')::int AND r.back_id = (id_of ->> 'p2p_ca:puzzle')::int,
    format('C front = live store: %s', r);
  ASSERT r.holder = 'P2pLive' AND r.holder_row IS NULL AND r.result_conclusion IS NULL AND r.final_from IS NULL
     AND r.flags = '{}', format('C rest: %s', r);

  -- D1: Bypass tie -> earlier release (the higher id)
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_d1');
  ASSERT r.grp = 'D' AND r.front_id = (id_of ->> 'p2p_d1i:puzzle')::int AND r.back_id = (id_of ->> 'p2p_d1a:puzzle')::int,
    format('D1 front = earlier release: %s', r);
  ASSERT r.result_conclusion = 'Bypass' AND r.holder = 'P2pD1i' AND r.holder_row = r.front_id
     AND r.final_from IS NULL AND r.flags = '{}', format('D1 rest: %s', r);

  -- D2: same release -> earlier first_assigned_date (ios 03-02 before android 03-03)
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_d2');
  ASSERT r.grp = 'D' AND r.front_id = (id_of ->> 'p2p_d2i:puzzle')::int, format('D2 front = earlier first assign: %s', r);
  -- D3: one release missing -> first_assigned_date (android 03-01; not the store with a
  -- release, not the lower id)
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_d3');
  ASSERT r.grp = 'D' AND r.front_id = (id_of ->> 'p2p_d3a:puzzle')::int AND r.front_id > r.back_id,
    format('D3 front = earlier first assign: %s', r);
  -- D4: no release, one first_assigned_date missing -> lower id (not the store with a date)
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_d4');
  ASSERT r.grp = 'D' AND r.front_id = (id_of ->> 'p2p_d4a:puzzle')::int, format('D4 front = lower id: %s', r);

  -- D5: List_Idea, final only on the later store -> that store is the front and the final's source
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_d5');
  ASSERT r.grp = 'D' AND r.front_id = (id_of ->> 'p2p_d5i:puzzle')::int AND r.back_id = (id_of ->> 'p2p_d5a:puzzle')::int,
    format('D5 front = the store with the final: %s', r);
  ASSERT r.result_conclusion = 'List_Idea' AND r.holder = 'P2pD5i' AND r.final_from = r.front_id,
    format('D5 rest: %s', r);
  ASSERT r.flags = '{two_demo_codes,media_conflict}', format('D5 flags: %s', r);

  -- D6: a record (5') beats a demo link only
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_d6');
  ASSERT r.grp = 'D' AND r.front_id = (id_of ->> 'p2p_d6i:puzzle')::int AND r.flags = '{}',
    format('D6 front = the recorded store: %s', r);

  -- E1: the List_Idea store is the front (the later release), result List_Idea, its final kept
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_e1');
  ASSERT r.grp = 'E' AND r.front_id = (id_of ->> 'p2p_e1i:puzzle')::int AND r.back_id = (id_of ->> 'p2p_e1a:puzzle')::int,
    format('E1 front = List_Idea store: %s', r);
  ASSERT r.result_conclusion = 'List_Idea' AND r.holder = 'P2pE1i' AND r.holder_row = r.front_id
     AND r.final_from = r.front_id, format('E1 rest: %s', r);
  ASSERT r.flags = '{two_record_codes,final_conflict}', format('E1 flags: %s', r);

  -- E2: List_Idea vs Playtest & Bypass; the final is only on the back store
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_e2');
  ASSERT r.grp = 'E' AND r.front_id = (id_of ->> 'p2p_e2a:puzzle')::int AND r.result_conclusion = 'List_Idea'
     AND r.final_from IS NULL AND r.flags = '{final_only_on_back}', format('E2: %s', r);

  -- F: the Playtest & Bypass store is the front (the later release), result Playtest & Bypass
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_f');
  ASSERT r.grp = 'F' AND r.front_id = (id_of ->> 'p2p_fi:puzzle')::int AND r.back_id = (id_of ->> 'p2p_fa:puzzle')::int
     AND r.result_conclusion = 'Playtest & Bypass' AND r.holder = 'P2pFi' AND r.holder_row = r.front_id
     AND r.final_from IS NULL AND r.flags = '{}', format('F: %s', r);

  -- G1: a store with 2 rows: listed, nothing to link
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_g1');
  ASSERT r.grp = 'G' AND r.front_id IS NULL AND r.back_id IS NULL AND r.result_conclusion IS NULL
     AND r.holder IS NULL AND r.holder_row IS NULL AND r.final_from IS NULL AND r.flags = '{multi_row}',
    format('G1: %s', r);
  -- G2: two results that are not D / E / F: listed as G, nothing to link
  SELECT * INTO STRICT r FROM eval_pair_phase2_classify('fam.p2p_g2');
  ASSERT r.grp = 'G' AND r.front_id IS NULL AND r.back_id IS NULL AND r.holder_row IS NULL
     AND r.flags = '{unsupported_results}', format('G2: %s', r);

  -- absent
  ASSERT NOT EXISTS (SELECT 1 FROM eval_pair_phase2_classify('fam.p2p_x3')), '3 games in the family: absent';
  ASSERT NOT EXISTS (SELECT 1 FROM eval_pair_phase2_classify('fam.p2p_xu')), 'unlinked family: absent';
  ASSERT NOT EXISTS (SELECT 1 FROM eval_pair_phase2_classify('fam.p2p_xo')), 'same os: absent';
  ASSERT NOT EXISTS (SELECT 1 FROM eval_pair_phase2_classify('fam.p2p_xe')), 'a store without a row: absent';
  ASSERT NOT EXISTS (SELECT 1 FROM eval_pair_phase2_classify('fam.p2p_xl')), 'already linked: absent';
  ASSERT NOT EXISTS (SELECT 1 FROM eval_pair_phase2_classify('fam.p2p_none')), 'unknown family: absent';
  ASSERT NOT EXISTS (SELECT 1 FROM eval_pair_phase2_classify(NULL)), 'NULL family: absent';
END $$;

-- ===== plan: every family, the same rows as classify =====
DO $$
DECLARE n_plan int; n_fam int; md_plan text; md_cls text;
BEGIN
  SELECT count(*), md5(string_agg(p::text, ',' ORDER BY p.family_id)) INTO n_plan, md_plan
    FROM eval_pair_phase2_plan() p WHERE p.family_id LIKE 'fam.p2p\_%';
  ASSERT n_plan = 17, format('plan lists the 17 present p2p families, got %s', n_plan);
  SELECT md5(string_agg(c::text, ',' ORDER BY c.family_id)) INTO md_cls
    FROM (SELECT DISTINCT family_id FROM game_info WHERE family_id LIKE 'fam.p2p\_%') f,
         LATERAL eval_pair_phase2_classify(f.family_id) c;
  ASSERT md_plan = md_cls, 'plan = classify per family';
  ASSERT (SELECT string_agg(grp || count, ' ' ORDER BY grp)
            FROM (SELECT grp, count(*) FROM eval_pair_phase2_plan() WHERE family_id LIKE 'fam.p2p\_%' GROUP BY grp) g)
       = 'A4 B1 C1 D6 E2 F1 G2', 'plan group counts';
  -- one row per family over the whole DB
  SELECT count(*), count(DISTINCT family_id) INTO n_plan, n_fam FROM eval_pair_phase2_plan();
  ASSERT n_plan = n_fam, 'one row per family';
  -- a clean, unjudged pair the plan lists is still not linked by reading it
  ASSERT (SELECT count(*) FROM game_evaluations WHERE game_id LIKE 'p2p\_%' AND pair_eval_id IS NOT NULL) = 4,
    'the plan links nothing';
END $$;
