-- 009: Composite index for evaluation list queries.
-- Every list/stats/months query filters on category_group and
-- filters/sorts on assigned_date. The existing partial index
-- (idx_game_evaluations_unassigned) only covers initial_evaluator IS NULL rows.
CREATE INDEX IF NOT EXISTS idx_game_evaluations_cat_assigned
  ON game_evaluations(category_group, assigned_date DESC);
