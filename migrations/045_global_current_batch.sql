-- Migration 045: one global current batch
--
-- The current batch used to be stored per category (app_config `current_batch:puzzle`,
-- `:arcade`, `:simulation`). The team now runs a single batch for every category, so it
-- becomes one row, `current_batch`, set once.
--
-- The new value is the NEWEST of the old per-category values by week order ("W2 Oct,
-- 2026" beats "W4 Sep, 2026"; labels are not sortable as text). The match is as tolerant as
-- lib/weekly-feedback weekLabelOrder: any case, any whitespace, surrounding whitespace
-- ignored, month by its first three letters ("Sept", "October" work), week of 1 to 3
-- digits. Rows whose month is not a month name are skipped. The value stored is the
-- trimmed label. Ties go to the smaller text, so the result never depends on row order.
--
-- Old rows are deleted ONLY when a `current_batch` row exists afterwards. A database whose
-- old values none of the above can read keeps them, and the code keeps falling back to them
-- (lib/current-batch.ts), instead of ending up with no batch at all.
--
-- Everything runs in ONE transaction: if any statement fails, nothing changes (psql -f
-- would otherwise carry on and still run the DELETE).
--
-- Order: the code may be deployed BEFORE this migration (lib/current-batch.ts falls back to
-- the old rows while no `current_batch` row exists), but apply the migration only AFTER the
-- new build is live. Until then the running code reads the per-category keys this migration
-- deletes, so evaluators would see "No active batch" and save List_Ideas with a NULL batch.
-- Idempotent: ON CONFLICT DO NOTHING keeps an already-set global value (even a cleared
-- one), and deleting already-deleted rows is a no-op.
--
-- Rollback: INSERT INTO app_config (key, value, updated_at)
--   SELECT 'current_batch:' || c, (SELECT value FROM app_config WHERE key = 'current_batch'), NOW()
--   FROM unnest(ARRAY['puzzle','arcade','simulation']) AS c
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
--   DELETE FROM app_config WHERE key = 'current_batch';

BEGIN;

WITH parsed AS (
  SELECT
    regexp_replace(value, '^[[:space:]]+|[[:space:]]+$', '', 'g') AS value,
    regexp_match(value,
      '^[[:space:]]*W([0-9]{1,3})[[:space:]]+([A-Za-z]{3,9}),[[:space:]]*([0-9]{4})[[:space:]]*$', 'i') AS m
  FROM app_config
  WHERE starts_with(key, 'current_batch:')
),
legacy AS (
  SELECT value,
    m[3]::int * 10000
    + array_position(
        ARRAY['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'],
        lower(substring(m[2] from 1 for 3))) * 100
    + m[1]::int AS ord
  FROM parsed
  WHERE m IS NOT NULL
)
INSERT INTO app_config (key, value, updated_at)
SELECT 'current_batch', value, NOW()
FROM legacy
WHERE ord IS NOT NULL
ORDER BY ord DESC, value
LIMIT 1
ON CONFLICT (key) DO NOTHING;

DELETE FROM app_config
WHERE starts_with(key, 'current_batch:')
  AND EXISTS (SELECT 1 FROM app_config WHERE key = 'current_batch');

COMMIT;
