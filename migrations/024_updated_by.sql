-- 024: track who last edited an evaluation. Stamped by PATCH /api/evaluations
-- on every content/record edit (updated_at is already maintained by a trigger).
ALTER TABLE game_evaluations
  ADD COLUMN IF NOT EXISTS updated_by TEXT;
