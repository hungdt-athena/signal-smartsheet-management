-- B: Report filter-dropdown options (4x scan of the same table)
SELECT 'week' AS kind, date_trunc('week', evaluate_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS v
  FROM game_evaluations WHERE evaluate_date IS NOT NULL GROUP BY 1,2
UNION ALL
SELECT 'month', to_char(date_trunc('month', evaluate_date AT TIME ZONE 'Asia/Ho_Chi_Minh'),'YYYY-MM')
  FROM game_evaluations WHERE evaluate_date IS NOT NULL GROUP BY 1,2
UNION ALL
SELECT 'quarter', to_char(evaluate_date AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY')||'-Q'||EXTRACT(QUARTER FROM evaluate_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::int
  FROM game_evaluations WHERE evaluate_date IS NOT NULL GROUP BY 1,2
UNION ALL
SELECT 'batch', batch FROM game_evaluations WHERE batch IS NOT NULL AND batch<>'' GROUP BY 1,2;
