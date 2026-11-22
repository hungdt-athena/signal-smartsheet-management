-- Migration 055: phase 2 of the Playtest store pairs (link the old pairs), part 1: schema
-- Spec: docs/superpowers/specs/2026-11-23-unified-playtest-phase2-design.md (6.1, 6.2)
--
-- Phase 2 links pairs whose two stores were BOTH judged before 054. The back row of such
-- a pair takes the pair's values, so the work its evaluator did would vanish from every
-- per-person count. This part adds what the link step and the counts need; it links
-- nothing and changes no row by itself (scripts/verify-eval-pairs.sh checks that):
--   game_evaluations.credit   jsonb, NULL by default. Written by phase 2 only, on a back
--                  row that had a result of its own before the link: the frozen values of
--                  every column the counts read (key = column name). Optional key '_moved':
--                  a json array of column names whose value was moved to the front row and
--                  is counted there. Keys that are not columns (e.g. 'noted') are ignored
--                  by eval_stats_rows.
--   eval_pair_merge_snapshots   one row per game_evaluations row phase 2 touches: the
--                  whole row before (row_before = to_jsonb(ge.*)) and the columns + values
--                  the run wrote (written), so a run can be reviewed and rolled back by run_id.
--   eval_pair_refresh_back(a, b)   now STICKY: if exactly one of the two rows carries a
--                  store-only result (Link_dead / Stale_release), the other is the front row;
--                  otherwise, if exactly one row already has pair_back = true, the front row
--                  stays where it is; otherwise (a fresh link) the lower id. Change from 054:
--                  a dead store that reopens no longer takes the front row back because its
--                  id is lower, and when both stores are store-only the front row stays.
--   eval_stats_rows   the rows the counting routes read. EVERY game_evaluations row, with
--                  credit applied, plus two flags:
--                    eval_row  = NOT pair_back OR eval_store_specific(initial_conclusion)
--                                OR credit IS NOT NULL      -> evaluation counts filter on it
--                    media_row = NOT pair_back OR credit IS NOT NULL
--                                                           -> media / recording counts filter on it
--                  (054's notPairCopy vs mediaRowFilter split, plus the credited rows).
--                  A row with credit reads each column from credit (cast to the column's
--                  type) when credit has that key, NULL when the column is in credit->'_moved',
--                  and the real column when credit lacks the key. The plumbing columns (id,
--                  game_id, pair_eval_id, pair_back, credit, updated_at, imported_at) always
--                  come from the real row. A row without credit reads exactly as the table.
--                  So credit must hold EVERY counted column of the back row, media included:
--                  a counted column left out reads the pair's (copied) value and counts twice.
--                  Built as two UNION ALL branches (credit IS NULL: the columns as they are;
--                  credit IS NOT NULL: the overrides), so filters on the view still use the
--                  table's indexes; idx_game_evaluations_credited finds the credited rows.
--   eval_pair_phase2_classify(family_id) / eval_pair_phase2_plan()   read-only: which old
--                  pairs phase 2 links, their group (spec 4: A..G), front / back row, the
--                  pair's result, holder and final, and flags for the review (see there).
--   eval_pair_phase2_apply(run_id, max_pairs)   links them, a batch per call (see there). Not
--                  run by this file. Its evaluation_log rows carry the run_id in `context`.
--   game_evaluations_touch_updated()   054's body behind one check: while the setting
--                  eval_pairs.keep_updated_at is 'on' (only inside apply), updated_at stays.
--
-- KEEP eval_stats_rows IN STEP WITH THE TABLE: it lists the columns of game_evaluations one
-- by one, in both branches (an override per column cannot be written with *). A later
-- migration that adds, renames or drops a column of game_evaluations must change this view in
-- the same migration (a new column goes at the end of the column list of BOTH branches, before
-- eval_row; CREATE OR REPLACE VIEW only appends). scripts/sql-verify/phase2-schema.sql fails until it is.
--
-- updated_at: writing credit is an ordinary UPDATE, so game_evaluations_touch_updated()
-- stamps updated_at, unless eval_pairs.keep_updated_at is 'on': apply runs with it on (spec:
-- phase 2 changes no row's updated_at).
--
-- ORDER: after 054. Additive: the build from before ignores the column, table and view.
-- Re-running 054 after 055 puts back 054's eval_pair_refresh_back (lower id): re-run 055
-- after it (054 also puts back its game_evaluations_touch_updated, and apply would then stamp
-- updated_at). Rolling back 054 needs 055 rolled back first (the view reads pair_back).
-- Idempotent: column / table / indexes IF NOT EXISTS, functions and view replaced.
--
-- ROLLBACK: run the lines below up to END ROLLBACK, without their leading "-- ", in psql
-- -- (scripts/verify-eval-pairs.sh extracts and runs them). It puts back 054's
-- -- eval_pair_refresh_back and game_evaluations_touch_updated verbatim, and drops the view,
-- -- the snapshot table and credit (with them every snapshot and credit phase 2 wrote: undo the
-- -- phase 2 runs first).
-- BEGIN;
-- DROP FUNCTION IF EXISTS eval_pair_phase2_apply(text, integer);
-- CREATE OR REPLACE FUNCTION game_evaluations_touch_updated() RETURNS trigger
-- LANGUAGE plpgsql AS $$
-- BEGIN
--   IF (NEW.pair_eval_id IS DISTINCT FROM OLD.pair_eval_id OR NEW.pair_back IS DISTINCT FROM OLD.pair_back)
--      AND to_jsonb(NEW) - ARRAY['pair_eval_id', 'pair_back', 'updated_at']
--        = to_jsonb(OLD) - ARRAY['pair_eval_id', 'pair_back', 'updated_at'] THEN
--     RETURN NEW;
--   END IF;
--   NEW.updated_at = NOW();
--   RETURN NEW;
-- END;
-- $$;
-- DROP FUNCTION IF EXISTS eval_pair_phase2_plan();
-- DROP FUNCTION IF EXISTS eval_pair_phase2_classify(text);
-- DROP VIEW IF EXISTS eval_stats_rows;
-- CREATE OR REPLACE FUNCTION eval_pair_refresh_back(a integer, b integer) RETURNS void
-- LANGUAGE plpgsql AS $$
-- DECLARE ca text; cb text; front integer;
-- BEGIN
--   SELECT initial_conclusion INTO ca FROM game_evaluations WHERE id = a AND pair_eval_id = b;
--   IF NOT FOUND THEN RETURN; END IF;
--   SELECT initial_conclusion INTO cb FROM game_evaluations WHERE id = b AND pair_eval_id = a;
--   IF NOT FOUND THEN RETURN; END IF;
--   front := CASE WHEN eval_store_specific(ca) = eval_store_specific(cb) THEN LEAST(a, b)
--                 WHEN eval_store_specific(ca) THEN b
--                 ELSE a END;
--   UPDATE game_evaluations SET pair_back = (id <> front)
--    WHERE id IN (a, b) AND pair_back IS DISTINCT FROM (id <> front);
-- END;
-- $$;
-- DROP INDEX IF EXISTS idx_game_evaluations_credited;
-- DROP TABLE IF EXISTS eval_pair_merge_snapshots;
-- ALTER TABLE game_evaluations DROP COLUMN IF EXISTS credit;
-- COMMIT;
-- END ROLLBACK

-- Four transactions: the first adds the column, the table and its indexes (metadata, an
-- empty table, and a partial index built in one pass over game_evaluations: its write lock
-- is held for milliseconds), the second
-- replaces the front-row rule and creates the view, the third adds the plan functions, the
-- fourth the apply function and the updated_at check.
BEGIN;

ALTER TABLE game_evaluations ADD COLUMN IF NOT EXISTS credit jsonb;

CREATE TABLE IF NOT EXISTS eval_pair_merge_snapshots (
  id                 bigserial PRIMARY KEY,
  run_id             text,
  game_evaluation_id integer,
  family_id          text,
  pair_group         text,
  row_before         jsonb,
  written            jsonb,
  created_at         timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_pair_merge_snapshots_run ON eval_pair_merge_snapshots (run_id);
CREATE INDEX IF NOT EXISTS idx_eval_pair_merge_snapshots_eval ON eval_pair_merge_snapshots (game_evaluation_id);
-- The credited rows, for eval_stats_rows' second branch (a few hundred rows at most).
CREATE INDEX IF NOT EXISTS idx_game_evaluations_credited ON game_evaluations (id) WHERE credit IS NOT NULL;

COMMIT;

BEGIN;

-- Sets pair_back on a linked pair (sticky): exactly one row with a store-only result ->
-- the other row is the front row; else exactly one row already the back row -> keep it;
-- else (a fresh link, or a broken state) the lower id. No-op unless a and b point at each
-- other. Same answer whichever row is passed first.
CREATE OR REPLACE FUNCTION eval_pair_refresh_back(a integer, b integer) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE ca text; cb text; ba boolean; bb boolean; sa boolean; sb boolean; front integer;
BEGIN
  SELECT initial_conclusion, pair_back INTO ca, ba FROM game_evaluations WHERE id = a AND pair_eval_id = b;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT initial_conclusion, pair_back INTO cb, bb FROM game_evaluations WHERE id = b AND pair_eval_id = a;
  IF NOT FOUND THEN RETURN; END IF;
  sa := eval_store_specific(ca);
  sb := eval_store_specific(cb);
  front := CASE WHEN sa AND NOT sb THEN b
                WHEN sb AND NOT sa THEN a
                WHEN ba AND NOT bb THEN b
                WHEN bb AND NOT ba THEN a
                ELSE LEAST(a, b) END;
  UPDATE game_evaluations SET pair_back = (id <> front)
   WHERE id IN (a, b) AND pair_back IS DISTINCT FROM (id <> front);
END;
$$;

-- The rows the counting routes read (see the header): every row, credit applied, plus
-- eval_row / media_row. Two UNION ALL branches, so a filter on the view reaches the table's
-- indexes: the rows without credit (nearly all) are the table columns as they are, and only
-- the few credited rows (found by idx_game_evaluations_credited) carry the per-column
-- overrides, which no index can see through. Columns in table order; a new
-- game_evaluations column must be added to BOTH branches in the same migration.
CREATE OR REPLACE VIEW eval_stats_rows AS
SELECT
  ge.id,
  ge.game_id,
  ge.category_group,
  ge.initial_evaluator,
  ge.final_evaluator,
  ge.assigned_date,
  ge.initial_note,
  ge.initial_conclusion,
  ge.drive_link,
  ge.youtube_link,
  ge.imported_at,
  ge.updated_at,
  ge.genre_1,
  ge.genre_2,
  ge.evaluate_date,
  ge.drive_date,
  ge.record_assignee,
  ge.record_assign_date,
  ge.record_5min_assignee,
  ge.record_5min_date,
  ge.record_5min_drive,
  ge.record_5min_drive_date,
  ge.record_20min_assignee,
  ge.record_20min_date,
  ge.record_20min_drive,
  ge.record_20min_drive_date,
  ge.final_conclusion,
  ge.batch,
  ge.game_alike,
  ge.final_note,
  ge.record_confirmed_at,
  ge.record_bucket,
  ge.final_conclusion_date,
  ge.updated_by,
  ge.first_assigned_date,
  ge.youtube_uploaded_at,
  ge.initial_gameplay,
  ge.initial_game_over,
  ge.initial_level_complete,
  ge.initial_self_note,
  ge.record_5min_confirmed_at,
  ge.record_20min_confirmed_at,
  ge.youtube_5min_link,
  ge.youtube_20min_link,
  ge.youtube_5min_uploaded_at,
  ge.youtube_20min_uploaded_at,
  ge.record_5min_batch,
  ge.record_20min_batch,
  ge.pair_eval_id,
  ge.pair_back,
  ge.credit,
  (NOT ge.pair_back OR eval_store_specific(ge.initial_conclusion)) AS eval_row,
  (NOT ge.pair_back) AS media_row
FROM game_evaluations ge
WHERE ge.credit IS NULL
UNION ALL
SELECT
  ge.id,
  ge.game_id,
  (CASE WHEN (ge.credit -> '_moved') ? 'category_group' THEN NULL
        WHEN ge.credit ? 'category_group' THEN (ge.credit ->> 'category_group')::character varying(20) ELSE ge.category_group END)::character varying(20) AS category_group,
  (CASE WHEN (ge.credit -> '_moved') ? 'initial_evaluator' THEN NULL
        WHEN ge.credit ? 'initial_evaluator' THEN (ge.credit ->> 'initial_evaluator')::character varying(100) ELSE ge.initial_evaluator END)::character varying(100) AS initial_evaluator,
  (CASE WHEN (ge.credit -> '_moved') ? 'final_evaluator' THEN NULL
        WHEN ge.credit ? 'final_evaluator' THEN (ge.credit ->> 'final_evaluator')::character varying(100) ELSE ge.final_evaluator END)::character varying(100) AS final_evaluator,
  (CASE WHEN (ge.credit -> '_moved') ? 'assigned_date' THEN NULL
        WHEN ge.credit ? 'assigned_date' THEN (ge.credit ->> 'assigned_date')::date ELSE ge.assigned_date END)::date AS assigned_date,
  (CASE WHEN (ge.credit -> '_moved') ? 'initial_note' THEN NULL
        WHEN ge.credit ? 'initial_note' THEN (ge.credit ->> 'initial_note')::text ELSE ge.initial_note END)::text AS initial_note,
  (CASE WHEN (ge.credit -> '_moved') ? 'initial_conclusion' THEN NULL
        WHEN ge.credit ? 'initial_conclusion' THEN (ge.credit ->> 'initial_conclusion')::character varying(50) ELSE ge.initial_conclusion END)::character varying(50) AS initial_conclusion,
  (CASE WHEN (ge.credit -> '_moved') ? 'drive_link' THEN NULL
        WHEN ge.credit ? 'drive_link' THEN (ge.credit ->> 'drive_link')::text ELSE ge.drive_link END)::text AS drive_link,
  (CASE WHEN (ge.credit -> '_moved') ? 'youtube_link' THEN NULL
        WHEN ge.credit ? 'youtube_link' THEN (ge.credit ->> 'youtube_link')::text ELSE ge.youtube_link END)::text AS youtube_link,
  ge.imported_at,
  ge.updated_at,
  (CASE WHEN (ge.credit -> '_moved') ? 'genre_1' THEN NULL
        WHEN ge.credit ? 'genre_1' THEN (ge.credit ->> 'genre_1')::character varying(50) ELSE ge.genre_1 END)::character varying(50) AS genre_1,
  (CASE WHEN (ge.credit -> '_moved') ? 'genre_2' THEN NULL
        WHEN ge.credit ? 'genre_2' THEN (ge.credit ->> 'genre_2')::character varying(50) ELSE ge.genre_2 END)::character varying(50) AS genre_2,
  (CASE WHEN (ge.credit -> '_moved') ? 'evaluate_date' THEN NULL
        WHEN ge.credit ? 'evaluate_date' THEN (ge.credit ->> 'evaluate_date')::timestamp with time zone ELSE ge.evaluate_date END)::timestamp with time zone AS evaluate_date,
  (CASE WHEN (ge.credit -> '_moved') ? 'drive_date' THEN NULL
        WHEN ge.credit ? 'drive_date' THEN (ge.credit ->> 'drive_date')::timestamp with time zone ELSE ge.drive_date END)::timestamp with time zone AS drive_date,
  (CASE WHEN (ge.credit -> '_moved') ? 'record_assignee' THEN NULL
        WHEN ge.credit ? 'record_assignee' THEN (ge.credit ->> 'record_assignee')::character varying(100) ELSE ge.record_assignee END)::character varying(100) AS record_assignee,
  (CASE WHEN (ge.credit -> '_moved') ? 'record_assign_date' THEN NULL
        WHEN ge.credit ? 'record_assign_date' THEN (ge.credit ->> 'record_assign_date')::timestamp with time zone ELSE ge.record_assign_date END)::timestamp with time zone AS record_assign_date,
  (CASE WHEN (ge.credit -> '_moved') ? 'record_5min_assignee' THEN NULL
        WHEN ge.credit ? 'record_5min_assignee' THEN (ge.credit ->> 'record_5min_assignee')::character varying(100) ELSE ge.record_5min_assignee END)::character varying(100) AS record_5min_assignee,
  (CASE WHEN (ge.credit -> '_moved') ? 'record_5min_date' THEN NULL
        WHEN ge.credit ? 'record_5min_date' THEN (ge.credit ->> 'record_5min_date')::timestamp with time zone ELSE ge.record_5min_date END)::timestamp with time zone AS record_5min_date,
  (CASE WHEN (ge.credit -> '_moved') ? 'record_5min_drive' THEN NULL
        WHEN ge.credit ? 'record_5min_drive' THEN (ge.credit ->> 'record_5min_drive')::text ELSE ge.record_5min_drive END)::text AS record_5min_drive,
  (CASE WHEN (ge.credit -> '_moved') ? 'record_5min_drive_date' THEN NULL
        WHEN ge.credit ? 'record_5min_drive_date' THEN (ge.credit ->> 'record_5min_drive_date')::timestamp with time zone ELSE ge.record_5min_drive_date END)::timestamp with time zone AS record_5min_drive_date,
  (CASE WHEN (ge.credit -> '_moved') ? 'record_20min_assignee' THEN NULL
        WHEN ge.credit ? 'record_20min_assignee' THEN (ge.credit ->> 'record_20min_assignee')::character varying(100) ELSE ge.record_20min_assignee END)::character varying(100) AS record_20min_assignee,
  (CASE WHEN (ge.credit -> '_moved') ? 'record_20min_date' THEN NULL
        WHEN ge.credit ? 'record_20min_date' THEN (ge.credit ->> 'record_20min_date')::timestamp with time zone ELSE ge.record_20min_date END)::timestamp with time zone AS record_20min_date,
  (CASE WHEN (ge.credit -> '_moved') ? 'record_20min_drive' THEN NULL
        WHEN ge.credit ? 'record_20min_drive' THEN (ge.credit ->> 'record_20min_drive')::text ELSE ge.record_20min_drive END)::text AS record_20min_drive,
  (CASE WHEN (ge.credit -> '_moved') ? 'record_20min_drive_date' THEN NULL
        WHEN ge.credit ? 'record_20min_drive_date' THEN (ge.credit ->> 'record_20min_drive_date')::timestamp with time zone ELSE ge.record_20min_drive_date END)::timestamp with time zone AS record_20min_drive_date,
  (CASE WHEN (ge.credit -> '_moved') ? 'final_conclusion' THEN NULL
        WHEN ge.credit ? 'final_conclusion' THEN (ge.credit ->> 'final_conclusion')::character varying(50) ELSE ge.final_conclusion END)::character varying(50) AS final_conclusion,
  (CASE WHEN (ge.credit -> '_moved') ? 'batch' THEN NULL
        WHEN ge.credit ? 'batch' THEN (ge.credit ->> 'batch')::character varying(40) ELSE ge.batch END)::character varying(40) AS batch,
  (CASE WHEN (ge.credit -> '_moved') ? 'game_alike' THEN NULL
        WHEN ge.credit ? 'game_alike' THEN (ge.credit ->> 'game_alike')::jsonb ELSE ge.game_alike END)::jsonb AS game_alike,
  (CASE WHEN (ge.credit -> '_moved') ? 'final_note' THEN NULL
        WHEN ge.credit ? 'final_note' THEN (ge.credit ->> 'final_note')::text ELSE ge.final_note END)::text AS final_note,
  (CASE WHEN (ge.credit -> '_moved') ? 'record_confirmed_at' THEN NULL
        WHEN ge.credit ? 'record_confirmed_at' THEN (ge.credit ->> 'record_confirmed_at')::timestamp with time zone ELSE ge.record_confirmed_at END)::timestamp with time zone AS record_confirmed_at,
  (CASE WHEN (ge.credit -> '_moved') ? 'record_bucket' THEN NULL
        WHEN ge.credit ? 'record_bucket' THEN (ge.credit ->> 'record_bucket')::text ELSE ge.record_bucket END)::text AS record_bucket,
  (CASE WHEN (ge.credit -> '_moved') ? 'final_conclusion_date' THEN NULL
        WHEN ge.credit ? 'final_conclusion_date' THEN (ge.credit ->> 'final_conclusion_date')::timestamp with time zone ELSE ge.final_conclusion_date END)::timestamp with time zone AS final_conclusion_date,
  (CASE WHEN (ge.credit -> '_moved') ? 'updated_by' THEN NULL
        WHEN ge.credit ? 'updated_by' THEN (ge.credit ->> 'updated_by')::text ELSE ge.updated_by END)::text AS updated_by,
  (CASE WHEN (ge.credit -> '_moved') ? 'first_assigned_date' THEN NULL
        WHEN ge.credit ? 'first_assigned_date' THEN (ge.credit ->> 'first_assigned_date')::date ELSE ge.first_assigned_date END)::date AS first_assigned_date,
  (CASE WHEN (ge.credit -> '_moved') ? 'youtube_uploaded_at' THEN NULL
        WHEN ge.credit ? 'youtube_uploaded_at' THEN (ge.credit ->> 'youtube_uploaded_at')::timestamp with time zone ELSE ge.youtube_uploaded_at END)::timestamp with time zone AS youtube_uploaded_at,
  (CASE WHEN (ge.credit -> '_moved') ? 'initial_gameplay' THEN NULL
        WHEN ge.credit ? 'initial_gameplay' THEN (ge.credit ->> 'initial_gameplay')::text ELSE ge.initial_gameplay END)::text AS initial_gameplay,
  (CASE WHEN (ge.credit -> '_moved') ? 'initial_game_over' THEN NULL
        WHEN ge.credit ? 'initial_game_over' THEN (ge.credit ->> 'initial_game_over')::text ELSE ge.initial_game_over END)::text AS initial_game_over,
  (CASE WHEN (ge.credit -> '_moved') ? 'initial_level_complete' THEN NULL
        WHEN ge.credit ? 'initial_level_complete' THEN (ge.credit ->> 'initial_level_complete')::text ELSE ge.initial_level_complete END)::text AS initial_level_complete,
  (CASE WHEN (ge.credit -> '_moved') ? 'initial_self_note' THEN NULL
        WHEN ge.credit ? 'initial_self_note' THEN (ge.credit ->> 'initial_self_note')::text ELSE ge.initial_self_note END)::text AS initial_self_note,
  (CASE WHEN (ge.credit -> '_moved') ? 'record_5min_confirmed_at' THEN NULL
        WHEN ge.credit ? 'record_5min_confirmed_at' THEN (ge.credit ->> 'record_5min_confirmed_at')::timestamp with time zone ELSE ge.record_5min_confirmed_at END)::timestamp with time zone AS record_5min_confirmed_at,
  (CASE WHEN (ge.credit -> '_moved') ? 'record_20min_confirmed_at' THEN NULL
        WHEN ge.credit ? 'record_20min_confirmed_at' THEN (ge.credit ->> 'record_20min_confirmed_at')::timestamp with time zone ELSE ge.record_20min_confirmed_at END)::timestamp with time zone AS record_20min_confirmed_at,
  (CASE WHEN (ge.credit -> '_moved') ? 'youtube_5min_link' THEN NULL
        WHEN ge.credit ? 'youtube_5min_link' THEN (ge.credit ->> 'youtube_5min_link')::text ELSE ge.youtube_5min_link END)::text AS youtube_5min_link,
  (CASE WHEN (ge.credit -> '_moved') ? 'youtube_20min_link' THEN NULL
        WHEN ge.credit ? 'youtube_20min_link' THEN (ge.credit ->> 'youtube_20min_link')::text ELSE ge.youtube_20min_link END)::text AS youtube_20min_link,
  (CASE WHEN (ge.credit -> '_moved') ? 'youtube_5min_uploaded_at' THEN NULL
        WHEN ge.credit ? 'youtube_5min_uploaded_at' THEN (ge.credit ->> 'youtube_5min_uploaded_at')::timestamp with time zone ELSE ge.youtube_5min_uploaded_at END)::timestamp with time zone AS youtube_5min_uploaded_at,
  (CASE WHEN (ge.credit -> '_moved') ? 'youtube_20min_uploaded_at' THEN NULL
        WHEN ge.credit ? 'youtube_20min_uploaded_at' THEN (ge.credit ->> 'youtube_20min_uploaded_at')::timestamp with time zone ELSE ge.youtube_20min_uploaded_at END)::timestamp with time zone AS youtube_20min_uploaded_at,
  (CASE WHEN (ge.credit -> '_moved') ? 'record_5min_batch' THEN NULL
        WHEN ge.credit ? 'record_5min_batch' THEN (ge.credit ->> 'record_5min_batch')::text ELSE ge.record_5min_batch END)::text AS record_5min_batch,
  (CASE WHEN (ge.credit -> '_moved') ? 'record_20min_batch' THEN NULL
        WHEN ge.credit ? 'record_20min_batch' THEN (ge.credit ->> 'record_20min_batch')::text ELSE ge.record_20min_batch END)::text AS record_20min_batch,
  ge.pair_eval_id,
  ge.pair_back,
  ge.credit,
  true AS eval_row,
  true AS media_row
FROM game_evaluations ge
WHERE ge.credit IS NOT NULL;

COMMIT;

-- ===== Plan (spec 5): which old pairs phase 2 links, and how. Read-only. =====
-- eval_pair_phase2_classify(family_id): the plan for ONE family, 0 or 1 row. The apply step
-- calls it again per family inside its own transaction (after locking the family), so a row
-- saved between the preview and the apply is classified by what it is then.
-- eval_pair_phase2_plan(): classify over every family with exactly 2 game_info rows.
--
-- A family gets a row only when it is clean: exactly 2 game_info rows, of 2 different os,
-- neither family_unlinked, each store with at least one game_evaluations row, and no row of
-- the family linked yet (pair_eval_id / pair_back). Then:
--   G  a store has more than one row (flag multi_row), or both stores are judged with two
--      results outside D / E / F (flag unsupported_results), or a row already carries credit
--      (flag credited: a pair unlinked after an earlier phase 2 run; relinking it is a person's
--      call, and its credit must not be overwritten). front_id / back_id NULL: listed in the
--      preview, never linked. So the preview's A..F counts are what apply links.
--   C  a store carries Link_dead / Stale_release. Front = the live store. Each store keeps
--      its result: result_conclusion = the front's own, holder = the front's own holder,
--      holder_row NULL (no eval group is copied).
--   A  neither store judged. Front = release-first. holder_row = the row whose holder (+ its
--      assign dates, batch, group) both rows take: an active holder (dashboard_users.active,
--      matched on lower(name); a name with no user row counts as active) before an inactive
--      one, then (between active holders only) the fewer pending games (initial_conclusion IS
--      NULL, not a back row, same initial_evaluator, at call time, counted across ALL category
--      groups: the user's rule is "the person with fewer games", unlike Rescue's per-group
--      count), then the earlier assigned_date, then the lower id.
--      No active holder: the earlier assigned_date among the rows that have a holder, flagged
--      both_holders_inactive (2 inactive holders) or no_active_holder (1 inactive, 1 empty).
--      Both empty: holder NULL, holder_row = the front row (the back follows the front).
--   B  one store judged. Front = release-first. holder_row = the judged row (its whole eval
--      group goes to the waiting row), result = its verdict, final_from = it when it has a final.
--   D  both judged, same result. Front = the store further down the pipeline, compared in
--      order: has a final, has a record (5' or 20' assignee), has a demo link (drive_link);
--      all equal -> release-first. result = the shared one.
--   E  List_Idea vs Bypass or Playtest & Bypass: front = the List_Idea store, result List_Idea.
--   F  Bypass vs Playtest & Bypass: front = the Playtest & Bypass store, result Playtest & Bypass.
--   D/E/F: holder_row = the front (its eval group goes to the back row); final_from = the front
--      when it has a final, else NULL (flag final_only_on_back when only the back has one).
-- Release-first: the earlier COALESCE(initial_release, temp_release)::date when both stores
-- have one and they differ; else the earlier first_assigned_date when both have one and they
-- differ; else the lower id.
-- Flags (text[], in this order): multi_row, unsupported_results, credited, two_demo_codes,
-- two_record_codes (both game_info rows carry a code), final_conflict (two different finals),
-- final_only_on_back, media_conflict (a link column, drive / record drive / YouTube, set on
-- both rows with different values), group_differs (category_group), both_holders_inactive,
-- no_active_holder.
-- LANGUAGE sql, single SELECT, STABLE, not STRICT: the planner inlines classify into plan's
-- LATERAL join.
BEGIN;

CREATE OR REPLACE FUNCTION eval_pair_phase2_classify(p_family_id text)
RETURNS TABLE(family_id text, grp text, front_id integer, back_id integer, result_conclusion text,
              holder text, holder_row integer, final_from integer, flags text[])
LANGUAGE sql STABLE AS $$
  WITH gi AS (
    SELECT g.game_id, g.os, COALESCE(g.family_unlinked, false) AS unlinked,
           NULLIF(g.demo_code, '') AS demo_code, NULLIF(g.record_code, '') AS record_code,
           COALESCE(g.initial_release, g.temp_release)::date AS rel
      FROM game_info g
     WHERE g.family_id = p_family_id
  ),
  ev AS (
    SELECT e.id, e.game_id, e.category_group, gi.rel, gi.demo_code, gi.record_code,
           NULLIF(e.initial_evaluator, '') AS h, e.assigned_date, e.first_assigned_date,
           NULLIF(e.initial_conclusion, '') AS c, NULLIF(e.final_conclusion, '') AS fin,
           -- further down the pipeline: final, then record (5' / 20'), then demo link
           CASE WHEN NULLIF(e.final_conclusion, '') IS NOT NULL THEN 4 ELSE 0 END
           + CASE WHEN COALESCE(NULLIF(e.record_5min_assignee, ''), NULLIF(e.record_20min_assignee, '')) IS NOT NULL
                  THEN 2 ELSE 0 END
           + CASE WHEN NULLIF(e.drive_link, '') IS NOT NULL THEN 1 ELSE 0 END AS reach,
           ARRAY[NULLIF(e.drive_link, ''), NULLIF(e.record_5min_drive, ''), NULLIF(e.record_20min_drive, ''),
                 NULLIF(e.youtube_link, ''), NULLIF(e.youtube_5min_link, ''), NULLIF(e.youtube_20min_link, '')] AS links,
           (e.pair_eval_id IS NOT NULL OR e.pair_back) AS linked,
           (e.credit IS NOT NULL) AS credited,
           count(gi.rel) OVER () AS n_rel,
           count(e.first_assigned_date) OVER () AS n_fad
      FROM gi JOIN game_evaluations e ON e.game_id = gi.game_id
  ),
  fam AS (
    SELECT r.n_ev, r.credited, r.res_grp, CASE WHEN r.credited THEN 'G' ELSE r.res_grp END AS grp
      FROM (
    SELECT s.n_ev, s.credited,
           CASE WHEN s.n_ev > 2 THEN 'G'
                WHEN s.n_store_only > 0 THEN 'C'
                WHEN s.n_judged = 0 THEN 'A'
                WHEN s.n_judged = 1 THEN 'B'
                WHEN s.n_results = 1 THEN 'D'
                WHEN s.has_li AND (s.has_bp OR s.has_pb) THEN 'E'
                WHEN s.has_bp AND s.has_pb THEN 'F'
                ELSE 'G' END AS res_grp
      FROM (SELECT count(*) AS n_ev, count(DISTINCT ev.game_id) AS n_games,
                   COALESCE(bool_or(ev.linked), false) AS any_linked,
                   COALESCE(bool_or(ev.credited), false) AS credited,
                   count(ev.c) AS n_judged,
                   count(*) FILTER (WHERE eval_store_specific(ev.c)) AS n_store_only,
                   count(DISTINCT ev.c) AS n_results,
                   COALESCE(bool_or(ev.c = 'List_Idea'), false) AS has_li,
                   COALESCE(bool_or(ev.c = 'Bypass'), false) AS has_bp,
                   COALESCE(bool_or(ev.c = 'Playtest & Bypass'), false) AS has_pb
              FROM ev) s
     WHERE s.n_games = 2 AND NOT s.any_linked
       AND (SELECT count(*) = 2 AND count(DISTINCT gi.os) = 2 AND NOT bool_or(gi.unlinked) FROM gi)
      ) r
  ),
  ranked AS (
    SELECT ev.*, f.grp, f.n_ev,
           (ev.h IS NOT NULL AND act.active) AS h_active,
           row_number() OVER (ORDER BY
             CASE f.grp WHEN 'C' THEN eval_store_specific(ev.c)::int
                        WHEN 'D' THEN -ev.reach
                        WHEN 'E' THEN (ev.c IS DISTINCT FROM 'List_Idea')::int
                        WHEN 'F' THEN (ev.c IS DISTINCT FROM 'Playtest & Bypass')::int
                        ELSE 0 END,
             CASE WHEN ev.n_rel = 2 THEN ev.rel END,
             CASE WHEN ev.n_fad = 2 THEN ev.first_assigned_date END,
             ev.id) AS pos,
           -- the backlog compares active holders only: with no active holder, assigned_date decides
           row_number() OVER (ORDER BY (ev.h IS NOT NULL AND act.active) DESC, (ev.h IS NOT NULL) DESC,
                              CASE WHEN ev.h IS NOT NULL AND act.active THEN pend.n END NULLS LAST,
                              ev.assigned_date NULLS LAST, ev.id) AS hpos
      FROM ev CROSS JOIN fam f
      LEFT JOIN LATERAL (SELECT COALESCE(bool_or(du.active), true) AS active
                           FROM dashboard_users du WHERE lower(du.name) = lower(ev.h)) act ON true
      LEFT JOIN LATERAL (SELECT count(*) AS n FROM game_evaluations x
                          WHERE f.grp = 'A' AND x.initial_evaluator = ev.h
                            AND x.initial_conclusion IS NULL AND NOT x.pair_back) pend ON true
  )
  SELECT p_family_id,
         f.grp,
         CASE WHEN f.grp <> 'G' THEN fr.id END,
         CASE WHEN f.grp <> 'G' THEN bk.id END,
         (CASE f.grp WHEN 'B' THEN COALESCE(fr.c, bk.c)
                     WHEN 'C' THEN fr.c
                     WHEN 'D' THEN fr.c
                     WHEN 'E' THEN 'List_Idea'
                     WHEN 'F' THEN 'Playtest & Bypass' END)::text,
         (CASE f.grp WHEN 'A' THEN hr.h
                     WHEN 'B' THEN CASE WHEN fr.c IS NOT NULL THEN fr.h ELSE bk.h END
                     WHEN 'G' THEN NULL
                     ELSE fr.h END)::text,
         CASE f.grp WHEN 'A' THEN CASE WHEN hr.h IS NULL THEN fr.id ELSE hr.id END
                    WHEN 'B' THEN CASE WHEN fr.c IS NOT NULL THEN fr.id ELSE bk.id END
                    WHEN 'D' THEN fr.id
                    WHEN 'E' THEN fr.id
                    WHEN 'F' THEN fr.id END,
         CASE WHEN f.grp = 'B' AND fr.c IS NOT NULL AND fr.fin IS NOT NULL THEN fr.id
              WHEN f.grp = 'B' AND bk.c IS NOT NULL AND bk.fin IS NOT NULL THEN bk.id
              WHEN f.grp IN ('D', 'E', 'F') AND fr.fin IS NOT NULL THEN fr.id END,
         CASE WHEN f.n_ev > 2 THEN ARRAY['multi_row']::text[]
              ELSE array_remove(ARRAY[
                CASE WHEN f.res_grp = 'G' THEN 'unsupported_results' END,
                CASE WHEN f.credited THEN 'credited' END,
                CASE WHEN fr.demo_code IS NOT NULL AND bk.demo_code IS NOT NULL THEN 'two_demo_codes' END,
                CASE WHEN fr.record_code IS NOT NULL AND bk.record_code IS NOT NULL THEN 'two_record_codes' END,
                CASE WHEN fr.fin <> bk.fin THEN 'final_conflict' END,
                CASE WHEN f.grp IN ('D', 'E', 'F') AND fr.fin IS NULL AND bk.fin IS NOT NULL THEN 'final_only_on_back' END,
                CASE WHEN EXISTS (SELECT 1 FROM unnest(fr.links, bk.links) AS m(x, y) WHERE m.x <> m.y)
                     THEN 'media_conflict' END,
                CASE WHEN fr.category_group <> bk.category_group THEN 'group_differs' END,
                CASE WHEN f.grp = 'A' AND fr.h IS NOT NULL AND bk.h IS NOT NULL
                          AND NOT fr.h_active AND NOT bk.h_active THEN 'both_holders_inactive' END,
                CASE WHEN f.grp = 'A' AND (fr.h IS NULL) <> (bk.h IS NULL)
                          AND NOT fr.h_active AND NOT bk.h_active THEN 'no_active_holder' END
              ]::text[], NULL) END
    FROM fam f
    JOIN ranked fr ON fr.pos = 1
    JOIN ranked bk ON bk.pos = 2
    JOIN ranked hr ON hr.hpos = 1
$$;

CREATE OR REPLACE FUNCTION eval_pair_phase2_plan()
RETURNS TABLE(family_id text, grp text, front_id integer, back_id integer, result_conclusion text,
              holder text, holder_row integer, final_from integer, flags text[])
LANGUAGE sql STABLE AS $$
  SELECT c.*
    FROM (SELECT g.family_id FROM game_info g
           WHERE g.family_id IS NOT NULL
           GROUP BY g.family_id HAVING count(*) = 2) f
   CROSS JOIN LATERAL eval_pair_phase2_classify(f.family_id) c
   ORDER BY c.grp, c.family_id
$$;

COMMIT;

-- ===== Apply (spec 5, 6.1, 6.2, 6.3): link the old pairs, a batch at a time =====
-- eval_pair_phase2_apply(p_run_id, p_max_pairs DEFAULT 500) RETURNS TABLE(grp, linked, flagged)
-- Links at most p_max_pairs families per call, in family_id order, all in the caller's
-- transaction. First it checks that game_evaluations_touch_updated() honors
-- eval_pairs.keep_updated_at (an error otherwise: 054 re-run after 055 puts back one that does
-- not). Candidates: families with exactly 2 game_info rows of 2 os, neither family_unlinked,
-- both games with an evaluation row, no row linked yet (pair_eval_id / pair_back) and no row
-- with credit (classify makes those G, flag credited). Per family:
--   1. pg_advisory_xact_lock(54, hashtext(family_id)) (the lock 054's insert trigger takes),
--      the family's game_info rows FOR SHARE (a Signal Sense family change waits for the
--      batch's commit), then the family's evaluation rows FOR UPDATE in id order;
--   2. eval_pair_phase2_classify(family_id) AFTER the locks: a row saved since the preview is
--      classified by what it is now; nothing (no longer clean), or group G, -> skipped;
--   3. the copies, every one while the two rows are still unlinked, so trg_eval_pair_sync
--      (WHEN pair_eval_id is set and unchanged) never runs a copy of its own:
--        A  holder_row's initial_evaluator, assigned_date, first_assigned_date, batch,
--           category_group onto the other row; the rest of the eval group: the holder row
--           fills its empty columns from the other, then the other takes the holder's
--        B  the judged row's whole eval_pair_eval_cols() onto the waiting row
--        A/B with the front as the receiving row: the front's record_5min_batch /
--           record_20min_batch are put back after that copy (a moved Record bucket re-sets
--           them), so the media step decides them from the front's own
--        C  no eval column (each store keeps its result, holder and group)
--        D/E/F  the front row's eval group is never touched (its final stays; E/F: it holds the
--           pair's result by construction, checked: an error otherwise); the back row gets
--           credit = to_jsonb(back row before the run, every column) + '_moved' (the media
--           columns whose value moved from the back onto the empty front), then takes the
--           front's eval_pair_eval_cols()
--        every group, media: the front fills its empty media columns from the back, then the
--           back takes the front's media (both set and different: the front's wins; the back's
--           stays in the snapshot and, in D/E/F, in credit)
--   4. the link: pair_eval_id both ways and pair_back = (row is the plan's back row) in ONE
--      UPDATE (eval_pair_refresh_back would pick the lower id for a fresh link);
--   5. one eval_pair_merge_snapshots row per row: row_before = the row before step 3,
--      written = {column: value the run set} for every column whose value changed (updated_at
--      never; pair_eval_id and pair_back always; credit when set);
--   6. one evaluation_log row per pair, on the row whose shared columns (eval_pair_eval_cols()
--      + eval_pair_media_cols()) changed; both changed -> the one whose holder changed; neither,
--      or both holders changed -> the back row. kind 'pair_merge' when that row's shared
--      columns changed, else 'pair_link' (on the back row); actor 'System', source 'other', pair_scope 'store', CONTEXT = p_run_id
--      (the rollback finds a run's log rows by it), owner / owner_after, conclusion, final and
--      batch before / after, changed = initial_conclusion changed.
-- updated_at: the function runs with eval_pairs.keep_updated_at = 'on' (its SET clause, so the
-- setting ends with the call), and game_evaluations_touch_updated() leaves updated_at alone
-- while it is on: no row's updated_at changes (spec 5).
-- Returns one row per group with at least one linked pair: linked, and flagged = how many of
-- those carry a plan flag. Nothing left: no rows, nothing written. The same run_id may be used
-- for several calls (one rollback undoes them all); an empty run_id is an error.
-- An error (e.g. the E/F check) fails the whole call: nothing of the batch is kept.
BEGIN;

-- 054's body behind one new first check. ROLLBACK above puts 054's back verbatim.
CREATE OR REPLACE FUNCTION game_evaluations_touch_updated() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- eval_pair_phase2_apply (055) links old pairs: not an edit
  IF current_setting('eval_pairs.keep_updated_at', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF (NEW.pair_eval_id IS DISTINCT FROM OLD.pair_eval_id OR NEW.pair_back IS DISTINCT FROM OLD.pair_back)
     AND to_jsonb(NEW) - ARRAY['pair_eval_id', 'pair_back', 'updated_at']
       = to_jsonb(OLD) - ARRAY['pair_eval_id', 'pair_back', 'updated_at'] THEN
    RETURN NEW;
  END IF;
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION eval_pair_phase2_apply(p_run_id text, p_max_pairs integer DEFAULT 500)
RETURNS TABLE(grp text, linked integer, flagged integer)
LANGUAGE plpgsql
SET eval_pairs.keep_updated_at = 'on'
AS $$
DECLARE
  media  text[] := eval_pair_media_cols();
  evals  text[] := eval_pair_eval_cols();
  hold   text[] := ARRAY['initial_evaluator', 'assigned_date', 'first_assigned_date', 'batch', 'category_group'];
  rest   text[];
  fam    text;
  p      record;
  f0 game_evaluations; k0 game_evaluations; src game_evaluations; f1 game_evaluations;
  fz game_evaluations; kz game_evaluations; lb game_evaluations; la game_evaluations;
  jf0 jsonb; jk0 jsonb; jf1 jsonb; jfz jsonb; jkz jsonb; moved jsonb;
  other  integer;
  f_chg boolean; k_chg boolean; log_front boolean;
  n_done integer := 0;
  counts jsonb := '{}';
BEGIN
  IF COALESCE(p_run_id, '') = '' THEN
    RAISE EXCEPTION '055: eval_pair_phase2_apply needs a run_id';
  END IF;
  -- 054 re-run after 055 puts back a touch function that ignores the setting: every row
  -- apply writes would get a new updated_at
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid
                  WHERE t.tgrelid = 'game_evaluations'::regclass AND t.tgname = 'trg_game_evaluations_updated'
                    AND f.proname = 'game_evaluations_touch_updated'
                    AND position('eval_pairs.keep_updated_at' IN f.prosrc) > 0) THEN
    RAISE EXCEPTION '055: game_evaluations_touch_updated() ignores eval_pairs.keep_updated_at (054 re-run after 055?): re-run 055 before apply';
  END IF;
  IF COALESCE(p_max_pairs, 0) <= 0 THEN RETURN; END IF;
  SELECT array_agg(c ORDER BY o) INTO rest FROM unnest(evals) WITH ORDINALITY u(c, o) WHERE c <> ALL (hold);

  FOR fam IN
    SELECT g.family_id
      FROM game_info g JOIN game_evaluations e ON e.game_id = g.game_id
     WHERE g.family_id IS NOT NULL
     GROUP BY g.family_id
    HAVING count(DISTINCT g.game_id) = 2 AND count(DISTINCT g.os) = 2
       AND NOT bool_or(COALESCE(g.family_unlinked, false))
       AND NOT bool_or(e.pair_eval_id IS NOT NULL OR e.pair_back OR e.credit IS NOT NULL)
       AND (SELECT count(*) FROM game_info x WHERE x.family_id = g.family_id) = 2
     ORDER BY g.family_id
  LOOP
    EXIT WHEN n_done >= p_max_pairs;
    PERFORM pg_advisory_xact_lock(54, hashtext(fam));
    -- the family's games: a Signal Sense family change waits for this batch's commit
    PERFORM 1 FROM game_info WHERE family_id = fam ORDER BY game_id FOR SHARE;
    PERFORM 1 FROM game_evaluations e JOIN game_info g ON g.game_id = e.game_id
      WHERE g.family_id = fam ORDER BY e.id FOR UPDATE OF e;
    SELECT * INTO p FROM eval_pair_phase2_classify(fam);
    -- G includes a family with credit (flag credited): credit is never overwritten
    CONTINUE WHEN NOT FOUND OR p.grp = 'G' OR p.front_id IS NULL OR p.back_id IS NULL;

    SELECT * INTO f0 FROM game_evaluations WHERE id = p.front_id;
    SELECT * INTO k0 FROM game_evaluations WHERE id = p.back_id;
    jf0 := to_jsonb(f0);
    jk0 := to_jsonb(k0);
    IF p.grp IN ('E', 'F') AND f0.initial_conclusion IS DISTINCT FROM p.result_conclusion THEN
      RAISE EXCEPTION '055: family % (group %): front row % holds %, not %',
        fam, p.grp, f0.id, f0.initial_conclusion, p.result_conclusion;
    END IF;

    -- the eval group (rows unlinked: no copy trigger)
    IF p.grp IN ('A', 'B') THEN
      SELECT * INTO src FROM game_evaluations WHERE id = p.holder_row;
      other := CASE WHEN p.holder_row = p.front_id THEN p.back_id ELSE p.front_id END;
      PERFORM eval_pair_copy(other, src, CASE p.grp WHEN 'A' THEN hold ELSE evals END);
      IF p.grp = 'A' THEN
        -- the rest of A's eval group: the holder row's wins; it fills what it lacks from the other
        PERFORM eval_pair_fill(p.holder_row, other, rest);
        SELECT * INTO src FROM game_evaluations WHERE id = p.holder_row;
        PERFORM eval_pair_copy(other, src, rest);
      END IF;
      IF other = p.front_id THEN
        -- a copy that moves the front's Record bucket (B: final_conclusion) re-sets its record
        -- batches (eval_pair_copy, 051's record_slots): put the front's own back; the media
        -- step below decides them, as for every front
        UPDATE game_evaluations
           SET record_5min_batch = f0.record_5min_batch, record_20min_batch = f0.record_20min_batch
         WHERE id = p.front_id
           AND (record_5min_batch IS DISTINCT FROM f0.record_5min_batch
                OR record_20min_batch IS DISTINCT FROM f0.record_20min_batch);
      END IF;
    END IF;
    -- media: the front fills what it lacks from the back
    PERFORM eval_pair_fill(p.front_id, p.back_id, media);
    SELECT * INTO f1 FROM game_evaluations WHERE id = p.front_id;
    jf1 := to_jsonb(f1);

    IF p.grp IN ('D', 'E', 'F') THEN
      SELECT COALESCE(jsonb_agg(c ORDER BY o), '[]') INTO moved
        FROM unnest(media) WITH ORDINALITY u(c, o)
       WHERE COALESCE(jf0 ->> c, '') IN ('', '[]') AND COALESCE(jf1 ->> c, '') NOT IN ('', '[]')
         AND jf1 -> c = jk0 -> c;
      UPDATE game_evaluations SET credit = jk0 || jsonb_build_object('_moved', moved) WHERE id = p.back_id;
    END IF;
    -- the back row takes the front's shared columns
    PERFORM eval_pair_copy(p.back_id, f1, CASE WHEN p.grp IN ('D', 'E', 'F') THEN evals || media ELSE media END);

    -- the link, front row as planned
    UPDATE game_evaluations
       SET pair_eval_id = CASE WHEN id = p.front_id THEN p.back_id ELSE p.front_id END,
           pair_back    = (id = p.back_id)
     WHERE id IN (p.front_id, p.back_id);

    SELECT * INTO fz FROM game_evaluations WHERE id = p.front_id;
    SELECT * INTO kz FROM game_evaluations WHERE id = p.back_id;
    jfz := to_jsonb(fz);
    jkz := to_jsonb(kz);
    INSERT INTO eval_pair_merge_snapshots (run_id, game_evaluation_id, family_id, pair_group, row_before, written)
    SELECT p_run_id, r.id, fam, p.grp, r.before,
           (SELECT COALESCE(jsonb_object_agg(a.key, a.value), '{}') FROM jsonb_each(r.after) a
             WHERE a.key <> 'updated_at'
               AND (a.key IN ('pair_eval_id', 'pair_back') OR a.value IS DISTINCT FROM r.before -> a.key))
      FROM (VALUES (f0.id, jf0, jfz), (k0.id, jk0, jkz)) r(id, before, after);

    -- the log row goes on the row whose shared values changed; both changed -> the one whose
    -- holder changed; otherwise (neither, or both holders changed) the back row
    f_chg := EXISTS (SELECT 1 FROM unnest(evals || media) c WHERE jf0 -> c IS DISTINCT FROM jfz -> c);
    k_chg := EXISTS (SELECT 1 FROM unnest(evals || media) c WHERE jk0 -> c IS DISTINCT FROM jkz -> c);
    log_front := f_chg AND (NOT k_chg OR (f0.initial_evaluator IS DISTINCT FROM fz.initial_evaluator
                                          AND k0.initial_evaluator IS NOT DISTINCT FROM kz.initial_evaluator));
    IF log_front THEN lb := f0; la := fz; ELSE lb := k0; la := kz; END IF;
    INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, owner, owner_after, source, context, kind,
      conclusion_before, conclusion_after, final_before, final_after, batch_before, batch_after,
      changed, pair_scope)
    VALUES (lb.id, lb.game_id, 'System', lb.initial_evaluator, la.initial_evaluator, 'other', p_run_id,
      CASE WHEN log_front OR k_chg THEN 'pair_merge' ELSE 'pair_link' END,
      lb.initial_conclusion, la.initial_conclusion, lb.final_conclusion, la.final_conclusion, lb.batch, la.batch,
      lb.initial_conclusion IS DISTINCT FROM la.initial_conclusion, 'store');

    n_done := n_done + 1;
    counts := jsonb_set(counts, ARRAY[p.grp], jsonb_build_array(
      COALESCE((counts -> p.grp ->> 0)::int, 0) + 1,
      COALESCE((counts -> p.grp ->> 1)::int, 0) + (COALESCE(cardinality(p.flags), 0) > 0)::int));
  END LOOP;

  RETURN QUERY SELECT c.key, (c.value ->> 0)::int, (c.value ->> 1)::int FROM jsonb_each(counts) c ORDER BY c.key;
END;
$$;

COMMIT;
