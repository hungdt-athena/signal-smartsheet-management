-- 023: timestamp for when a game's final conclusion was decided. Stamped NOW()
-- on each final_conclusion write (see PATCH /api/evaluations). Existing decided
-- rows are backfilled to a fixed 2026-06-26 (the day they were bulk-decided);
-- the UPDATE is idempotent so it can be re-run to correct earlier backfills.
ALTER TABLE game_evaluations
  ADD COLUMN IF NOT EXISTS final_conclusion_date TIMESTAMPTZ;

UPDATE game_evaluations
  SET final_conclusion_date = '2026-06-26 12:00:00+07',
      final_evaluator = 'VinhTD'
  WHERE final_conclusion IS NOT NULL;
