-- Migration 010: Normalize evaluator name casing in game_evaluations
-- Imported sheet data has casing drift (Huydd vs HuyDD, Quangnm vs QuangNM),
-- which duplicates entries in filters and breaks exact-match comparisons.
--
-- Pass 1: prefer the canonical casing from dashboard_users.
-- Pass 2: for names not in dashboard_users, collapse each case-insensitive
--         group to its most frequent variant.

DO $$
DECLARE
  col TEXT;
BEGIN
  FOREACH col IN ARRAY ARRAY[
    'initial_evaluator', 'final_evaluator',
    'record_assignee', 'record_5min_assignee', 'record_20min_assignee'
  ] LOOP
    -- Pass 1: dashboard_users casing wins
    EXECUTE format($f$
      UPDATE game_evaluations ge
      SET %1$I = du.name
      FROM dashboard_users du
      WHERE lower(ge.%1$I) = lower(du.name)
        AND ge.%1$I <> du.name
    $f$, col);

    -- Pass 2: most frequent variant wins for the rest
    EXECUTE format($f$
      UPDATE game_evaluations ge
      SET %1$I = canon.name
      FROM (
        SELECT lower(%1$I) AS k,
               mode() WITHIN GROUP (ORDER BY %1$I) AS name
        FROM game_evaluations
        WHERE %1$I IS NOT NULL
        GROUP BY lower(%1$I)
      ) canon
      WHERE lower(ge.%1$I) = canon.k
        AND ge.%1$I <> canon.name
    $f$, col);
  END LOOP;
END $$;
