# Evaluations Load Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Evaluations page and Short List tab load only the current month's slim data in a single round-trip, with server-resolved month defaults and correct full-set stats.

**Architecture:** `GET /api/evaluations` learns `month=auto` (server resolves current month UTC+7, falls back to latest month with data, returns `applied_month`), drops unused JSON metadata from the list SELECT, runs meta/stats queries only on page 1, and replaces the bare count with a single FILTER-aggregate stats query. Clients send `month=auto` on first load and sync the picker from the response without refetching. A composite DB index + range-based month predicate make the filtered queries index-friendly.

**Tech Stack:** Next.js 14 App Router, postgres.js tagged templates (`lib/db.ts` `sql`), Jest (node env for API tests), plain SQL migration file.

**Spec:** `docs/superpowers/specs/2026-06-11-evaluations-load-optimization-design.md`

---

### Task 1: DB index migration

**Files:**
- Create: `migrations/009_eval_list_index.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 009: Composite index for evaluation list queries.
-- Every list/stats/months query filters on category_group and
-- filters/sorts on assigned_date. The existing partial index
-- (idx_game_evaluations_unassigned) only covers initial_evaluator IS NULL rows.
CREATE INDEX IF NOT EXISTS idx_game_evaluations_cat_assigned
  ON game_evaluations(category_group, assigned_date DESC);
```

- [ ] **Step 2: Commit**

```bash
git add migrations/009_eval_list_index.sql
git commit -m "feat: composite index for evaluation list queries (migration 009)"
```

Note: migrations in this repo are applied manually against the Postgres instance (same as 005–008). Flag to the user at the end that `009_eval_list_index.sql` needs to be run.

---

### Task 2: API — failing tests for the new `/api/evaluations` GET contract

**Files:**
- Create: `__tests__/api/evaluations.test.ts`

The route under test is `app/api/evaluations/route.ts`. `lib/db.ts` exports `sql` (postgres.js tagged template). In tests we mock it with an implementation that routes on the SQL text. Auth is bypassed via `SKIP_AUTH=true` (see `lib/auth-guard.ts`, which returns `null` immediately in that case).

- [ ] **Step 1: Write the failing tests**

```typescript
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { GET } from '@/app/api/evaluations/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

interface MockData {
  months?: { year: number; month: number }[]
  rows?: Record<string, unknown>[]
  stats?: { total: number; evaluated: number; dead_links: number }[]
  conclusions?: { c: string }[]
}

// Routes mock results by inspecting the SQL text. Tagged-template calls
// receive a strings array; fragment calls (sql`AND ...`) and the
// sql(array) IN-list helper fall through to the default branch.
function setupSql({ months = [], rows = [], stats = [{ total: 0, evaluated: 0, dead_links: 0 }], conclusions = [] }: MockData = {}) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('EXTRACT(YEAR')) return Promise.resolve(months)
    if (q.includes('count(*)')) return Promise.resolve(stats)
    if (q.includes('initial_conclusion AS c')) return Promise.resolve(conclusions)
    if (q.includes('SELECT ge.id')) return Promise.resolve(rows)
    return Promise.resolve([])
  })
}

// All SQL text seen by the mock, for shape assertions.
function allQueries(): string {
  return sqlMock.mock.calls
    .filter(c => Array.isArray(c[0]))
    .map(c => (c[0] as string[]).join(' '))
    .join('\n')
}

function get(qs: string) {
  return GET(new NextRequest(`http://localhost/api/evaluations?${qs}`))
}

describe('GET /api/evaluations', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  beforeEach(() => {
    // 2026-06-15 in UTC — current month in UTC+7 is June 2026.
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-06-15T10:00:00Z').getTime())
  })
  afterEach(() => { jest.restoreAllMocks() })

  it('month=auto picks the current month when it has data', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }, { year: 2026, month: 5 }] })
    const res = await get('category=puzzle&month=auto&page=1')
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.applied_month).toEqual({ year: 2026, month: 6 })
  })

  it('month=auto falls back to the latest month with data', async () => {
    setupSql({ months: [{ year: 2026, month: 5 }, { year: 2026, month: 4 }] })
    const res = await get('category=puzzle&month=auto&page=1')
    const json = await res.json()
    expect(json.applied_month).toEqual({ year: 2026, month: 5 })
  })

  it('month=auto with no data applies no month and returns applied_month null', async () => {
    setupSql({ months: [] })
    const res = await get('category=puzzle&month=auto&page=1')
    const json = await res.json()
    expect(json.applied_month).toBeNull()
    expect(json.data).toEqual([])
  })

  it('page 1 returns stats computed from the aggregate query', async () => {
    setupSql({
      months: [{ year: 2026, month: 6 }],
      stats: [{ total: 320, evaluated: 200, dead_links: 12 }],
    })
    const res = await get('category=puzzle&month=auto&page=1')
    const json = await res.json()
    expect(json.total).toBe(320)
    expect(json.stats).toEqual({ total: 320, evaluated: 200, pending: 120, dead_links: 12 })
    expect(json.available_months).toEqual([{ year: 2026, month: 6 }])
  })

  it('page > 1 skips meta and stats queries entirely', async () => {
    setupSql({ rows: [{ id: 1 }] })
    const res = await get('category=puzzle&year=2026&month=6&page=2')
    const json = await res.json()
    expect(json.data).toEqual([{ id: 1 }])
    expect(json.stats).toBeUndefined()
    expect(json.available_months).toBeUndefined()
    expect(json.available_conclusions).toBeUndefined()
    const q = allQueries()
    expect(q).not.toContain('count(*)')
    expect(q).not.toContain('EXTRACT(YEAR')
  })

  it('list query no longer selects screenshot_urls or categories', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&month=auto&page=1')
    const q = allQueries()
    expect(q).not.toContain('screenshot_urls')
    expect(q).not.toContain("metadata->'categories'")
  })

  it('explicit month filter uses a make_date range, not EXTRACT', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=3&page=1')
    const q = allQueries()
    expect(q).toContain('make_date')
    // The months meta query legitimately uses EXTRACT(MONTH ...)::int;
    // only the old equality-filter form must be gone.
    expect(q).not.toContain('EXTRACT(MONTH FROM ge.assigned_date) =')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/api/evaluations.test.ts`
Expected: FAIL — `applied_month` undefined, `stats` undefined, list query still contains `screenshot_urls`, month filter still uses `EXTRACT(MONTH`.

- [ ] **Step 3: Commit the failing tests**

```bash
git add __tests__/api/evaluations.test.ts
git commit -m "test: contract tests for evaluations API load optimization"
```

---

### Task 3: API — implement the new GET in `app/api/evaluations/route.ts`

**Files:**
- Modify: `app/api/evaluations/route.ts:16-148` (the GET function only; PATCH untouched)
- Test: `__tests__/api/evaluations.test.ts`

- [ ] **Step 1: Replace the GET function**

Replace the entire current `GET` (lines 16–148) with:

```typescript
export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const { searchParams } = req.nextUrl
    const category = searchParams.get('category') || 'puzzle'
    const evaluator = searchParams.get('evaluator') || ''
    const conclusion = searchParams.get('conclusion') || ''
    const conclusions = searchParams.get('conclusions') || ''
    const status = searchParams.get('status') || ''
    const assignmentStatus = searchParams.get('assignment_status') || ''
    const hasRecording = searchParams.get('has_recording') || ''
    const recorder = searchParams.get('recorder') || ''
    const monthParam = searchParams.get('month') || ''
    const autoMonth = monthParam === 'auto'
    const year = parseInt(searchParams.get('year') || '0')
    const month = autoMonth ? 0 : parseInt(monthParam || '0')
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
    const limit = Math.min(500, Math.max(10, parseInt(searchParams.get('limit') || '200')))
    const offset = (page - 1) * limit
    const wantMeta = page === 1

    const statusFilter = status === 'pending'
      ? sql`AND ge.initial_conclusion IS NULL`
      : status === 'done'
        ? sql`AND ge.initial_conclusion IS NOT NULL`
        : sql``

    const evaluatorFilter = evaluator ? sql`AND ge.initial_evaluator = ${evaluator}` : sql``

    const conclusionFilter = conclusions
      ? sql`AND ge.initial_conclusion IN ${sql(conclusions.split(',').map(c => c.trim()).filter(Boolean))}`
      : conclusion
        ? sql`AND ge.initial_conclusion = ${conclusion}`
        : sql``

    const assignmentFilter = assignmentStatus === 'unassigned'
      ? sql`AND ge.record_5min_assignee IS NULL AND ge.record_20min_assignee IS NULL`
      : assignmentStatus === 'assigned'
        ? sql`AND (ge.record_5min_assignee IS NOT NULL OR ge.record_20min_assignee IS NOT NULL)`
        : sql``

    const recordingFilter = hasRecording === 'true'
      ? sql`AND (ge.record_5min_assignee IS NOT NULL OR ge.record_20min_assignee IS NOT NULL)`
      : sql``

    const recorderFilter = recorder
      ? sql`AND (ge.record_5min_assignee = ${recorder} OR ge.record_20min_assignee = ${recorder})`
      : sql``

    // Months with data — needed for the picker (page 1) and to resolve month=auto.
    const availableMonths = (wantMeta || autoMonth)
      ? await sql`
          SELECT DISTINCT
            EXTRACT(YEAR FROM ge.assigned_date)::int AS year,
            EXTRACT(MONTH FROM ge.assigned_date)::int AS month
          FROM game_evaluations ge
          WHERE ge.category_group = ${category}
            AND ge.assigned_date IS NOT NULL
            ${evaluatorFilter}
          ORDER BY year DESC, month DESC
        `
      : []

    // month=auto → current month (Asia/Ho_Chi_Minh) if it has data, else latest with data.
    let applied: { year: number; month: number } | null = null
    if (autoMonth) {
      const nowVN = new Date(Date.now() + 7 * 3600 * 1000)
      const curY = nowVN.getUTCFullYear()
      const curM = nowVN.getUTCMonth() + 1
      if (availableMonths.some(m => m.year === curY && m.month === curM)) {
        applied = { year: curY, month: curM }
      } else if (availableMonths.length > 0) {
        applied = { year: availableMonths[0].year, month: availableMonths[0].month }
      }
    } else if (year > 0 && month > 0) {
      applied = { year, month }
    }

    const monthFilter = applied
      ? sql`AND ge.assigned_date >= make_date(${applied.year}, ${applied.month}, 1)
            AND ge.assigned_date < make_date(${applied.year}, ${applied.month}, 1) + interval '1 month'`
      : sql``

    const [rows, statsRows, distinctConclusions] = await Promise.all([
      sql`
        SELECT ge.id, ge.game_id, ge.category_group, ge.genre_1, ge.genre_2,
          ge.initial_evaluator, ge.final_evaluator, ge.assigned_date,
          ge.evaluate_date, ge.initial_note, ge.initial_conclusion,
          ge.record_assignee, ge.record_assign_date,
          ge.record_5min_assignee, ge.record_5min_date,
          ge.record_5min_drive, ge.record_5min_drive_date,
          ge.record_20min_assignee, ge.record_20min_date,
          ge.record_20min_drive, ge.record_20min_drive_date,
          ge.drive_link, ge.drive_date, ge.youtube_link,
          ge.imported_at, ge.updated_at,
          gi.title, gi.os, gi.app_link, gi.icon_url,
          COALESCE(gi.initial_release, gi.temp_release)::text AS release_date,
          COALESCE(dev.developer_name, dev.dev_company) AS publisher_name
        FROM game_evaluations ge
        JOIN game_info gi ON ge.game_id = gi.game_id
        LEFT JOIN developer dev ON gi.publisher_id = dev.id
        WHERE ge.category_group = ${category}
          ${evaluatorFilter}
          ${conclusionFilter}
          ${statusFilter}
          ${monthFilter}
          ${assignmentFilter}
          ${recordingFilter}
          ${recorderFilter}
        ORDER BY ge.assigned_date DESC, ge.imported_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      wantMeta
        ? sql`
            SELECT count(*)::int AS total,
              count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL)::int AS evaluated,
              count(*) FILTER (WHERE ge.initial_conclusion = 'Link_dead')::int AS dead_links
            FROM game_evaluations ge
            WHERE ge.category_group = ${category}
              ${evaluatorFilter}
              ${conclusionFilter}
              ${statusFilter}
              ${monthFilter}
              ${assignmentFilter}
              ${recordingFilter}
              ${recorderFilter}
          `
        : Promise.resolve([]),
      wantMeta
        ? sql`
            SELECT DISTINCT ge.initial_conclusion AS c
            FROM game_evaluations ge
            WHERE ge.category_group = ${category}
              AND ge.initial_conclusion IS NOT NULL
              ${evaluatorFilter}
              ${monthFilter}
          `
        : Promise.resolve([]),
    ])

    const body: Record<string, unknown> = { data: rows, page, limit }

    if (wantMeta) {
      const s = statsRows[0] || { total: 0, evaluated: 0, dead_links: 0 }
      body.total = s.total
      body.stats = {
        total: s.total,
        evaluated: s.evaluated,
        pending: s.total - s.evaluated,
        dead_links: s.dead_links,
      }
      body.applied_month = applied
      body.available_months = availableMonths
      body.conclusion_options = CONCLUSION_OPTIONS
      const present: string[] = distinctConclusions.map(r => r.c)
      body.available_conclusions = CONCLUSION_OPTIONS.filter(c => present.includes(c))
        .concat(present.filter(c => !CONCLUSION_OPTIONS.includes(c)).sort())
    }

    return NextResponse.json(body)
  } catch (err) {
    console.error('GET /api/evaluations error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
```

Contract changes vs. before: `total`, `available_months`, `conclusion_options`, `available_conclusions` now appear **only on page 1** (all current consumers — Evaluations page, ShortListTab, RecordVideoTab — only read them from page-1 responses); new fields `stats` and `applied_month` on page 1; list rows no longer carry `screenshot_urls`/`categories`.

- [ ] **Step 2: Run the tests**

Run: `npx jest __tests__/api/evaluations.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 3: Run the full suite + lint to catch regressions**

Run: `npx jest && npx next lint --quiet`
Expected: all suites pass, no lint errors

- [ ] **Step 4: Commit**

```bash
git add app/api/evaluations/route.ts
git commit -m "feat: month=auto, slim payload, page-1 meta + stats for /api/evaluations"
```

---

### Task 4: Evaluations page — auto month, API stats, slim interface

**Files:**
- Modify: `app/(manager)/evaluations/page.tsx`

All edits below are exact-string replacements against the current file.

- [ ] **Step 1: Remove `screenshot_urls` from the row interface**

In the `Evaluation` interface, delete the line:

```typescript
  screenshot_urls: string[] | null
```

- [ ] **Step 2: Replace month-init state with auto-month state**

Replace:

```typescript
  const [filterMonth, setFilterMonth] = useState<YearMonth | null>(null)
  const [monthInitialized, setMonthInitialized] = useState(false)
```

with:

```typescript
  const [filterMonth, setFilterMonth] = useState<YearMonth | null>(null)
  // First load sends month=auto; the server resolves the default month
  // (current month, falling back to latest with data) and echoes it back.
  const [autoMonth, setAutoMonth] = useState(true)
  const suppressFetchRef = useRef(false)
```

- [ ] **Step 3: Replace client-computed stats with API stats**

Replace:

```typescript
  const stats = useMemo(() => {
    const totalCount = data.length
    const evaluatedCount = data.filter(d => !!d.initial_conclusion).length
    const pendingCount = totalCount - evaluatedCount
    const deadLinkCount = data.filter(d => d.initial_conclusion === 'Link_dead').length
    const percent = totalCount > 0 ? Math.round((evaluatedCount / totalCount) * 100) : 0
    return { totalCount, evaluatedCount, pendingCount, deadLinkCount, percent }
  }, [data])
```

with:

```typescript
  const [apiStats, setApiStats] = useState({ total: 0, evaluated: 0, pending: 0, dead_links: 0 })
  const stats = useMemo(() => ({
    totalCount: apiStats.total,
    evaluatedCount: apiStats.evaluated,
    pendingCount: apiStats.pending,
    deadLinkCount: apiStats.dead_links,
    percent: apiStats.total > 0 ? Math.round((apiStats.evaluated / apiStats.total) * 100) : 0,
  }), [apiStats])
```

(The stat-card JSX keeps using `stats.totalCount` etc. — no render changes needed.)

- [ ] **Step 4: Rework `fetchPage`**

Replace the whole `fetchPage` callback with:

```typescript
  const fetchPage = useCallback(async (page: number, append: boolean) => {
    if (append) setLoadingMore(true); else setLoading(true)
    try {
      const params = new URLSearchParams({ category, page: String(page), limit: String(PAGE_SIZE) })
      const isManager = role === 'admin' || role === 'moderator'
      if (!isManager) {
        if (userName) params.set('evaluator', userName)
      } else if (filterEvaluator) {
        params.set('evaluator', filterEvaluator)
      }
      if (filterConclusion) params.set('conclusion', filterConclusion)
      if (filterStatus) params.set('status', filterStatus)
      if (autoMonth) {
        params.set('month', 'auto')
      } else if (filterMonth) {
        params.set('year', String(filterMonth.year))
        params.set('month', String(filterMonth.month))
      }
      const res = await fetch(`/api/evaluations?${params}`)
      const json = await res.json()
      const rows = json.data || []
      if (append) {
        setData(prev => [...prev, ...rows])
      } else {
        setData(rows)
      }
      if (json.total !== undefined) setTotal(json.total)
      if (json.stats) setApiStats(json.stats)
      if (json.available_conclusions) setConclusionOptions(json.available_conclusions)
      if (json.available_months) setAvailableMonths(json.available_months)
      if (autoMonth && json.applied_month !== undefined) {
        const ap = json.applied_month as YearMonth | null
        if (ap && (ap.year !== filterMonth?.year || ap.month !== filterMonth?.month)) {
          // Sync the picker to the server-resolved month without refetching.
          suppressFetchRef.current = true
          setFilterMonth(ap)
        }
      }
      setHasMore(rows.length === PAGE_SIZE)
    } catch { /* ignore */ }
    setLoading(false)
    setLoadingMore(false)
  }, [category, filterEvaluator, filterConclusion, filterStatus, filterMonth, autoMonth, role, userName])
```

Note the `hasMore` change: pages > 1 no longer return `total`, so "a full page came back" is the continuation signal (worst case: one extra empty fetch when the total is an exact multiple of `PAGE_SIZE`).

- [ ] **Step 5: Guard the refetch effect**

Replace:

```typescript
  useEffect(() => {
    pageRef.current = 1
    fetchPage(1, false)
  }, [fetchPage])
```

with:

```typescript
  useEffect(() => {
    if (suppressFetchRef.current) {
      suppressFetchRef.current = false
      return
    }
    pageRef.current = 1
    fetchPage(1, false)
  }, [fetchPage])
```

- [ ] **Step 6: Disable auto mode when the user picks a month**

Replace:

```typescript
        <MonthPicker
          available={availableMonths}
          value={filterMonth}
          onChange={setFilterMonth}
        />
```

with:

```typescript
        <MonthPicker
          available={availableMonths}
          value={filterMonth}
          onChange={v => { setAutoMonth(false); setFilterMonth(v) }}
        />
```

- [ ] **Step 7: Lint + build check**

Run: `npx next lint --quiet && npx tsc --noEmit`
Expected: no errors (unused `monthInitialized` references are gone; `useMemo` import still used by `stats`/`filtered`)

- [ ] **Step 8: Commit**

```bash
git add "app/(manager)/evaluations/page.tsx"
git commit -m "feat: single-fetch auto month default + API stats on Evaluations page"
```

---

### Task 5: Short List tab — auto month default

**Files:**
- Modify: `app/(manager)/youtube/page.tsx` (function `ShortListTab`, ~line 1155)

- [ ] **Step 1: Add auto-month state**

In `ShortListTab`, replace:

```typescript
  const [filterMonth, setFilterMonth] = useState<YearMonth | null>(null)
```

with:

```typescript
  const [filterMonth, setFilterMonth] = useState<YearMonth | null>(null)
  // First load sends month=auto; server resolves current month or latest with data.
  const [autoMonth, setAutoMonth] = useState(true)
  const suppressFetchRef = useRef(false)
```

(`useRef` is already imported in this file; verify, and add to the React import if missing.)

- [ ] **Step 2: Rework `fetchData` month params + applied_month sync**

In `ShortListTab`'s `fetchData`, replace:

```typescript
      if (filterMonth) {
        params.set('year', String(filterMonth.year))
        params.set('month', String(filterMonth.month))
      }
```

with:

```typescript
      if (autoMonth) {
        params.set('month', 'auto')
      } else if (filterMonth) {
        params.set('year', String(filterMonth.year))
        params.set('month', String(filterMonth.month))
      }
```

and after the line `if (json.available_months) setAvailableMonths(json.available_months)` add:

```typescript
      if (autoMonth && json.applied_month !== undefined) {
        const ap = json.applied_month as YearMonth | null
        if (ap && (ap.year !== filterMonth?.year || ap.month !== filterMonth?.month)) {
          suppressFetchRef.current = true
          setFilterMonth(ap)
        }
      }
```

then add `autoMonth` to the `useCallback` dependency array:

```typescript
  }, [filterCategory, filterConclusions, filterAssignment, filterMonth, autoMonth])
```

- [ ] **Step 3: Guard the refetch effect**

Replace:

```typescript
  useEffect(() => { fetchData() }, [fetchData])
```

with:

```typescript
  useEffect(() => {
    if (suppressFetchRef.current) {
      suppressFetchRef.current = false
      return
    }
    fetchData()
  }, [fetchData])
```

(Only the one inside `ShortListTab` — other tabs have their own effects.)

- [ ] **Step 4: Disable auto mode on manual pick**

Replace (inside `ShortListTab`):

```typescript
        <MonthPicker available={availableMonths} value={filterMonth} onChange={setFilterMonth} />
```

with:

```typescript
        <MonthPicker available={availableMonths} value={filterMonth}
          onChange={v => { setAutoMonth(false); setFilterMonth(v) }} />
```

- [ ] **Step 5: Lint + typecheck + full test suite**

Run: `npx next lint --quiet && npx tsc --noEmit && npx jest`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add "app/(manager)/youtube/page.tsx"
git commit -m "feat: auto month default for Short List tab"
```

---

### Task 6: Verify end-to-end + production build

**Files:** none (verification only)

- [ ] **Step 1: Production build**

Run: `npm run build`
Expected: compiles with no type or lint errors

- [ ] **Step 2: Manual smoke check (requires DB env)**

Run: `npm run dev` (port 3333), open `http://localhost:3333/evaluations?cat=puzzle` with the Network tab:
- Exactly **one** `/api/evaluations` request on load, with `month=auto`
- Month picker shows the resolved month; stats cards populated from `stats`
- Response rows contain no `screenshot_urls`
- Scroll to bottom → `page=2` request, response has only `data`
- Open a row → modal loads via `/api/evaluations/<gameId>` (unchanged)
- `Videos → Short List` tab: one request with `month=auto`, picker synced

- [ ] **Step 3: Remind user to apply migration**

Tell the user: run `migrations/009_eval_list_index.sql` against the production Postgres (same manual process as 005–008).
