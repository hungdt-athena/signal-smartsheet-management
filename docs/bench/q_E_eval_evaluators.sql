-- E: /api/evaluations available_evaluators (full-table mode() GROUP BY lower())
SELECT mode() WITHIN GROUP (ORDER BY ge.initial_evaluator) AS e
FROM game_evaluations ge
WHERE ge.category_group='puzzle' AND ge.initial_evaluator IS NOT NULL
GROUP BY lower(ge.initial_evaluator) ORDER BY 1;
