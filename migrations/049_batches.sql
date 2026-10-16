-- Migration 049: batches (an explicit start date per batch)
--
-- Until now the Performance tab INFERRED the days a batch covers from the games that carry
-- its label (min(evaluate_date)). That broke once managers started moving games between
-- batches in bulk: one game judged on 07/09 and later moved to "W1 Oct" pulled that batch's
-- start back three weeks, and "W4 Sep" swallowed W1 and W2 Oct.
--
-- A batch is now a row here: its label and the day it starts. It ends the day the next one
-- starts (lib/report-batches.ts), so consecutive batches tile the calendar. The day a batch
-- is closed belongs to the OLD batch; the new batch starts the next day. Starts are not
-- Mondays.
--
-- game_evaluations.batch is NOT touched. A game that carries a label belongs to that batch
-- in the Report whatever day it was judged; only unlabeled games are placed by these dates.
--
-- BACKFILL: the dates below were read off the daily volume of each label (first day with a
-- sustained run of games, plus one when that day is also the previous batch's last busy
-- day) and confirmed by the team. W1 Sep = 27/08 and W2 Oct = 06/10 were chosen by hand.
-- Labels older than W2 Jul 2026 are not listed: they are not in chronological order
-- (leftovers of the Sheet -> Postgres migration) and keep resolving by label.
--
-- ORDER: additive. Apply it BEFORE the build that reads it; the old build ignores the table.
-- Idempotent: CREATE ... IF NOT EXISTS and ON CONFLICT DO NOTHING (re-running never moves a
-- start date somebody has edited since).
--
-- ROLLBACK (the table is new, nothing else depends on it):
--   DROP TABLE IF EXISTS batches;
-- then redeploy the previous build (git revert of the batch-start-dates commits, base
-- 8988ae1). State before this migration is saved in scratchpad/rollback-batches/
-- pre-049-snapshot.json (current_batch row, derived spans, label counts).

BEGIN;

CREATE TABLE IF NOT EXISTS batches (
  label      VARCHAR(40) PRIMARY KEY,
  starts_on  DATE        NOT NULL,
  set_by     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One batch per start day: two starting the same day would give one of them an empty window.
CREATE UNIQUE INDEX IF NOT EXISTS batches_starts_on_key ON batches (starts_on);

INSERT INTO batches (label, starts_on, set_by) VALUES
  ('W2 Jul, 2026', DATE '2026-07-07', 'migration-049'),
  ('W3 Jul, 2026', DATE '2026-07-13', 'migration-049'),
  ('W4 Jul, 2026', DATE '2026-07-21', 'migration-049'),
  ('W1 Aug, 2026', DATE '2026-07-28', 'migration-049'),
  ('W2 Aug, 2026', DATE '2026-08-07', 'migration-049'),
  ('W3 Aug, 2026', DATE '2026-08-13', 'migration-049'),
  ('W4 Aug, 2026', DATE '2026-08-21', 'migration-049'),
  ('W1 Sep, 2026', DATE '2026-08-27', 'migration-049'),
  ('W2 Sep, 2026', DATE '2026-09-08', 'migration-049'),
  ('W3 Sep, 2026', DATE '2026-09-14', 'migration-049'),
  ('W4 Sep, 2026', DATE '2026-09-21', 'migration-049'),
  ('W1 Oct, 2026', DATE '2026-09-28', 'migration-049'),
  ('W2 Oct, 2026', DATE '2026-10-06', 'migration-049'),
  ('W3 Oct, 2026', DATE '2026-10-14', 'migration-049')
ON CONFLICT (label) DO NOTHING;

COMMIT;
