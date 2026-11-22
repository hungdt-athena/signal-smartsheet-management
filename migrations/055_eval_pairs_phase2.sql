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
--
-- KEEP eval_stats_rows IN STEP WITH THE TABLE: it lists the columns of game_evaluations one
-- by one, in both branches (an override per column cannot be written with *). A later
-- migration that adds, renames or drops a column of game_evaluations must change this view in
-- the same migration (a new column goes at the end of the column list of BOTH branches, before
-- eval_row; CREATE OR REPLACE VIEW only appends). scripts/sql-verify/phase2-schema.sql fails until it is.
--
-- updated_at: writing credit is an ordinary UPDATE, so game_evaluations_touch_updated()
-- stamps updated_at. Whatever writes credit must keep updated_at itself (spec: phase 2 changes
-- no row's updated_at).
--
-- ORDER: after 054. Additive: the build from before ignores the column, table and view.
-- Re-running 054 after 055 puts back 054's eval_pair_refresh_back (lower id): re-run 055
-- after it. Rolling back 054 needs 055 rolled back first (the view reads pair_back).
-- Idempotent: column / table / indexes IF NOT EXISTS, function and view replaced.
--
-- ROLLBACK: run the lines below up to END ROLLBACK, without their leading "-- ", in psql
-- -- (scripts/verify-eval-pairs.sh extracts and runs them). It puts back 054's
-- -- eval_pair_refresh_back verbatim, and drops the view, the snapshot table and credit
-- -- (with them every snapshot and credit phase 2 wrote: undo the phase 2 runs first).
-- BEGIN;
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

-- Two transactions: the first adds the column, the table and its indexes (metadata, an
-- empty table, and a partial index built in one pass over game_evaluations: its write lock
-- is held for milliseconds), the second
-- replaces the front-row rule and creates the view.
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
