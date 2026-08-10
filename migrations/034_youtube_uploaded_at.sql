-- 034: youtube_uploaded_at — when the matched video was uploaded (sheet `ytb_uploaded`.time)
--
-- Why: "Recorded" had two incompatible definitions.
--   Record tab  → a matching upload exists in the ytb sheet (video is the truth)
--   Report      → record_confirmed_at IS NOT NULL (the manual Confirm click)
-- The two columns are written by two different steps that never correct each
-- other, so the same game read Recorded on one screen and Pending on the other.
--
-- Report could not simply adopt the video definition because youtube_link has no
-- timestamp, and every Report number is windowed by date. This column gives the
-- link a date, so completion can be COALESCE(record_confirmed_at, youtube_uploaded_at)
-- everywhere and both screens finally agree.
--
-- Backfill: /api/evaluations/reconcile-recorders (mode 'apply') now stamps this
-- whenever it writes a link OR finds the column empty on an already-correct link.
-- Nothing else writes it; NULL just means the row falls back to record_confirmed_at.

ALTER TABLE game_evaluations
  ADD COLUMN IF NOT EXISTS youtube_uploaded_at timestamptz;

COMMENT ON COLUMN game_evaluations.youtube_uploaded_at IS
  'Upload time of the matched ytb_uploaded row (VN local, stored as timestamptz). Set by reconcile-recorders alongside youtube_link.';

-- Report windows recording work on COALESCE(record_confirmed_at, youtube_uploaded_at).
CREATE INDEX IF NOT EXISTS idx_game_evaluations_recorded_at
  ON game_evaluations ((COALESCE(record_confirmed_at, youtube_uploaded_at)));
