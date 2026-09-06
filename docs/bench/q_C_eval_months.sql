-- C: /api/evaluations available_months (runs on every filter change)
SELECT DISTINCT
  EXTRACT(YEAR  FROM COALESCE(ge.evaluate_date, ge.updated_at))::int AS year,
  EXTRACT(MONTH FROM COALESCE(ge.evaluate_date, ge.updated_at))::int AS month
FROM game_evaluations ge
WHERE ge.category_group = 'puzzle'
  AND COALESCE(ge.evaluate_date, ge.updated_at) IS NOT NULL
ORDER BY year DESC, month DESC;
