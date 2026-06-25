# Eval: Game Alike + Final Note Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Game Alike" field (reusing weekly-feedback's game-search/chip UX) and a manager-only "Final Note" field to the evaluation flow, and rename "Note" → "Initial Note" on both the Evaluation form and the Short List table.

**Architecture:** New `game_alike` (JSONB) + `final_note` (TEXT) columns on `game_evaluations`. The `GameSearch` widget and `GameAlikeGame` type from `components/weekly-feedback/` are reused via a new `components/GameAlikeField.tsx` (editable list + read-only chips). API GET/PATCH gain the two fields; PATCH gates `game_alike` to the eval owner and `final_note` to managers (admin|moderator).

**Tech Stack:** Next.js 14 (app router), React 18, TypeScript, `postgres` (porsager) tagged-template SQL, next-auth, Jest.

## Global Constraints

- Timezone is always `Asia/Ho_Chi_Minh` (UTC+7). (No new date logic here, but keep it in mind.)
- `game_alike` data shape is the flat array `GameAlikeGame[]` = `{ game_id: string|null, title: string, app_link: string|null, icon_url: string|null, manual: boolean }` — **no named groups** (do NOT use `AlikeBlock`).
- "Manager" = `role === 'admin' || role === 'moderator'` everywhere (matches existing code).
- Reuse existing CSS classes (`.wf-chip`, `.wf-chips`, `.wf-gamesearch`, `.wf-alike-game*`) — do not invent new class names unless a gap is found.
- All store/link hrefs must pass `isSafeHref` before persisting (XSS guard, same as weekly-feedback).
- Lint must stay clean (`npm run lint`) — no unused vars/imports.

---

### Task 1: Database migration

**Files:**
- Create: `migrations/020_eval_game_alike_final_note.sql`

**Interfaces:**
- Produces: columns `game_evaluations.game_alike JSONB NOT NULL DEFAULT '[]'` and `game_evaluations.final_note TEXT`.

- [ ] **Step 1: Write the migration file**

```sql
-- 020: Evaluation Game Alike (flat list of similar games, reusing the
-- weekly-feedback GameAlikeGame shape) + manager-only Final Note.
ALTER TABLE game_evaluations
  ADD COLUMN IF NOT EXISTS game_alike JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS final_note TEXT;
```

- [ ] **Step 2: Commit**

```bash
git add migrations/020_eval_game_alike_final_note.sql
git commit -m "feat(eval): migration 020 — game_alike + final_note columns"
```

> Note: migrations in this repo are applied manually against Postgres (see MEMORY: prior migrations "pending manual apply"). Flag to the user that 020 must be applied before the feature works end-to-end.

---

### Task 2: `sanitizeAlikeGames` helper

**Files:**
- Modify: `lib/weekly-feedback.ts` (add exported function near `sanitizeGame`, ~line 61)
- Test: `__tests__/lib/weekly-feedback.test.ts`

**Interfaces:**
- Consumes: existing private `sanitizeGame(g: unknown): GameAlikeGame` (same file), exported `isSafeHref`.
- Produces: `export function sanitizeAlikeGames(input: unknown): GameAlikeGame[]` — maps `sanitizeGame` over an array, drops entries whose `title` is blank; returns `[]` for non-arrays.

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/lib/weekly-feedback.test.ts` (and add `sanitizeAlikeGames` to the import on line 1):

```ts
  it('sanitizeAlikeGames keeps safe games, drops blanks and unsafe links', () => {
    expect(sanitizeAlikeGames([
      { game_id: 'g1', title: 'Candy', app_link: 'https://a', icon_url: 'https://i', manual: false },
      { title: '   ', app_link: 'https://b', manual: true },
      { title: 'Bad', app_link: 'javascript:alert(1)', manual: true },
    ])).toEqual([
      { game_id: 'g1', title: 'Candy', app_link: 'https://a', icon_url: 'https://i', manual: false },
      { game_id: null, title: 'Bad', app_link: null, icon_url: null, manual: true },
    ])
  })

  it('sanitizeAlikeGames returns [] for non-arrays', () => {
    expect(sanitizeAlikeGames(null)).toEqual([])
    expect(sanitizeAlikeGames({})).toEqual([])
  })
```

Update the import line 1 to:

```ts
import { sanitizeSections, legacyToSections, rowToSections, isSafeHref, sanitizeAlikeGames } from '@/lib/weekly-feedback'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- weekly-feedback`
Expected: FAIL — `sanitizeAlikeGames is not a function`.

- [ ] **Step 3: Implement the helper**

In `lib/weekly-feedback.ts`, after `sanitizeGame` (the function ending ~line 61), add:

```ts
// Flat-list variant for the evaluation "Game Alike" field (no named groups).
// Reuses sanitizeGame's per-field XSS guard; drops entries with no title.
export function sanitizeAlikeGames(input: unknown): GameAlikeGame[] {
  if (!Array.isArray(input)) return []
  return input.map(sanitizeGame).filter((g) => g.title.trim().length > 0)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- weekly-feedback`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/weekly-feedback.ts __tests__/lib/weekly-feedback.test.ts
git commit -m "feat(eval): sanitizeAlikeGames helper for flat game-alike list"
```

---

### Task 3: API GET + PATCH — `game_alike` & `final_note`

**Files:**
- Modify: `app/api/evaluations/route.ts` (GET list SELECT ~line 160-169; PATCH ~line 247-369)
- Modify: `app/api/evaluations/[gameId]/route.ts` (GET SELECT ~line 30-39)
- Test: `__tests__/api/evaluations.test.ts`

**Interfaces:**
- Consumes: `sanitizeAlikeGames` from Task 2; `sql.json` (porsager helper, already used in `app/api/weekly-feedback/route.ts`).
- Produces: GET responses include `game_alike` (array) + `final_note` (string|null). PATCH accepts body fields `game_alike` (owner-gated) and `final_note` (manager-gated, 403 otherwise).

- [ ] **Step 1: Write the failing test**

Add to `__tests__/api/evaluations.test.ts` inside the `describe('GET /api/evaluations')` block:

```ts
  it('list query selects game_alike and final_note', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&month=auto&page=1')
    const q = allQueries()
    expect(q).toContain('ge.game_alike')
    expect(q).toContain('ge.final_note')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- evaluations`
Expected: FAIL — query does not contain `ge.game_alike`.

- [ ] **Step 3: Add columns to both GET SELECTs**

In `app/api/evaluations/route.ts`, the list SELECT (~line 162) — extend the `ge.evaluate_date, ge.initial_note, ...` line to also select the new columns. Change:

```ts
          ge.evaluate_date, ge.initial_note, ge.initial_conclusion, ge.final_conclusion, ge.batch,
```
to:
```ts
          ge.evaluate_date, ge.initial_note, ge.final_note, ge.game_alike,
          ge.initial_conclusion, ge.final_conclusion, ge.batch,
```

In `app/api/evaluations/[gameId]/route.ts` (~line 32), make the identical change to that SELECT's matching line.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- evaluations`
Expected: PASS.

- [ ] **Step 5: Wire PATCH — destructure, gate, update**

In `app/api/evaluations/route.ts` PATCH:

(a) Add `game_alike, final_note` to the destructure (~line 253):

```ts
    const {
      id, initial_note, final_note, game_alike, initial_conclusion, final_conclusion, batch, drive_link, youtube_link,
      record_5min_assignee, record_20min_assignee,
      record_5min_drive, record_20min_drive,
    } = body
```

(b) Import the sanitizer at the top of the file (with the other `@/lib` imports):

```ts
import { sanitizeAlikeGames } from '@/lib/weekly-feedback'
```

(c) In the non-manager block, include `game_alike` in the owner-gated `editsContent` and forbid `final_note` for non-managers. Change the `editsContent` line (~line 296) to:

```ts
        const editsContent = initial_note !== undefined || initial_conclusion !== undefined
          || youtube_link !== undefined || batch !== undefined || game_alike !== undefined
```

And add, right after the existing `final_conclusion` forbid (~line 316):

```ts
        if (final_note !== undefined) {
          return NextResponse.json({ error: 'Forbidden: final note requires manager role' }, { status: 403 })
        }
```

(d) Add provided-flags near the others (~line 326):

```ts
    const finalNoteProvided = provided('final_note'), finalNoteVal = clean(final_note)
    const gaProvided = provided('game_alike')
    const gaJson = gaProvided ? sanitizeAlikeGames(game_alike) : []
```

(e) In the UPDATE statement, add two new SET clauses. After the `initial_note = CASE ...` line (~line 332) add:

```ts
        final_note = CASE WHEN ${finalNoteProvided} THEN ${finalNoteVal} ELSE final_note END,
        game_alike = CASE WHEN ${gaProvided} THEN ${sql.json(gaJson)}::jsonb ELSE game_alike END,
```

- [ ] **Step 6: Build to verify wiring compiles**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors. (If `tsc` is not configured standalone, run `npm run build` and confirm it compiles past the type-check phase.)

- [ ] **Step 7: Commit**

```bash
git add app/api/evaluations/route.ts "app/api/evaluations/[gameId]/route.ts" __tests__/api/evaluations.test.ts
git commit -m "feat(eval): API read/write game_alike (owner) + final_note (manager)"
```

---

### Task 4: `GameAlikeField` component (editable + read-only)

**Files:**
- Create: `components/GameAlikeField.tsx`

**Interfaces:**
- Consumes: `GameSearch` from `@/components/weekly-feedback/GameSearch`, `PlatformIcon` from `@/components/weekly-feedback/PlatformIcon`, type `GameAlikeGame` from `@/components/weekly-feedback/types`.
- Produces:
  - `GameAlikeField({ value, onChange, disabled }: { value: GameAlikeGame[]; onChange: (next: GameAlikeGame[]) => void; disabled?: boolean })` — editable chip list + search; when `disabled`, renders read-only chips only.
  - `GameAlikeChips({ value }: { value: GameAlikeGame[] | null | undefined })` — compact read-only chips for table cells; renders `—` when empty.

- [ ] **Step 1: Create the component**

```tsx
'use client'
import { GameAlikeGame } from './weekly-feedback/types'
import { GameSearch } from './weekly-feedback/GameSearch'
import { PlatformIcon } from './weekly-feedback/PlatformIcon'

// Flat "Game Alike" list for an evaluation. Mirrors the weekly-feedback chip +
// GameSearch UX, but a single ungrouped list. Read-only when `disabled`.
export function GameAlikeField({ value, onChange, disabled }: {
  value: GameAlikeGame[]
  onChange: (next: GameAlikeGame[]) => void
  disabled?: boolean
}) {
  const games = value || []
  const addGame = (g: GameAlikeGame) => onChange([...games, g])
  const removeGame = (gi: number) => onChange(games.filter((_, i) => i !== gi))

  if (disabled) return <GameAlikeChips value={games} />

  return (
    <div className="wf-alike-block" style={{ margin: 0 }}>
      <ul className="wf-chips">
        {games.map((g, gi) => (
          <li key={gi} className="wf-chip">
            {g.icon_url && <img src={g.icon_url} alt="" width={18} height={18} />}
            {g.app_link
              ? <a href={g.app_link} target="_blank" rel="noopener noreferrer">{g.title}</a>
              : <span>{g.title}</span>}
            <PlatformIcon link={g.app_link} />
            {g.manual && <span className="wf-manual" title="Not in DB">·manual</span>}
            <button type="button" title="Remove game" onClick={() => removeGame(gi)}>✕</button>
          </li>
        ))}
      </ul>
      <GameSearch onPick={addGame} />
    </div>
  )
}

// Read-only chips for list/table cells.
export function GameAlikeChips({ value }: { value: GameAlikeGame[] | null | undefined }) {
  const games = value || []
  if (!games.length) return <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>
  return (
    <div className="wf-alike-games">
      {games.map((g, i) => {
        const inner = (
          <>
            {g.icon_url && <img src={g.icon_url} alt="" width={18} height={18} />}
            <span className="wf-alike-game-title">{g.title}</span>
            <PlatformIcon link={g.app_link} />
          </>
        )
        return g.app_link
          ? <a key={i} className="wf-alike-game is-link" href={g.app_link} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>{inner}</a>
          : <span key={i} className="wf-alike-game">{inner}</span>
      })}
    </div>
  )
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run lint`
Expected: no errors for `components/GameAlikeField.tsx`.

- [ ] **Step 3: Commit**

```bash
git add components/GameAlikeField.tsx
git commit -m "feat(eval): GameAlikeField component (editable list + read-only chips)"
```

---

### Task 5: Evaluation form — relabel Note, add Game Alike + Final Note

**Files:**
- Modify: `components/EvalDetailPanel.tsx`

**Interfaces:**
- Consumes: `GameAlikeField` (Task 4), type `GameAlikeGame`, the PATCH fields from Task 3.
- Produces: form sends `game_alike` (when `canEditEval`) and `final_note` (when manager) in its PATCH body.

- [ ] **Step 1: Extend the EvalDetail interface**

In `components/EvalDetailPanel.tsx`, add the import (top, after line 7):

```ts
import { GameAlikeField } from '@/components/GameAlikeField'
import type { GameAlikeGame } from '@/components/weekly-feedback/types'
```

Add two fields to the `EvalDetail` interface, after `initial_note` (line 19):

```ts
  final_note: string | null
  game_alike: GameAlikeGame[] | null
```

- [ ] **Step 2: Add state**

After `const [note, setNote] = useState('')` (line 362) add:

```ts
  const [finalNote, setFinalNote] = useState('')
  const [gameAlike, setGameAlike] = useState<GameAlikeGame[]>([])
```

- [ ] **Step 3: Populate in applyData**

In `applyData` (after `setNote(data.initial_note || '')`, line 420) add:

```ts
    setFinalNote(data.final_note || '')
    setGameAlike(Array.isArray(data.game_alike) ? data.game_alike : [])
```

- [ ] **Step 4: Add the edit-gate for Final Note**

After `const canEditEval = ...` (line 518) add:

```ts
  // Final Note is a manager-only field (admin or moderator).
  const canEditFinalNote = !readOnly && isManager
```

And extend the `canEdit` union (line 525) so the Save button shows for a manager-only edit:

```ts
  const canEdit = canEditEval || canEdit5 || canEdit20 || canEditAssignee || canEditFinalNote
```

- [ ] **Step 5: Send the new fields on save**

In `save()`, inside the `if (canEditEval) { ... }` block (after `body.drive_link = driveLink`, line 563) add:

```ts
        body.game_alike = gameAlike
```

And after that block (after line 564, before the `canEdit5` line) add:

```ts
      if (canEditFinalNote) body.final_note = finalNote
```

- [ ] **Step 6: Relabel Note → Initial Note and render the new fields**

In the Note `field` block (line 962-976), change the label text on line 964 from `Note` to `Initial Note`:

```tsx
                  <span className="label">Initial Note</span>
```

Immediately after that Note `</div>` (after line 976), insert the Game Alike and Final Note fields:

```tsx
              <div className="field">
                <span className="label">Game Alike</span>
                <GameAlikeField value={gameAlike} onChange={g => { setGameAlike(g); setDirty(true) }} disabled={!canEditEval} />
              </div>

              <div className="field">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="label">Final Note</span>
                  {canEditFinalNote && finalNote && <ClearBtn onClick={() => { setFinalNote(''); setDirty(true) }} />}
                </div>
                <textarea
                  className="input"
                  rows={3}
                  value={finalNote}
                  onChange={e => { setFinalNote(e.target.value); setDirty(true) }}
                  placeholder={canEditFinalNote ? 'Final note (managers only)…' : 'Final note (managers only)'}
                  disabled={!canEditFinalNote}
                  style={{ resize: 'vertical', fontSize: 13 }}
                />
              </div>
```

- [ ] **Step 7: Build / lint**

Run: `npm run lint`
Expected: no errors. Visually confirm in `npm run dev` (port 3333): open an evaluation — "Initial Note" label, a Game Alike search+chips block below it (editable as the eval owner/admin), and a Final Note textarea that is editable only for admin/moderator.

- [ ] **Step 8: Commit**

```bash
git add components/EvalDetailPanel.tsx
git commit -m "feat(eval): form adds Game Alike + manager-only Final Note, renames Note→Initial Note"
```

---

### Task 6: Short List — relabel, Final Note cell, drop dates, Game Alike column

**Files:**
- Modify: `app/(manager)/evaluations/page.tsx`

**Interfaces:**
- Consumes: `GameAlikeChips` (Task 4), type `GameAlikeGame`, the existing `FinalConclusionCell`/`DemoVideoCell` patterns.
- Produces: Short List table columns `# | Game | Link | Final Conclusion | Demo Video | Initial Note | Final Note | Game Alike`; inline manager-editable Final Note.

- [ ] **Step 1: Imports + interface fields**

Add imports near the top (after line 16):

```ts
import { GameAlikeChips } from '@/components/GameAlikeField'
import type { GameAlikeGame } from '@/components/weekly-feedback/types'
```

Add to the `ShortListItem` interface (after `initial_note`, line 130):

```ts
  final_note: string | null
  game_alike: GameAlikeGame[] | null
```

- [ ] **Step 2: Add the `FinalNoteCell` component**

Insert after `DemoVideoCell` (after line 280), modeled on `DemoVideoCell` but a textarea, manager-gated:

```tsx
// Manager-only inline Final Note. Click to reveal a textarea; save via PATCH
// final_note. Non-managers see the text read-only (no edit affordance).
function FinalNoteCell({ item, isManager, onSaved }: {
  item: ShortListItem
  isManager: boolean
  onSaved: (id: number, value: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(item.final_note || '')
  const [saving, setSaving] = useState(false)

  const cancel = () => { setVal(item.final_note || ''); setEditing(false) }

  const save = async () => {
    const v = val.trim()
    if (v === (item.final_note || '')) { setEditing(false); return }
    setSaving(true)
    try {
      const res = await fetch('/api/evaluations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, final_note: v || null }),
      })
      if (res.ok) onSaved(item.id, v || null)
    } catch { /* ignore */ }
    setSaving(false)
    setEditing(false)
  }

  if (editing && isManager) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 4 }} onClick={e => e.stopPropagation()}>
        <textarea
          autoFocus
          className="input"
          rows={2}
          style={{ fontSize: 11, padding: '3px 6px', width: 170, resize: 'vertical' }}
          placeholder="Final note…"
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(); if (e.key === 'Escape') cancel() }}
          disabled={saving}
        />
        <button className="btn btn-primary btn-sm" style={{ padding: '3px 7px', fontSize: 11 }} onClick={save} disabled={saving} title="Save (⌘/Ctrl+Enter)">✓</button>
        <button className="btn btn-ghost btn-sm" style={{ padding: '3px 6px', fontSize: 11 }} onClick={cancel} disabled={saving} title="Cancel">✕</button>
      </span>
    )
  }

  return (
    <span
      onClick={e => { if (isManager) { e.stopPropagation(); setVal(item.final_note || ''); setEditing(true) } }}
      title={isManager ? 'Click to edit final note' : (item.final_note || undefined)}
      style={{ display: 'inline-flex', alignItems: 'center', maxWidth: 220, cursor: isManager ? 'pointer' : (item.final_note ? 'help' : 'default') }}
    >
      {item.final_note
        ? <span style={{ fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.final_note}</span>
        : <span style={{ fontSize: 12, color: isManager ? 'var(--accent)' : 'var(--faint)', fontWeight: isManager ? 600 : 400 }}>{isManager ? '+ add' : '—'}</span>}
    </span>
  )
}
```

- [ ] **Step 3: Add the save handler**

After `handleDriveLinkSaved` (line 357) add:

```ts
  const handleFinalNoteSaved = (id: number, value: string | null) => {
    setData(prev => prev.map(d => d.id === id ? { ...d, final_note: value } : d))
  }
```

- [ ] **Step 4: Update table headers**

Replace the header row (lines 483-491) with the new columns (rename Note, drop both date columns, add Final Note + Game Alike):

```tsx
                <th style={{ width: 36 }}>#</th>
                <th>Game</th>
                <th style={{ width: 110 }}>Link</th>
                <th style={{ width: 150 }}>Final Conclusion</th>
                <th style={{ width: 90 }}>Demo Video</th>
                <th>Initial Note</th>
                <th>Final Note</th>
                <th>Game Alike</th>
```

- [ ] **Step 5: Update the skeleton-row widths**

The empty/loading colSpan stays `8` (8 columns before, 8 after). Update the skeleton width array (line 499) to drop the two date widths and add two text-cell widths:

```tsx
                  <td key={c}><span className="skeleton" style={{ width: [30, 200, 70, 110, 60, 160, 140, 140][c] || 80, height: 14 }} /></td>
```

- [ ] **Step 6: Update the body cells**

Keep the `#`, Game, Link, Final Conclusion, Demo Video cells unchanged. The current "Note" cell (lines 569-577) stays as the **Initial Note** cell (no code change — it already shows `item.initial_note`). **Replace the two date `<td>` cells (lines 578-583)** with the Final Note and Game Alike cells:

```tsx
                  <td onClick={e => e.stopPropagation()}>
                    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                      <FinalNoteCell item={item} isManager={isManager} onSaved={handleFinalNoteSaved} />
                      <CopyBtn text={item.final_note} />
                    </span>
                  </td>
                  <td>
                    <GameAlikeChips value={item.game_alike} />
                  </td>
```

- [ ] **Step 7: Build / lint**

Run: `npm run lint`
Expected: no errors. Note: `fmtDate` is still used by the standard eval tab (lines ~1019/1028), so it does not become unused.

Visually confirm in `npm run dev`: Short List header reads `… Demo Video | Initial Note | Final Note | Game Alike`; the two date columns are gone; a manager can click Final Note to edit inline; a non-manager sees Final Note read-only; Game Alike shows chips (or `—`).

- [ ] **Step 8: Commit**

```bash
git add "app/(manager)/evaluations/page.tsx"
git commit -m "feat(eval): Short List adds Final Note (inline, manager) + Game Alike, drops date cols, renames Note→Initial Note"
```

---

### Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (including the new `sanitizeAlikeGames` and `game_alike`/`final_note` column assertions).

- [ ] **Step 2: Lint + build**

Run: `npm run lint && npm run build`
Expected: clean lint, successful build.

- [ ] **Step 3: Manual end-to-end (after migration 020 applied)**

With `npm run dev`:
1. As an evaluator on your own game: add a Game Alike (search a game + paste a link), save, reload → it persists. Final Note textarea is disabled.
2. As admin/moderator: edit Final Note on the form and inline in Short List → persists. Confirm a non-manager PATCH of `final_note` returns 403 (e.g. via devtools) — the field is disabled in UI, this is the server gate.
3. Short List: confirm columns and that the two date columns are gone.

- [ ] **Step 4: Remind the user** that `migrations/020_eval_game_alike_final_note.sql` must be applied to Postgres manually before the feature works against real data.

---

## Self-Review

**Spec coverage:**
- Evaluation form: rename Note → Initial Note (Task 5 Step 6) ✓; Game Alike below Note (Task 5 Step 6 + Task 4) ✓; Final Note admin/moderator-only (Task 5 Steps 4-6, gated server-side Task 3) ✓.
- Short List: Note → Initial Note header (Task 6 Step 4) ✓; Final Note inline-editable manager-only (Task 6 Steps 2,6) ✓; drop 2 date columns (Task 6 Steps 4,6) ✓; Game Alike read-only last column (Task 6 Step 6 + Task 4 `GameAlikeChips`) ✓.
- DB + API for both fields (Tasks 1, 3) ✓. Game Alike reuses weekly-feedback logic as a flat list (Tasks 2, 4) ✓.

**Placeholder scan:** none — all steps contain concrete code and commands.

**Type consistency:** `GameAlikeGame` used identically across Tasks 3-6; `sanitizeAlikeGames` signature matches its definition; `final_note`/`game_alike` field names match across migration, API, interfaces, and components. `GameAlikeField`/`GameAlikeChips` props match their call sites.
