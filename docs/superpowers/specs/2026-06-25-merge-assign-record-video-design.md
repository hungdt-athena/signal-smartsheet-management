# Merge "Assign Record" + "Record Video" into one "Record" tab

Date: 2026-06-25
Status: Approved (verbal) — overnight autonomous build

## Problem

`app/(manager)/youtube/page.tsx` currently hosts three tabs:
- `tab=youtube` — uploaded YouTube videos (from Google Sheet). **Unchanged.**
- `tab=short_list` — "Assign Record": assign 5'/20' recorders to Short List games.
- `tab=record_video` — "Record Video": split 5'/20' tables of assigned games.

The two recording tabs overlap heavily and force the team to bounce between
"assign" and "track". Merge them into a single **Record** tab.

## Decisions (locked by user)

1. **Scope** — show only games in the **current batch** whose
   `final_conclusion ∈ {Priority IV, Insight}`. Other / unset final conclusions
   do NOT appear.
2. **Auto-bucketing** — `Insight → 5 min` container; `Priority IV → 20 min`
   container. Each game belongs to exactly **one** container.
3. **Recorder column** — inline dropdown, options from `/api/team/recorders`
   (`dashboard_users`). Replaces the old "Category" column **and** the old
   "Assign Record" modal (assignment is now inline in the table).
4. **Status lifecycle** (see derivation below): `pending → draft → recording →
   recorded`.
5. **Recorded** — derived client-side by matching the game title against the
   YouTube tab's uploaded list. Display-only (NOT persisted). The "Recorded"
   badge is a **hyperlink** to the YouTube video.
6. **Default filter** — batch defaults to the team's current batch (like Short
   List).
7. **Roles** — managers (admin/moderator) assign + confirm; recorders
   (evaluator) see only their own rows, read-only.
8. **No recording submission** in this tab (no Drive upload column / panel).
9. **Keep** the "Extract Chat" button. Keep `ExtractChatModal`.

## Data model

Reuse existing columns — no new assignee columns:
- Insight game's recorder → `record_5min_assignee`
- Priority IV game's recorder → `record_20min_assignee`

One new column (migration `021_record_confirmed.sql`):
```sql
ALTER TABLE game_evaluations
  ADD COLUMN IF NOT EXISTS record_confirmed_at TIMESTAMPTZ;
```
`record_status` text column is intentionally NOT added — `pending` and
`recorded` are derived; only the "confirmed" fact needs persistence.

> Migration is applied **manually** by the user (repo convention). The GET query
> adds `record_confirmed_at` to its SELECT, so the code must NOT be deployed
> until migration 021 is applied — otherwise the query errors in prod.

### Status derivation (per game, client-side)

```
bucket   = final_conclusion === 'Priority IV' ? '20min' : '5min'   // Insight → 5min
assignee = bucket === '20min' ? record_20min_assignee : record_5min_assignee
ytMatch  = youtube uploaded row whose normalized title === normalized game title

status =
    ytMatch          ? 'recorded'     // takes precedence; badge links to video
  : !assignee        ? 'pending'
  : record_confirmed_at ? 'recording'
  :                     'draft'
```

Title normalization: lowercase, trim, collapse internal whitespace, strip
diacritics. (Matches the kind of drift seen in sheet data.)

Re-assigning a recorder resets the game to `draft` (clears `record_confirmed_at`).

## API

### GET `/api/evaluations` (extend)
- Add `ge.record_confirmed_at` to the row SELECT (and to `ShortListItem`-equiv
  type on the client).
- Filters already exist: `batch`, `final_conclusions` (added 2026-06-25),
  `recorder`. The Record tab calls with:
  `category, batch=<current>, final_conclusions=Priority IV,Insight, limit=500`.
- Non-manager: server already forces own-rows for `evaluator` via the
  `recorder` param path (client passes `recorder=<self>`); keep that.

### POST `/api/evaluations/confirm-records` (new)
- Role: `admin`, `moderator`.
- Body: `{ ids: number[] }`.
- `UPDATE game_evaluations SET record_confirmed_at = NOW()
   WHERE id IN (...) AND record_confirmed_at IS NULL` (only flips drafts).
- Returns `{ confirmed: <count> }`.

### POST `/api/evaluations/assign-records` (modify)
- Relax role from `['admin']` → `['admin','moderator']`.
- When an assignee column is written (set OR changed), also reset
  `record_confirmed_at = NULL` so a re-assign drops the game back to `draft`.
  (Only when the assignee actually changes — a no-op write must not reset.)

## UI — `RecordTab` (replaces ShortListTab + RecordVideoTab)

Layout mirrors the old Record Video: two side-by-side containers.

- **Header**: title "Record", subline `<total> games · <batch> · <category>`.
- **Filter row**: `DateFilter` + Category select + **Batch select (default
  current batch)** + segmented Status filter (All / Pending / Draft / Recording
  / Recorded) + (manager) **Confirm Assign** button with draft-count badge +
  **Extract Chat** button.
- **Two tables**: `5 MIN` (Insight) and `20 MIN` (Priority IV).
  - Columns: `# · Game · Recorder · Status`.
  - **Recorder**: manager → inline `StyledSelect` (options from
    `/api/team/recorders`); recorder/non-manager → plain text (read-only).
    Changing it calls `assign-records` (one-row batch) → optimistic update,
    status becomes `draft`.
  - **Status**: badge per derivation. `recorded` badge wraps an `<a>` to
    `https://www.youtube.com/watch?v=<youtubeId>`.
- **Confirm Assign**: collects all visible `draft` rows, POSTs their ids to
  `confirm-records`, refetches. Manager-only. Disabled when no drafts.
- **Extract Chat**: opens existing `ExtractChatModal` over the assigned games.
- **Row click**: opens `EvalDetailPanel` (read-only-ish; keep current behavior).
- Recorder-role view: only their rows returned by the server; Recorder column
  read-only; no Confirm/Assign controls.

### YouTube match source
Fetch `/api/sheets/ytb-uploaded` once on mount; build a `Map<normalizedTitle,
youtubeId>` for the recorded lookup. Pick the row with a real `youtubeId`.

## Nav (`app/(manager)/layout.tsx`)
Under the "Videos" group:
- Keep `{ tab=youtube, label: 'YouTube' }`.
- Replace the two children with one:
  `{ tab=record_video, label: 'Record', roles: ['admin','moderator','evaluator'] }`.
- Remove `tab=short_list` child.

## Cleanup
In `youtube/page.tsx`: delete `ShortListTab`, `RecordVideoTab`,
`AssignRecordModal`; add `RecordTab`. Keep `YouTubeTab`, `ExtractChatModal`,
`RecordTable` (adapted), `RecordingCell` (replaced by a `StatusBadge` for the
new statuses), `SkeletonRows`, `DriveBtnSmall`. Router: `tab=record_video` →
`RecordTab`; remove `tab=short_list` route.

## Out of scope
- Persisting `recorded` to DB.
- Drive/recording file submission.
- Changing the YouTube tab.
- Backfilling old per-game dual (5'+20') assignments — new model assumes one
  bucket per game by final_conclusion.

## Risks
- **Title matching** may miss due to sheet drift; normalization may need tuning.
  Non-fatal (just shows `recording` instead of `recorded`).
- **Migration ordering**: do not push/deploy until 021 is applied.

---

## Addendum (2026-06-26): manual bucket overrides — drag, add, remove

Bucket is no longer purely derived from final_conclusion; users can move games
between containers, add other games, and remove games from the list.

### Data model — migration `022_record_bucket.sql`
```sql
ALTER TABLE game_evaluations ADD COLUMN IF NOT EXISTS record_bucket TEXT;
-- '5min' | '20min' = manual bucket override; 'none' = removed from list;
-- NULL = auto by final_conclusion (Insight→5min, Priority IV→20min)
```

### Bucket / membership resolution (server + client agree)
```
record_bucket = '5min'  → 5min container (in list)
record_bucket = '20min' → 20min container (in list)
record_bucket = 'none'  → excluded
record_bucket = NULL     → Insight→5min, Priority IV→20min, else excluded
```
Server WHERE (Record tab, within batch+category):
```sql
AND (
  ge.record_bucket IN ('5min','20min')
  OR (ge.record_bucket IS NULL AND ge.final_conclusion IN ('Insight','Priority IV'))
)
```

### API
- GET `/api/evaluations`: add `record_bucket` to SELECT; new param `record_view=1`
  applies the membership clause above (ignores `final_conclusions` in that mode).
  Record tab switches from `final_conclusions=Priority IV,Insight` to `record_view=1`.
- POST `/api/evaluations/record-bucket` (new), admin/moderator:
  `{ id, bucket: '5min'|'20min'|'none' }`.
  - `'none'`: set record_bucket='none', clear BOTH assignees + record_confirmed_at.
  - `'5min'|'20min'`: set record_bucket; **carry the current recorder** into the
    target duration column, clear the other; keep record_confirmed_at.
  - Resolves the current effective bucket/assignee from the row before writing.

### UI (RecordTab)
- **Drag & drop** (manager only): rows `draggable`; each container is a drop
  target. Drop into the other container → POST record-bucket → optimistic move
  (update record_bucket + swap assignee field client-side). Same-container drop = no-op.
- **Add**: a "+ Add" button per container opens a picker listing current
  batch+category games NOT already in the list (fetch `/api/evaluations?category
  &batch&limit=500`, exclude shown ids, search box). Select → record-bucket with
  that container's bucket → refetch.
- **Remove**: per-row × (manager) → inline styled confirm ("Remove from list?
  clears the recorder") → record-bucket `'none'` → optimistic remove. No window.confirm.
- Split uses effective bucket: `record_bucket ∈ {5min,20min} ? it : (final_conclusion==='Priority IV'?'20min':'5min')`.
