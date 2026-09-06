-- A: Report per-evaluator aggregate over the month window (SARGABLE form, as shipped)
SELECT lower(ge.initial_evaluator) k, count(*)
FROM game_evaluations ge
WHERE ge.evaluate_date IS NOT NULL
  AND ge.initial_evaluator IS NOT NULL AND ge.initial_evaluator <> ''
  AND ge.evaluate_date >= ('2026-08-01'::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
  AND ge.evaluate_date <  ('2026-09-01'::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
GROUP BY 1;
