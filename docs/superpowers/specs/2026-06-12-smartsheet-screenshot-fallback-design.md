# Smartsheet Sync v2 — Cell Images, Demo Drive, Update Flow — Design

**Date:** 2026-06-12 (supersedes the earlier same-day "cell-image fallback" draft — scope expanded per user)
**Scope:** new `POST /api/admin/import-screenshots` route, modified `workflows/smartsheet-to-db-evaluations.json` (flow 1, full re-sync), new `workflows/smartsheet-db-update-sync.json` (flow 2, incremental), small `EvalDetailPanel` addition.

## Problem

Three gaps between the games Smartsheets and the DB:
1. **StoreKit cell images.** For games whose StoreKit screenshots never arrived from the store API, evaluators paste a hand-taken screenshot into the StoreKit column cell. Invisible to the app today.
2. **Drive Video column.** Holds a **demo video** link (unrelated to the 5/20-minute record videos — an earlier misunderstanding caused it to be skipped from import). Needs syncing.
3. **Ongoing edits.** The team still works on Smartsheet until the app is published, so the DB drifts. A second flow must pick up changed rows and update the DB.

## Decisions (confirmed with user)

- **Demo drive mapping:** Smartsheet `Drive Video` → existing `game_evaluations.drive_link` (it is independent of `record_5min_drive`/`record_20min_drive`; no migration needed). Shown as its own "Demo Video (Drive)" field in the detail panel.
- **Flow 1 (full re-sync):** modify the existing `smartsheet-to-db-evaluations.json` to (a) DELETE the category at the start of the run, (b) map `Drive Video` → `drive_link`, (c) also catch StoreKit cell images and deliver them to the new app endpoint. One sheet per run (OOM rule), user runs it once per sheet to rebuild the DB.
- **Flow 2 (incremental, new):** `GET /sheets/{id}?rowsModifiedSince=<now − 48h>` per sheet (all sheets in one run — modified-row payloads are small), **upsert** with `ON CONFLICT (game_id, category_group) DO UPDATE` on the sync-able fields, plus the same image catch. Scheduled daily (created inactive; user activates). Overlap-safe and stateless (fixed 48h lookback, upserts are idempotent).
- **Conflict rule:** until the app is published, **Smartsheet wins** for sync-able fields (initial_evaluator, assigned_date, evaluate_date, initial_note, initial_conclusion, genre_1/2, youtube_link, drive_link). App-only fields are never touched by sync: `final_evaluator`, `record_*`, and `manual_screenshot_urls` (hand uploads win over cell images via the endpoint's skip rule).
- Architecture unchanged from v1 draft: Smartsheet token lives only in n8n → n8n resolves temporary image URLs via `POST /2.0/imageurls`; the app endpoint downloads/uploads/persists using existing `lib/supabase-storage.ts` + `sql.json`.

## Components

### 1. `POST /api/admin/import-screenshots` (new route — unchanged from v1 draft)

Auth: `x-webhook-secret` OR admin session (same as `import-evaluations`). Body `{ items: [{ game_id, image_urls[] }] }`, ≤50 items, ≤10 URLs/game. Per game: skip when not in `game_info`, when `metadata->'screenshot_urls'` is a non-empty array, or when `manual_screenshot_urls` is non-empty; otherwise download (15s timeout, ≤5 MB, png/jpeg/webp by content-type), upload via `uploadScreenshot`, append once with `${sql.json(uploadedUrls)}`. Response: counts + `failed[]`. 503 when storage unconfigured. Both flows call this endpoint; idempotency lives here.

### 2. Flow 1 — `workflows/smartsheet-to-db-evaluations.json` (modified)

Existing graph: manual trigger → Sheet IDs (one id, swap per run) → Get Sheet (`includeAll=true`) → Build SQL (json_to_recordset insert) → Insert Rows (Postgres cred `KBZC0RGIJsc8d7GK`). Changes:
- **Build SQL** adds `drive_link: clean(row['Drive Video'])` to the record and to the INSERT column list/recordset definition, and now prefixes the statement with `DELETE FROM game_evaluations WHERE category_group = '<category>';` (single execution, category is a code-node constant — clearing per category per run as requested).
- **New image branch** off Get Sheet: Collect Cell Images (rows with `cells[StoreKit].image.id` + GameID, batches of 50) → IF non-empty → `POST /2.0/imageurls` → Build Items (join URLs by imageId, chunks of 50) → IF non-empty → `POST {APP_URL}/api/admin/import-screenshots` with `x-webhook-secret`.

### 3. Flow 2 — `workflows/smartsheet-db-update-sync.json` (new)

Schedule trigger (daily, imported inactive) + manual trigger. Config node lists ALL `{sheetId, category}` pairs (puzzle `2184120410001284` — note puzzle data spans ~6 sheets, user appends the remaining ids — arcade `3926172768358276`, simulation `7899099241074564`).

Per sheet: `GET /2.0/sheets/{id}?rowsModifiedSince={{ ISO(now − 48h) }}&includeAll=true` → returns only rows modified in the window. Then:
- **Upsert branch:** same row-flattening as flow 1 →
  ```sql
  INSERT INTO game_evaluations (game_id, category_group, initial_evaluator, assigned_date,
    evaluate_date, initial_note, initial_conclusion, genre_1, genre_2, youtube_link, drive_link)
  SELECT ... FROM json_to_recordset($jrows$...$jrows$::json) AS v(...)
  WHERE EXISTS (SELECT 1 FROM game_info gi WHERE gi.game_id = v.game_id)
  ON CONFLICT (game_id, category_group) DO UPDATE SET
    initial_evaluator = EXCLUDED.initial_evaluator,
    assigned_date     = EXCLUDED.assigned_date,
    evaluate_date     = EXCLUDED.evaluate_date,
    initial_note      = EXCLUDED.initial_note,
    initial_conclusion= EXCLUDED.initial_conclusion,
    genre_1           = EXCLUDED.genre_1,
    genre_2           = EXCLUDED.genre_2,
    youtube_link      = EXCLUDED.youtube_link,
    drive_link        = EXCLUDED.drive_link,
    updated_at        = NOW();
  ```
  (new games inserted, changed games overwritten — Smartsheet wins; app-only columns untouched)
- **Image branch:** identical to flow 1's, over the modified rows only.
- **flow_log:** one row per run (`name='smartsheet-update-sync'`, note = aggregate counts JSON) to spreadsheet `1yb558PpmunJcdDYCyVzdDpBfKDiIArMBG4IBI-eR0dg` tab `flow_log`, Google Sheets cred `UMl5XCc7aOcf9yi3`.

### 4. `EvalDetailPanel` — Demo Video field

Add a "Demo Video (Drive)" field in the Evaluation card (above the YouTube link): an URL input bound to the existing `driveLink` state (already wired into save → PATCH `drive_link`), editable under `canEditEval`, with an "Open demo video" link when set. The list table's existing Drive/Video button already displays `drive_link` — no other UI changes.

## Lifecycle

1. User runs flow 1 once per sheet → DB rebuilt (category cleared first), images backfilled.
2. Flow 2 runs daily while the team still edits Smartsheet → changed rows upserted, new images caught.
3. When the app is published and the team moves off Smartsheet, the user deactivates flow 2. `drive_link` then becomes app-editable via the new panel field; manual screenshots continue working as before.

## Error handling

- Endpoint: per-URL failures → `failed[]`; partial success persists; never deletes anything; expired Smartsheet URLs simply fail and are retried next run.
- Flow 2 lookback (48h) > schedule period (24h) → missed runs self-heal; double-processing is harmless (upserts + endpoint skip rules).
- Flow 1 DELETE+INSERT runs as one Postgres execution per sheet; a failed insert leaves the category empty but re-running the flow restores it (acceptable for a manual backfill).

## Out of scope (YAGNI)

- Row attachments (paper-clips); multi-image cells; webhook-based real-time sync; syncing DB → Smartsheet (one direction only); migrating `drive_link` semantics after publish.

## Testing

- Jest for the endpoint (mock db/storage/fetch): auth, 503, 400, three skip paths, happy path asserting raw-array `sql.json` param, download failure, bad content-type.
- Workflows: JSON validity check (`python3 json.load`), then live dry-run: flow 1 on the puzzle sheet, flow 2 manual run right after (should report ~0 changes), verify flow_log rows + spot-check one game with a pasted StoreKit image and one with a Drive Video link.
