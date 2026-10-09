-- Migration 045: one global current batch
--
-- The current batch used to be stored per category (app_config `current_batch:puzzle`,
-- `:arcade`, `:simulation`). The team now runs a single batch for every category, so it
-- becomes one row, `current_batch`, set once.
--
-- The new value is the NEWEST of the old per-category values by week order ("W2 Oct,
-- 2026" beats "W4 Sep, 2026"; labels are not sortable as text). Old rows are then
-- deleted. If no old value parses as a batch label, nothing is inserted and the batch
-- stays unset until a manager sets it.
--
-- Safe to deploy the code first: lib/current-batch.ts falls back to the old rows while
-- no `current_batch` row exists. Idempotent: ON CONFLICT DO NOTHING keeps an
-- already-set global value, and the DELETE of already-deleted rows is a no-op.
--
-- Rollback: INSERT INTO app_config (key, value, updated_at)
--   SELECT 'current_batch:' || c, (SELECT value FROM app_config WHERE key = 'current_batch'), NOW()
--   FROM unnest(ARRAY['puzzle','arcade','simulation']) AS c;
--   DELETE FROM app_config WHERE key = 'current_batch';

WITH legacy AS (
  SELECT value,
    substring(value from '[0-9]{4}$')::int * 10000
    + array_position(
        ARRAY['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'],
        lower(substring(value from '^W[0-9]+ +([A-Za-z]{3})'))) * 100
    + substring(value from '^W([0-9]+)')::int AS ord
  FROM app_config
  WHERE starts_with(key, 'current_batch:')
    AND value ~ '^W[0-9]+ +[A-Za-z]+, *[0-9]{4}$'
)
INSERT INTO app_config (key, value, updated_at)
SELECT 'current_batch', value, NOW()
FROM legacy
ORDER BY ord DESC
LIMIT 1
ON CONFLICT (key) DO NOTHING;

DELETE FROM app_config WHERE starts_with(key, 'current_batch:');
