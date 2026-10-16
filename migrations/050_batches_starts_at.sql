-- Migration 050: batches.starts_at (a start TIME, not just a start day)
--
-- 049 stored the day a batch starts. Batches really change in the middle of a day: the day
-- the old one is closed, games judged before the switch belong to it and games judged after
-- belong to the new one. A date cannot say that, so the Report gets a TIMESTAMPTZ and
-- compares evaluate_date to it exactly. Times are entered and shown in Asia/Ho_Chi_Minh.
--
-- BACKFILL: the times below are ESTIMATES read off the labels the games carried that day. List_Idea
-- games are stamped with the current batch when judged, so on the closing day the label
-- flips from the old batch to the new one; each time is the midpoint of the gap between the
-- last old-labelled and the first new-labelled game around the best cut (a game is
-- misplaced in 0-24% of the cases depending on the boundary). Exception: W3 Oct is
-- not an estimate - the manager set it on 2026-10-13 17:09 (app_config.updated_at), which
-- lies between the last panel save on W2 Oct (16:40) and the first on W3 Oct (20:08).
-- W2 Jul has no predecessor, so it starts at the beginning of 07/07.
--
-- 049's starts_on stays (kept in step with starts_at, the VN date of it) so a build that
-- still reads it keeps working; nothing new reads it.
--
-- ORDER: additive. Apply BEFORE the build that reads starts_at.
-- Idempotent: only rows without a starts_at are filled.
--
-- ROLLBACK:
--   BEGIN;
--   DROP INDEX IF EXISTS batches_starts_at_key;
--   UPDATE batches b SET starts_on = v.d FROM (VALUES
--     ('W2 Jul, 2026', DATE '2026-07-07'), ('W3 Jul, 2026', DATE '2026-07-13'),
--     ('W4 Jul, 2026', DATE '2026-07-21'), ('W1 Aug, 2026', DATE '2026-07-28'),
--     ('W2 Aug, 2026', DATE '2026-08-07'), ('W3 Aug, 2026', DATE '2026-08-13'),
--     ('W4 Aug, 2026', DATE '2026-08-21'), ('W1 Sep, 2026', DATE '2026-08-27'),
--     ('W2 Sep, 2026', DATE '2026-09-08'), ('W3 Sep, 2026', DATE '2026-09-14'),
--     ('W4 Sep, 2026', DATE '2026-09-21'), ('W1 Oct, 2026', DATE '2026-09-28'),
--     ('W2 Oct, 2026', DATE '2026-10-06'), ('W3 Oct, 2026', DATE '2026-10-14')
--   ) AS v(label, d) WHERE b.label = v.label;
--   CREATE UNIQUE INDEX IF NOT EXISTS batches_starts_on_key ON batches (starts_on);
--   ALTER TABLE batches DROP COLUMN starts_at;
--   COMMIT;
-- then redeploy the build before this change (git revert of the starts_at commit).

BEGIN;

ALTER TABLE batches ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;

UPDATE batches b
SET starts_at = v.at AT TIME ZONE 'Asia/Ho_Chi_Minh',
    starts_on = v.at::date,
    updated_at = NOW()
FROM (VALUES
  ('W2 Jul, 2026', TIMESTAMP '2026-07-07 00:00'),
  ('W3 Jul, 2026', TIMESTAMP '2026-07-13 10:43'),
  ('W4 Jul, 2026', TIMESTAMP '2026-07-20 11:45'),
  ('W1 Aug, 2026', TIMESTAMP '2026-07-27 17:40'),
  ('W2 Aug, 2026', TIMESTAMP '2026-08-06 14:12'),
  ('W3 Aug, 2026', TIMESTAMP '2026-08-13 03:11'),
  ('W4 Aug, 2026', TIMESTAMP '2026-08-20 15:07'),
  ('W1 Sep, 2026', TIMESTAMP '2026-08-27 10:17'),
  ('W2 Sep, 2026', TIMESTAMP '2026-09-07 11:17'),
  ('W3 Sep, 2026', TIMESTAMP '2026-09-14 09:17'),
  ('W4 Sep, 2026', TIMESTAMP '2026-09-21 05:14'),
  ('W1 Oct, 2026', TIMESTAMP '2026-09-28 09:54'),
  ('W2 Oct, 2026', TIMESTAMP '2026-10-06 11:28'),
  ('W3 Oct, 2026', TIMESTAMP '2026-10-13 17:09')
) AS v(label, at)
WHERE b.label = v.label AND b.starts_at IS NULL;

-- A batch created after 049 and before this migration: keep its day, from midnight.
UPDATE batches
SET starts_at = starts_on::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
WHERE starts_at IS NULL;

ALTER TABLE batches ALTER COLUMN starts_at SET NOT NULL;

-- Two batches may now start on the same DAY (that is the point); never the same instant.
DROP INDEX IF EXISTS batches_starts_on_key;
CREATE UNIQUE INDEX IF NOT EXISTS batches_starts_at_key ON batches (starts_at);

COMMIT;
