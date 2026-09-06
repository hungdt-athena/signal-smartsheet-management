-- Migration 043: make ytb_uploads a live mirror of the `ytb_uploaded` sheet
--
-- Background. Migration 008 created ytb_uploads and POST /api/admin/backfill-sheets
-- loaded it once. Nothing has written to it since: measured 2026-09-06, the table
-- held 433 rows whose newest uploaded_at was 2026-06-08, while game_evaluations had
-- 200 YouTube uploads recorded AFTER that date. Reading the table as-is would have
-- reported every video from the last three months as missing.
--
-- It now has a real writer (POST /api/cron/ytb-mirror, and the self-heal path in
-- GET /api/ytb-uploads), so these columns exist to make a mirrored row usable:
--
--   row_index  the 1-based sheet row it came from. The sheet stays the source of
--              truth for writes and PATCH/DELETE address rows by position, so a
--              mirrored row without it cannot be written back.
--   synced_at  when this row was pulled. The read path compares max(synced_at)
--              against its staleness budget to decide whether to re-pull, so the
--              table can never silently rot the way it just did.

ALTER TABLE ytb_uploads
  ADD COLUMN IF NOT EXISTS row_index INTEGER,
  ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;

COMMENT ON COLUMN ytb_uploads.row_index IS
  '1-based row in sheet `ytb_uploaded` (2 = first data row). Mirror only.';
COMMENT ON COLUMN ytb_uploads.synced_at IS
  'When this row was last pulled from the sheet. NULL = pre-mirror backfill row.';

-- The read path sorts by this to find the freshest sync; the mirror replaces the
-- whole table each run so there is no per-row lookup to index.
CREATE INDEX IF NOT EXISTS idx_ytb_uploads_synced_at ON ytb_uploads(synced_at DESC);
