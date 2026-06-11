# Manual Screenshots for Games Missing StoreKit — Design

**Date:** 2026-06-11
**Scope:** `EvalDetailPanel`, `GET /api/evaluations/[gameId]`, new `app/api/evaluations/[gameId]/screenshots/` routes, new `lib/supabase-storage.ts`

## Problem

Very new games often have no StoreKit screenshots in `game_info.metadata->'screenshot_urls'` yet (the store API hasn't returned them). The team screenshots the store page manually and currently has nowhere to put those images. They need to attach manual screenshots to a game so every later view of that game shows them — until the real StoreKit data arrives, at which point the manual copies are deleted automatically.

## Decisions (confirmed with user)

- **Storage: Supabase Storage** (public bucket), not Google Drive — the team already has a Supabase account (used by `signal-scheduler`), a public bucket gives direct CDN-served `<img>` URLs with no per-file permission dance, and it avoids touching the production Google OAuth token (Sheets-scoped only).
- **Upload path:** Next.js API route using the Supabase service key server-side (no n8n round-trip).
- **Cleanup:** automatic, lazily, when the game detail is opened — if StoreKit screenshots now exist alongside manual ones, the server deletes the manual files and clears the metadata in the background and returns the StoreKit set.
- **Permissions:** admin/moderator, or the game's `initial_evaluator` — same rule as editing the evaluation.
- **UX:** paste (Ctrl+V), drag-and-drop, or click-to-pick; staged previews; nothing uploads until an explicit **Save screenshots** button is pressed.

## Storage layout & data model

- Bucket: `game-screenshots`, **public**, created once by hand in the Supabase dashboard.
- Object path: `<game_id>/<epoch_ms>-<index>.<ext>` — all of a game's manual images live under the `<game_id>/` prefix, so "delete all for game" is a list-by-prefix + batch remove.
- Public URL shape: `<SUPABASE_URL>/storage/v1/object/public/game-screenshots/<path>`.
- New env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service role key; server-side only, never sent to the client).
- DB: **no new column.** Manual URLs are stored as a JSON array of strings at `game_info.metadata->'manual_screenshot_urls'`, beside the existing `screenshot_urls`. The detail SELECT adds one expression.
- Limits (enforced client-side for UX and server-side for safety): max **10 images per save**, max **5 MB per image**, MIME `image/png`, `image/jpeg`, `image/webp` only.

## Components

### 1. `lib/supabase-storage.ts` (new)

Thin server-side helper over the Supabase Storage REST API (use `@supabase/supabase-js`; add as a dependency):

- `isStorageConfigured(): boolean` — both env vars present.
- `uploadScreenshot(gameId, buffer, ext, index): Promise<string>` — uploads one object, returns its public URL.
- `deleteGameScreenshots(gameId): Promise<void>` — list `<game_id>/` prefix, remove all objects.
- `deleteScreenshotByUrl(url): Promise<void>` — derive the object path from a public URL (validate it belongs to this bucket), remove it.

### 2. `app/api/evaluations/[gameId]/screenshots/route.ts` (new)

**POST** — multipart `FormData` with one or more `files` entries.
1. `requireAuth`; then permission check: admin/moderator, or session user name equals the game's `initial_evaluator` (one SQL lookup joining `game_evaluations`). 403 otherwise.
2. 503 `Storage not configured` if env vars missing.
3. Validate count (≤10), per-file size (≤5 MB), MIME whitelist → 400 with a per-file error list.
4. Upload sequentially; collect successes and failures. Append successful URLs to `metadata->'manual_screenshot_urls'` with one UPDATE (`jsonb_set` over `COALESCE(metadata->'manual_screenshot_urls', '[]')`).
5. Response: `{ urls: string[] (full updated array), failed: { name, error }[] }`. Partial success is a 200 — already-uploaded files stay saved; the client re-stages only the failures.

**DELETE** — JSON body `{ url?: string }`.
- Same permission check. With `url`: remove that object + filter it out of the metadata array. Without `url`: delete all under the prefix + clear the key. Response: `{ urls: string[] }`.

### 3. `GET /api/evaluations/[gameId]` (modify existing)

- SELECT adds `gi.metadata->'manual_screenshot_urls' AS manual_screenshot_urls`.
- Response logic:
  - StoreKit present → return `screenshot_urls` as today; `manual_screenshot_urls: null`. If manual URLs were also present, fire-and-forget (no `await` on the response path): delete Supabase objects + `UPDATE game_info SET metadata = metadata - 'manual_screenshot_urls'`. Log failures with `console.error`; the next view retries naturally.
  - No StoreKit → return `manual_screenshot_urls` (may be empty/null).

### 4. `EvalDetailPanel.tsx` (modify)

- `EvalDetail` interface gains `manual_screenshot_urls: string[] | null`.
- Rendering: if `screenshot_urls` non-empty → existing StoreKit card, unchanged. Else → **Manual Screenshots card**:
  - Saved manual images render exactly like StoreKit thumbnails (click → existing lightbox), each with a small "manual" pill, plus a hover delete button (visible only to users passing the same can-edit check used for the evaluation form, i.e. `isAdmin || isManager || ev.initial_evaluator === userName` — match the POST rule, manager included).
  - Dropzone (visible to the same users; hidden when storage is unconfigured — detected by a 503 on save, and the dropzone shows the error state): "Dán ảnh (Ctrl+V), kéo thả, hoặc bấm để chọn". A `paste` listener on `window` is attached only while the panel is mounted and ignores events when `expandedImg` lightbox is open or focus is in an input/textarea.
  - Staged files: object-URL previews with a dashed "pending" border and a per-file remove ✕. Client-side validation (type/size/count) rejects bad files immediately with a toast.
  - **Save screenshots** button, separate from "Save Evaluation": enabled only when staged files exist; on success, staged previews are replaced by the returned saved URLs (and object URLs revoked); failures stay staged with an error toast.
  - Deleting a saved image calls DELETE with its URL and updates local state from the response.
- Cache note: the panel's per-game `cacheRef` must be updated with the fresh manual URLs after save/delete (reuse the existing `applyData` path).

## Error handling

- Partial upload failure → 200 with `failed[]`; client keeps failed files staged for retry.
- Oversized/wrong-type files → blocked client-side; server re-validates (400).
- Missing Supabase env → POST/DELETE return 503; UI surfaces "Storage chưa được cấu hình" in the dropzone.
- Lazy cleanup failure → logged, retried implicitly on next detail view (idempotent: delete-by-prefix + metadata key removal).
- Concurrent saves on the same game are tolerated: the metadata UPDATE re-reads `COALESCE(... , '[]')` in SQL, and last-writer-wins on the array is acceptable for this team size.

## Out of scope (YAGNI)

- Image crop/resize/compression, ordering/reordering, captions.
- Uploading manual images for games that already have StoreKit screenshots.
- Backfilling/migrating any previously shared ad-hoc images.
- n8n involvement of any kind.

## Testing

- **Jest (node), mocking `@/lib/db` and `@/lib/supabase-storage`:**
  - POST: 401 unauthenticated; 403 wrong evaluator; 503 unconfigured; 400 too many/too large/bad MIME; 200 happy path appends URLs (assert UPDATE called and response array); 200 partial failure returns `failed[]` while successes persist.
  - DELETE: with URL removes one and filters metadata; without URL clears all; 403 wrong evaluator.
  - GET detail: returns `manual_screenshot_urls` when no StoreKit; returns StoreKit and triggers cleanup when both exist (assert delete helper + metadata-clear UPDATE invoked).
- **Manual UI check:** paste/drag/pick all stage previews; Save persists and survives reload; delete works; evaluator without ownership sees read-only images and no dropzone.
