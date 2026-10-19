# Rescue Follows the Selected Range Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Report's "Move N stale games from X, Y and Z to the M evaluators Rescue picked" line, and the Rescue panel it links to, count only games whose `assigned_date` falls inside the Report's selected range (a batch, week, month...), and the line stays hidden when no game in that range has waited past `staleDays`.

**Architecture:** One new pure module (`lib/rescue-range.ts`) parses and validates an optional `[from, to)` pair of VN calendar days. `scanRoster` / `selectStaleGames` take it and narrow only the SOURCE-side counts (`stale`, `movable`, `pull`); a new `staleAll` keeps the whole-stock stale count so the RECEIVER gate and the waterfill still judge a person by everything on their desk. The Report route passes `win.from` / `win.to` into the same scan, and the banner's "Open Rescue" link carries the range to Team Ops as `assignedFrom` / `assignedTo` (NOT `from`, which Reassign already uses for an evaluator name).

**Tech Stack:** Next.js 14 App Router, TypeScript, `postgres` tagged-template client (`@/lib/db`), Jest + Testing Library.

**Spec:** No separate spec. The agreed logic is in the conversation of 2026-10-19:
- Window = `assigned_date` inside the Report's range, not `evaluate_date` (stale games have no `evaluate_date`).
- Line is shown only when the in-range stale count passes the existing `STALE.min` / `canRebalance` gate, which already hides the line below the threshold.
- Receivers are still judged on their whole stock.
- Banner and Rescue panel use the same range so the two numbers match.

## Global Constraints

- Timezone is `Asia/Ho_Chi_Minh`. `assigned_date` is a `DATE`, so the range is compared as calendar days with `from` inclusive and `to` EXCLUSIVE, the same convention as `win.from` / `win.to` in `app/api/report/route.ts`.
- A threshold must never travel in a URL (`components/RescuePanel.tsx:110`, `__tests__/components/team-ops-deeplink.test.tsx` rule 4). A range is a view selector, not a setting, so it may. It is never written to `app_config`.
- Do not change the config shape (`staleDays`, `cooldownDays`, `sourceMinBacklog`, `receiverMaxStale`, `activeDays`).
- An evaluator-scoped Report keeps `rescue: null`.
- UI copy: plain and direct, no metaphors, no humanizer skill (memory: ui-copy-plain-direct, report-plain-english-lexicon). Use the words evaluate / backlog / stale.
- Typecheck with `npm run typecheck`. Before pushing run a full build in an isolated dist (`NEXT_DIST_DIR=.next-check`, 6 GB heap, via `rtk proxy`), because unused vars fail `next build` but not jest (memory: lint-errors-block-replit-publish, build-exit0-not-proof). Never run `npm run build` while the dev server is up.
- `app/api/report/route.ts` may contain a NUL byte in a sentinel. Use `git diff --text` when reviewing it (memory: route-ts-nul-byte-binary-diff).

## Review Focus

1. A person whose stale games are all OUTSIDE the range must not turn into a RECEIVER just because their in-range count is 0 (Task 2 test).
2. A malformed, half-malformed or inverted range must return 400, never silently widen to the whole backlog (Task 1 and Task 4 tests).
3. Open-ended windows: All-time has no range; a custom window with only `from` or only `to` must work (Task 1 test).
4. A game assigned on the `to` day belongs to the NEXT batch and must not be counted (Task 3 test asserts `<` on `to`).
5. Cool-down and range together: `movable` is the in-range stale games that are outside cool-down, never more than `stale` (Task 3 test).
6. The Report link and a Reassign link both use the query string: `from` stays Reassign's evaluator name, Rescue reads only `assignedFrom` / `assignedTo` (Task 7 test).

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/rescue-range.ts` (new) | Pure: `AssignedRange` type and `parseAssignedRange`; no DB import |
| `lib/rescue-rules.ts` | Add optional `staleAll` to `RescueStats`; receiver gate reads it |
| `lib/rescue-core.ts` | `scanRoster` and `selectStaleGames` accept `range` |
| `app/api/operations/rescue/route.ts` | Parse range from query / body, pass it down, echo it back, record it in `operation_runs.params` |
| `app/api/report/route.ts` | `scanRescueRoster` takes the range; payload gains `rescue.range` |
| `components/report/ReportView.tsx` | Type additions, link carries the range, `why` says "assigned in this batch" |
| `app/(manager)/team-ops/page.tsx` | Read `assignedFrom` / `assignedTo`, hand `initialRange` to the panel |
| `components/RescuePanel.tsx` | Range state, chip with "Show all backlog", range in GET and POST |
| `__tests__/lib/rescue-range.test.ts` (new) | Parser tests |
| `__tests__/lib/rescue-rules.test.ts` | `staleAll` gate tests |
| `__tests__/lib/rescue-core.test.ts` (new) | SQL receives the range |
| `__tests__/api/rescue.test.ts` (new) | 400s and range pass-through |
| `__tests__/components/report-overview.test.tsx` | Link and copy with and without a range |
| `__tests__/components/team-ops-deeplink.test.tsx` | Panel reads the range from the URL |

Start from an up-to-date `main` on a new branch (`git switch -c fix/rescue-follows-range origin/main`). The working tree has many unrelated untracked PJ202 docs; do not `git add -A`.

---

### Task 1: Range parser (pure)

**Files:**
- Create: `lib/rescue-range.ts`
- Test: `__tests__/lib/rescue-range.test.ts`

**Interfaces:**
- Produces:
  - `type AssignedRange = { from: string | null; to: string | null }`
  - `parseAssignedRange(from: unknown, to: unknown): { ok: true; range: AssignedRange | null } | { ok: false; error: string }`
  - `rangeKey(range: AssignedRange | null | undefined): string` returns `''` for none, else `"from|to"`; used as an effect dependency

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/rescue-range.test.ts
import { parseAssignedRange, rangeKey } from '@/lib/rescue-range'

describe('lib/rescue-range parseAssignedRange', () => {
  it('returns no range when neither end is given', () => {
    expect(parseAssignedRange(undefined, undefined)).toEqual({ ok: true, range: null })
    expect(parseAssignedRange('', null)).toEqual({ ok: true, range: null })
  })

  it('accepts a closed range, to exclusive', () => {
    expect(parseAssignedRange('2026-10-06', '2026-10-13')).toEqual({
      ok: true, range: { from: '2026-10-06', to: '2026-10-13' },
    })
  })

  it('accepts a range open on one side', () => {
    expect(parseAssignedRange('2026-10-06', null)).toEqual({ ok: true, range: { from: '2026-10-06', to: null } })
    expect(parseAssignedRange(null, '2026-10-13')).toEqual({ ok: true, range: { from: null, to: '2026-10-13' } })
  })

  it('rejects a malformed day instead of widening to the whole backlog', () => {
    expect(parseAssignedRange('06/10/2026', '2026-10-13').ok).toBe(false)
    expect(parseAssignedRange('2026-02-31', '2026-03-05').ok).toBe(false)
    expect(parseAssignedRange('2026-10-06', 'soon').ok).toBe(false)
  })

  it('rejects an empty or inverted range', () => {
    expect(parseAssignedRange('2026-10-13', '2026-10-13').ok).toBe(false)
    expect(parseAssignedRange('2026-10-13', '2026-10-06').ok).toBe(false)
  })

  it('rangeKey is empty for none and stable for a range', () => {
    expect(rangeKey(null)).toBe('')
    expect(rangeKey({ from: '2026-10-06', to: null })).toBe('2026-10-06|')
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx jest __tests__/lib/rescue-range.test.ts`
Expected: FAIL, `Cannot find module '@/lib/rescue-range'`.

- [ ] **Step 3: Write the module**

```ts
// lib/rescue-range.ts — the optional assigned-date range Rescue can be scoped to.
//
// PURE module (no DB import). A range is a VIEW SELECTOR, like the genre: it picks which
// games the sentence or the panel is about and is never written to app_config, so unlike
// a threshold it may travel in a URL. `from` is inclusive, `to` is EXCLUSIVE, both VN
// calendar days, the same convention as the Report's window (`win.from` / `win.to`).

export type AssignedRange = { from: string | null; to: string | null }

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

// Rejects 2026-02-31 as well as 06/10/2026: Date rolls the 31st over to March, so the
// round trip is what proves the day exists.
function isDay(s: string): boolean {
  if (!ISO_DAY.test(s)) return false
  const t = Date.parse(`${s}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s
}

const clean = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s === '' ? null : s
}

// A bad range is an error, never "no range": silently falling back to the whole backlog
// would show a number that is not the one the reader asked about.
export function parseAssignedRange(
  from: unknown,
  to: unknown,
): { ok: true; range: AssignedRange | null } | { ok: false; error: string } {
  const f = clean(from)
  const t = clean(to)
  if (f === null && t === null) return { ok: true, range: null }
  if ((f !== null && !isDay(f)) || (t !== null && !isDay(t))) {
    return { ok: false, error: 'assigned range must be YYYY-MM-DD days' }
  }
  if (f !== null && t !== null && f >= t) {
    return { ok: false, error: 'assigned range must end after it starts' }
  }
  return { ok: true, range: { from: f, to: t } }
}

export function rangeKey(range: AssignedRange | null | undefined): string {
  return range ? `${range.from ?? ''}|${range.to ?? ''}` : ''
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx jest __tests__/lib/rescue-range.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/rescue-range.ts __tests__/lib/rescue-range.test.ts
git commit -m "feat(rescue): assigned-date range parser"
```

---

### Task 2: Receiver gate reads the whole-stock stale count

**Files:**
- Modify: `lib/rescue-rules.ts` (interface `RescueStats`, function `classifyRoster`)
- Test: `__tests__/lib/rescue-rules.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RescueStats.staleAll?: number`, the person's stale count across the whole backlog. When absent, `stale` is the whole-stock number. `stale` and `movable` may now be narrowed to a range; `staleAll` never is.

- [ ] **Step 1: Write the failing tests** (append inside the existing `describe('lib/rescue-rules classifyRoster', ...)`)

```ts
  it('does not let a range hide a stale pile elsewhere: receiver gate uses staleAll', () => {
    // 0 stale inside the selected range, 40 stale outside it.
    const [r] = classifyRoster([stat('Mai', { pending: 60, stale: 0, staleAll: 40, movable: 0, evaluatedRecent: 9 })], cfg)
    expect(r.role).toBe('neutral')
    expect(r.reason).toContain('40 stale of their own')
  })

  it('a range-narrowed source still pulls only the in-range games and says so', () => {
    const [r] = classifyRoster([stat('Binh', { pending: 50, stale: 30, staleAll: 45, movable: 30, evaluatedRecent: 4 })], cfg)
    expect(r.role).toBe('source')
    expect(r.pull).toBe(30)
    expect(r.reason).toContain('30 stale in range')
  })

  it('without staleAll nothing changes: stale is the whole-stock number', () => {
    const [r] = classifyRoster([stat('Lan', { pending: 18, stale: 11, movable: 4, evaluatedRecent: 9 })], cfg)
    expect(r.reason).toBe('18 pending, 11 stale, 7 in cool-down')
  })
```

- [ ] **Step 2: Run and see them fail**

Run: `npx jest __tests__/lib/rescue-rules.test.ts`
Expected: FAIL. The first test has `role` `'receiver'`; the second fails on `staleAll` not being on the type (ts-jest) or on the missing "in range" text.

- [ ] **Step 3: Implement**

In `lib/rescue-rules.ts`, add to `RescueStats` after `movable`:

```ts
  // The person's stale count over the WHOLE backlog. Only set when a range narrows
  // `stale` / `movable` to some assigned-date window: the receiver gate must still see
  // everything on the desk, or a person whose stale pile sits in another batch looks
  // clean here and is handed more games.
  staleAll?: number
```

In `classifyRoster`, replace the source reason and the receiver gate:

```ts
    if (s.pending >= cfg.sourceMinBacklog && s.movable > 0) {
      const cooling = s.stale - s.movable
      const note = cooling > 0 ? `, ${cooling} in cool-down` : ''
      const scoped = s.staleAll !== undefined && s.staleAll !== s.stale ? ' in range' : ''
      return { ...s, role: 'source', pull: s.movable, reason: `${s.pending} pending, ${s.stale} stale${scoped}${note}` }
    }
    // Then the receiver gate. Every condition must hold, and the FIRST failure is the
    // reason shown, so the panel always explains its own verdict.
    const ownStale = s.staleAll ?? s.stale
    if (ownStale > cfg.receiverMaxStale) {
      const limit = cfg.receiverMaxStale === 0 ? 'own shelf not clean' : `over the ${cfg.receiverMaxStale} stale allowance`
      return { ...s, role: 'neutral', pull: 0, reason: `${ownStale} stale of their own — ${limit}` }
    }
```

Also update the header comment line `RECEIVER stale <= receiverMaxStale` to `RECEIVER (staleAll ?? stale) <= receiverMaxStale`.

- [ ] **Step 4: Run and see them pass**

Run: `npx jest __tests__/lib/rescue-rules.test.ts`
Expected: PASS, including the 10 or so tests that were already there.

- [ ] **Step 5: Commit**

```bash
git add lib/rescue-rules.ts __tests__/lib/rescue-rules.test.ts
git commit -m "feat(rescue): receiver gate judges the whole backlog, not the selected range"
```

---

### Task 3: Scan and game selection accept a range

**Files:**
- Modify: `lib/rescue-core.ts` (`scanRoster`, `selectStaleGames`)
- Test: `__tests__/lib/rescue-core.test.ts` (new)

**Interfaces:**
- Consumes: `AssignedRange` (Task 1), `RescueStats.staleAll` (Task 2).
- Produces:
  - `scanRoster(opts: { category: string; config: RescueConfig; range?: AssignedRange | null }): Promise<RescueStats[]>`. With a range, `stale` / `movable` count only games with `from <= assigned_date < to`; `staleAll` is always the whole-stock stale count. Without a range, `staleAll` equals `stale`.
  - `selectStaleGames(opts: { category; from; config; limit?; range?: AssignedRange | null }): Promise<Candidate[]>` with the same predicate.

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/lib/rescue-core.test.ts
/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { scanRoster, selectStaleGames } from '@/lib/rescue-core'
import { sql } from '@/lib/db'
import { DEFAULT_RESCUE_CONFIG } from '@/lib/rescue-config'

const sqlMock = sql as unknown as jest.Mock

// postgres.js evaluates a nested `sql` fragment before the outer query, so every fragment
// and the outer query all land in mock.calls: [strings, ...values].
function sqlText() {
  return sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? (c[0] as string[]).join(' ') : '')).join('\n')
}
function sqlValues() {
  return sqlMock.mock.calls.flatMap(c => c.slice(1))
}

beforeEach(() => {
  sqlMock.mockReset()
  sqlMock.mockImplementation(() => Promise.resolve([]))
})

describe('lib/rescue-core range', () => {
  it('scanRoster adds no assigned_date bounds without a range, and staleAll is still selected', async () => {
    await scanRoster({ category: 'puzzle', config: DEFAULT_RESCUE_CONFIG })
    expect(sqlText()).not.toMatch(/assigned_date >=/)
    expect(sqlText()).not.toMatch(/assigned_date </)
    expect(sqlText()).toContain('stale_all')
  })

  it('scanRoster bounds stale and movable by from inclusive and to exclusive', async () => {
    await scanRoster({ category: 'puzzle', config: DEFAULT_RESCUE_CONFIG, range: { from: '2026-10-06', to: '2026-10-13' } })
    expect(sqlText()).toMatch(/assigned_date >= /)
    expect(sqlText()).toMatch(/assigned_date < /)
    expect(sqlValues()).toEqual(expect.arrayContaining(['2026-10-06', '2026-10-13']))
  })

  it('an open-ended range adds only the bound it has', async () => {
    await scanRoster({ category: 'puzzle', config: DEFAULT_RESCUE_CONFIG, range: { from: '2026-10-06', to: null } })
    expect(sqlText()).toMatch(/assigned_date >= /)
    expect(sqlText()).not.toMatch(/assigned_date < /)
  })

  it('maps stale_all, and falls back to stale when the column is absent', async () => {
    sqlMock.mockImplementation((strings: unknown) =>
      Promise.resolve(Array.isArray(strings) && (strings as string[]).join(' ').includes('FROM evaluator_roster')
        ? [{ name: 'A', game_platform: null, weight: null, today_available: true, pending: 9, stale: 2, stale_all: 7, movable: 2, evaluated_recent: 1 }]
        : []))
    const [row] = await scanRoster({ category: 'puzzle', config: DEFAULT_RESCUE_CONFIG, range: { from: '2026-10-06', to: '2026-10-13' } })
    expect(row).toMatchObject({ stale: 2, staleAll: 7, movable: 2 })
  })

  it('selectStaleGames applies the same bounds', async () => {
    await selectStaleGames({ category: 'puzzle', from: 'A', config: DEFAULT_RESCUE_CONFIG, range: { from: '2026-10-06', to: '2026-10-13' } })
    expect(sqlText()).toMatch(/assigned_date >= /)
    expect(sqlText()).toMatch(/assigned_date < /)
  })
})
```

- [ ] **Step 2: Run and see it fail**

Run: `npx jest __tests__/lib/rescue-core.test.ts`
Expected: FAIL (`stale_all` missing, no bounds).

- [ ] **Step 3: Implement** in `lib/rescue-core.ts`

Add the import and a fragment helper under the existing imports:

```ts
import type { AssignedRange } from '@/lib/rescue-range'

// The selected assigned-date window as an AND-able fragment. `to` is exclusive: the
// game assigned ON the day the next batch starts belongs to that next batch.
function inRange(range: AssignedRange | null | undefined) {
  return sql`${range?.from ? sql`AND ge.assigned_date >= ${range.from}::date` : sql``}
             ${range?.to ? sql`AND ge.assigned_date < ${range.to}::date` : sql``}`
}
```

`scanRoster`: change the signature to `opts: { category: string; config: RescueConfig; range?: AssignedRange | null }`, and replace the `pend` CTE's three columns:

```ts
      SELECT ge.initial_evaluator AS name,
             count(*)::int AS pending,
             count(*) FILTER (
               WHERE ge.assigned_date IS NOT NULL
                 AND (SELECT d FROM today) - ge.assigned_date > ${staleDays}
                 ${inRange(opts.range)}
             )::int AS stale,
             -- Whole backlog, never narrowed: the receiver gate reads this one.
             count(*) FILTER (
               WHERE ge.assigned_date IS NOT NULL
                 AND (SELECT d FROM today) - ge.assigned_date > ${staleDays}
             )::int AS stale_all,
             count(*) FILTER (
               WHERE ge.assigned_date IS NOT NULL
                 AND (SELECT d FROM today) - ge.assigned_date > ${staleDays}
                 AND ge.game_id NOT IN (SELECT game_id FROM cooled)
                 ${inRange(opts.range)}
             )::int AS movable
```

In the final SELECT add `COALESCE(p.stale_all, 0) AS stale_all,` after the `stale` line; add `stale_all: number` to the row type and `staleAll: r.stale_all ?? r.stale,` to the mapped object (`pending`, `evaluated_recent` etc. stay).

`selectStaleGames`: add `range?: AssignedRange | null` to opts and append `${inRange(opts.range)}` after the `AND (SELECT d FROM today) - ge.assigned_date > ${staleDays}` line.

- [ ] **Step 4: Run and see it pass**

Run: `npx jest __tests__/lib/rescue-core.test.ts __tests__/lib/rescue-rules.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/rescue-core.ts __tests__/lib/rescue-core.test.ts
git commit -m "feat(rescue): scan and pull stale games inside an assigned-date range"
```

---

### Task 4: Rescue API takes, validates and echoes the range

**Files:**
- Modify: `app/api/operations/rescue/route.ts`
- Test: `__tests__/api/rescue.test.ts` (new)

**Interfaces:**
- Consumes: `parseAssignedRange`, `AssignedRange` (Task 1); `scanRoster` / `selectStaleGames` with `range` (Task 3).
- Produces:
  - `GET /api/operations/rescue?category=&assignedFrom=&assignedTo=` returns `{ ok, category, config, rows, range }`.
  - `POST` body gains `range?: { from?: string | null; to?: string | null }`; every JSON response gains `range: AssignedRange | null`. A malformed range returns 400 `{ error }`.
  - `operation_runs.params` gains `assigned_from` and `assigned_to` (null when no range).

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/api/rescue.test.ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn(() => Promise.resolve(null)) }))

import { GET, POST } from '@/app/api/operations/rescue/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

function values() {
  return sqlMock.mock.calls.flatMap(c => c.slice(1))
}

beforeEach(() => {
  sqlMock.mockReset()
  sqlMock.mockImplementation(() => Promise.resolve([]))
})

function get(qs: string) {
  return GET(new NextRequest(`http://localhost/api/operations/rescue?${qs}`))
}
function post(body: unknown) {
  return POST(new NextRequest('http://localhost/api/operations/rescue', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
}

describe('/api/operations/rescue range', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('GET without a range echoes null', async () => {
    const res = await get('category=puzzle')
    expect(res.status).toBe(200)
    expect((await res.json()).range).toBeNull()
  })

  it('GET with a range scans inside it and echoes it', async () => {
    const res = await get('category=puzzle&assignedFrom=2026-10-06&assignedTo=2026-10-13')
    expect(res.status).toBe(200)
    expect((await res.json()).range).toEqual({ from: '2026-10-06', to: '2026-10-13' })
    expect(values()).toEqual(expect.arrayContaining(['2026-10-06', '2026-10-13']))
  })

  it('GET with a malformed range is 400, not the whole backlog', async () => {
    const res = await get('category=puzzle&assignedFrom=yesterday')
    expect(res.status).toBe(400)
    expect(sqlMock).not.toHaveBeenCalled()
  })

  it('POST scan with an inverted range is 400 and never saves the config', async () => {
    const res = await post({ action: 'scan', category: 'puzzle', range: { from: '2026-10-13', to: '2026-10-06' } })
    expect(res.status).toBe(400)
    expect(sqlMock).not.toHaveBeenCalled()
  })

  it('POST scan with a range echoes it', async () => {
    const res = await post({ action: 'scan', category: 'puzzle', range: { from: '2026-10-06', to: '2026-10-13' } })
    expect(res.status).toBe(200)
    expect((await res.json()).range).toEqual({ from: '2026-10-06', to: '2026-10-13' })
  })
})
```

- [ ] **Step 2: Run and see it fail**

Run: `npx jest __tests__/api/rescue.test.ts`
Expected: FAIL (`range` undefined, malformed range returns 200).

- [ ] **Step 3: Implement** in `app/api/operations/rescue/route.ts`

Add imports:

```ts
import { parseAssignedRange, type AssignedRange } from '@/lib/rescue-range'
```

Add to `interface Body`: `range?: { from?: string | null; to?: string | null }`.

`GET`: after the category check and before `try`:

```ts
  const parsed = parseAssignedRange(
    req.nextUrl.searchParams.get('assignedFrom'),
    req.nextUrl.searchParams.get('assignedTo'),
  )
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const range = parsed.range
```

then `scanRoster({ category, config, range })` and `{ ok: true, category, config, rows, range }` in the response.

`POST`: after `const config = clampRescueConfig(body.config)`:

```ts
  const parsed = parseAssignedRange(body.range?.from, body.range?.to)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const range: AssignedRange | null = parsed.range
```

Pass `range` to the `scanRoster({ category, config, range })` call and to `selectStaleGames({ category, from: s.name, config, limit: s.pull, range })`. Add `range` to every `NextResponse.json(...)` object in POST: the `scan` response, both `reason:` early returns, the `no_stale_games` return, and `payload` (the final commit response spreads `payload`, so it inherits it). In `insertOperationRun`'s `params`, add `assigned_from: range?.from ?? null, assigned_to: range?.to ?? null,`.

- [ ] **Step 4: Run and see it pass**

Run: `npx jest __tests__/api/rescue.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add app/api/operations/rescue/route.ts __tests__/api/rescue.test.ts
git commit -m "feat(rescue): API scans and pulls inside an assigned-date range"
```

---

### Task 5: Report route scans inside the selected window

**Files:**
- Modify: `app/api/report/route.ts` (`scanRescueRoster` around line 52, its call near line 978, the `rescue` payload near line 1509)

**Interfaces:**
- Consumes: `AssignedRange` (Task 1), `scanRoster` with `range` (Task 3), `RescueStats.staleAll` (Task 2).
- Produces: `rescue` payload adds `range: AssignedRange | null`.

- [ ] **Step 1: Write the failing test.** There is no route-level test for this file today and the route is ~1600 lines of queries, so pin the merge logic instead: extract the per-person merge in `scanRescueRoster` into a pure exported function and test that.

Create `lib/rescue-merge.ts`:

```ts
// lib/rescue-merge.ts — adds per-bucket Rescue rosters up per person (pure).
import type { RescueStats } from '@/lib/rescue-rules'

export function mergeRosters(perBucket: RescueStats[][]): RescueStats[] {
  const by = new Map<string, RescueStats>()
  for (const rows of perBucket) {
    for (const r of rows) {
      const cur = by.get(r.name)
      if (!cur) { by.set(r.name, { ...r }); continue }
      // staleAll is read BEFORE `stale` is added to: when the first row carried no
      // staleAll, its `stale` is the whole-stock number.
      cur.staleAll = (cur.staleAll ?? cur.stale) + (r.staleAll ?? r.stale)
      cur.pending += r.pending
      cur.stale += r.stale
      cur.movable += r.movable
      cur.evaluatedRecent += r.evaluatedRecent
      // Available on ANY roster they are on: today_available is a fact about the
      // person's day, not about a genre.
      cur.available = cur.available || r.available
      cur.platform = cur.platform ?? r.platform
      cur.weight = cur.weight ?? r.weight
    }
  }
  return Array.from(by.values())
}
```

Test (`__tests__/lib/rescue-merge.test.ts`):

```ts
import { mergeRosters } from '@/lib/rescue-merge'
import type { RescueStats } from '@/lib/rescue-rules'

const s = (name: string, o: Partial<RescueStats>): RescueStats => ({
  name, platform: null, weight: null, available: true,
  pending: 0, stale: 0, movable: 0, evaluatedRecent: 0, ...o,
})

describe('mergeRosters', () => {
  it('adds stale, staleAll, movable and pending across buckets, one row per person', () => {
    const out = mergeRosters([
      [s('A', { pending: 10, stale: 3, staleAll: 5, movable: 3 })],
      [s('A', { pending: 4, stale: 1, staleAll: 2, movable: 1 }), s('B', { pending: 2 })],
    ])
    expect(out).toHaveLength(2)
    expect(out.find(r => r.name === 'A')).toMatchObject({ pending: 14, stale: 4, staleAll: 7, movable: 4 })
  })

  it('treats a missing staleAll as stale', () => {
    const [a] = mergeRosters([[s('A', { stale: 3 })], [s('A', { stale: 2, staleAll: 6 })]])
    expect(a.staleAll).toBe(9)
  })
})
```

- [ ] **Step 2: Run and see it fail**

Run: `npx jest __tests__/lib/rescue-merge.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `lib/rescue-merge.ts` with the corrected body, then in `app/api/report/route.ts`:

1. Replace the body of `scanRescueRoster` after the `if (category !== 'all')` line:

```ts
async function scanRescueRoster(category: string, config: RescueConfig, range: AssignedRange | null): Promise<RescueStats[]> {
  if (category !== 'all') return scanRoster({ category, config, range })
  return mergeRosters(await Promise.all(BUCKETS.map((b) => scanRoster({ category: b, config, range }))))
}
```

keeping the long explanatory comment above it and adding one paragraph to it: "`range` narrows `stale` / `movable` only; `staleAll` is summed too so the receiver gate still sees a person's whole stock."

2. Add imports: `import { mergeRosters } from '@/lib/rescue-merge'` and `import type { AssignedRange } from '@/lib/rescue-range'`.

3. Build the range once, near where `win` is defined (after line ~245):

```ts
    // The Rescue sentence follows the window on screen. Stale games have no
    // evaluate_date, so the window is applied to when they were ASSIGNED. All-time has
    // no bounds at all and scans the whole backlog, as before.
    const rescueRange: AssignedRange | null = win.from || win.to
      ? { from: win.from || null, to: win.to || null }
      : null
```

4. Change the call (line ~978) to `scanRescueRoster(category, rescueCfg, rescueRange)`.

5. In the `rescue` payload (line ~1509) add:

```ts
      range: rescueRange,
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx jest __tests__/lib/rescue-merge.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Verify against prod data (read-only)**

Run a dev server on a second port with its own dist, then request the Report for each batch with the same query string the UI sends (copy it from devtools):

```bash
SKIP_AUTH=true NEXT_DIST_DIR=.next-verify npx next dev -p 3340
```

Expected `rescue.movableTotal` with `staleDays = 7` on 2026-10-19: W2 Oct = 248, W1 Oct = 1, W3 Oct = 0, month Oct about 249, All-time about 249. These come from the per-day counts taken on 2026-10-19; they grow from 2026-10-20 as W2 and then W3 games pass 7 days. Clean up `.next-verify` afterwards.

- [ ] **Step 6: Commit**

```bash
git add lib/rescue-merge.ts __tests__/lib/rescue-merge.test.ts app/api/report/route.ts
git commit -m "feat(report): Rescue sentence counts games assigned inside the selected window"
```

---

### Task 6: Report copy and link carry the range

**Files:**
- Modify: `components/report/ReportView.tsx` (the `rescue` type near line 240, `catParam` near line 99, the `rebalance` action near lines 1113-1167)
- Test: `__tests__/components/report-overview.test.tsx`

**Interfaces:**
- Consumes: `rescue.range` (Task 5).
- Produces: the "Open Rescue" href gains `&assignedFrom=…&assignedTo=…` when `rescue.range` is set. It stays byte-identical otherwise, which keeps the existing href test at line 917 valid.

- [ ] **Step 1: Write the failing tests** (add near the existing rescue tests, using the same fixture builder those tests use around lines 788-960)

```tsx
  it('Open Rescue carries the range the sentence was counted over', async () => {
    // fixture: copy the one used by the href test at line 906, adding range
    //   rescue: { ...baseRescue, range: { from: '2026-10-06', to: '2026-10-13' } }
    const link = screen.getByText('Open Rescue') as HTMLAnchorElement
    expect(link.getAttribute('href')).toContain('&assignedFrom=2026-10-06&assignedTo=2026-10-13')
    expect(link.getAttribute('href')).not.toMatch(/&from=|staleDays/)
  })

  it('says the games were assigned in this window', async () => {
    // same fixture
    const move = actionLine('rebalance')   // the helper the neighbouring test at line 953 uses
    expect(move.why).toContain('assigned in this')
  })

  it('leaves the old wording and link alone when no range is set', async () => {
    // existing fixtures have no `range`; the tests at lines 917 and 958 already assert this
  })
```

Fill the fixture placeholders from the neighbouring tests when writing the file; do not leave the comments in.

- [ ] **Step 2: Run and see them fail**

Run: `npx jest __tests__/components/report-overview.test.tsx -t "range"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Type (inside `rescue: null | {…}`):

```ts
    // Set when the Report window narrowed the scan: the days the games were assigned in
    // (to exclusive).
    range?: { from: string | null; to: string | null } | null
```

Under `catParam`:

```ts
// Carries the window the sentence was counted over. Named assignedFrom / assignedTo
// because `from` is Reassign's evaluator name on the same page.
function rangeParam(d: Bundle): string {
  const r = d.rescue?.range
  if (!r) return ''
  return `${r.from ? `&assignedFrom=${r.from}` : ''}${r.to ? `&assignedTo=${r.to}` : ''}`
}
```

In the `rebalance` action: `href` becomes `` `/team-ops?tab=rescue${catParam(d)}${rangeParam(d)}&flash=…` ``. In `why`, when `rb.range` is set, replace the clause "that have been in their backlog for more than {rb.staleDays} days" with "assigned in this {windowNoun(d)} that have waited more than {rb.staleDays} days". Keep the `why` under its 150-character comment budget by checking the rendered text in the test (the existing tests at line 953+ show how the length is asserted).

- [ ] **Step 4: Run and see them pass**

Run: `npx jest __tests__/components/report-overview.test.tsx`
Expected: PASS, new and old.

- [ ] **Step 5: Commit**

```bash
git add components/report/ReportView.tsx __tests__/components/report-overview.test.tsx
git commit -m "feat(report): Rescue line says which window it counted and links to the same range"
```

---

### Task 7: Team Ops opens Rescue on the same range

**Files:**
- Modify: `app/(manager)/team-ops/page.tsx` (near lines 56-73), `components/RescuePanel.tsx` (props, state, fetch effect, `post`, header)
- Test: `__tests__/components/team-ops-deeplink.test.tsx`

**Interfaces:**
- Consumes: `parseAssignedRange`, `rangeKey`, `AssignedRange` (Task 1); the API's `range` parameter (Task 4).
- Produces: `RescuePanel` prop `initialRange?: AssignedRange | null`.

- [ ] **Step 1: Write the failing tests** (in `team-ops-deeplink.test.tsx`, same style as the existing deeplink cases)

```tsx
  it('opens Rescue on the range in the URL and asks the API for it', async () => {
    params = new URLSearchParams('tab=rescue&cat=puzzle&assignedFrom=2026-10-06&assignedTo=2026-10-13')
    render(<TeamOpsPage />)
    await screen.findByText(/Assigned 06 Oct/)             // shows the last INCLUDED day: 12 Oct
    const url = String((global.fetch as jest.Mock).mock.calls.find(([u]) => String(u).startsWith('/api/operations/rescue'))![0])
    expect(url).toContain('assignedFrom=2026-10-06')
    expect(url).toContain('assignedTo=2026-10-13')
  })

  it('sends the range with a scan, and "Show all backlog" drops it', async () => {
    params = new URLSearchParams('tab=rescue&cat=puzzle&assignedFrom=2026-10-06&assignedTo=2026-10-13')
    render(<TeamOpsPage />)
    fireEvent.click(await screen.findByText('Show all backlog'))
    await waitFor(() => {
      const gets = (global.fetch as jest.Mock).mock.calls.map(([u]) => String(u)).filter(u => u.startsWith('/api/operations/rescue?'))
      expect(gets[gets.length - 1]).not.toContain('assignedFrom')
    })
  })

  it('ignores a malformed range instead of scanning something else', async () => {
    params = new URLSearchParams('tab=rescue&cat=puzzle&assignedFrom=nope')
    render(<TeamOpsPage />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    const url = String((global.fetch as jest.Mock).mock.calls.find(([u]) => String(u).startsWith('/api/operations/rescue'))![0])
    expect(url).not.toContain('assignedFrom')
    expect(screen.queryByText(/Assigned /)).toBeNull()
  })

  it('a Reassign link still reads from as an evaluator name', async () => {
    // existing ?from= test stays green; add no change here, this is the guard for review focus 6
  })
```

Remove the last placeholder test body if the existing `?from=` test already covers it, and say so in the commit message.

- [ ] **Step 2: Run and see them fail**

Run: `npx jest __tests__/components/team-ops-deeplink.test.tsx`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement**

`team-ops/page.tsx`, beside `initialCategory`:

```tsx
  // Same reasoning as the category: a range picks which games the screen is about and
  // is never saved, so it may ride in the URL. A malformed one is dropped, not repaired.
  const parsedRange = parseAssignedRange(searchParams.get('assignedFrom'), searchParams.get('assignedTo'))
  const initialRange = parsedRange.ok ? parsedRange.range : null
```

and `<RescuePanel flash={flash} initialCategory={initialCategory} initialRange={initialRange} />`.

`RescuePanel.tsx`:

1. Signature: `{ flash = [], initialCategory, initialRange = null }: { flash?: string[]; initialCategory?: Bucket; initialRange?: AssignedRange | null }`.
2. `const [range, setRange] = useState<AssignedRange | null>(initialRange)`; `const rKey = rangeKey(range)`.
3. Fetch URL in the initial-load effect:

```ts
    const qs = new URLSearchParams({ category })
    if (range?.from) qs.set('assignedFrom', range.from)
    if (range?.to) qs.set('assignedTo', range.to)
    fetch(`/api/operations/rescue?${qs}`, { cache: 'no-store' })
```

and the deps become `[category, rKey, applyRows]` (read `range` through a ref or disable the exhaustive-deps lint with a one-line comment; prefer the ref).
4. `post()` body: `{ action, category, config, range, ...picks() }`.
5. Header, above the table, only when `range` is set:

```tsx
{range && (
  <div className="rescue-range">
    <span>Only games assigned {fmtDays(range)}</span>
    <button type="button" className="btn-link" onClick={() => setRange(null)}>Show all backlog</button>
  </div>
)}
```

with

```ts
// `to` is exclusive, so the last day shown is the day before it.
function fmtDays(r: AssignedRange): string {
  const d = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })
  const last = (s: string) => d(new Date(Date.parse(`${s}T00:00:00Z`) - 864e5).toISOString().slice(0, 10))
  if (r.from && r.to) return `${d(r.from)} to ${last(r.to)}`
  if (r.from) return `from ${d(r.from)}`
  return `before ${d(r.to!)}`
}
```

Use the existing chip or note class the panel already uses for small header text instead of `rescue-range` if one exists.

- [ ] **Step 4: Run and see them pass**

Run: `npx jest __tests__/components/team-ops-deeplink.test.tsx`
Expected: PASS, including the existing deeplink cases (`?flash=`, `?from=`, and "nothing near Rescue's saved thresholds").

- [ ] **Step 5: Commit**

```bash
git add "app/(manager)/team-ops/page.tsx" components/RescuePanel.tsx __tests__/components/team-ops-deeplink.test.tsx
git commit -m "feat(team-ops): Rescue opens on the assigned-date range the Report counted"
```

---

### Task 8: Whole-change verification

**Files:** none.

- [ ] **Step 1: Full test run and typecheck**

Run: `npx jest && npm run typecheck`
Expected: all green. Fix any report test whose fixture type no longer compiles by adding the optional fields, not by editing assertions.

- [ ] **Step 2: Isolated production build** (stop any dev server using `.next` first)

Run: `NEXT_DIST_DIR=.next-check NODE_OPTIONS=--max-old-space-size=6144 rtk proxy npm run build`
Expected: exit 0 AND no "Failed to compile" or unused-variable lint errors in the output. Exit 0 alone is not proof (memory: build-exit0-not-proof).

- [ ] **Step 3: Click-through on the dev server** (`SKIP_AUTH=true NEXT_DIST_DIR=.next-verify npx next dev -p 3340`)

1. Performance > batch W2 Oct: the line reads about 248 games, and "Open Rescue" opens the panel with the "Only games assigned 06 Oct to 12 Oct" chip and the same total.
2. Switch to W3 Oct and W1 Oct: the line disappears.
3. Switch to All batches: the line shows the whole backlog and the link has no range.
4. In the panel press "Show all backlog": the total widens, nothing else changes.
5. Do NOT press Commit on prod data. Verify commit only against a local or branch database, or stop at Preview.

- [ ] **Step 4: Remove `.next-verify`, push, record memory**

After the user approves: push `main` per the repo's "push main = push directly" habit (memory: signal-deploy-git-and-test-env), then add a memory note `rescue-follows-selected-range` and a one-line pointer in `MEMORY.md`.

---

## Self-review

- **Spec coverage:** range filter on `assigned_date` (Tasks 3, 5); hidden when under threshold (kept through the existing `canRebalance` gate, no new code; Task 5 step 5 and Task 8 step 3 check it); receivers on whole stock (Tasks 2, 3); panel matches banner (Tasks 4, 6, 7). No gap.
- **Not included on purpose (decided 2026-10-19):** any mention of stale games OUTSIDE the selected range, whether as a separate line when the banner is hidden or as a sentence inside `why`. The banner is about the batch on screen and hides when that batch has nothing past `staleDays`. Anyone who wants the older backlog switches to the older batch or All.
- **Placeholders:** Tasks 6 and 7 contain test skeletons whose fixtures must be copied from the named neighbouring tests; the files and line numbers are given. Nothing else is deferred.
- **Type consistency:** `AssignedRange`, `parseAssignedRange`, `rangeKey`, `staleAll`, `rescue.range`, `assignedFrom` / `assignedTo`, `initialRange` are spelled the same in every task.
