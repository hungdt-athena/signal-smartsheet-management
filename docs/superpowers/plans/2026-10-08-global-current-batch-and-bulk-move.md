# Global Current Batch + Bulk Batch Move Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "current batch" one global value shared by every category group, and let managers move many games to another batch in one action from Short List.

**Architecture:** `lib/current-batch.ts` becomes the only reader of the single `app_config` key `current_batch` (with a fallback to the old per-category keys until migration 045 runs). Every route that used to read `current_batch:<category>` calls it. A new manager-only `POST /api/evaluations/batch-move` does one `UPDATE ... WHERE id = ANY(ids)`; Short List gets a Select mode (checkbox column) and a `BatchMoveBar` (target batch, Move, confirm dialog).

**Tech Stack:** Next.js 14 App Router, TypeScript, `postgres` (postgres.js) via `@/lib/db`, Jest + Testing Library (`jest-environment-node` for routes, jsdom for components).

**Spec:** `docs/superpowers/specs/2026-10-08-global-current-batch-and-bulk-move-design.md`

**Work in:** the worktree `/private/tmp/claude-501/-Users-anhhung-orca-workspaces-signal-smartsheet-management-main-3/3268dd21-7599-4c30-aac5-66f06324ab8a/scratchpad/global-batch` on branch `feat/global-current-batch` (created from `origin/main`). Every command below runs from that directory. `node_modules` is not present there; symlink it once:
`ln -s /Users/anhhung/orca/workspaces/signal-smartsheet-management/main-3/node_modules node_modules`

## Global Constraints

- The single key is `app_config.key = 'current_batch'`. Legacy keys are `current_batch:<category>`.
- Batch labels look like `W2 Oct, 2026`; order them with `weekLabelOrder` from `@/lib/weekly-feedback`, never as strings.
- Bulk move: admin or moderator only (`requireManager`), 1 to 500 ids per request, integers only, no filter on conclusion or final conclusion.
- Prod DB is ~225ms away per round-trip: `getCurrentBatch()` must stay ONE query.
- Run tests with `rtk proxy npx jest <path>` (plain `npx jest` output is compressed by RTK and hides failures). Typecheck with `rtk proxy npm run typecheck`.
- Never run `next build` without `NEXT_DIST_DIR=.next-check` (a dev server may be running); delete `.next-check` and `git checkout -- tsconfig.json` afterwards.
- `app/api/evaluations/route.ts` contains a NUL byte. Edit it with a Python string replace (below), never the Edit tool, and diff it with `git diff --text`.
- 9 suites already fail on `origin/main` and are unrelated: `effort-sessions`, `evaluators`, `handover`, `reassign`, `users-active`, `weekly-feedback-batches`, `weekly-feedback`, `workflows-trigger`, `people-config-db` (17 failing tests). Report them unchanged; do not fix them.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- UI copy is plain and direct, one idea per line, no metaphors (reader is Vietnamese reading English).

## Review Focus

1. **Clearing the current batch while legacy keys still exist** must yield "none", not the old per-category value. (Task 1 test `treats an empty global row as none`.)
2. **Hidden rows must never be moved.** Changing category, batch, evaluator, conclusion, final-conclusion or date filter must drop the selection. (Task 6 test.)
3. **Clicking a checkbox must not open the game panel.** (Task 6 test.)
4. **Bad ids to `batch-move`:** duplicates, strings, floats, negatives, zero, empty array, 501 ids. Duplicates collapse; the rest are 400. (Task 4 tests.)
5. **Ids that do not exist** return a smaller `moved` count, not an error. (Task 4 test.)
6. **A game that already has a final conclusion is moved**, with the confirm dialog saying so. (Task 4 SQL test + Task 5 dialog test.)

---

### Task 1: One global reader (`lib/current-batch.ts`) and the missing-demo route

**Files:**
- Modify: `lib/current-batch.ts` (full replacement)
- Modify: `__tests__/lib/current-batch.test.ts` (full replacement)
- Modify: `app/api/evaluations/missing-demo/route.ts`
- Modify: `__tests__/api/evaluations-missing-demo.test.ts` (full replacement)

**Interfaces:**
- Produces: `CURRENT_BATCH_KEY: 'current_batch'`, `pickCurrentBatch(rows: {key: string; value: string | null}[]): string | null`, `getCurrentBatch(): Promise<string | null>`. `getCurrentBatches` and `onlyCurrentBatch` are removed.

- [ ] **Step 1: Replace the lib test**

Write `__tests__/lib/current-batch.test.ts`:

```ts
/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
import { getCurrentBatch, pickCurrentBatch } from '@/lib/current-batch'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

describe('pickCurrentBatch', () => {
  it('uses the global value', () => {
    expect(pickCurrentBatch([{ key: 'current_batch', value: 'W2 Oct, 2026' }])).toBe('W2 Oct, 2026')
  })

  it('lets the global row win over legacy per-category rows, whatever their order', () => {
    expect(pickCurrentBatch([
      { key: 'current_batch:puzzle', value: 'W1 Oct, 2026' },
      { key: 'current_batch', value: 'W2 Oct, 2026' },
    ])).toBe('W2 Oct, 2026')
  })

  it('treats an empty global row as "none set" and does NOT fall back to legacy rows', () => {
    // A manager who clears the batch before migration 045 has run must get "none".
    expect(pickCurrentBatch([
      { key: 'current_batch:puzzle', value: 'W2 Oct, 2026' },
      { key: 'current_batch', value: null },
    ])).toBeNull()
    expect(pickCurrentBatch([
      { key: 'current_batch:puzzle', value: 'W2 Oct, 2026' },
      { key: 'current_batch', value: '' },
    ])).toBeNull()
  })

  it('falls back to the newest legacy value when there is no global row', () => {
    expect(pickCurrentBatch([
      { key: 'current_batch:arcade', value: 'W1 Oct, 2026' },
      { key: 'current_batch:puzzle', value: 'W2 Oct, 2026' },
    ])).toBe('W2 Oct, 2026')
  })

  it('compares legacy values by week order, not as strings', () => {
    // As strings "W4 Sep" > "W1 Oct" ('4' > '1'); by week order October is newer.
    expect(pickCurrentBatch([
      { key: 'current_batch:arcade', value: 'W4 Sep, 2026' },
      { key: 'current_batch:puzzle', value: 'W1 Oct, 2026' },
    ])).toBe('W1 Oct, 2026')
    expect(pickCurrentBatch([
      { key: 'current_batch:arcade', value: 'W4 Dec, 2026' },
      { key: 'current_batch:puzzle', value: 'W1 Jan, 2027' },
    ])).toBe('W1 Jan, 2027')
  })

  it('ignores blank legacy values and unrelated keys', () => {
    expect(pickCurrentBatch([
      { key: 'current_batch:simulation', value: null },
      { key: 'current_batch:arcade', value: '' },
      { key: 'something_else', value: 'W9 Oct, 2026' },
    ])).toBeNull()
  })

  it('returns null when nothing is set', () => {
    expect(pickCurrentBatch([])).toBeNull()
  })
})

describe('getCurrentBatch', () => {
  beforeEach(() => sqlMock.mockReset())

  it('reads app_config in ONE query and returns the picked value', async () => {
    sqlMock.mockResolvedValue([
      { key: 'current_batch:puzzle', value: 'W1 Oct, 2026' },
      { key: 'current_batch', value: 'W2 Oct, 2026' },
    ])
    expect(await getCurrentBatch()).toBe('W2 Oct, 2026')
    expect(sqlMock).toHaveBeenCalledTimes(1)
    const text = (sqlMock.mock.calls[0][0] as string[]).join(' ')
    expect(text).toContain('app_config')
    expect(text).toContain("'current_batch'")
    expect(text).toContain("LIKE 'current_batch:%'")
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `rtk proxy npx jest __tests__/lib/current-batch.test.ts`
Expected: FAIL, `pickCurrentBatch` / `getCurrentBatch` is not exported from `@/lib/current-batch`.

- [ ] **Step 3: Replace the lib**

Write `lib/current-batch.ts`:

```ts
import { sql } from '@/lib/db'
import { weekLabelOrder } from '@/lib/weekly-feedback'

/** app_config key holding the ONE current batch shared by every category group. */
export const CURRENT_BATCH_KEY = 'current_batch'
const LEGACY_PREFIX = 'current_batch:'

interface ConfigRow { key: string; value: string | null }

/** Pure choice of the current batch from the app_config rows that matched.
 *
 *  A global row is authoritative even when its value is empty: clearing the batch must
 *  mean "none", not "whatever a legacy per-category row still says". Legacy rows
 *  (`current_batch:<category>`) only matter until migration 045 folds them into the
 *  global row; until then the newest one by week order stands in, so code deployed
 *  before the migration never reports "no active batch" for the whole system. */
export function pickCurrentBatch(rows: ConfigRow[]): string | null {
  const global = rows.find(r => r.key === CURRENT_BATCH_KEY)
  if (global) return global.value || null
  let best: string | null = null
  for (const r of rows) {
    if (!r.key.startsWith(LEGACY_PREFIX) || !r.value) continue
    if (best === null || weekLabelOrder(r.value) > weekLabelOrder(best)) best = r.value
  }
  return best
}

/** The current batch, or null when none is set. One query: the database is ~225ms
 *  away, so the legacy fallback rides along in the same read instead of a second one. */
export async function getCurrentBatch(): Promise<string | null> {
  const rows = await sql`
    SELECT key, value FROM app_config
    WHERE key = 'current_batch' OR key LIKE 'current_batch:%'
  `
  return pickCurrentBatch(rows as unknown as ConfigRow[])
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `rtk proxy npx jest __tests__/lib/current-batch.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Replace the missing-demo route test**

Write `__tests__/api/evaluations-missing-demo.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))

import { GET } from '@/app/api/evaluations/missing-demo/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

type Binds = unknown[]
let gameQueries: { text: string; binds: Binds }[] = []

function game(over: Record<string, unknown>) {
  return {
    id: 1, game_id: 'g1', title: 'Game', icon_url: null, genre_1: 'Casual',
    category_group: 'puzzle', batch: 'W2 Oct, 2026', evaluate_date: '2026-10-07T10:00:00Z',
    ...over,
  }
}

/** config rows for getCurrentBatch(); `games` for the missing-demo query. */
function db(config: { key: string; value: string | null }[], games: Record<string, unknown>[]) {
  gameQueries = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: Binds) => {
    const text = Array.isArray(strings) ? (strings as string[]).join(' ') : ''
    if (text.includes('app_config')) return Promise.resolve(config)
    gameQueries.push({ text, binds })
    return Promise.resolve(games)
  })
}

const CFG = [{ key: 'current_batch', value: 'W2 Oct, 2026' }]

function req(qs = '') {
  return new NextRequest(`http://localhost/api/evaluations/missing-demo${qs}`)
}

describe('GET /api/evaluations/missing-demo', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeEach(() => {
    process.env.SKIP_AUTH = 'false'
    sessionMock.mockResolvedValue({ user: { name: 'PhuongNT1', role: 'evaluator' } })
  })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('rejects a caller who is not signed in', async () => {
    sessionMock.mockResolvedValue(null)
    db(CFG, [])
    const res = await GET(req())
    expect(res.status).toBe(401)
  })

  it('asks only for the signed-in user\'s own List_Idea games with no demo link', async () => {
    db(CFG, [game({})])
    await GET(req())
    expect(gameQueries).toHaveLength(1)
    const { text, binds } = gameQueries[0]
    expect(text).toMatch(/initial_conclusion\s*=\s*'List_Idea'/)
    expect(text).toMatch(/drive_link/)
    expect(text).toMatch(/lower\(ge\.initial_evaluator\)\s*=\s*lower\(/)
    expect(binds).toContain('PhuongNT1')
  })

  it('ignores a crafted ?evaluator= -- it can never reveal someone else\'s games', async () => {
    db(CFG, [])
    await GET(req('?evaluator=HuyDD'))
    expect(gameQueries[0].binds).toContain('PhuongNT1')
    expect(gameQueries[0].binds).not.toContain('HuyDD')
  })

  it('does not query games at all for a user with no name', async () => {
    sessionMock.mockResolvedValue({ user: { name: null, role: 'evaluator' } })
    db(CFG, [game({})])
    const res = await GET(req())
    expect(await res.json()).toEqual({ items: [] })
    expect(gameQueries).toHaveLength(0)
  })

  it('does not query games when no current batch is set', async () => {
    db([{ key: 'current_batch', value: null }], [game({})])
    const res = await GET(req())
    expect(await res.json()).toEqual({ items: [] })
    expect(gameQueries).toHaveLength(0)
  })

  it('asks the database for the one current batch', async () => {
    db(CFG, [])
    await GET(req())
    expect(gameQueries[0].text).toMatch(/ge\.batch\s*=/)
    expect(gameQueries[0].binds).toContain('W2 Oct, 2026')
  })

  it('applies the one batch to every category, with no per-category filtering', async () => {
    db(CFG, [
      game({ id: 1, category_group: 'puzzle' }),
      game({ id: 2, category_group: 'arcade' }),
      game({ id: 3, category_group: 'simulation' }),
    ])
    const body = await (await GET(req())).json()
    expect(body.items.map((i: { id: number }) => i.id)).toEqual([1, 2, 3])
  })

  it('returns the fields the panel renders', async () => {
    db(CFG, [game({ id: 1, title: 'ArcFlush', icon_url: 'https://x/i.png' })])
    const body = await (await GET(req())).json()
    expect(body.items[0]).toEqual({
      id: 1, game_id: 'g1', title: 'ArcFlush', icon_url: 'https://x/i.png',
      category: 'puzzle', genre: 'Casual', batch: 'W2 Oct, 2026',
      evaluate_date: '2026-10-07T10:00:00Z',
    })
  })
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `rtk proxy npx jest __tests__/api/evaluations-missing-demo.test.ts`
Expected: FAIL (the route still imports `getCurrentBatches` / `onlyCurrentBatch`, which no longer exist, so the suite errors; if it runs, `applies the one batch to every category` fails).

- [ ] **Step 7: Update the route**

In `app/api/evaluations/missing-demo/route.ts`: replace the two imports

```ts
import { getCurrentBatches, onlyCurrentBatch } from '@/lib/current-batch'
import { weekLabelOrder } from '@/lib/weekly-feedback'
```
with
```ts
import { getCurrentBatch } from '@/lib/current-batch'
```
and replace everything from `const current = await getCurrentBatches()` through the `.sort(...)`/`.map(...)` chain with:

```ts
    const current = await getCurrentBatch()
    if (!current) return NextResponse.json({ items: [] })

    const rows = await sql`
      SELECT ge.id, ge.game_id, gi.title, gi.icon_url, ge.genre_1, ge.category_group,
        ge.batch, ge.evaluate_date
      FROM game_evaluations ge
      JOIN game_info gi ON gi.game_id = ge.game_id
      WHERE ge.initial_conclusion = 'List_Idea'
        AND COALESCE(ge.drive_link, '') = ''
        AND lower(ge.initial_evaluator) = lower(${me})
        AND ge.batch = ${current}
      ORDER BY ge.evaluate_date DESC NULLS LAST, ge.id
    ` as unknown as Row[]

    const items = rows.map(r => ({
      id: r.id,
      game_id: r.game_id,
      title: r.title,
      icon_url: r.icon_url,
      category: r.category_group,
      genre: r.genre_1,
      batch: r.batch,
      evaluate_date: r.evaluate_date,
    }))
```
Also change the header comment line "limited to the current batch" to stay accurate (it already is) and keep the rest of the handler.

- [ ] **Step 8: Run both suites and typecheck**

Run: `rtk proxy npx jest __tests__/lib/current-batch.test.ts __tests__/api/evaluations-missing-demo.test.ts __tests__/components/missing-demo-prompt.test.tsx && rtk proxy npm run typecheck`
Expected: all PASS; typecheck prints no errors.

- [ ] **Step 9: Commit**

```bash
git add lib/current-batch.ts __tests__/lib/current-batch.test.ts app/api/evaluations/missing-demo/route.ts __tests__/api/evaluations-missing-demo.test.ts
git commit -m "refactor(batch): read one global current batch, with a legacy fallback

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Set the global batch (route, client helper, Short List picker, migration 045)

**Files:**
- Modify: `app/api/evaluations/current-batch/route.ts` (full replacement)
- Create: `lib/current-batch-client.ts`
- Create: `__tests__/api/evaluations-current-batch.test.ts`
- Create: `__tests__/lib/current-batch-client.test.ts`
- Create: `migrations/045_global_current_batch.sql`
- Modify: `app/(manager)/evaluations/page.tsx` (the Short List picker handler)

**Interfaces:**
- Consumes: `getCurrentBatch`, `CURRENT_BATCH_KEY` from Task 1.
- Produces: `saveCurrentBatch(batch: string | null): Promise<boolean>` in `lib/current-batch-client.ts`; `GET /api/evaluations/current-batch` → `{ current_batch: string | null }`; `POST` body `{ batch: string | null }` → `{ current_batch: string | null }`.

- [ ] **Step 1: Write the route test**

Write `__tests__/api/evaluations-current-batch.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))

import { GET, POST } from '@/app/api/evaluations/current-batch/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

let calls: { text: string; binds: unknown[] }[] = []

function db(config: { key: string; value: string | null }[]) {
  calls = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    const text = Array.isArray(strings) ? (strings as string[]).join(' ') : ''
    calls.push({ text, binds })
    return Promise.resolve(text.includes('SELECT key, value') ? config : [])
  })
}

const post = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/evaluations/current-batch', {
    method: 'POST', body: JSON.stringify(body),
  } as never))

describe('/api/evaluations/current-batch', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeEach(() => {
    process.env.SKIP_AUTH = 'false'
    sessionMock.mockResolvedValue({ user: { name: 'HungDT', role: 'admin' } })
  })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('GET returns the global value, ignoring a ?category=', async () => {
    db([
      { key: 'current_batch:puzzle', value: 'W1 Oct, 2026' },
      { key: 'current_batch', value: 'W2 Oct, 2026' },
    ])
    const res = await GET(new NextRequest('http://localhost/api/evaluations/current-batch?category=puzzle'))
    expect(await res.json()).toEqual({ current_batch: 'W2 Oct, 2026' })
  })

  it('POST writes the single global key, whatever category the caller sends', async () => {
    db([])
    const res = await post({ category: 'arcade', batch: 'W3 Oct, 2026' })
    expect(await res.json()).toEqual({ current_batch: 'W3 Oct, 2026' })
    const write = calls.find(c => c.text.includes('INSERT INTO app_config'))!
    expect(write.binds[0]).toBe('current_batch')
    expect(write.binds).toContain('W3 Oct, 2026')
    expect(JSON.stringify(write.binds)).not.toContain('arcade')
  })

  it('POST with no batch stores null, meaning "none"', async () => {
    db([])
    const res = await post({ batch: null })
    expect(await res.json()).toEqual({ current_batch: null })
    const write = calls.find(c => c.text.includes('INSERT INTO app_config'))!
    expect(write.binds[1]).toBeNull()
  })

  it('POST is refused for an evaluator', async () => {
    sessionMock.mockResolvedValue({ user: { name: 'PhuongNT1', role: 'evaluator' } })
    db([])
    const res = await post({ batch: 'W3 Oct, 2026' })
    expect(res.status).toBe(403)
    expect(calls.some(c => c.text.includes('INSERT INTO app_config'))).toBe(false)
  })

  it('POST is refused when not signed in', async () => {
    sessionMock.mockResolvedValue(null)
    db([])
    const res = await post({ batch: 'W3 Oct, 2026' })
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `rtk proxy npx jest __tests__/api/evaluations-current-batch.test.ts`
Expected: FAIL (the old route reads/writes `current_batch:<category>`; 401 case fails or `INSERT` bind[0] is `current_batch:arcade`).

- [ ] **Step 3: Replace the route**

Write `app/api/evaluations/current-batch/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { CURRENT_BATCH_KEY, getCurrentBatch } from '@/lib/current-batch'

export const dynamic = 'force-dynamic'

// The ONE active weekly batch, shared by every category group. Managers set it;
// evaluators marking a game List_Idea get this batch forced (see EvalDetailPanel).
// Stored in app_config under key `current_batch`.

export async function GET() {
  const guard = await requireAuth()
  if (guard) return guard

  return NextResponse.json({ current_batch: await getCurrentBatch() })
}

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  try {
    const { batch } = await req.json()
    const value = batch ? String(batch) : null
    await sql`
      INSERT INTO app_config (key, value, updated_at)
      VALUES (${CURRENT_BATCH_KEY}, ${value}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
    `
    return NextResponse.json({ current_batch: value })
  } catch (err) {
    console.error('POST /api/evaluations/current-batch error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `rtk proxy npx jest __tests__/api/evaluations-current-batch.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the client-helper test**

Write `__tests__/lib/current-batch-client.test.ts`:

```ts
import { saveCurrentBatch } from '@/lib/current-batch-client'

describe('saveCurrentBatch', () => {
  it('POSTs only the batch (no category) and resolves true on success', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true })
    global.fetch = fetchMock as unknown as typeof fetch
    expect(await saveCurrentBatch('W2 Oct, 2026')).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/evaluations/current-batch')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ batch: 'W2 Oct, 2026' })
  })

  it('sends null to clear the batch', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true })
    global.fetch = fetchMock as unknown as typeof fetch
    await saveCurrentBatch(null)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ batch: null })
  })

  it('resolves false on a non-ok response and on a network error', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch
    expect(await saveCurrentBatch('W2 Oct, 2026')).toBe(false)
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch
    expect(await saveCurrentBatch('W2 Oct, 2026')).toBe(false)
  })
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `rtk proxy npx jest __tests__/lib/current-batch-client.test.ts`
Expected: FAIL, cannot find module `@/lib/current-batch-client`.

- [ ] **Step 7: Write the helper**

Write `lib/current-batch-client.ts`:

```ts
/** Set (or clear, with null) the global current batch. Resolves true on success.
 *  A network failure resolves false rather than throwing. */
export async function saveCurrentBatch(batch: string | null): Promise<boolean> {
  try {
    const res = await fetch('/api/evaluations/current-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch }),
    })
    return res.ok
  } catch {
    return false
  }
}
```

- [ ] **Step 8: Run it and watch it pass**

Run: `rtk proxy npx jest __tests__/lib/current-batch-client.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 9: Point the Short List picker at the helper**

Apply with Python (the page is large; exact-string replace, each `old` must appear exactly once):

```bash
python3 - <<'EOF'
p = 'app/(manager)/evaluations/page.tsx'
s = open(p).read()
def swap(old, new):
    global s
    assert s.count(old) == 1, old[:60]
    s = s.replace(old, new)
swap("import { saveDriveLink } from '@/lib/drive-link-client'\n",
     "import { saveDriveLink } from '@/lib/drive-link-client'\nimport { saveCurrentBatch } from '@/lib/current-batch-client'\n")
swap("""  const saveCurrentBatch = async (v: string) => {
    setCurrentBatch(v || null)
    try {
      await fetch('/api/evaluations/current-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: filterCategory, batch: v || null }),
      })
    } catch { /* ignore */ }
  }
""", """  const handleCurrentBatchChange = async (v: string) => {
    setCurrentBatch(v || null)
    await saveCurrentBatch(v || null)
  }
""")
swap("                onChange={saveCurrentBatch}\n", "                onChange={handleCurrentBatchChange}\n")
open(p, 'w').write(s)
EOF
```

Also change the label under "Current batch" (same file) from `evaluators auto-fill this for List_Idea` to `all categories · evaluators auto-fill this for List_Idea` so the manager sees it is global:

```bash
python3 - <<'EOF'
p = 'app/(manager)/evaluations/page.tsx'
s = open(p).read()
old = "evaluators auto-fill this for List_Idea"
assert s.count(old) == 1
open(p, 'w').write(s.replace(old, "all categories · evaluators auto-fill this for List_Idea"))
EOF
```

- [ ] **Step 10: Write migration 045**

Write `migrations/045_global_current_batch.sql`:

```sql
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
```

- [ ] **Step 11: Dry-run the migration on prod without changing anything**

Write a throwaway script in the scratchpad (not in the repo) and run it. It does two things: (a) runs the migration's SELECT, which must list `W2 Oct, 2026` first (prod had both legacy keys at `W2 Oct, 2026` on 2026-10-08), and (b) runs `EXPLAIN` on the real INSERT and DELETE statements, which makes Postgres parse and plan them without executing, so a syntax or type error in the migration shows up now:

```bash
SP=/private/tmp/claude-501/-Users-anhhung-orca-workspaces-signal-smartsheet-management-main-3/3268dd21-7599-4c30-aac5-66f06324ab8a/scratchpad
cat > $SP/dryrun045.cjs <<'EOF'
const { createRequire } = require('module'); const fs = require('fs')
const repo = '/Users/anhhung/orca/workspaces/signal-smartsheet-management/main-3'
const postgres = createRequire(repo + '/package.json')('postgres')
for (const l of fs.readFileSync(repo + '/.env.local', 'utf8').split('\n')) { const m = l.match(/^DATABASE_URL=(.*)$/); if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, '') }
const sql = postgres(process.env.DATABASE_URL, { max: 1 })
;(async () => {
  const rows = await sql`
    WITH legacy AS (
      SELECT value,
        substring(value from '[0-9]{4}$')::int * 10000
        + array_position(ARRAY['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'],
            lower(substring(value from '^W[0-9]+ +([A-Za-z]{3})'))) * 100
        + substring(value from '^W([0-9]+)')::int AS ord
      FROM app_config
      WHERE starts_with(key, 'current_batch:') AND value ~ '^W[0-9]+ +[A-Za-z]+, *[0-9]{4}$'
    )
    SELECT value, ord FROM legacy ORDER BY ord DESC`
  console.log(JSON.stringify(rows))
  const migration = fs.readFileSync(process.cwd() + '/migrations/045_global_current_batch.sql', 'utf8')
  const [insertStmt, deleteStmt] = migration.split(/;\s*\n/).map(x => x.replace(/^(--.*\n)+/gm, '').trim()).filter(x => /^(WITH|DELETE)/.test(x))
  await sql.unsafe('EXPLAIN ' + insertStmt)
  await sql.unsafe('EXPLAIN ' + deleteStmt)
  console.log('INSERT and DELETE parse and plan OK')
  await sql.end()
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
EOF
node $SP/dryrun045.cjs
```
Run it from the worktree root (the script reads `migrations/045_global_current_batch.sql` relative to the current directory). Expected output: a JSON array whose first element has `"value":"W2 Oct, 2026"` and `ord` 20261002, then `INSERT and DELETE parse and plan OK`. If it errors, fix the SQL in the migration file before continuing. DO NOT apply the migration: the user applies it by hand (Task 7).

- [ ] **Step 12: Typecheck and commit**

Run: `rtk proxy npm run typecheck` (expected: no errors) and
`rtk proxy npx jest __tests__/api/evaluations-current-batch.test.ts __tests__/lib/current-batch-client.test.ts` (expected: PASS).

```bash
git add app/api/evaluations/current-batch/route.ts lib/current-batch-client.ts __tests__/api/evaluations-current-batch.test.ts __tests__/lib/current-batch-client.test.ts migrations/045_global_current_batch.sql "app/(manager)/evaluations/page.tsx"
git commit -m "feat(batch): set the current batch once for every category

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The three other readers use the global batch

**Files:**
- Modify: `app/api/evaluations/facets/route.ts`
- Modify: `app/api/evaluations/route.ts` (NUL byte: Python replace only)
- Modify: `app/api/evaluations/[gameId]/route.ts`
- Create: `__tests__/api/current-batch-readers.test.ts`

**Interfaces:**
- Consumes: `getCurrentBatch` (Task 1). Each route's JSON shape is unchanged: facets and list return `current_batch` and `default_batch`; `[gameId]` returns `data.current_batch`.

- [ ] **Step 1: Write the failing test**

Write `__tests__/api/current-batch-readers.test.ts`. The config rows put a legacy row FIRST and the global row second, so code that still reads "the first row" or a per-category key returns the wrong batch:

```ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))
jest.mock('@/lib/config', () => ({ getConfigValues: jest.fn(async () => []) }))
jest.mock('@/lib/people-config-db', () => ({ loadHiddenEvaluatorKeys: jest.fn(async () => []) }))

import { GET as getList } from '@/app/api/evaluations/route'
import { GET as getFacets } from '@/app/api/evaluations/facets/route'
import { GET as getOne } from '@/app/api/evaluations/[gameId]/route'
import { clearAvailableMonthsCache } from '@/lib/evaluations-filters'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

// Legacy row first, global row second: a reader that takes "the first row" or builds a
// per-category key gets W1; the right answer is the global W2.
const CONFIG = [
  { key: 'current_batch:arcade', value: 'W1 Oct, 2026' },
  { key: 'current_batch', value: 'W2 Oct, 2026' },
]

function db({ present = [] as { batch: string }[], game = null as Record<string, unknown> | null } = {}) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('app_config')) return Promise.resolve(CONFIG)
    if (q.includes('FROM game_evaluations ge') && q.includes('LEFT JOIN developer')) {
      return Promise.resolve(game ? [game] : [])
    }
    if (q.includes('SELECT DISTINCT ge.batch') && q.includes('JOIN game_info')) return Promise.resolve(present)
    if (q.includes('SELECT DISTINCT ge.batch')) return Promise.resolve(present)
    if (q.includes('count(*)')) return Promise.resolve([{ total: 0, evaluated: 0 }])
    return Promise.resolve([])
  })
}

describe('readers of the current batch use the one global value', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => clearAvailableMonthsCache())

  it('GET /api/evaluations/facets', async () => {
    db({ present: [{ batch: 'W2 Oct, 2026' }] })
    const res = await getFacets(new NextRequest('http://localhost/api/evaluations/facets?category=arcade'))
    const json = await res.json()
    expect(json.current_batch).toBe('W2 Oct, 2026')
    expect(json.default_batch).toBe('W2 Oct, 2026')
  })

  it('GET /api/evaluations (page 1 with meta)', async () => {
    db({ present: [{ batch: 'W2 Oct, 2026' }] })
    const res = await getList(new NextRequest('http://localhost/api/evaluations?category=arcade&page=1'))
    const json = await res.json()
    expect(json.current_batch).toBe('W2 Oct, 2026')
    expect(json.default_batch).toBe('W2 Oct, 2026')
  })

  it('GET /api/evaluations/[gameId] returns it as data.current_batch for any category', async () => {
    db({ game: { id: 1, game_id: 'g1', category_group: 'arcade', initial_evaluator: 'X', screenshot_urls: null, manual_screenshot_urls: null } })
    const res = await getOne(
      new NextRequest('http://localhost/api/evaluations/g1?category=arcade'),
      { params: { gameId: 'g1' } },
    )
    const json = await res.json()
    expect(json.data.current_batch).toBe('W2 Oct, 2026')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `rtk proxy npx jest __tests__/api/current-batch-readers.test.ts`
Expected: FAIL, 3 tests: facets and list return `W1 Oct, 2026` (first row), `[gameId]` returns `null`.

- [ ] **Step 3: Update `facets/route.ts`**

```bash
python3 - <<'EOF'
p = 'app/api/evaluations/facets/route.ts'
s = open(p).read()
def swap(old, new):
    global s
    assert s.count(old) == 1, old[:70]
    s = s.replace(old, new)
swap("import { getConfigValues } from '@/lib/config'\n",
     "import { getConfigValues } from '@/lib/config'\nimport { getCurrentBatch } from '@/lib/current-batch'\n")
swap("      distinctConclusions, batchRows, cfg, presentRows,\n",
     "      distinctConclusions, batchRows, currentBatchVal, presentRows,\n")
swap("      sql`SELECT value FROM app_config WHERE key = ${`current_batch:${category}`}`,\n",
     "      getCurrentBatch(),\n")
swap("    const currentBatchVal: string | null = (cfg[0]?.value as string | undefined) ?? null\n", "")
open(p, 'w').write(s)
EOF
```

- [ ] **Step 4: Update `route.ts` (list)**

```bash
python3 - <<'EOF'
p = 'app/api/evaluations/route.ts'
s = open(p, 'rb').read().decode('utf-8')
def swap(old, new):
    global s
    assert s.count(old) == 1, old[:70]
    s = s.replace(old, new)
swap("import { sql } from '@/lib/db'\n",
     "import { sql } from '@/lib/db'\nimport { getCurrentBatch } from '@/lib/current-batch'\n")
swap("const [conclusionOptions, hiddenEvaluatorKeys, batchRows, cfg, presentRows] = await Promise.all([",
     "const [conclusionOptions, hiddenEvaluatorKeys, batchRows, currentBatchVal, presentRows] = await Promise.all([")
swap("        sql`SELECT value FROM app_config WHERE key = ${`current_batch:${category}`}`,\n",
     "        getCurrentBatch(),\n")
swap("      const currentBatchVal: string | null = cfg[0]?.value ?? null\n", "")
open(p, 'wb').write(s.encode('utf-8'))
EOF
git diff --text --stat app/api/evaluations/route.ts
```
Expected: the diff stat shows a handful of changed lines (the NUL byte must survive: `git diff --text app/api/evaluations/route.ts` shows only the four edits).

- [ ] **Step 5: Update `[gameId]/route.ts`**

```bash
python3 - <<'EOF'
p = 'app/api/evaluations/[gameId]/route.ts'
s = open(p).read()
def swap(old, new):
    global s
    assert s.count(old) == 1, old[:70]
    s = s.replace(old, new)
swap("import { sql } from '@/lib/db'\n",
     "import { sql } from '@/lib/db'\nimport { getCurrentBatch } from '@/lib/current-batch'\n")
swap("""    // The game and the team's current-batch config go out together. The config read
    // used to come after the game had landed, because the key it wants is built from
    // that game's category_group -- one more serialized round-trip on the panel's
    // hottest path (every open, every Next). There are only three categories, so
    // reading all of them costs nothing on a connection that is otherwise idle and
    // lets both queries share one round-trip. The right one is picked out below.
    const [rows, batchCfg] = await Promise.all([""",
"""    // The game and the team's current batch go out together: they are independent,
    // so they share one round-trip on the panel's hottest path (every open, every Next).
    const [rows, currentBatch] = await Promise.all([""")
swap("""      sql<{ key: string; value: string }[]>`
        SELECT key, value FROM app_config WHERE key LIKE 'current_batch:%'
      `,
    ])""", """      getCurrentBatch(),
    ])""")
swap("""    // Team-wide "current batch" for this game's category — drives the forced
    // batch evaluators get when marking List_Idea (see EvalDetailPanel).
    row.current_batch =
      batchCfg.find(c => c.key === `current_batch:${row.category_group}`)?.value ?? null
""", """    // Team-wide current batch (one value for every category) — drives the forced
    // batch evaluators get when marking List_Idea (see EvalDetailPanel).
    row.current_batch = currentBatch
""")
open(p, 'w').write(s)
EOF
```

- [ ] **Step 6: Run the new test, the existing list-route suite and typecheck**

Run: `rtk proxy npx jest __tests__/api/current-batch-readers.test.ts __tests__/api/evaluations.test.ts __tests__/api/eval-detail.test.ts && rtk proxy npm run typecheck`
Expected: PASS everywhere, no type errors. If `evaluations.test.ts` now fails because its generic sql mock returns `[]` for the `getCurrentBatch()` query, that is fine: `pickCurrentBatch([])` returns null. Anything else failing is a real regression: stop and fix.

- [ ] **Step 7: Commit**

```bash
git add app/api/evaluations/facets/route.ts app/api/evaluations/route.ts "app/api/evaluations/[gameId]/route.ts" __tests__/api/current-batch-readers.test.ts
git commit -m "refactor(batch): facets, list and game detail read the global batch

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `POST /api/evaluations/batch-move`

**Files:**
- Create: `app/api/evaluations/batch-move/route.ts`
- Create: `__tests__/api/evaluations-batch-move.test.ts`

**Interfaces:**
- Produces: `POST /api/evaluations/batch-move`, body `{ ids: number[]; batch: string }`, response `{ moved: number }`; constant `MAX_MOVE = 500` exported from the route module.

- [ ] **Step 1: Write the failing test**

Write `__tests__/api/evaluations-batch-move.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))

import { POST, MAX_MOVE } from '@/app/api/evaluations/batch-move/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

let calls: { text: string; binds: unknown[] }[] = []

/** `updated` = the rows the UPDATE ... RETURNING id hands back. */
function db(updated: { id: number }[] = []) {
  calls = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    calls.push({ text: Array.isArray(strings) ? (strings as string[]).join(' ') : '', binds })
    return Promise.resolve(updated)
  })
}

const post = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/evaluations/batch-move', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  } as never))

describe('POST /api/evaluations/batch-move', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeEach(() => {
    process.env.SKIP_AUTH = 'false'
    sessionMock.mockResolvedValue({ user: { name: 'HungDT', role: 'admin' } })
  })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('is refused when not signed in, and for an evaluator', async () => {
    db()
    sessionMock.mockResolvedValue(null)
    expect((await post({ ids: [1], batch: 'W2 Oct, 2026' })).status).toBe(401)
    sessionMock.mockResolvedValue({ user: { name: 'PhuongNT1', role: 'evaluator' } })
    expect((await post({ ids: [1], batch: 'W2 Oct, 2026' })).status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('lets a moderator through', async () => {
    db([{ id: 1 }])
    sessionMock.mockResolvedValue({ user: { name: 'Mod', role: 'moderator' } })
    expect((await post({ ids: [1], batch: 'W2 Oct, 2026' })).status).toBe(200)
  })

  it.each([
    ['empty ids', { ids: [], batch: 'W2 Oct, 2026' }],
    ['ids missing', { batch: 'W2 Oct, 2026' }],
    ['ids not an array', { ids: 5, batch: 'W2 Oct, 2026' }],
    ['string id', { ids: ['1'], batch: 'W2 Oct, 2026' }],
    ['float id', { ids: [1.5], batch: 'W2 Oct, 2026' }],
    ['negative id', { ids: [-3], batch: 'W2 Oct, 2026' }],
    ['zero id', { ids: [0], batch: 'W2 Oct, 2026' }],
    ['blank batch', { ids: [1], batch: '   ' }],
    ['missing batch', { ids: [1] }],
    ['non-string batch', { ids: [1], batch: 7 }],
  ])('400 for %s, and never touches the database', async (_name, body) => {
    db()
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(typeof (await res.json()).error).toBe('string')
    expect(calls).toHaveLength(0)
  })

  it('400 for a body that is not JSON', async () => {
    db()
    expect((await post('not json')).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('accepts exactly MAX_MOVE ids and refuses one more', async () => {
    expect(MAX_MOVE).toBe(500)
    db([])
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
    expect((await post({ ids: ids(500), batch: 'W2 Oct, 2026' })).status).toBe(200)
    expect((await post({ ids: ids(501), batch: 'W2 Oct, 2026' })).status).toBe(400)
  })

  it('collapses duplicate ids before updating', async () => {
    db([{ id: 1 }, { id: 2 }])
    await post({ ids: [1, 2, 2, 1], batch: 'W2 Oct, 2026' })
    expect(calls[0].binds).toContainEqual([1, 2])
  })

  it('moves a game that already has a final conclusion: the UPDATE has no conclusion filter', async () => {
    db([{ id: 1 }])
    await post({ ids: [1], batch: 'W2 Oct, 2026' })
    const { text } = calls[0]
    expect(text).toMatch(/UPDATE game_evaluations/)
    expect(text).not.toMatch(/final_conclusion|initial_conclusion/)
  })

  it('updates only the listed ids, stamps who did it, and trims the batch', async () => {
    db([{ id: 4 }, { id: 9 }])
    await post({ ids: [4, 9], batch: '  W3 Oct, 2026 ' })
    const { text, binds } = calls[0]
    expect(text).toMatch(/WHERE id = ANY\(/)
    expect(text).toMatch(/updated_by/)
    expect(binds).toContain('W3 Oct, 2026')
    expect(binds).toContain('HungDT')
    expect(binds).toContainEqual([4, 9])
  })

  it('returns how many rows actually changed; ids that do not exist are not an error', async () => {
    db([{ id: 4 }])
    const res = await post({ ids: [4, 9999], batch: 'W3 Oct, 2026' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ moved: 1 })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `rtk proxy npx jest __tests__/api/evaluations-batch-move.test.ts`
Expected: FAIL, cannot find module `@/app/api/evaluations/batch-move/route`.

- [ ] **Step 3: Write the route**

Write `app/api/evaluations/batch-move/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { getSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

/** Same as the Short List page size, so "select all shown" always fits. */
export const MAX_MOVE = 500

// Move many games to another batch in one statement (manager tier only).
//
// There is deliberately NO filter on initial/final conclusion: ticking a game that
// already has a final conclusion means the manager wants it moved, and PATCH's
// lock on a finished game does not apply to this explicit bulk action. Only the
// listed ids can change; ids that do not exist simply do not count in `moved`.

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  let body: { ids?: unknown; batch?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const batch = typeof body.batch === 'string' ? body.batch.trim() : ''
  if (!batch) return NextResponse.json({ error: 'batch is required' }, { status: 400 })

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return NextResponse.json({ error: 'ids must be a non-empty array' }, { status: 400 })
  }
  if (!body.ids.every(n => Number.isInteger(n) && (n as number) > 0)) {
    return NextResponse.json({ error: 'ids must be positive integers' }, { status: 400 })
  }
  const ids = Array.from(new Set(body.ids as number[]))
  if (ids.length > MAX_MOVE) {
    return NextResponse.json({ error: `Move at most ${MAX_MOVE} games at a time` }, { status: 400 })
  }

  try {
    const actor = process.env.SKIP_AUTH === 'true' ? null : (await getSession())?.user?.name ?? null
    const rows = await sql`
      UPDATE game_evaluations
      SET batch = ${batch}, updated_by = ${actor}, updated_at = NOW()
      WHERE id = ANY(${ids})
      RETURNING id
    `
    return NextResponse.json({ moved: rows.length })
  } catch (err) {
    console.error('POST /api/evaluations/batch-move error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `rtk proxy npx jest __tests__/api/evaluations-batch-move.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Prove the SQL against the real database, read-only**

The unit test mocks `sql`, so check the parameter types with a SELECT of the same shape (writes nothing):

```bash
SP=/private/tmp/claude-501/-Users-anhhung-orca-workspaces-signal-smartsheet-management-main-3/3268dd21-7599-4c30-aac5-66f06324ab8a/scratchpad
cat > $SP/anyids.cjs <<'EOF'
const { createRequire } = require('module'); const fs = require('fs')
const repo = '/Users/anhhung/orca/workspaces/signal-smartsheet-management/main-3'
const postgres = createRequire(repo + '/package.json')('postgres')
for (const l of fs.readFileSync(repo + '/.env.local', 'utf8').split('\n')) { const m = l.match(/^DATABASE_URL=(.*)$/); if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, '') }
const sql = postgres(process.env.DATABASE_URL, { max: 1 })
;(async () => {
  const ids = Array.from(new Set([1, 2, 3]))
  const r = await sql`SELECT id FROM game_evaluations WHERE id = ANY(${ids})`
  console.log('ANY(int[]) ok, rows:', r.length)
  await sql.end()
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
EOF
node $SP/anyids.cjs
```
Expected: `ANY(int[]) ok, rows: <number>`. (An earlier run already proved this on 2026-10-08; this re-checks the exact shape used by the route.)

- [ ] **Step 6: Commit**

```bash
git add app/api/evaluations/batch-move/route.ts __tests__/api/evaluations-batch-move.test.ts
git commit -m "feat(batch): add a manager-only bulk batch-move endpoint

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `BatchMoveBar` (action bar + confirm dialog) and its client helper

**Files:**
- Create: `lib/batch-move-client.ts`
- Create: `components/BatchMoveBar.tsx`
- Create: `__tests__/components/batch-move-bar.test.tsx`
- Modify: `app/globals.css` (append a small block)

**Interfaces:**
- Consumes: `POST /api/evaluations/batch-move` (Task 4); `StyledSelect` from `@/components/StyledSelect` (props `{ value, onChange, options: {value,label}[], placeholder? }`).
- Produces:
  - `moveBatch(ids: number[], batch: string): Promise<{ ok: true; moved: number } | { ok: false; error: string }>`
  - `BatchMoveBar` props: `{ selected: { id: number; final_conclusion: string | null }[]; batchOptions: string[]; onCancel: () => void; onMoved: (moved: number) => void }`

- [ ] **Step 1: Write the failing test**

Write `__tests__/components/batch-move-bar.test.tsx`. `StyledSelect` is a custom portal dropdown; swap it for a native `<select>` so the test drives the choice with `fireEvent.change`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

jest.mock('@/components/StyledSelect', () => ({
  StyledSelect: ({ value, onChange, options, placeholder }: {
    value: string; onChange: (v: string) => void
    options: { value: string; label: string }[]; placeholder?: string
  }) => (
    <select aria-label={placeholder ?? 'select'} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}))

import { BatchMoveBar } from '@/components/BatchMoveBar'

const OPTIONS = ['W3 Oct, 2026', 'W2 Oct, 2026']
const plain = { id: 1, final_conclusion: null }
const locked = { id: 2, final_conclusion: 'Good' }

function mount(selected = [plain, locked], over: Partial<React.ComponentProps<typeof BatchMoveBar>> = {}) {
  const onCancel = jest.fn()
  const onMoved = jest.fn()
  render(<BatchMoveBar selected={selected} batchOptions={OPTIONS} onCancel={onCancel} onMoved={onMoved} {...over} />)
  return { onCancel, onMoved }
}
const pick = (v: string) => fireEvent.change(screen.getByLabelText('Move to batch'), { target: { value: v } })

let moveBody: unknown
function stubFetch(result: { ok: boolean; json: unknown }) {
  moveBody = null
  global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    moveBody = JSON.parse(String(init?.body))
    return { ok: result.ok, json: async () => result.json } as Response
  }) as unknown as typeof fetch
}

describe('BatchMoveBar', () => {
  it('shows the selected count and keeps Move disabled until a batch is chosen', () => {
    mount()
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled()
    pick('W2 Oct, 2026')
    expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled()
  })

  it('asks for confirmation first, naming the count and the batch', () => {
    mount()
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Move 2 games to W2 Oct, 2026?')
  })

  it('says how many selected games already have a final conclusion', () => {
    mount([plain, locked, { id: 3, final_conclusion: 'Priority I' }])
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('2 of them already have a final conclusion and will move too')
  })

  it('uses the singular for exactly one locked game, and says nothing when none are locked', () => {
    mount([plain, locked])
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('1 of them already has a final conclusion and will move too')
  })

  it('has no final-conclusion line when nobody is locked', () => {
    mount([plain, { id: 5, final_conclusion: null }])
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('dialog')).not.toHaveTextContent('final conclusion')
  })

  it('uses the singular title for one game', () => {
    mount([plain])
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Move 1 game to W2 Oct, 2026?')
  })

  it('does nothing when the dialog is cancelled', () => {
    stubFetch({ ok: true, json: { moved: 2 } })
    const { onMoved } = mount()
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(onMoved).not.toHaveBeenCalled()
  })

  it('POSTs the ids and batch on confirm, then reports how many moved', async () => {
    stubFetch({ ok: true, json: { moved: 2 } })
    const { onMoved } = mount()
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }))
    await waitFor(() => expect(onMoved).toHaveBeenCalledWith(2))
    expect(moveBody).toEqual({ ids: [1, 2], batch: 'W2 Oct, 2026' })
  })

  it('shows the server error and does not report a move when the request fails', async () => {
    stubFetch({ ok: false, json: { error: 'Forbidden' } })
    const { onMoved } = mount()
    pick('W2 Oct, 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }))
    await screen.findByText(/Couldn.t move: Forbidden/)
    expect(onMoved).not.toHaveBeenCalled()
  })

  it('Cancel on the bar leaves select mode', () => {
    const { onCancel } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `rtk proxy npx jest __tests__/components/batch-move-bar.test.tsx`
Expected: FAIL, cannot find module `@/components/BatchMoveBar`.

- [ ] **Step 3: Write the client helper**

Write `lib/batch-move-client.ts`:

```ts
export type MoveResult = { ok: true; moved: number } | { ok: false; error: string }

/** Move games to another batch. Never throws: a network failure is a failed result. */
export async function moveBatch(ids: number[], batch: string): Promise<MoveResult> {
  try {
    const res = await fetch('/api/evaluations/batch-move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, batch }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: typeof json.error === 'string' ? json.error : 'Request failed' }
    return { ok: true, moved: Number(json.moved) || 0 }
  } catch {
    return { ok: false, error: 'Network error' }
  }
}
```

- [ ] **Step 4: Write the component**

Write `components/BatchMoveBar.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { StyledSelect } from '@/components/StyledSelect'
import { moveBatch } from '@/lib/batch-move-client'

export interface SelectedGame { id: number; final_conclusion: string | null }

/** Bottom bar of Short List's select mode: pick a batch, Move, confirm.
 *  Moving a game that already has a final conclusion is allowed (ticking it means the
 *  manager wants it moved); the confirm dialog says how many such games are included,
 *  because batch is also the week the Record tab shows. */
export function BatchMoveBar({ selected, batchOptions, onCancel, onMoved }: {
  selected: SelectedGame[]
  batchOptions: string[]
  onCancel: () => void
  onMoved: (moved: number) => void
}) {
  const [batch, setBatch] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const n = selected.length
  const locked = selected.filter(s => !!s.final_conclusion).length

  async function confirm() {
    setBusy(true)
    setError(null)
    const res = await moveBatch(selected.map(s => s.id), batch)
    setBusy(false)
    if (!res.ok) { setError(`Couldn't move: ${res.error}`); return }
    setConfirming(false)
    onMoved(res.moved)
  }

  return (
    <>
      <div className="bmb" role="region" aria-label="Move games to another batch">
        <span className="bmb-count">{n} selected</span>
        <span className="bmb-label">Move to</span>
        <div style={{ width: 190 }}>
          <StyledSelect
            value={batch}
            onChange={setBatch}
            placeholder="Move to batch"
            options={batchOptions.map(b => ({ value: b, label: b }))}
          />
        </div>
        <button className="btn btn-primary btn-sm" disabled={!batch || n === 0}
          onClick={() => { setError(null); setConfirming(true) }}>
          Move
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>

      {confirming && (
        <div className="modal-backdrop">
          <div className="modal bmb-dialog" role="dialog" aria-modal="true" aria-labelledby="bmb-title">
            <div className="modal-head">
              <div className="modal-title" id="bmb-title" style={{ whiteSpace: 'normal' }}>
                Move {n} {n === 1 ? 'game' : 'games'} to {batch}?
              </div>
            </div>
            <div className="modal-body">
              {locked > 0 && (
                <p className="bmb-note">
                  {locked} of them already {locked === 1 ? 'has' : 'have'} a final conclusion and will move too.
                </p>
              )}
              {error && <p className="bmb-err">{error}</p>}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setConfirming(false)} disabled={busy}>Back</button>
              <button className="btn btn-primary" onClick={confirm} disabled={busy}>
                {busy ? 'Moving…' : 'Confirm move'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 5: Append the CSS**

Append to `app/globals.css`:

```css

/* ===== Short List bulk move (components/BatchMoveBar.tsx) ===== */
.bmb { display: flex; align-items: center; gap: 10px; padding: 10px 16px; margin-top: 10px; background: var(--surface); border: 1px solid var(--accent-border); border-radius: 12px; box-shadow: var(--shadow-md); flex: none; }
.bmb-count { font-size: 13px; font-weight: 700; color: var(--accent); }
.bmb-label { font-size: 12px; color: var(--muted); margin-left: 6px; }
.bmb-dialog { max-width: 440px; }
.bmb-note { margin: 0; font-size: 13px; color: var(--warn); background: var(--warn-weak); border-radius: 8px; padding: 8px 10px; }
.bmb-err { margin: 0; font-size: 12.5px; color: var(--bad); }
```

- [ ] **Step 6: Run the test, typecheck, commit**

Run: `rtk proxy npx jest __tests__/components/batch-move-bar.test.tsx && rtk proxy npm run typecheck`
Expected: PASS (10 tests), no type errors.

```bash
git add lib/batch-move-client.ts components/BatchMoveBar.tsx __tests__/components/batch-move-bar.test.tsx app/globals.css
git commit -m "feat(batch): BatchMoveBar with a confirm dialog that counts finished games

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Select mode in Short List

**Files:**
- Modify: `app/(manager)/evaluations/page.tsx` (only inside `ShortListEvalTab`, which starts at `function ShortListEvalTab()`)
- Create: `__tests__/components/evaluations-select-mode.test.tsx`

**Interfaces:**
- Consumes: `BatchMoveBar` / `SelectedGame` (Task 5); the existing `currentBatchOptions` array and `fetchData` / `fetchFacets` callbacks inside `ShortListEvalTab`.
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing test**

Write `__tests__/components/evaluations-select-mode.test.tsx`. It renders the Short List tab (`?cat=short_list`) as a manager or an evaluator, with `StyledSelect` replaced by a native select and the heavy cell children stubbed:

```tsx
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

class NoopObserver {
  observe() { /* never intersects in jsdom */ }
  disconnect() { /* nothing */ }
  unobserve() { /* nothing */ }
}
global.IntersectionObserver = NoopObserver as unknown as typeof IntersectionObserver

let mockRole = 'admin'
jest.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { id: 1, role: mockRole, name: 'HungDT', email: 'hungdt@athena.studio' } },
    status: 'authenticated',
  }),
}))
jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('cat=short_list'),
}))
jest.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ conclusion: [], final_conclusion: [] }) }))
jest.mock('@/components/EvalDetailPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="eval-panel" />,
  weekBatches: () => ['W3 Oct, 2026', 'W2 Oct, 2026'],
}))
jest.mock('@/components/StyledSelect', () => ({
  StyledSelect: ({ value, onChange, options, placeholder }: {
    value: string; onChange: (v: string) => void
    options: { value: string; label: string }[]; placeholder?: string
  }) => (
    <select aria-label={placeholder ?? 'select'} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}))
jest.mock('@/components/TrendTagCell', () => ({ TrendTagCell: () => null }))
jest.mock('@/components/QuickStatsModal', () => ({ QuickStatsModal: () => null }))
jest.mock('@/components/weekly-feedback/WeeklyFeedbackTab', () => ({ WeeklyFeedbackTab: () => null }))
jest.mock('@/components/TaggingTab', () => ({ TaggingTab: () => null }))

import EvaluationsPage from '@/app/(manager)/evaluations/page'

const row = (over: Record<string, unknown>) => ({
  id: 1, game_id: 'g1', title: 'Alpha', icon_url: null, os: 'ios', app_link: null,
  genre_1: null, genre_2: null, initial_evaluator: 'HungDT', initial_note: null, final_note: null,
  game_alike: null, initial_conclusion: 'List_Idea', final_conclusion: null,
  batch: 'W1 Oct, 2026', drive_link: null, publisher_name: null, assigned_date: null,
  evaluate_date: null, category_group: 'puzzle', tags: null, ...over,
})
const ROWS = [row({ id: 1, game_id: 'g1', title: 'Alpha' }), row({ id: 2, game_id: 'g2', title: 'Beta', final_conclusion: 'Good' })]

function stubFetch() {
  const calls: { url: string; init?: RequestInit }[] = []
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    let body: unknown = {}
    if (url.startsWith('/api/evaluations/facets')) {
      body = { available_months: [], available_conclusions: ['List_Idea'], available_evaluators: [], available_batches: ['W1 Oct, 2026'], current_batch: 'W2 Oct, 2026', default_batch: 'W1 Oct, 2026' }
    } else if (url.startsWith('/api/evaluations/batch-move')) {
      body = { moved: 2 }
    } else if (url.startsWith('/api/evaluations?')) {
      body = { data: ROWS, total: 2, applied_month: null }
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  }) as unknown as typeof fetch
  return calls
}
const rowsCalls = (calls: { url: string }[]) => calls.filter(c => c.url.startsWith('/api/evaluations?'))

async function open(role = 'admin') {
  mockRole = role
  const calls = stubFetch()
  render(<EvaluationsPage />)
  await screen.findByText('Alpha')
  return calls
}
const checkboxes = () => screen.queryAllByRole('checkbox')

describe('Short List select mode', () => {
  it('shows no Select button to an evaluator', async () => {
    await open('evaluator')
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull()
  })

  it('hides the checkboxes until Select is pressed, then shows one per game plus select-all', async () => {
    await open()
    expect(checkboxes()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    expect(checkboxes()).toHaveLength(3)
    expect(screen.getByLabelText('Select all shown')).toBeInTheDocument()
  })

  it('Cancel hides the checkboxes and drops the selection', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByLabelText('Select Alpha'))
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0])
    expect(checkboxes()).toHaveLength(0)
    expect(screen.queryByText('1 selected')).toBeNull()
  })

  it('the action bar appears only while something is selected, and select-all selects every shown game', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    expect(screen.queryByText(/selected$/)).toBeNull()
    fireEvent.click(screen.getByLabelText('Select all shown'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Select all shown'))
    expect(screen.queryByText(/selected$/)).toBeNull()
  })

  it('clicking a checkbox does not open the game panel, but clicking the row does', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByLabelText('Select Alpha'))
    expect(screen.queryByTestId('eval-panel')).toBeNull()
    fireEvent.click(screen.getByText('Beta'))
    expect(screen.getByTestId('eval-panel')).toBeInTheDocument()
  })

  it('changing a filter drops the selection, so hidden games can never be moved', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByLabelText('Select all shown'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'arcade' } })
    await waitFor(() => expect(screen.queryByText(/selected$/)).toBeNull())
  })

  it('moves the selected games, leaves select mode and reloads the rows and the batch list', async () => {
    const calls = await open()
    const before = rowsCalls(calls).length
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByLabelText('Select all shown'))
    fireEvent.change(screen.getByLabelText('Move to batch'), { target: { value: 'W2 Oct, 2026' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('1 of them already has a final conclusion and will move too')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm move' })) })

    const move = calls.find(c => c.url === '/api/evaluations/batch-move')!
    expect(JSON.parse(String(move.init?.body))).toEqual({ ids: [1, 2], batch: 'W2 Oct, 2026' })
    await waitFor(() => expect(rowsCalls(calls).length).toBeGreaterThan(before))
    await waitFor(() => expect(checkboxes()).toHaveLength(0))
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `rtk proxy npx jest __tests__/components/evaluations-select-mode.test.tsx`
Expected: FAIL, the first rendering tests fail because there is no "Select" button (the "evaluator has no Select" test passes trivially; every manager test fails). If the suite errors earlier because a child component needs a mock (for example a cell that fetches), add `jest.mock('<path>', () => ({ <Export>: () => null }))` for it, the same way `TrendTagCell` is stubbed; do not change production code for that.

- [ ] **Step 3: Edit `ShortListEvalTab`**

All edits are inside `function ShortListEvalTab()`; `anchor_start` below means everything is searched only after `s.index('function ShortListEvalTab()')`.

```bash
python3 - <<'EOF'
p = 'app/(manager)/evaluations/page.tsx'
s = open(p).read()
start = s.index('function ShortListEvalTab()')
head, tail = s[:start], s[start:]

def swap(old, new):
    global tail
    assert tail.count(old) >= 1, old[:70]
    tail = tail.replace(old, new, 1)   # first occurrence inside ShortListEvalTab

# 1. state + helpers, right after the detail-panel state
swap("  const [detailGameId, setDetailGameId] = useState<string | null>(null)\n",
"""  const [detailGameId, setDetailGameId] = useState<string | null>(null)
  // Bulk batch move (managers). The checkbox column stays hidden until Select is pressed.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const exitSelectMode = () => { setSelectMode(false); setSelectedIds(new Set()) }
  const toggleSelected = (id: number) => setSelectedIds(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
""")

# 2. clear the selection whenever what is listed changes (after the fetch effects)
swap("""  useEffect(() => {
    if (df.suppressFetchRef.current) { df.suppressFetchRef.current = false; return }
    fetchData()
  }, [fetchData])
""", """  useEffect(() => {
    if (df.suppressFetchRef.current) { df.suppressFetchRef.current = false; return }
    fetchData()
  }, [fetchData])

  // A move must only ever cover rows the manager can see. Any change to what is listed
  // (category, any filter, the date range) drops the selection.
  useEffect(() => {
    setSelectedIds(new Set())
  }, [filterCategory, filterConclusions, filterFinalConclusions, filterEvaluator, filterBatch, df.value])
""")

# 3. Select / Cancel button before the result count
swap("""        <span className="sync" style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600 }}>""",
"""        {isManager && (selectMode
          ? <button className="btn btn-sm" onClick={exitSelectMode}>Cancel</button>
          : <button className="btn btn-sm" onClick={() => setSelectMode(true)}>Select</button>)}

        <span className="sync" style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600 }}>""")

# 4. header checkbox column
swap("""              <tr>
                <th style={{ width: 36 }}>#</th>
                <th style={{ width: 280 }}>Game</th>""",
"""              <tr>
                {selectMode && (
                  <th style={{ width: 34 }}>
                    <input type="checkbox" aria-label="Select all shown"
                      checked={data.length > 0 && data.every(d => selectedIds.has(d.id))}
                      onChange={e => setSelectedIds(e.target.checked ? new Set(data.map(d => d.id)) : new Set())} />
                  </th>
                )}
                <th style={{ width: 36 }}>#</th>
                <th style={{ width: 280 }}>Game</th>""")

# 5. empty-state colSpan
swap('<tr><td colSpan={9} className="empty">No games found</td></tr>',
     '<tr><td colSpan={selectMode ? 10 : 9} className="empty">No games found</td></tr>')

# 6. row checkbox cell
swap("""                  onClick={() => setDetailGameId(item.game_id)}>
                  <td className="num" style={{ color: 'var(--faint)', fontSize: 12 }}>{idx + 1}</td>""",
"""                  onClick={() => setDetailGameId(item.game_id)}>
                  {selectMode && (
                    <td onClick={e => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${item.title}`}
                        checked={selectedIds.has(item.id)}
                        onChange={() => toggleSelected(item.id)} />
                    </td>
                  )}
                  <td className="num" style={{ color: 'var(--faint)', fontSize: 12 }}>{idx + 1}</td>""")

# 7. the action bar, between the table card and the detail panel
swap("""      </div>

      {detailGameId && (""", """      </div>

      {isManager && selectMode && selectedIds.size > 0 && (
        <BatchMoveBar
          selected={data.filter(d => selectedIds.has(d.id)).map(d => ({ id: d.id, final_conclusion: d.final_conclusion }))}
          batchOptions={currentBatchOptions}
          onCancel={exitSelectMode}
          onMoved={() => { exitSelectMode(); fetchData(); fetchFacets() }}
        />
      )}

      {detailGameId && (""")

s = head + tail
# import (top of file, once)
imp = "import { saveCurrentBatch } from '@/lib/current-batch-client'\n"
assert s.count(imp) == 1
s = s.replace(imp, imp + "import { BatchMoveBar } from '@/components/BatchMoveBar'\n")
open(p, 'w').write(s)
EOF
```
Note `currentBatchOptions` is declared later in the same component body than the JSX uses it only at render time, so declaration order is fine; confirm with the typecheck below.

- [ ] **Step 4: Run the test and the page's existing tests**

Run: `rtk proxy npx jest __tests__/components/evaluations-select-mode.test.tsx __tests__/components/evaluations-first-load.test.tsx __tests__/components/evaluations-search.test.tsx`
Expected: PASS. If `moves the selected games ...` fails only on the `Move` button lookup because the bar's `Move` and the confirm dialog's heading both match, scope with `within(screen.getByRole('region', { name: 'Move games to another batch' }))`; do not weaken the assertion.

- [ ] **Step 5: Typecheck and commit**

Run: `rtk proxy npm run typecheck`
Expected: no errors.

```bash
git add "app/(manager)/evaluations/page.tsx" __tests__/components/evaluations-select-mode.test.tsx
git commit -m "feat(short-list): select games and move them to another batch

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Verify the whole branch, then ship on the user's word

**Files:** none (verification); the spec gets a small correction.

- [ ] **Step 1: Correct the spec to match what was built**

In `docs/superpowers/specs/2026-10-08-global-current-batch-and-bulk-move-design.md`:
- In "Storage and reading", replace the `onlyCurrentBatch(rows, current: string | null)` bullet with: "The missing-demo route filters in SQL (`ge.batch = $current`), so no row-filtering helper is needed; `getCurrentBatches` and `onlyCurrentBatch` are removed."
- In "Data migration", replace the "Effect to expect" sentence with: "Prod on 2026-10-08 already had both `current_batch:puzzle` and `current_batch:arcade` at `W2 Oct, 2026`, so the migration changes no visible value."
- In the missing-demo row of the callers table, replace `getCurrentBatch()` + `onlyCurrentBatch` with `getCurrentBatch()` and a SQL `ge.batch = $current`.

Commit: `git add docs/superpowers/specs/2026-10-08-global-current-batch-and-bulk-move-design.md && git commit -m "docs(spec): match the global-batch design to what was built

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"`

- [ ] **Step 2: Run the new and touched suites**

Run: `rtk proxy npx jest __tests__/lib/current-batch.test.ts __tests__/lib/current-batch-client.test.ts __tests__/api/evaluations-current-batch.test.ts __tests__/api/current-batch-readers.test.ts __tests__/api/evaluations-batch-move.test.ts __tests__/api/evaluations-missing-demo.test.ts __tests__/components/batch-move-bar.test.tsx __tests__/components/evaluations-select-mode.test.tsx __tests__/components/missing-demo-prompt.test.tsx`
Expected: all PASS.

- [ ] **Step 3: Run the whole suite and compare to the known baseline**

Run: `rtk proxy npx jest 2>&1 | grep -E "^(FAIL|Tests:|Test Suites:)" | sort | uniq`
Expected: exactly the 9 known failing suites (see Global Constraints) and 17 failing tests; every other suite passes. Any other FAIL is a regression introduced here: fix it. Report the failing list unchanged in the hand-off.

- [ ] **Step 4: Typecheck and an isolated production build**

Run:
```bash
rtk proxy npm run typecheck
NEXT_DIST_DIR=.next-check NODE_OPTIONS=--max-old-space-size=6144 rtk proxy npx next build 2>&1 | grep -E "Failed|rror|Compiled|batch-move|current-batch"
rm -rf .next-check && git checkout -- tsconfig.json && git status --short
```
Expected: typecheck clean; `Compiled successfully`; both `/api/evaluations/batch-move` and `/api/evaluations/current-batch` listed; `git status --short` shows nothing (the build rewrites `tsconfig.json`, which is why it is restored).

- [ ] **Step 5: Look at it (UI)**

Dump the real component DOM and screenshot it with the app CSS, as done for `MissingDemoPrompt` (render `BatchMoveBar` in a throwaway jest test that writes `document.body.innerHTML` to the scratchpad, wrap it in a page that links `app/globals.css`, then `chrome --headless=new --screenshot`). Check: the bar sits below the table, the confirm dialog's amber note reads cleanly, nothing overflows at 1100px wide. Delete the throwaway test afterwards.

- [ ] **Step 6: Hand off to the user. Do NOT push yet.**

Tell the user: branch `feat/global-current-batch` is ready; the code may be deployed before the migration (legacy fallback), but the migration must come only after the new build is live; list the 9 known failing suites. Then, only after the user says to push:

```bash
git fetch origin && git rev-list --left-right --count origin/main...HEAD
git push origin HEAD:main
```
(The first command must show `0 N`; if origin/main moved, `git rebase origin/main`, rerun Steps 2-4, then push.)

Then the user, in this order: (1) Republishes on Replit and confirms the new build is live (the running code reads only the per-category keys that the migration deletes, so applying it earlier leaves evaluators on "No active batch" and saves List_Ideas with a NULL batch); (2) runs the migration's CTE as a plain SELECT to confirm it picks `W2 Oct, 2026`, then applies `migrations/045_global_current_batch.sql` on prod by hand and checks `SELECT key, value FROM app_config WHERE key LIKE 'current_batch%'` shows exactly one row `current_batch = W2 Oct, 2026`; (3) sets the current batch once in Short List and uses Select to move any games stamped in the gap.
