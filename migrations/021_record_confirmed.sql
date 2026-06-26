-- 021: "confirmed" timestamp for recording assignments. NULL = draft (assigned
-- but not yet confirmed by a manager); set = recording (confirmed).
ALTER TABLE game_evaluations
  ADD COLUMN IF NOT EXISTS record_confirmed_at TIMESTAMPTZ;
