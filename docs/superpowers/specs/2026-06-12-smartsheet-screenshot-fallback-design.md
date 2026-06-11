# Smartsheet Cell-Image Fallback for StoreKit Screenshots — Design

**Date:** 2026-06-12
**Scope:** new `POST /api/admin/import-screenshots` route, new n8n workflow `workflows/smartsheet-storekit-images.json`

## Problem

For games whose StoreKit screenshots never arrived from the store API, evaluators paste a hand-taken screenshot directly into the **StoreKit column cell** on the games Smartsheets. Those images are invisible to the app. We want them pulled into Supabase as the game's manual screenshots so they show up in the eval detail panel — using the existing manual-screenshots pipeline (display + lazy cleanup when real StoreKit data arrives).

## Decisions (confirmed with user)

- Image source: **cell images in the StoreKit column** (the same column whose `x` text value means dead link). One Smartsheet cell holds at most one image, so a game gets at most one screenshot from this source.
- Direction: Smartsheet → DB. The DB is composed from several Smartsheets (one per category), so the sync runs **per sheet**: puzzle `2184120410001284`, arcade `3926172768358276`, simulation `7899099241074564`.
- Runs as a **one-time backfill now**, and the same pieces are reusable from the future scheduled sync (idempotent thanks to skip rules).
- **Skip rule:** a game is skipped when it already has StoreKit screenshots (`metadata->'screenshot_urls'` non-empty) **or** already has manual screenshots (`manual_screenshot_urls` non-empty — hand-uploaded images win), or doesn't exist in `game_info`.
- Architecture: **hybrid**. The Smartsheet token lives only in n8n (cred `vAGuEElrZVb7OOoI`), so n8n resolves temporary image URLs; the Next app downloads/uploads/persists, reusing `lib/supabase-storage.ts` and the `sql.json` jsonb idiom (single-encoding — the double-encode bug class is already fixed and tested).

## Components

### 1. `POST /api/admin/import-screenshots` (new route)

Auth: `x-webhook-secret` header (n8n server-to-server) OR admin session — same dual scheme as `app/api/admin/import-evaluations/route.ts`. `maxDuration = 60`.

Request body:
```json
{ "items": [ { "game_id": "...", "image_urls": ["https://...temporary..."] } ] }
```
Limits: ≤50 items per call; ≤10 URLs per game (in practice 1 — one cell image). Invalid body → 400. Storage unconfigured → 503.

Per item:
1. Normalize: drop entries without `game_id` or with empty `image_urls`; dedup by `game_id` (first wins); cap URLs at 10.
2. One batched state query:
   ```sql
   SELECT game_id,
     CASE WHEN jsonb_typeof(metadata->'screenshot_urls') = 'array'
          THEN jsonb_array_length(metadata->'screenshot_urls') ELSE 0 END > 0 AS has_storekit,
     CASE WHEN jsonb_typeof(metadata->'manual_screenshot_urls') = 'array'
          THEN jsonb_array_length(metadata->'manual_screenshot_urls') ELSE 0 END > 0 AS has_manual
   FROM game_info WHERE game_id IN (...)
   ```
3. Skip → counters (`skipped_not_found`, `skipped_has_storekit`, `skipped_has_manual`).
4. Otherwise download each URL server-side: `fetch` with a 15s `AbortSignal.timeout`, require 2xx, content-type whitelist `image/png|jpeg|webp` (parameters stripped), body ≤5 MB. Upload survivors via `uploadScreenshot(game_id, buf, ext, i)`.
5. If ≥1 image uploaded: one `jsonb_set` append UPDATE using `${sql.json(uploadedUrls)}` (NEVER `JSON.stringify(...)::jsonb`). Count as `uploaded`. If every URL failed: push `{ game_id, error }` to `failed[]`.

Response:
```json
{ "ok": true, "received": n, "uploaded": n, "skipped_has_storekit": n,
  "skipped_has_manual": n, "skipped_not_found": n, "failed": [{ "game_id": "...", "error": "..." }] }
```
n8n logs these counts to the `flow_log` Google Sheet per repo convention.

### 2. n8n workflow `workflows/smartsheet-storekit-images.json` (new)

Manual-trigger workflow, importable into n8n cloud (`autoai9.app.n8n.cloud`), following the conventions of the existing `workflows/smartsheet-to-db-evaluations.json` (credential IDs, app URL, `x-webhook-secret`, flow_log logging — the implementer must read that file and mirror its patterns).

Per category sheet (3 configured items):
1. `GET /2.0/sheets/{sheetId}/columns` → find column IDs for `GameID` and `StoreKit` by title.
2. `GET /2.0/sheets/{sheetId}?columnIds=<gameId>,<storekit>&include=objectValue` → slim row payload (simulation has ~17.5k rows; fetching only 2 columns keeps it manageable).
3. Code node: keep rows where the StoreKit cell has `image.id` and GameID is non-empty → `{ game_id, imageId }`.
4. `POST /2.0/imageurls` in batches (≤50 imageIds per call) → temporary URLs (they expire in ~30 minutes; the flow proceeds to delivery immediately).
5. Code node: build `{ items: [{ game_id, image_urls: [url] }] }` chunks of 50.
6. `POST {APP_URL}/api/admin/import-screenshots` with `x-webhook-secret` per chunk.
7. Aggregate counts → append one `flow_log` row per category (`date, name='storekit-images-<category>', status, note=counts JSON, sheet_id`).

### 3. No UI or cleanup changes

Images land in `manual_screenshot_urls`, so the existing card displays them and the existing lazy cleanup removes them when real StoreKit data arrives. Nothing else to touch.

## Error handling

- Per-URL download failures degrade to `failed[]`/partial uploads — never abort the batch.
- Expired Smartsheet URLs → download 403/410 → lands in `failed[]`; re-running the flow regenerates URLs.
- Re-runs are idempotent: once a game has manual screenshots it's skipped (`skipped_has_manual`).
- The route never deletes anything.

## Out of scope (YAGNI)

- Row attachments (paper-clip files) — user confirmed images are cell images.
- Multi-image per game from Smartsheet (cells hold one image).
- Scheduling the n8n flow (it will be invoked from the future phase-2 sync; for now manual runs).
- Backfilling games whose StoreKit cell holds only `x` (dead link) — no image to take.

## Testing

- Jest (node), mocking `@/lib/db`, `@/lib/supabase-storage`, and `global.fetch`:
  - 401 without secret/admin; 503 unconfigured; 400 bad body / >50 items
  - skip paths: not found, has storekit, has manual
  - happy path: downloads, uploads, single `sql.json` UPDATE param is the raw URL array, correct counters
  - download failure and non-image content-type → `failed[]` / partial
- n8n flow: dry-run on the puzzle sheet (smallest, 391 rows) first; verify `flow_log` row + spot-check one game in the UI.
