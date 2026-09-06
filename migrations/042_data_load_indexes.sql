-- Migration 042: indexes for the two date columns the hot list/report paths sort
-- and filter on.
--
-- game_evaluations already carried 15 indexes and not one of them could serve
-- evaluate_date -- the column Short List sorts by and Report filters by. The reason
-- both paths wrapped the column in an expression:
--   Short List: ORDER BY COALESCE(evaluate_date, updated_at)
--   Report:     WHERE (evaluate_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= …
-- A btree on evaluate_date matches neither. So index (1) matches Short List's
-- expression exactly, and index (2) works only because the Report predicates were
-- rewritten to compare the raw column against constants (same commit).
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Run these
-- statements one at a time, by hand, against prod -- do not wrap them in BEGIN.

-- (1) Short List: filters category_group, then sorts on the COALESCE expression.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ge_cat_evalcoalesce
  ON game_evaluations (category_group, (COALESCE(evaluate_date, updated_at)) DESC);

-- (2) Report: window filters on evaluate_date. Useless without the sargable rewrite.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ge_evaluate_date
  ON game_evaluations (evaluate_date) WHERE evaluate_date IS NOT NULL;

ANALYZE game_evaluations;
