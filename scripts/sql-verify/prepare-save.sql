-- Parameter types follow postgres.js: booleans typed, everything else unknown. Casts keep
-- parameter types explicit (postgres.js sends numbers/strings untyped).
-- $1 id, $2 concProvided(bool), $3 concVal, $4 batch, $5 final_conclusion,
-- $6 actor, $7 role, $8 source, $9 context, $10 view_s, $11 hidden_s, $12 idle_s,
-- $13 initialTouched(bool), $14 finalTouched(bool)
PREPARE save(unknown, boolean, unknown, unknown, unknown, unknown, unknown, unknown, unknown,
             unknown, unknown, unknown, boolean, boolean) AS
WITH old AS (
  SELECT id, game_id, initial_conclusion, initial_evaluator, final_conclusion, evaluate_date
  FROM game_evaluations WHERE id = $1
  FOR NO KEY UPDATE
), upd AS (
  UPDATE game_evaluations ge SET
    -- every use of a reused parameter carries the same cast, or Postgres raises
    -- "inconsistent types deduced for parameter" (the route binds each use separately)
    initial_conclusion = CASE WHEN $2 THEN $3::text ELSE ge.initial_conclusion END,
    evaluate_date = CASE
      WHEN $2 AND $3::text IS NOT NULL
        AND ge.initial_conclusion IS DISTINCT FROM $3::text
        AND (   $6::text IS NULL
             OR lower(ge.initial_evaluator) = lower($6::text)
             OR ge.evaluate_date IS NULL
             OR ($3::text = 'List_Idea' AND $4::text IS NOT NULL
                 AND ge.batch IS DISTINCT FROM $4::text))
        THEN clock_timestamp()
      WHEN $2 AND $3::text IS NULL THEN NULL
      ELSE ge.evaluate_date END,
    final_conclusion = COALESCE($5::text, ge.final_conclusion),
    batch = CASE WHEN $4::text IS NULL THEN ge.batch ELSE $4::text END,
    updated_by = $6::text
  FROM old WHERE ge.id = old.id
  RETURNING ge.*
), logged AS (
  INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, actor_role, owner, source,
    context, kind, conclusion_before, conclusion_after, final_before, final_after, changed,
    view_s, hidden_s, idle_s)
  SELECT old.id, old.game_id, $6::text, $7::text, old.initial_evaluator, $8::text, $9::text,
    CASE
      WHEN NOT $13 AND $14 THEN 'final'
      WHEN NOT $13 THEN 'other'
      WHEN old.evaluate_date IS NULL AND upd.initial_conclusion IS NOT NULL
           AND upd.initial_conclusion <> 'Stale_release'
           AND old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion THEN 'first'
      WHEN old.initial_conclusion IS NOT NULL AND upd.initial_conclusion IS NULL THEN 'clear'
      ELSE 'revise' END,
    old.initial_conclusion, upd.initial_conclusion, old.final_conclusion, upd.final_conclusion,
    old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion,
    $10::int, $11::int, $12::int
  FROM old JOIN upd ON upd.id = old.id
)
SELECT id FROM upd;
