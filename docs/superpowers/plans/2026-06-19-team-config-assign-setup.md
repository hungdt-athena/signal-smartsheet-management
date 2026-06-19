# Team Weights + Config Genre→Bucket + Assign Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an editable Weight column to the Team tab, a Genre→Bucket editor to the Config tab, and a DB-backed "Assign Setup" subtab under Evaluations that prepares the per-bucket evaluator roster for future BE-side game assignment.

**Architecture:** Next.js 14 App Router. New API routes under `app/api/` follow the existing route pattern (`requireManager()` guard, `sql` tagged-template from `@/lib/db`). `category_mappings` (migration 015) backs the Config section; `evaluator_roster` (extended by migration 016) backs Assign Setup and is its sole writer. Team weights forward to an n8n webhook like the existing platform/availability write-backs.

**Tech Stack:** Next.js 14.2, React 18, `postgres` (porsager) tagged templates, NextAuth, Jest + ts-jest + @testing-library/react.

## Global Constraints

- All write/manage routes guard with `requireManager()` (= `requireRole(['admin','moderator'])`) from `@/lib/auth-guard`. Read-only "any authed" uses `requireAuth()`.
- DB access only via `import { sql } from '@/lib/db'` (single `DATABASE_URL` connection; `game_info` is reachable on it).
- API route files set `export const dynamic = 'force-dynamic'`.
- API tests: first line `/**\n * @jest-environment node\n */`, `jest.mock('@/lib/db', () => ({ sql: jest.fn() }))`, set `process.env.SKIP_AUTH = 'true'` in `beforeAll`.
- Buckets are exactly `'puzzle' | 'arcade' | 'simulation'` (fixed; no add-bucket UI this round).
- Weight values are exactly `30 | 50 | 70 | 100` (default 100).
- `evaluator_roster.game_category` stores either the sentinel `'All'` or a comma-joined genre list (e.g. `'puzzle,word'`).
- Migrations are applied manually via Supabase SQL editor (no migrate script in repo). Migration files are still committed.
- Run the full suite with `npm test`; lint with `npm run lint`; type-check via `npm run build`.

---

### Task 1: Migration 016 — `evaluator_roster` per-bucket

**Files:**
- Create: `migrations/016_roster_bucket.sql`

**Interfaces:**
- Produces: `evaluator_roster` columns `category_group TEXT NOT NULL` (default backfill `'puzzle'`), `game_category TEXT`, and unique constraint `UNIQUE (list_type, category_group, name)`.

- [ ] **Step 1: Write the migration file**

```sql
-- Migration 016: evaluator_roster per-bucket — Assign Setup is the sole writer.
-- Adds category_group so the same person can sit in puzzle/arcade/simulation
-- independently, widens game_category for multi-genre values ('All' or 'a,b,c'),
-- and replaces UNIQUE(list_type, name) with UNIQUE(list_type, category_group, name).

ALTER TABLE evaluator_roster ADD COLUMN IF NOT EXISTS category_group TEXT;
UPDATE evaluator_roster SET category_group = 'puzzle' WHERE category_group IS NULL;
ALTER TABLE evaluator_roster ALTER COLUMN category_group SET NOT NULL;

ALTER TABLE evaluator_roster ALTER COLUMN game_category TYPE TEXT;

-- Drop the old (list_type, name) unique constraint. The name below is Postgres'
-- default for UNIQUE(list_type, name) created in migration 008; if `\d evaluator_roster`
-- shows a different name, drop that one instead.
ALTER TABLE evaluator_roster DROP CONSTRAINT IF EXISTS evaluator_roster_list_type_name_key;

ALTER TABLE evaluator_roster
  ADD CONSTRAINT evaluator_roster_bucket_name_key UNIQUE (list_type, category_group, name);
```

- [ ] **Step 2: Verify the file is well-formed**

Run: `grep -c "ALTER TABLE" migrations/016_roster_bucket.sql`
Expected: `4`

- [ ] **Step 3: Manual apply note (do not run a script)**

Add nothing to code. The implementer/user applies this in the Supabase SQL editor. Before applying, run `\d evaluator_roster` to confirm the existing unique constraint name matches `evaluator_roster_list_type_name_key`; if not, edit the `DROP CONSTRAINT` line. (This is an operational step, recorded here so it is not forgotten.)

- [ ] **Step 4: Commit**

```bash
git add migrations/016_roster_bucket.sql
git commit -m "feat: migration 016 — evaluator_roster per-bucket (category_group, multi-genre, new unique)"
```

---

### Task 2: Buckets + roster shared lib

**Files:**
- Create: `lib/buckets.ts`
- Test: `__tests__/lib/buckets.test.ts`

**Interfaces:**
- Produces:
  - `BUCKETS = ['puzzle','arcade','simulation'] as const`
  - `type Bucket = 'puzzle' | 'arcade' | 'simulation'`
  - `isBucket(v: unknown): v is Bucket`
  - `WEIGHTS = [30,50,70,100] as const`
  - `isWeight(v: unknown): v is 30|50|70|100`
  - `normalizeCategory(v: unknown): string` — returns `'All'` for empty/`'All'`/`'all'`, otherwise a trimmed comma-joined list of non-empty parts.

- [ ] **Step 1: Write the failing test**

```ts
import { isBucket, isWeight, normalizeCategory, BUCKETS, WEIGHTS } from '@/lib/buckets'

describe('lib/buckets', () => {
  it('BUCKETS and WEIGHTS have the expected members', () => {
    expect(BUCKETS).toEqual(['puzzle', 'arcade', 'simulation'])
    expect(WEIGHTS).toEqual([30, 50, 70, 100])
  })
  it('isBucket / isWeight validate membership', () => {
    expect(isBucket('puzzle')).toBe(true)
    expect(isBucket('rpg')).toBe(false)
    expect(isWeight(70)).toBe(true)
    expect(isWeight(60)).toBe(false)
    expect(isWeight('70')).toBe(false)
  })
  it('normalizeCategory maps empty/all → All, joins/trims lists', () => {
    expect(normalizeCategory('')).toBe('All')
    expect(normalizeCategory(undefined)).toBe('All')
    expect(normalizeCategory('all')).toBe('All')
    expect(normalizeCategory(' puzzle , word ,')).toBe('puzzle,word')
    expect(normalizeCategory(['puzzle', 'word'])).toBe('puzzle,word')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/lib/buckets.test.ts`
Expected: FAIL — cannot find module `@/lib/buckets`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/buckets.ts — shared bucket / weight / category helpers for Config + Assign Setup.

export const BUCKETS = ['puzzle', 'arcade', 'simulation'] as const
export type Bucket = (typeof BUCKETS)[number]
export function isBucket(v: unknown): v is Bucket {
  return typeof v === 'string' && (BUCKETS as readonly string[]).includes(v)
}

export const WEIGHTS = [30, 50, 70, 100] as const
export type Weight = (typeof WEIGHTS)[number]
export function isWeight(v: unknown): v is Weight {
  return typeof v === 'number' && (WEIGHTS as readonly number[]).includes(v)
}

/** Normalize a category multi-select value to storage form: 'All' or 'a,b,c'. */
export function normalizeCategory(v: unknown): string {
  const parts = Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? v.split(',')
      : []
  const clean = parts.map(p => String(p).trim()).filter(Boolean)
  if (clean.length === 0) return 'All'
  if (clean.length === 1 && clean[0].toLowerCase() === 'all') return 'All'
  return clean.filter(p => p.toLowerCase() !== 'all').join(',')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/lib/buckets.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/buckets.ts __tests__/lib/buckets.test.ts
git commit -m "feat: lib/buckets — shared bucket/weight/category helpers"
```

---

### Task 3: `/api/config/categories` route

**Files:**
- Create: `app/api/config/categories/route.ts`
- Test: `__tests__/api/config-categories.test.ts`

**Interfaces:**
- Consumes: `sql` (mocked), `isBucket` from `@/lib/buckets`.
- Produces HTTP route with:
  - `GET` → `{ puzzle: string[], arcade: string[], simulation: string[] }` (active genres per bucket; any authed).
  - `GET?manage=1` → `{ puzzle: Row[], ... }`, `Row = { id, genre, category_group, active }` (manager).
  - `GET?check=<genre>` → `{ exists: boolean }` (manager).
  - `POST { genre, category_group }` → `{ ok: true }` (manager).
  - `PATCH { id, active }` → `{ ok: true }` (manager).
  - `DELETE { id }` → `{ ok: true }` (manager).

- [ ] **Step 1: Write the failing test**

```ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { GET, POST } from '@/app/api/config/categories/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

function req(url: string, init?: RequestInit) {
  return new NextRequest(`http://localhost${url}`, init as never)
}

describe('/api/config/categories', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => sqlMock.mockReset())

  it('GET groups active genres by bucket', async () => {
    sqlMock.mockResolvedValueOnce([
      { genre: 'puzzle', category_group: 'puzzle' },
      { genre: 'word', category_group: 'puzzle' },
      { genre: 'arcade', category_group: 'arcade' },
    ])
    const res = await GET(req('/api/config/categories'))
    const json = await res.json()
    expect(json.puzzle).toEqual(['puzzle', 'word'])
    expect(json.arcade).toEqual(['arcade'])
    expect(json.simulation).toEqual([])
  })

  it('GET?check returns exists=true when game_info has the genre', async () => {
    sqlMock.mockResolvedValueOnce([{ one: 1 }])
    const res = await GET(req('/api/config/categories?check=Puzzle'))
    expect(await res.json()).toEqual({ exists: true })
  })

  it('GET?check returns exists=false for an unknown genre', async () => {
    sqlMock.mockResolvedValueOnce([])
    const res = await GET(req('/api/config/categories?check=zzz'))
    expect(await res.json()).toEqual({ exists: false })
  })

  it('POST rejects an invalid bucket', async () => {
    const res = await POST(req('/api/config/categories', {
      method: 'POST',
      body: JSON.stringify({ genre: 'foo', category_group: 'rpg' }),
    }))
    expect(res.status).toBe(400)
  })

  it('POST inserts a mapping', async () => {
    sqlMock.mockResolvedValueOnce([])
    const res = await POST(req('/api/config/categories', {
      method: 'POST',
      body: JSON.stringify({ genre: 'Roguelike', category_group: 'arcade' }),
    }))
    expect(await res.json()).toEqual({ ok: true })
    expect(sqlMock).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/api/config-categories.test.ts`
Expected: FAIL — cannot find module `@/app/api/config/categories/route`.

- [ ] **Step 3: Write the implementation**

```ts
// app/api/config/categories/route.ts — genre→bucket mappings (category_mappings table).
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { BUCKETS, isBucket } from '@/lib/buckets'

export const dynamic = 'force-dynamic'

interface MappingRow { id: number; genre: string; category_group: string; active: boolean }

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams
  const check = params.get('check')
  const manage = params.get('manage') === '1'

  // Genre-existence probe against game_info.metadata.categories (advisory only).
  if (check !== null) {
    const guard = await requireManager()
    if (guard) return guard
    const g = check.trim()
    if (!g) return NextResponse.json({ exists: false })
    const rows = await sql<{ one: number }[]>`
      SELECT 1 AS one FROM game_info
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(metadata->'categories') c
        WHERE lower(c) = lower(${g})
      )
      LIMIT 1
    `
    return NextResponse.json({ exists: rows.length > 0 }, { headers: { 'Cache-Control': 'no-store' } })
  }

  if (manage) {
    const guard = await requireManager()
    if (guard) return guard
    const rows = await sql<MappingRow[]>`
      SELECT id, genre, category_group, active
      FROM category_mappings
      ORDER BY category_group ASC, id ASC
    `
    const grouped: Record<string, MappingRow[]> = {}
    for (const b of BUCKETS) grouped[b] = []
    for (const r of rows) (grouped[r.category_group] ??= []).push(r)
    return NextResponse.json(grouped, { headers: { 'Cache-Control': 'no-store' } })
  }

  const guard = await requireAuth()
  if (guard) return guard
  const rows = await sql<{ genre: string; category_group: string }[]>`
    SELECT genre, category_group FROM category_mappings
    WHERE active = true
    ORDER BY category_group ASC, id ASC
  `
  const grouped: Record<string, string[]> = {}
  for (const b of BUCKETS) grouped[b] = []
  for (const r of rows) (grouped[r.category_group] ??= []).push(r.genre)
  return NextResponse.json(grouped, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const { genre, category_group } = await req.json()
  const g = typeof genre === 'string' ? genre.trim() : ''
  if (!g) return NextResponse.json({ error: 'genre is required' }, { status: 400 })
  if (!isBucket(category_group)) return NextResponse.json({ error: 'Invalid bucket' }, { status: 400 })
  try {
    await sql`
      INSERT INTO category_mappings (genre, category_group)
      VALUES (${g}, ${category_group})
      ON CONFLICT (genre, category_group) DO NOTHING
    `
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('POST /api/config/categories error:', err)
    return NextResponse.json({ error: 'Failed to add mapping' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const { id, active } = await req.json()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  if (typeof active !== 'boolean') return NextResponse.json({ error: 'active must be boolean' }, { status: 400 })
  try {
    await sql`UPDATE category_mappings SET active = ${active} WHERE id = ${id}`
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PATCH /api/config/categories error:', err)
    return NextResponse.json({ error: 'Failed to update mapping' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  try {
    await sql`DELETE FROM category_mappings WHERE id = ${id}`
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('DELETE /api/config/categories error:', err)
    return NextResponse.json({ error: 'Failed to delete mapping' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/api/config-categories.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/config/categories/route.ts __tests__/api/config-categories.test.ts
git commit -m "feat: /api/config/categories — genre→bucket CRUD + DB-existence check"
```

---

### Task 4: `useCategoryMappings` hook + Config Genre→Bucket UI

**Files:**
- Create: `hooks/useCategoryMappings.ts`
- Modify: `app/(manager)/config/page.tsx` (add a `<CategorySection/>` block after the `FIELDS.map(...)`)

**Interfaces:**
- Consumes: `/api/config/categories` route (Task 3), `BUCKETS` from `@/lib/buckets`.
- Produces:
  - `useCategoryMappings()` → `{ data: Record<Bucket, string[]>, loading: boolean, refresh: () => Promise<void> }` (active genres per bucket).

- [ ] **Step 1: Write the hook**

```ts
// hooks/useCategoryMappings.ts — active genres per bucket, for Config + Assign Setup.
'use client'
import { useCallback, useEffect, useState } from 'react'
import { BUCKETS, type Bucket } from '@/lib/buckets'

const EMPTY: Record<Bucket, string[]> = { puzzle: [], arcade: [], simulation: [] }

export function useCategoryMappings() {
  const [data, setData] = useState<Record<Bucket, string[]>>(EMPTY)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/config/categories', { cache: 'no-store' })
      if (res.ok) {
        const json = await res.json()
        const next = { ...EMPTY }
        for (const b of BUCKETS) next[b] = Array.isArray(json[b]) ? json[b] : []
        setData(next)
      }
    } catch { /* keep previous */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])
  return { data, loading, refresh }
}
```

- [ ] **Step 2: Add the manage-fetch + Category section to the Config page**

In `app/(manager)/config/page.tsx`, extend the manage-state and render. First add a state slice + fetch alongside the existing `fetchData` (which already calls `/api/config?manage=1`). Add a second fetch for categories. Insert this component definition at the bottom of the file and render `<CategorySection/>` right after the `{FIELDS.map(...)}` block inside the page `<div className="page">`.

```tsx
// --- add import at top of file ---
import { BUCKETS, type Bucket } from '@/lib/buckets'

// --- render: add after the {FIELDS.map(...)} block, before closing </div> ---
<CategorySection />
```

```tsx
// --- append to app/(manager)/config/page.tsx ---

interface MappingRow { id: number; genre: string; category_group: string; active: boolean }

const BUCKET_LABELS: Record<Bucket, string> = {
  puzzle: 'Puzzle', arcade: 'Arcade', simulation: 'Simulation',
}

function CategorySection() {
  const [data, setData] = useState<Record<Bucket, MappingRow[]>>({ puzzle: [], arcade: [], simulation: [] })
  const [loading, setLoading] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/config/categories?manage=1', { cache: 'no-store' })
      if (res.ok) {
        const json = await res.json()
        setData({ puzzle: json.puzzle ?? [], arcade: json.arcade ?? [], simulation: json.simulation ?? [] })
      }
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  async function send(method: string, body: unknown): Promise<boolean> {
    const res = await fetch('/api/config/categories', {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (res.ok) { await fetchData(); return true }
    return false
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-label">Genre → Bucket</span>
        <span className="card-note">Which game genres feed each evaluation bucket</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {BUCKETS.map(b => (
          <BucketGroup
            key={b}
            label={BUCKET_LABELS[b]}
            bucket={b}
            rows={data[b]}
            loading={loading}
            onAdd={(genre) => send('POST', { genre, category_group: b })}
            onToggle={(id, active) => send('PATCH', { id, active })}
            onDelete={(id) => send('DELETE', { id })}
          />
        ))}
      </div>
    </div>
  )
}

function BucketGroup({
  label, bucket, rows, loading, onAdd, onToggle, onDelete,
}: {
  label: string
  bucket: Bucket
  rows: MappingRow[]
  loading: boolean
  onAdd: (genre: string) => Promise<boolean>
  onToggle: (id: number, active: boolean) => Promise<boolean>
  onDelete: (id: number) => Promise<boolean>
}) {
  const [newValue, setNewValue] = useState('')
  const [warn, setWarn] = useState(false)
  const [checking, setChecking] = useState(false)

  async function attemptAdd() {
    const g = newValue.trim()
    if (!g) return
    setChecking(true)
    try {
      const res = await fetch(`/api/config/categories?check=${encodeURIComponent(g)}`, { cache: 'no-store' })
      const exists = res.ok ? (await res.json()).exists : true
      if (!exists && !warn) { setWarn(true); return }  // first attempt: show warning, require confirm
      if (await onAdd(g)) { setNewValue(''); setWarn(false) }
    } finally { setChecking(false) }
  }

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--faint)' }}>
        {label} <span style={{ fontWeight: 400 }}>· {rows.filter(r => r.active).length}/{rows.length}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {rows.length === 0 && !loading && <span className="empty">No genres</span>}
        {rows.map(r => (
          <span key={r.id} className="chip" style={{ opacity: r.active ? 1 : 0.45 }}>
            {r.genre}
            <button className="chip-x" title={r.active ? 'Disable' : 'Enable'}
              onClick={() => onToggle(r.id, !r.active)}>{r.active ? '⊘' : '⊙'}</button>
            <button className="chip-x" title="Delete" onClick={() => onDelete(r.id)}>✕</button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input className="input" style={{ flex: 1 }} value={newValue}
          onChange={e => { setNewValue(e.target.value); setWarn(false) }}
          onKeyDown={e => { if (e.key === 'Enter') attemptAdd() }}
          placeholder={`Add genre to ${label.toLowerCase()}…`} />
        <button className="btn btn-primary btn-sm" disabled={checking || !newValue.trim()} onClick={attemptAdd}>
          {checking ? '...' : warn ? 'Add anyway' : 'Add'}
        </button>
      </div>
      {warn && (
        <p className="msg-err" style={{ marginTop: 6, fontSize: 11 }}>
          ⚠️ “{newValue.trim()}” was never seen in the game database — check the spelling, or click “Add anyway”.
        </p>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Add chip styles**

In `app/globals.css`, append:

```css
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px 2px 10px;
  border: 1px solid var(--border); border-radius: 999px; font-size: 12px; background: var(--card); }
.chip-x { border: none; background: none; cursor: pointer; color: var(--faint);
  font-size: 11px; padding: 0 2px; line-height: 1; }
.chip-x:hover { color: var(--text); }
```

- [ ] **Step 4: Verify it builds and lints**

Run: `npm run lint && npm run build`
Expected: no errors; `/config` compiles.

- [ ] **Step 5: Manual check**

Run `npm run dev`, open `/config`. Confirm the three bucket groups render their seeded genres, adding a known genre (e.g. `casual`) succeeds, and adding gibberish (e.g. `zzzqqq`) shows the ⚠️ warning and only adds on the second click.

- [ ] **Step 6: Commit**

```bash
git add hooks/useCategoryMappings.ts app/\(manager\)/config/page.tsx app/globals.css
git commit -m "feat: Config Genre→Bucket editor with DB-existence warning"
```

---

### Task 5: Team tab Weight column

**Files:**
- Create: `app/api/team/initial/weight/route.ts`
- Test: `__tests__/api/team-weight.test.ts`
- Modify: `app/api/team/initial/route.ts` (map sheet `Weight` → `weight`)
- Modify: `app/(manager)/team/page.tsx` (add Weight column + add-row weight field)

**Interfaces:**
- Consumes: `isWeight` from `@/lib/buckets`, env `WEBHOOK_TEAM_INITIAL_WEIGHT`.
- Produces:
  - `POST /api/team/initial/weight` `{ row_number, weight }` → forwards to webhook, `{ ok: true }`.
  - `InitialEvaluator` gains `weight: number`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/team/initial/weight/route'

const realFetch = global.fetch

function req(body: unknown) {
  return new NextRequest('http://localhost/api/team/initial/weight', {
    method: 'POST', body: JSON.stringify(body),
  } as never)
}

describe('POST /api/team/initial/weight', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true'; process.env.WEBHOOK_TEAM_INITIAL_WEIGHT = 'http://hook' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip; global.fetch = realFetch })

  it('rejects a weight outside 30/50/70/100', async () => {
    const res = await req({ row_number: 2, weight: 60 })
    const r = await POST(res)
    expect(r.status).toBe(400)
  })

  it('forwards a valid weight to the webhook', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as never
    const r = await POST(req({ row_number: 2, weight: 70 }))
    expect(await r.json()).toEqual({ ok: true })
    expect(global.fetch).toHaveBeenCalledWith('http://hook', expect.objectContaining({ method: 'POST' }))
  })

  it('returns 502 when the webhook fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as never
    const r = await POST(req({ row_number: 2, weight: 70 }))
    expect(r.status).toBe(502)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/api/team-weight.test.ts`
Expected: FAIL — cannot find module `@/app/api/team/initial/weight/route`.

- [ ] **Step 3: Write the weight route**

```ts
// app/api/team/initial/weight/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { isWeight } from '@/lib/buckets'

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const url = process.env.WEBHOOK_TEAM_INITIAL_WEIGHT
  if (!url) return NextResponse.json({ error: 'WEBHOOK_TEAM_INITIAL_WEIGHT not configured' }, { status: 500 })

  const body = await req.json()
  if (!isWeight(body?.weight)) return NextResponse.json({ error: 'weight must be 30/50/70/100' }, { status: 400 })

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) return NextResponse.json({ error: 'Webhook failed' }, { status: 502 })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/api/team-weight.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Map the sheet Weight column in the GET route**

In `app/api/team/initial/route.ts`: add `weight: number` to the `InitialEvaluator` interface, add `'Weight'?: string | number` to `RawWebhookRow`, and map it:

```ts
// in the interface:
  weight: number
// in RawWebhookRow:
  'Weight'?: string | number
// in the .map(...) object:
  weight: Number(row['Weight']) || 100,
```

- [ ] **Step 6: Add the Weight column to the Team UI**

In `app/(manager)/team/page.tsx`:

```tsx
// interface InitialEvaluator: add
  weight: number

// state near pendingPlatform:
  const [pendingWeight, setPendingWeight] = useState<Record<number, number>>({})
  const [savingWeight, setSavingWeight] = useState<Set<number>>(new Set())

// add-form initial state: add weight
  const [addForm, setAddForm] = useState({ name: '', today_available: 'Yes' as 'Yes' | 'No', game_platform: 'all', game_category: '', weight: 100 })

// handler (place beside handlePlatformConfirm):
  async function handleWeightConfirm(rowNum: number) {
    const value = pendingWeight[rowNum]
    if (!value) return
    setSavingWeight(s => new Set(Array.from(s).concat([rowNum])))
    try {
      const res = await fetch('/api/team/initial/weight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_number: rowNum, weight: value }),
      })
      if (!res.ok) throw new Error()
      setRows(r => r.map(ev => ev.row_number === rowNum ? { ...ev, weight: value } : ev))
      setPendingWeight(p => { const n = { ...p }; delete n[rowNum]; return n })
    } catch {
      setError('Failed to update weight.')
    } finally {
      setSavingWeight(s => { const n = new Set(s); n.delete(rowNum); return n })
    }
  }
```

Add a header `<th>Weight</th>` after the Game Category header, and a cell after the Game Category cell in the data row:

```tsx
<td>
  {(() => {
    const pendingW = pendingWeight[ev.row_number]
    const currentW = pendingW ?? ev.weight ?? 100
    const isDirtyW = pendingW !== undefined && pendingW !== ev.weight
    const isSavingW = savingWeight.has(ev.row_number)
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <StyledSelect
          value={String(currentW)}
          onChange={v => setPendingWeight(p => ({ ...p, [ev.row_number]: Number(v) }))}
          options={[30, 50, 70, 100].map(w => ({ value: String(w), label: String(w) }))}
        />
        {isDirtyW && (
          <button className="btn btn-sm btn-primary"
            onClick={() => handleWeightConfirm(ev.row_number)} disabled={isSavingW}>
            {isSavingW ? '...' : 'Confirm'}
          </button>
        )}
      </div>
    )
  })()}
</td>
```

In the add-row `<tr>` add a Weight cell (before the actions cell):

```tsx
<td>
  <StyledSelect
    value={String(addForm.weight)}
    onChange={v => setAddForm(f => ({ ...f, weight: Number(v) }))}
    options={[30, 50, 70, 100].map(w => ({ value: String(w), label: String(w) }))}
  />
</td>
```

Update the two `colSpan={5}` empty/loading rows to `colSpan={6}`. Ensure `handleAdd`'s reset and the cancel button reset include `weight: 100`.

- [ ] **Step 7: Verify build + lint + tests**

Run: `npm run lint && npm test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add app/api/team/initial/weight/route.ts __tests__/api/team-weight.test.ts app/api/team/initial/route.ts app/\(manager\)/team/page.tsx
git commit -m "feat: Team tab editable Weight column (30/50/70/100) via n8n write-back"
```

> **Revised (2026-06-19):** the weight write now goes **directly** to the Evaluator List
> sheet via `lib/google-sheets.ts` (`updateEvaluatorWeight`), not through an n8n webhook —
> the Weight column already exists in that sheet and the OAuth credential already has access
> (same spreadsheet as Handover Log, `1kR6I3DnYCn67GUqZv0ms6cksUnRTHEBQniVjOuoEqlo`).
> No `WEBHOOK_TEAM_INITIAL_WEIGHT` and no manual sheet/n8n setup required. Reads still come
> through `WEBHOOK_TEAM_INITIAL_GET` (which already returns the Weight column).

---

### Task 6: `/api/assign-setup` routes

**Files:**
- Create: `app/api/assign-setup/route.ts` (GET/POST/PATCH/DELETE)
- Create: `app/api/assign-setup/recommend/route.ts` (GET)
- Test: `__tests__/api/assign-setup.test.ts`

**Interfaces:**
- Consumes: `sql` (mocked), `isBucket`, `isWeight`, `normalizeCategory` from `@/lib/buckets`.
- Produces:
  - `GET /api/assign-setup?group=<bucket>` → `{ initial: RosterRow[], final: RosterRow[] }`, `RosterRow = { id, name, today_available, game_platform, game_category, weight }`.
  - `GET /api/assign-setup/recommend?q=<text>` → `{ users: { name: string; email: string }[] }`.
  - `POST /api/assign-setup` `{ category_group, list_type, name, today_available?, game_platform?, game_category?, weight?, provision? }` → `{ ok: true }`.
  - `PATCH /api/assign-setup` `{ id, field, value }` (`field ∈ today_available|game_platform|game_category|weight`) → `{ ok: true }`.
  - `DELETE /api/assign-setup` `{ id }` → `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { GET, POST, PATCH } from '@/app/api/assign-setup/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock
function req(url: string, init?: RequestInit) { return new NextRequest(`http://localhost${url}`, init as never) }

describe('/api/assign-setup', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => sqlMock.mockReset())

  it('GET requires a valid group', async () => {
    const res = await GET(req('/api/assign-setup?group=rpg'))
    expect(res.status).toBe(400)
  })

  it('GET returns initial + final split by list_type', async () => {
    sqlMock.mockResolvedValueOnce([
      { id: 1, name: 'Ann', today_available: true, game_platform: 'all', game_category: 'All', weight: 100, list_type: 'initial' },
      { id: 2, name: 'Bob', today_available: false, game_platform: 'ios', game_category: 'word', weight: 70, list_type: 'final' },
    ])
    const res = await GET(req('/api/assign-setup?group=puzzle'))
    const json = await res.json()
    expect(json.initial).toHaveLength(1)
    expect(json.final).toHaveLength(1)
    expect(json.initial[0].name).toBe('Ann')
  })

  it('POST rejects an invalid bucket', async () => {
    const res = await POST(req('/api/assign-setup', {
      method: 'POST', body: JSON.stringify({ category_group: 'rpg', list_type: 'initial', name: 'X' }),
    }))
    expect(res.status).toBe(400)
  })

  it('POST with provision upserts dashboard_users then inserts the roster row', async () => {
    sqlMock.mockResolvedValue([])  // every statement resolves []
    const res = await POST(req('/api/assign-setup', {
      method: 'POST',
      body: JSON.stringify({ category_group: 'puzzle', list_type: 'initial', name: 'newperson', provision: true, weight: 50 }),
    }))
    expect(await res.json()).toEqual({ ok: true })
    const allSql = sqlMock.mock.calls.filter(c => Array.isArray(c[0])).map(c => (c[0] as string[]).join(' ')).join('\n')
    expect(allSql).toContain('dashboard_users')
    expect(allSql).toContain('evaluator_roster')
  })

  it('PATCH rejects an unknown field', async () => {
    const res = await PATCH(req('/api/assign-setup', {
      method: 'PATCH', body: JSON.stringify({ id: 1, field: 'role', value: 'admin' }),
    }))
    expect(res.status).toBe(400)
  })

  it('PATCH rejects an invalid weight', async () => {
    const res = await PATCH(req('/api/assign-setup', {
      method: 'PATCH', body: JSON.stringify({ id: 1, field: 'weight', value: 60 }),
    }))
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/api/assign-setup.test.ts`
Expected: FAIL — cannot find module `@/app/api/assign-setup/route`.

- [ ] **Step 3: Write the route**

```ts
// app/api/assign-setup/route.ts — DB-backed evaluator_roster editor (sole writer).
import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { isBucket, isWeight, normalizeCategory } from '@/lib/buckets'

export const dynamic = 'force-dynamic'

interface RosterRow {
  id: number; name: string; today_available: boolean
  game_platform: string; game_category: string; weight: number; list_type: string
}

const PLATFORMS = ['all', 'ios', 'android']

export async function GET(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const group = req.nextUrl.searchParams.get('group') ?? ''
  if (!isBucket(group)) return NextResponse.json({ error: 'Invalid group' }, { status: 400 })

  const rows = await sql<RosterRow[]>`
    SELECT id, name, today_available, game_platform, game_category, weight, list_type
    FROM evaluator_roster
    WHERE category_group = ${group}
    ORDER BY sort_order NULLS LAST, name ASC
  `
  return NextResponse.json({
    initial: rows.filter(r => r.list_type === 'initial'),
    final: rows.filter(r => r.list_type === 'final'),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const b = await req.json()

  if (!isBucket(b.category_group)) return NextResponse.json({ error: 'Invalid bucket' }, { status: 400 })
  if (b.list_type !== 'initial' && b.list_type !== 'final') return NextResponse.json({ error: 'Invalid list_type' }, { status: 400 })
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const platform = PLATFORMS.includes(b.game_platform) ? b.game_platform : 'all'
  const category = normalizeCategory(b.game_category)
  const weight = isWeight(b.weight) ? b.weight : 100
  const available = b.today_available === false ? false : true

  try {
    if (b.provision) {
      const email = `${name.toLowerCase().replace(/\s+/g, '')}@athena.studio`
      await sql`
        INSERT INTO dashboard_users (email, name, role)
        VALUES (${email}, ${name}, 'evaluator')
        ON CONFLICT (email) DO NOTHING
      `
    }
    await sql`
      INSERT INTO evaluator_roster (list_type, category_group, name, today_available, game_platform, game_category, weight)
      VALUES (${b.list_type}, ${b.category_group}, ${name}, ${available}, ${platform}, ${category}, ${weight})
      ON CONFLICT (list_type, category_group, name) DO NOTHING
    `
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('POST /api/assign-setup error:', err)
    return NextResponse.json({ error: 'Failed to add evaluator' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const { id, field, value } = await req.json()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  try {
    if (field === 'today_available') {
      await sql`UPDATE evaluator_roster SET today_available = ${value === true || value === 'Yes'}, updated_at = NOW() WHERE id = ${id}`
    } else if (field === 'game_platform') {
      if (!PLATFORMS.includes(value)) return NextResponse.json({ error: 'Invalid platform' }, { status: 400 })
      await sql`UPDATE evaluator_roster SET game_platform = ${value}, updated_at = NOW() WHERE id = ${id}`
    } else if (field === 'game_category') {
      await sql`UPDATE evaluator_roster SET game_category = ${normalizeCategory(value)}, updated_at = NOW() WHERE id = ${id}`
    } else if (field === 'weight') {
      if (!isWeight(value)) return NextResponse.json({ error: 'weight must be 30/50/70/100' }, { status: 400 })
      await sql`UPDATE evaluator_roster SET weight = ${value}, updated_at = NOW() WHERE id = ${id}`
    } else {
      return NextResponse.json({ error: 'Unknown field' }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PATCH /api/assign-setup error:', err)
    return NextResponse.json({ error: 'Failed to update' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  try {
    await sql`DELETE FROM evaluator_roster WHERE id = ${id}`
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('DELETE /api/assign-setup error:', err)
    return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Write the recommend route**

```ts
// app/api/assign-setup/recommend/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  if (!q) return NextResponse.json({ users: [] })
  const like = `%${q}%`
  const users = await sql<{ name: string; email: string }[]>`
    SELECT name, email FROM dashboard_users
    WHERE name ILIKE ${like} OR email ILIKE ${like}
    ORDER BY name ASC
    LIMIT 10
  `
  return NextResponse.json({ users }, { headers: { 'Cache-Control': 'no-store' } })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest __tests__/api/assign-setup.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add app/api/assign-setup __tests__/api/assign-setup.test.ts
git commit -m "feat: /api/assign-setup — per-bucket roster CRUD + new-user provisioning + recommend"
```

---

### Task 7: Assign Setup subtab UI + nav

**Files:**
- Create: `components/AssignSetup.tsx`
- Modify: `app/(manager)/layout.tsx` (add the nav child)
- Modify: `app/(manager)/evaluations/page.tsx` (dispatch `cat==='assign_setup'`)

**Interfaces:**
- Consumes: `/api/assign-setup`, `/api/assign-setup/recommend`, `useCategoryMappings`, `BUCKETS`, `WEIGHTS`, `StyledSelect`.

- [ ] **Step 1: Add the nav child**

In `app/(manager)/layout.tsx`, inside the Evaluations `children` array, after the `short_list` entry:

```tsx
{ href: '/evaluations?cat=assign_setup', label: 'Assign Setup', roles: ['admin', 'moderator'] },
```

- [ ] **Step 2: Dispatch in the evaluations page**

In `app/(manager)/evaluations/page.tsx`, at the top-level dispatch (currently `return category === 'short_list' ? <ShortListEvalTab /> : <EvaluationsPageInner />`), add the assign-setup branch and the import:

```tsx
import { AssignSetup } from '@/components/AssignSetup'
// ...
  if (category === 'assign_setup') return <AssignSetup />
  return category === 'short_list' ? <ShortListEvalTab /> : <EvaluationsPageInner />
```

- [ ] **Step 3: Write the component**

```tsx
// components/AssignSetup.tsx — DB-backed per-bucket evaluator roster editor.
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { StyledSelect } from '@/components/StyledSelect'
import { useCategoryMappings } from '@/hooks/useCategoryMappings'
import { BUCKETS, WEIGHTS, type Bucket } from '@/lib/buckets'

interface RosterRow {
  id: number; name: string; today_available: boolean
  game_platform: string; game_category: string; weight: number
}
type ListType = 'initial' | 'final'

const BUCKET_LABELS: Record<Bucket, string> = { puzzle: 'Puzzle', arcade: 'Arcade', simulation: 'Simulation' }
const WEIGHT_OPTS = WEIGHTS.map(w => ({ value: String(w), label: String(w) }))
const PLATFORM_OPTS = [{ value: 'all', label: 'all' }, { value: 'ios', label: 'ios' }, { value: 'android', label: 'android' }]
const AVAIL_OPTS = [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }]

export function AssignSetup() {
  const [bucket, setBucket] = useState<Bucket>('puzzle')
  const { data: catData } = useCategoryMappings()
  const [initial, setInitial] = useState<RosterRow[]>([])
  const [final, setFinal] = useState<RosterRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const genres = catData[bucket] ?? []

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/assign-setup?group=${bucket}`, { cache: 'no-store' })
      if (!res.ok) throw new Error()
      const json = await res.json()
      setInitial(json.initial ?? []); setFinal(json.final ?? [])
    } catch { setError('Failed to load roster.') }
    finally { setLoading(false) }
  }, [bucket])

  useEffect(() => { refresh() }, [refresh])

  async function patch(id: number, field: string, value: unknown) {
    const res = await fetch('/api/assign-setup', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, field, value }),
    })
    if (res.ok) refresh(); else setError('Update failed.')
  }
  async function remove(id: number) {
    const res = await fetch('/api/assign-setup', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    })
    if (res.ok) refresh(); else setError('Delete failed.')
  }
  async function add(list_type: ListType, payload: { name: string; provision: boolean }) {
    const res = await fetch('/api/assign-setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category_group: bucket, list_type, ...payload }),
    })
    if (res.ok) refresh(); else setError('Add failed.')
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h-title">Assign Setup</h1>
        <button className="btn btn-sm" onClick={refresh} disabled={loading}>
          <span className={loading ? 'spin' : ''}>↻</span>{loading ? '...' : 'Refresh'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {BUCKETS.map(b => (
          <button key={b} className={`seg-btn-premium${bucket === b ? ' active' : ''}`} onClick={() => setBucket(b)}>
            {BUCKET_LABELS[b]}
          </button>
        ))}
      </div>

      {error && <p className="msg-err" style={{ marginBottom: 8 }}>{error}</p>}

      <RosterTable title="Initial Evaluator" rows={initial} genres={genres}
        onPatch={patch} onRemove={remove} onAdd={p => add('initial', p)} />
      <RosterTable title="Final Evaluator" rows={final} genres={genres}
        onPatch={patch} onRemove={remove} onAdd={p => add('final', p)} />
    </div>
  )
}

function RosterTable({
  title, rows, genres, onPatch, onRemove, onAdd,
}: {
  title: string
  rows: RosterRow[]
  genres: string[]
  onPatch: (id: number, field: string, value: unknown) => void
  onRemove: (id: number) => void
  onAdd: (p: { name: string; provision: boolean }) => void
}) {
  return (
    <div className="card">
      <div className="card-head"><span className="card-label">{title}</span></div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Evaluator Name</th><th>Today Available</th><th>Platform</th>
              <th>Category</th><th style={{ width: 90 }}>Weight</th><th style={{ width: 80 }} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="empty">No evaluators yet</td></tr>}
            {rows.map(r => (
              <tr key={r.id}>
                <td className="cell-name">{r.name}</td>
                <td>
                  <StyledSelect value={r.today_available ? 'Yes' : 'No'} options={AVAIL_OPTS}
                    onChange={v => onPatch(r.id, 'today_available', v)} />
                </td>
                <td>
                  <StyledSelect value={r.game_platform || 'all'} options={PLATFORM_OPTS}
                    onChange={v => onPatch(r.id, 'game_platform', v)} />
                </td>
                <td>
                  <CategoryPicker value={r.game_category} genres={genres}
                    onChange={v => onPatch(r.id, 'game_category', v)} />
                </td>
                <td>
                  <StyledSelect value={String(r.weight ?? 100)} options={WEIGHT_OPTS}
                    onChange={v => onPatch(r.id, 'weight', Number(v))} />
                </td>
                <td>
                  <button className="btn btn-sm btn-danger" onClick={() => onRemove(r.id)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AddEvalRow onAdd={onAdd} />
    </div>
  )
}

// Multi-select category: 'All' or comma-joined genres of the active bucket.
function CategoryPicker({ value, genres, onChange }: { value: string; genres: string[]; onChange: (v: string) => void }) {
  const selected = useMemo(
    () => (value && value.toLowerCase() !== 'all' ? value.split(',').map(s => s.trim()).filter(Boolean) : []),
    [value],
  )
  const isAll = selected.length === 0
  const [open, setOpen] = useState(false)

  function toggle(g: string) {
    const next = selected.includes(g) ? selected.filter(x => x !== g) : [...selected, g]
    onChange(next.length === 0 ? 'All' : next.join(','))
  }

  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="ssel-btn" onClick={() => setOpen(o => !o)}>
        <span>{isAll ? 'All' : selected.join(', ')}</span>
        <span className="chev">▾</span>
      </button>
      {open && (
        <div className="ssel-menu" style={{ position: 'absolute', zIndex: 50, top: '100%', left: 0, minWidth: 160, maxHeight: 240, overflowY: 'auto' }}
          onMouseLeave={() => setOpen(false)}>
          <label className="ssel-opt" style={{ display: 'flex', gap: 6 }}>
            <input type="checkbox" checked={isAll} onChange={() => onChange('All')} /> All
          </label>
          {genres.map(g => (
            <label key={g} className="ssel-opt" style={{ display: 'flex', gap: 6 }}>
              <input type="checkbox" checked={selected.includes(g)} onChange={() => toggle(g)} /> {g}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// Add-eval input with dashboard_users autocomplete; unknown id → provision flag.
function AddEvalRow({ onAdd }: { onAdd: (p: { name: string; provision: boolean }) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [sugg, setSugg] = useState<{ name: string; email: string }[]>([])

  useEffect(() => {
    if (!name.trim()) { setSugg([]); return }
    let alive = true
    const t = setTimeout(async () => {
      const res = await fetch(`/api/assign-setup/recommend?q=${encodeURIComponent(name.trim())}`, { cache: 'no-store' })
      if (alive && res.ok) setSugg((await res.json()).users ?? [])
    }, 200)
    return () => { alive = false; clearTimeout(t) }
  }, [name])

  function submit(provision: boolean, value?: string) {
    const n = (value ?? name).trim()
    if (!n) return
    onAdd({ name: n, provision })
    setName(''); setSugg([]); setOpen(false)
  }

  const isKnown = sugg.some(s => s.name.toLowerCase() === name.trim().toLowerCase())

  if (!open) return <button className="add-row-btn" onClick={() => setOpen(true)}>+ Add evaluator</button>

  return (
    <div style={{ marginTop: 8, position: 'relative' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="input" style={{ flex: 1 }} autoFocus value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(!isKnown) }}
          placeholder="Type a name to search, or a new id (auto @athena.studio)…" />
        <button className="btn btn-primary btn-sm" disabled={!name.trim()} onClick={() => submit(!isKnown)}>
          {isKnown ? 'Add' : 'Add + create user'}
        </button>
        <button className="btn btn-sm" onClick={() => { setOpen(false); setName(''); setSugg([]) }}>✕</button>
      </div>
      {sugg.length > 0 && (
        <div className="ssel-menu" style={{ position: 'absolute', zIndex: 50, top: '100%', left: 0, right: 0, maxHeight: 200, overflowY: 'auto' }}>
          {sugg.map(s => (
            <div key={s.email} className="ssel-opt" onClick={() => submit(false, s.name)}>
              {s.name} <span style={{ color: 'var(--faint)' }}>· {s.email}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Verify build + lint + full test suite**

Run: `npm run lint && npm run build && npm test`
Expected: all green; `/evaluations?cat=assign_setup` compiles.

- [ ] **Step 5: Manual check**

Run `npm run dev`, open `/evaluations?cat=assign_setup`. Switch buckets; the category picker should list only the active bucket's genres (from Config). Add an existing user via the suggestion list; add a brand-new id and confirm the button reads "Add + create user". Edit availability/platform/category/weight inline; reload and confirm persistence.

- [ ] **Step 6: Commit**

```bash
git add components/AssignSetup.tsx app/\(manager\)/layout.tsx app/\(manager\)/evaluations/page.tsx
git commit -m "feat: Assign Setup subtab — per-bucket DB roster editor (initial + final)"
```

---

## Self-Review

**Spec coverage:**
- Team Weight column → Task 5. ✓
- Config Genre→Bucket + DB-existence warning → Tasks 3, 4. ✓
- Assign Setup subtab, 3 bucket tabs, initial+final full parity → Tasks 6, 7. ✓
- Per-bucket roster (category_group), multi-genre `game_category`, new unique → Task 1. ✓
- New-user provisioning (`@athena.studio` + dashboard_users) → Task 6 POST. ✓
- Category options = bucket's genres + All → Task 7 `CategoryPicker` + `useCategoryMappings`. ✓
- Recommend from dashboard_users → Task 6 recommend route + Task 7 `AddEvalRow`. ✓
- Sole writer of evaluator_roster (no n8n sync) → design decision; nothing to build. ✓

**Placeholder scan:** none — all steps contain concrete code/commands.

**Type consistency:** `RosterRow` fields match between Task 6 (route) and Task 7 (component); `normalizeCategory` / `isWeight` / `isBucket` / `BUCKETS` / `WEIGHTS` defined in Task 2 and used consistently; `WEBHOOK_TEAM_INITIAL_WEIGHT` named identically in Task 5 route + test + handoff note.

## Execution Handoff

Two execution options — see the prompt after this file is saved.
```
