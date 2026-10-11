-- Migration 045: one global current batch
--
-- The current batch used to be stored per category (app_config `current_batch:puzzle`,
-- `:arcade`, `:simulation`). The team now runs a single batch for every category, so it
-- becomes one row, `current_batch`, set once.
--
-- The new value is the NEWEST of the old per-category values by week order ("W2 Oct,
-- 2026" beats "W4 Sep, 2026"; labels are not sortable as text). Each old value is first
-- NORMALISED, then VALIDATED, and the label stored is the CANONICAL one:
--   1. every run of whitespace (spaces, tabs, newlines, no-break spaces) becomes one space
--      and the ends are trimmed;
--   2. the result must read, in any case, as week 1-4, a real English month (3-letter
--      abbreviation, "Sept", or the full name), a comma and a 4-digit year. Anything else
--      ("W5 Oct", "W0 Oct", "W150 Oct", "W1 Mayday", "foo", a 60-space label) is skipped;
--   3. the stored value is rebuilt as 'W<week> <Mon>, <year>' (e.g. "W2 Oct, 2026"), the
--      exact shape lib/weekly-feedback isBatchLabel accepts. It is never longer than 12
--      characters, so it always fits the batch column and every List_Idea save.
-- Ties cannot differ in text (same week order means same canonical label); the final sort
-- key is still collation-independent so the result never depends on row order.
--
-- Old rows are deleted ONLY when a `current_batch` row exists afterwards. A database none of
-- whose old values passes the check keeps them untouched (nothing is lost) and gets no global
-- row. lib/current-batch.ts applies the same check to the old rows it falls back to.
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
  SELECT regexp_match(
    btrim(regexp_replace(value, '[[:space:]\u00a0]+', ' ', 'g')),
    '^W([1-4]) (jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december), ?([0-9]{4})$',
    'i') AS m
  FROM app_config
  WHERE starts_with(key, 'current_batch:') AND value IS NOT NULL
),
legacy AS (
  SELECT
    'W' || m[1] || ' ' || initcap(lower(substring(m[2] from 1 for 3))) || ', ' || m[3] AS value,
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
ORDER BY ord DESC, value COLLATE "C"
LIMIT 1
ON CONFLICT (key) DO NOTHING;

DELETE FROM app_config
WHERE starts_with(key, 'current_batch:')
  AND EXISTS (SELECT 1 FROM app_config WHERE key = 'current_batch');

COMMIT;
