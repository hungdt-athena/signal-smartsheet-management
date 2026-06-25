# Implementation Plan — Merge Assign Record + Record Video

Companion to `2026-06-25-merge-assign-record-video-design.md`.

Two independent workstreams (disjoint files → safe to run in parallel):
- **Backend (A)**: migration + API routes.
- **Frontend (B)**: `youtube/page.tsx` rewrite + nav.

B codes against the API contract in the spec, so it does not need A's code.
Integration + typecheck + commit done by the orchestrator after both finish.

---

## Workstream A — Backend

### A1. Migration `migrations/021_record_confirmed.sql`
```sql
-- 021: "confirmed" timestamp for recording assignments. NULL = draft (assigned
-- but not yet confirmed by a manager); set = recording (confirmed).
ALTER TABLE game_evaluations
  ADD COLUMN IF NOT EXISTS record_confirmed_at TIMESTAMPTZ;
```

### A2. `app/api/evaluations/route.ts` — GET SELECT
Add `ge.record_confirmed_at` to the row SELECT list (near the other
`record_*` columns, ~line 165-169). No other GET change (batch +
`final_conclusions` filters already exist).

Also in PATCH: ensure editing a recorder is not required here (PATCH already
blocks `record_*_assignee` for non-managers; leave as-is).

### A3. `app/api/evaluations/assign-records/route.ts`
- Change `requireRole(['admin'])` → `requireRole(['admin','moderator'])`.
- In the UPDATE, reset `record_confirmed_at` to NULL when the relevant assignee
  actually changes. Simplest correct form: reset when this request writes a
  (different) assignee to the bucket. Implementation: add to the SET clause
  ```
  record_confirmed_at = CASE
    WHEN (${has5}  AND ${r5}  IS DISTINCT FROM record_5min_assignee)
      OR (${has20} AND ${r20} IS DISTINCT FROM record_20min_assignee)
    THEN NULL ELSE record_confirmed_at END
  ```
  (Evaluate this BEFORE the assignee columns are updated in the same statement —
  in Postgres, SET expressions all read the OLD row, so ordering is fine.)

### A4. `app/api/evaluations/confirm-records/route.ts` (new)
```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'moderator'])
  if (guard) return guard
  try {
    const { ids } = await req.json()
    const list = Array.isArray(ids) ? ids.map(Number).filter(Boolean) : []
    if (list.length === 0) {
      return NextResponse.json({ error: 'ids array is required' }, { status: 400 })
    }
    const result = await sql`
      UPDATE game_evaluations
      SET record_confirmed_at = NOW()
      WHERE id IN ${sql(list)} AND record_confirmed_at IS NULL
    `
    return NextResponse.json({ confirmed: result.count })
  } catch (err) {
    console.error('POST /api/evaluations/confirm-records error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
```

### A verification
- `npx tsc --noEmit` clean for the three route files.
- Confirm `requireRole` import path matches existing usage.

---

## Workstream B — Frontend

### B1. `app/(manager)/layout.tsx` nav
Replace the two "Videos" children (`tab=short_list`, `tab=record_video`) with:
```ts
{ href: '/youtube?tab=youtube', label: 'YouTube' },
{ href: '/youtube?tab=record_video', label: 'Record', roles: ['admin','moderator','evaluator'] },
```
Drop the "Assign Record/Record Video hidden..." comment line if no longer true.

### B2. `app/(manager)/youtube/page.tsx`
1. Extend `ShortListItem` interface: add
   `final_conclusion: string | null`,
   `record_confirmed_at: string | null`,
   `record_5min_assignee`, `record_20min_assignee` (already present),
   `record_5min_drive`, `record_20min_drive` (present). Keep `batch`.
2. Add `recordStatus(item, ytMap)` helper returning
   `'pending'|'draft'|'recording'|'recorded'` + optional youtubeId, per spec
   derivation. Add `normalizeTitle()` (lowercase/trim/collapse-ws/strip
   diacritics via `.normalize('NFD').replace(/\p{Diacritic}/gu,'')`).
3. Add `RecordStatusBadge({ status, youtubeId })` — colored badge; `recorded`
   wraps `<a href=watch?v=...>`.
4. New `RecordTab` component:
   - Session role; `isManager = admin|moderator`.
   - State: `data`, `loading`, `filterCategory` (default 'puzzle'),
     `filterBatch` + `currentBatch` (default-to-current once, ref guard — copy
     the pattern just added to `evaluations/page.tsx` ShortListEvalTab),
     `filterStatus` ('' default), `ytMap`, `detailGameId`, `showExtract`.
   - `useDateFilter('assigned')` + DateFilter (optional; keep batch as primary).
   - Fetch: `/api/evaluations?category&batch&final_conclusions=Priority IV,Insight&limit=500`
     (+ `recorder=<self>` when non-manager). Set `currentBatch` from
     `json.current_batch`; default `filterBatch` once.
   - Fetch `/api/sheets/ytb-uploaded` once → build `ytMap`
     `Map<normalizedTitle, youtubeId>` (prefer rows with youtubeId).
   - Split: `list5 = data.filter(final_conclusion==='Insight')`,
     `list20 = data.filter(final_conclusion==='Priority IV')`.
     Apply `filterStatus` using `recordStatus`.
   - `assignRecorder(item, name)`: POST `assign-records` with the bucket field
     (`record_20min_assignee` for Priority IV else `record_5min_assignee`),
     optimistic update (set assignee, clear `record_confirmed_at`).
   - `confirmAssign()`: gather visible draft ids → POST `confirm-records` →
     refetch.
   - Render two `RecordTable`s with columns `# · Game · Recorder · Status`.
   - Keep `ExtractChatModal` (games = assigned ones) + `EvalDetailPanel` modal.
5. Rewrite `RecordTable` props: `{ label, items, loading, isManager, recorders,
   onAssign, ytMap, onClickGame }`. Recorder cell = StyledSelect (manager) or
   text. Status cell = `RecordStatusBadge`.
6. Delete `ShortListTab`, `RecordVideoTab`, `AssignRecordModal`, and the old
   `RecordingCell` (or repurpose). Keep `YouTubeTab`, `ExtractChatModal`,
   `SkeletonRows`, `DriveBtnSmall`.
7. Router `VideosPageInner`: `tab==='record_video'` → `<RecordTab/>`; remove the
   `tab==='short_list'` branch; default `YouTubeTab`.

### B verification
- `npx tsc --noEmit` clean.
- No remaining references to deleted components.

---

## Integration (orchestrator)
1. After A+B: run `npx tsc --noEmit -p tsconfig.json` — fix any contract drift.
2. `npm run build` if quick, else rely on tsc.
3. Commit (do NOT push — user applies migration 021 first, reviews, then
   pushes/deploys). Commit message documents the migration-before-deploy order.
4. Leave a summary for the morning: what changed, that migration 021 must be
   applied, and that it's unpushed pending review.
