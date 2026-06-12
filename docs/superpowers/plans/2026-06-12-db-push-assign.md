# DB Push + Assign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the "push new games" + "auto-assign evaluator" pipeline from Smartsheet into Postgres (`game_evaluations`), so the web app becomes the working surface and the Smartsheet push/assign flows can be retired.

**Architecture:** Two new cron-style API routes (`/api/cron/push-evaluations`, `/api/cron/assign-evaluators`) own the SQL + assignment logic; the assignment algorithm is a pure function in `lib/` (ported from the n8n `auto-assign-game-evaluator` flow, TDD). A small n8n flow orchestrates daily: sync roster sheet → push → assign → Google Chat notify. Old Smartsheet flows keep running until a one-day cutover.

**Tech Stack:** Next.js App Router routes, `lib/db` (postgres tagged templates), Jest (`@jest-environment node`, `jest.mock('@/lib/db')` pattern from `__tests__/api/evaluations.test.ts`), n8n workflow JSON in `workflows/` (gitignored — force-add).

---

## Current state (for context — verified 2026-06-12)

- **Push today:** n8n `[unified]-database-to-smartsheet` selects from `game_info`: release (`COALESCE(initial_release, temp_release)`) within last 30 days, `type` NULL or ILIKE '%sync%', `app_link IS NOT NULL`, `is_active`, metadata categories overlap the category-group's list (from Google Sheet "N8N configs", field `<Group> smartsheet ID` + `categories_list`). Dedupe via Google Sheet ledger "[Signal] Imported Game IDs". Pushes rows to Smartsheet, then calls the assign flow.
- **Assign today:** n8n `auto-assign-game-evaluator` reads Google Sheet `1kR6I3DnYCn67GUqZv0ms6cksUnRTHEBQniVjOuoEqlo` tab "Evaluator List" filtered `Today Available = Yes` (columns: Evaluator Name, Game Platform, Weight), takes Smartsheet rows with empty Initial Evaluator, splits by weight (largest-remainder; platform-specific evaluators take matching-platform games first, up to their target; the rest go to `all` evaluators by weight), writes Initial Evaluator + Assigned Date, notifies Google Chat.
- **DB:** `game_evaluations` has `UNIQUE(game_id, category_group)` → `ON CONFLICT DO NOTHING` replaces the ID ledger. `evaluator_roster` (migration 008) has `list_type/name/today_available/game_platform/game_category/sort_order` but **no `weight`**. `app_config` is a key/value table. Flow 2 `smartsheet-db-update-sync` (daily 06:00) upserts Smartsheet→DB, Smartsheet wins on `initial_evaluator`/`assigned_date` — this is why DB-assign must NOT run before cutover.
- **Auth pattern:** routes accept `x-webhook-secret == process.env.WEBHOOK_SECRET` OR an admin session (see `app/api/admin/import-evaluations/route.ts`).

## Transition design (no dual-assign conflict)

1. **Build + parallel validation:** deploy both routes. n8n flow runs with `dryRun=true` daily — compares would-push/would-assign counts against the old pipeline (Chat message). Old pipeline untouched; flow 2 keeps copying Smartsheet assignments into DB.
2. **Cutover (one morning):** deactivate `[unified]-database-to-smartsheet`, `auto-assign-game-evaluator`, and `smartsheet-db-update-sync`; flip the new flow to `dryRun=false`. Evaluators work in the web app from that day.
3. **Never hard-delete** rows from `game_evaluations` for dead links (mark `Link_dead` instead) — a deleted row inside the 30-day window would be re-inserted by the next push run.

## File structure

- `migrations/011_roster_weight.sql` — add `weight` to `evaluator_roster` (manual apply, like 009/010)
- `lib/assign-evaluators.ts` — pure assignment algorithm (no I/O)
- `__tests__/lib/assign-evaluators.test.ts`
- `app/api/admin/sync-roster/route.ts` — upsert roster rows POSTed by n8n (sheet stays the management UI until the sheet→DB effort finishes)
- `__tests__/api/sync-roster.test.ts`
- `app/api/cron/push-evaluations/route.ts`
- `__tests__/api/push-evaluations.test.ts`
- `app/api/cron/assign-evaluators/route.ts`
- `__tests__/api/assign-evaluators.test.ts`
- `workflows/db-push-assign.json` — n8n orchestrator (force-add to git)

---

### Task 1: Migration 011 — roster weight

**Files:**
- Create: `migrations/011_roster_weight.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Migration 011: evaluator_roster.weight — assignment quota weight
-- Mirrors the "Weight" column of the Evaluator List sheet (blank → 100).
ALTER TABLE evaluator_roster
  ADD COLUMN IF NOT EXISTS weight INT NOT NULL DEFAULT 100;
```

- [ ] **Step 2: Commit**

```bash
git add migrations/011_roster_weight.sql
git commit -m "feat: migration 011 — evaluator_roster.weight for DB assignment"
```

Note for the run log: migrations in this repo are applied **manually** against Neon Postgres. 009 and 010 are also still pending — apply 009 → 010 → 011 together at cutover prep.

---

### Task 2: `lib/assign-evaluators.ts` — pure assignment algorithm (TDD)

Port of the n8n `assigned2` code node: largest-remainder weighted split; platform-specific evaluators (ios/android) take matching-platform games first up to their weighted target; ALL remaining games are then split among `platform === 'all'` evaluators by weight. If there are no `all` evaluators, leftover games stay unassigned (same as the old flow).

**Files:**
- Create: `lib/assign-evaluators.ts`
- Test: `__tests__/lib/assign-evaluators.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
/**
 * @jest-environment node
 */
import { splitByWeight, assignGames } from '@/lib/assign-evaluators'

describe('splitByWeight', () => {
  it('splits total proportionally and sums exactly to total', () => {
    expect(splitByWeight([100, 100], 10)).toEqual([5, 5])
    const r = splitByWeight([100, 50, 50], 10)
    expect(r.reduce((a, b) => a + b, 0)).toBe(10)
    expect(r).toEqual([5, 3, 2]) // largest remainder
  })
  it('returns zeros for zero total or zero weights', () => {
    expect(splitByWeight([100, 100], 0)).toEqual([0, 0])
    expect(splitByWeight([0, 0], 5)).toEqual([0, 0])
  })
})

describe('assignGames', () => {
  const g = (id: number, os: string | null) => ({ id, os })

  it('splits evenly between two equal-weight "all" evaluators', () => {
    const games = [g(1, 'ios'), g(2, 'android'), g(3, 'ios'), g(4, 'android')]
    const evals = [
      { name: 'A', platform: 'all', weight: 100 },
      { name: 'B', platform: 'all', weight: 100 },
    ]
    const m = assignGames(games, evals)
    expect(m.size).toBe(4)
    const counts = [...m.values()].reduce((acc: Record<string, number>, n) => {
      acc[n] = (acc[n] || 0) + 1; return acc
    }, {})
    expect(counts).toEqual({ A: 2, B: 2 })
  })

  it('gives platform-specific evaluators only matching-platform games', () => {
    const games = [g(1, 'ios'), g(2, 'android'), g(3, 'ios'), g(4, 'ios')]
    const evals = [
      { name: 'IOS', platform: 'ios', weight: 100 },
      { name: 'ALL', platform: 'all', weight: 300 },
    ]
    const m = assignGames(games, evals)
    expect(m.size).toBe(4)
    for (const [id, name] of m) {
      if (name === 'IOS') expect(games.find(x => x.id === id)!.os).toBe('ios')
    }
    // IOS target = round(4 * 100/400) = 1
    expect([...m.values()].filter(n => n === 'IOS').length).toBe(1)
  })

  it('leaves games unassigned when no "all" evaluator can take the rest', () => {
    const games = [g(1, 'android'), g(2, 'android')]
    const evals = [{ name: 'IOS', platform: 'ios', weight: 100 }]
    const m = assignGames(games, evals)
    expect(m.size).toBe(0)
  })

  it('throws on empty evaluator list', () => {
    expect(() => assignGames([g(1, 'ios')], [])).toThrow('evaluator list empty')
  })

  it('treats unknown/blank platform and weight as all/100', () => {
    const games = [g(1, null), g(2, 'ios')]
    const evals = [{ name: 'A', platform: '', weight: 0 }]
    const m = assignGames(games, evals)
    expect(m.size).toBe(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/lib/assign-evaluators.test.ts`
Expected: FAIL — module `@/lib/assign-evaluators` not found.

- [ ] **Step 3: Implement**

```ts
// Pure assignment algorithm, ported from the n8n "auto-assign-game-evaluator"
// flow (code node `assigned2`). No I/O — callers load games/roster and persist.

export interface AssignableGame {
  id: number
  os: string | null // game_info.os: 'ios' | 'android' | other/null
}

export interface RosterEvaluator {
  name: string
  platform: string // 'all' | 'ios' | 'android' (blank/unknown → 'all')
  weight: number   // blank/0 → 100
}

// Largest-remainder split of `total` proportional to `weights`; sums to total.
export function splitByWeight(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0 || total <= 0) return weights.map(() => 0)
  const raw = weights.map(w => (total * w) / sum)
  const base = raw.map(x => Math.floor(x))
  let rem = total - base.reduce((a, b) => a + b, 0)
  const order = raw.map((_, i) => i).sort((a, b) => (raw[b] - base[b]) - (raw[a] - base[a]))
  for (let i = 0; i < rem; i++) base[order[i]]++
  return base
}

function gameMatchesPlatform(game: AssignableGame, platform: string): boolean {
  if (!platform || platform === 'all') return true
  return (game.os || '').toLowerCase() === platform
}

// Returns Map<gameId, evaluatorName>. Games may be left out when only
// platform-specific evaluators remain and no game matches their platform.
export function assignGames(
  games: AssignableGame[],
  roster: { name: string; platform?: string | null; weight?: number | null }[],
): Map<number, string> {
  const evaluators = roster
    .map(e => ({
      name: String(e.name ?? '').trim(),
      platform: String(e.platform ?? 'all').trim().toLowerCase() || 'all',
      weight: Number(e.weight) || 100,
    }))
    .filter(e => e.name)
  if (evaluators.length === 0) throw new Error('evaluator list empty')

  const targets = splitByWeight(evaluators.map(e => e.weight), games.length)
  const assignment = new Map<number, string>()
  let remaining = [...games]

  // Phase 1: platform-specific evaluators take matching games up to target.
  evaluators.forEach((e, i) => {
    if (e.platform === 'all') return
    const take = remaining.filter(g => gameMatchesPlatform(g, e.platform)).slice(0, targets[i])
    for (const g of take) assignment.set(g.id, e.name)
    remaining = remaining.filter(g => !assignment.has(g.id))
  })

  // Phase 2: everything left is split among 'all' evaluators by weight.
  const alls = evaluators.filter(e => e.platform === 'all')
  if (alls.length > 0 && remaining.length > 0) {
    const share = splitByWeight(alls.map(e => e.weight), remaining.length)
    let k = 0
    alls.forEach((e, i) => {
      for (let j = 0; j < share[i]; j++) assignment.set(remaining[k++].id, e.name)
    })
  }

  return assignment
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/lib/assign-evaluators.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/assign-evaluators.ts __tests__/lib/assign-evaluators.test.ts
git commit -m "feat: pure weighted assignment algorithm ported from n8n flow"
```

---

### Task 3: `POST /api/admin/sync-roster`

The Evaluator List sheet stays the roster management UI for now (handover flows also read it). n8n reads the sheet and POSTs rows here before each assign run, so `evaluator_roster` always mirrors it. When the sheet→DB migration finishes, this route is bypassed and the Team page writes the table directly.

**Files:**
- Create: `app/api/admin/sync-roster/route.ts`
- Test: `__tests__/api/sync-roster.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { POST } from '@/app/api/admin/sync-roster/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

function post(body: unknown, secret = 's3cret') {
  return POST(new NextRequest('http://localhost/api/admin/sync-roster', {
    method: 'POST',
    headers: { 'x-webhook-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('POST /api/admin/sync-roster', () => {
  const realSecret = process.env.WEBHOOK_SECRET
  beforeAll(() => { process.env.WEBHOOK_SECRET = 's3cret'; process.env.SKIP_AUTH = 'false' })
  afterAll(() => { process.env.WEBHOOK_SECRET = realSecret })
  beforeEach(() => { sqlMock.mockReset(); sqlMock.mockResolvedValue([]) })

  it('rejects a wrong secret with 401', async () => {
    const res = await post({ rows: [] }, 'wrong')
    expect(res.status).toBe(401)
  })

  it('rejects missing rows with 400', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
  })

  it('upserts each row and reports the count', async () => {
    const res = await post({ rows: [
      { 'Evaluator Name': 'KietCD', 'Today Available': 'Yes', 'Game Platform': 'all', 'Weight': '100' },
      { 'Evaluator Name': 'HuyDD', 'Today Available': 'No', 'Game Platform': 'ios', 'Weight': '' },
    ] })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.synced).toBe(2)
    const q = sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? c[0].join(' ') : '')).join('\n')
    expect(q).toContain('INSERT INTO evaluator_roster')
    expect(q).toContain('ON CONFLICT')
  })

  it('skips rows without a name', async () => {
    const res = await post({ rows: [{ 'Evaluator Name': '' }] })
    const json = await res.json()
    expect(json.synced).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/api/sync-roster.test.ts`
Expected: FAIL — route module not found.

- [ ] **Step 3: Implement the route**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Mirror the "Evaluator List" Google Sheet into evaluator_roster (list_type
// 'initial'). n8n POSTs the sheet rows (keyed by column title) before each
// assign run, so the DB roster always matches what managers edit in the sheet.

function hasWebhookSecret(req: NextRequest): boolean {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

export async function POST(req: NextRequest) {
  if (!hasWebhookSecret(req)) {
    const guard = await requireRole(['admin'])
    if (guard) return guard
  }

  let body: { rows?: Record<string, unknown>[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  if (!Array.isArray(body.rows)) {
    return NextResponse.json({ error: 'rows array required' }, { status: 400 })
  }

  let synced = 0
  for (const [i, row] of body.rows.entries()) {
    const name = String(row['Evaluator Name'] ?? '').trim()
    if (!name) continue
    const available = String(row['Today Available'] ?? '').trim().toLowerCase() === 'yes'
    const platform = String(row['Game Platform'] ?? 'all').trim().toLowerCase() || 'all'
    const weight = Number(row['Weight']) || 100
    const category = String(row['Game Category'] ?? '').trim().toLowerCase() || null
    await sql`
      INSERT INTO evaluator_roster (list_type, name, today_available, game_platform, game_category, weight, sort_order, updated_at)
      VALUES ('initial', ${name}, ${available}, ${platform}, ${category}, ${weight}, ${i}, NOW())
      ON CONFLICT (list_type, name) DO UPDATE SET
        today_available = EXCLUDED.today_available,
        game_platform   = EXCLUDED.game_platform,
        game_category   = EXCLUDED.game_category,
        weight          = EXCLUDED.weight,
        sort_order      = EXCLUDED.sort_order,
        updated_at      = NOW()
    `
    synced++
  }

  return NextResponse.json({ ok: true, synced })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/api/sync-roster.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/admin/sync-roster/route.ts __tests__/api/sync-roster.test.ts
git commit -m "feat: sync-roster route — mirror Evaluator List sheet into evaluator_roster"
```

---

### Task 4: `POST /api/cron/push-evaluations`

Mirrors the Smartsheet push SQL, inserting directly into `game_evaluations`. The category→categories-list mapping is POSTed by n8n (which already reads the "N8N configs" sheet), keeping a single config source until the sheet→DB effort lands. Dedupe = `ON CONFLICT (game_id, category_group) DO NOTHING`.

**Files:**
- Create: `app/api/cron/push-evaluations/route.ts`
- Test: `__tests__/api/push-evaluations.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { POST } from '@/app/api/cron/push-evaluations/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

function post(body: unknown, secret = 's3cret') {
  return POST(new NextRequest('http://localhost/api/cron/push-evaluations', {
    method: 'POST',
    headers: { 'x-webhook-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('POST /api/cron/push-evaluations', () => {
  const realSecret = process.env.WEBHOOK_SECRET
  beforeAll(() => { process.env.WEBHOOK_SECRET = 's3cret'; process.env.SKIP_AUTH = 'false' })
  afterAll(() => { process.env.WEBHOOK_SECRET = realSecret })
  beforeEach(() => { sqlMock.mockReset() })

  it('rejects a wrong secret with 401', async () => {
    const res = await post({ category: 'puzzle', categories: ['puzzle'] }, 'wrong')
    expect(res.status).toBe(401)
  })

  it('rejects an unknown category with 400', async () => {
    const res = await post({ category: 'rpg', categories: ['rpg'] })
    expect(res.status).toBe(400)
  })

  it('rejects an empty categories list with 400', async () => {
    const res = await post({ category: 'puzzle', categories: [] })
    expect(res.status).toBe(400)
  })

  it('inserts and returns the pushed game ids', async () => {
    sqlMock.mockResolvedValue([{ game_id: 'g1' }, { game_id: 'g2' }])
    const res = await post({ category: 'puzzle', categories: ['puzzle', 'word'] })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.pushed).toBe(2)
    expect(json.game_ids).toEqual(['g1', 'g2'])
    const q = sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? c[0].join(' ') : '')).join('\n')
    expect(q).toContain('INSERT INTO game_evaluations')
    expect(q).toContain('ON CONFLICT (game_id, category_group) DO NOTHING')
    expect(q).toContain("INTERVAL '30 days'")
  })

  it('dryRun selects without inserting', async () => {
    sqlMock.mockResolvedValue([{ game_id: 'g1' }])
    const res = await post({ category: 'puzzle', categories: ['puzzle'], dryRun: true })
    const json = await res.json()
    expect(json.dryRun).toBe(true)
    expect(json.pushed).toBe(1)
    const q = sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? c[0].join(' ') : '')).join('\n')
    expect(q).not.toContain('INSERT INTO game_evaluations')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/api/push-evaluations.test.ts`
Expected: FAIL — route module not found.

- [ ] **Step 3: Implement the route**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// DB replacement for the "[unified] database-to-smartsheet" n8n flow:
// new releases from game_info become unassigned game_evaluations rows.
// Same eligibility filter as the Smartsheet push; dedupe via the
// UNIQUE(game_id, category_group) constraint instead of the ID-ledger sheet.
// NOTE: never hard-delete game_evaluations rows for dead links (mark
// Link_dead) — a deleted row inside the 30-day window would be re-pushed.

const CATEGORIES = ['puzzle', 'arcade', 'simulation']

function hasWebhookSecret(req: NextRequest): boolean {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

export async function POST(req: NextRequest) {
  if (!hasWebhookSecret(req)) {
    const guard = await requireRole(['admin'])
    if (guard) return guard
  }

  let body: { category?: string; categories?: string[]; dryRun?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const category = body.category || ''
  if (!CATEGORIES.includes(category)) {
    return NextResponse.json({ error: `category must be one of ${CATEGORIES.join(', ')}` }, { status: 400 })
  }
  const cats = (body.categories || []).map(c => String(c).trim().toLowerCase()).filter(Boolean)
  if (cats.length === 0) {
    return NextResponse.json({ error: 'categories list required' }, { status: 400 })
  }

  try {
    // Eligibility mirror of the Smartsheet push SQL. Dates compare in VN time
    // like the old flow did ($now was UTC+7 in n8n).
    const eligible = sql`
      SELECT gi.game_id
      FROM game_info gi
      WHERE COALESCE(gi.initial_release, gi.temp_release)
              BETWEEN ((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - INTERVAL '30 days')
                  AND (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
        AND (gi.type IS NULL OR gi.type::text ILIKE '%sync%')
        AND gi.app_link IS NOT NULL
        AND gi.is_active = TRUE
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(gi.metadata -> 'categories') AS cat
          WHERE lower(cat) = ANY(${cats})
        )
        AND NOT EXISTS (
          SELECT 1 FROM game_evaluations ge
          WHERE ge.game_id = gi.game_id AND ge.category_group = ${category}
        )
    `

    const rows = body.dryRun
      ? await eligible
      : await sql`
          INSERT INTO game_evaluations (game_id, category_group)
          SELECT e.game_id FROM (${eligible}) e, LATERAL (SELECT ${category}) c
          ON CONFLICT (game_id, category_group) DO NOTHING
          RETURNING game_id
        `

    return NextResponse.json({
      ok: true,
      dryRun: !!body.dryRun,
      category,
      pushed: rows.length,
      game_ids: rows.map(r => r.game_id),
    })
  } catch (err) {
    console.error('POST /api/cron/push-evaluations error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
```

**Implementation note (verify when writing):** the nested `SELECT ... FROM (${eligible})` composition must match how `lib/db`'s tagged-template fragments compose in this codebase (the `postgres` library composes fragments natively). If fragment-in-FROM proves awkward, inline the WHERE clause into the INSERT…SELECT directly — duplication of the filter between dryRun and insert paths is acceptable; keeping the INSERT shape `INSERT INTO game_evaluations (game_id, category_group) SELECT gi.game_id, ${category} FROM game_info gi WHERE ... ON CONFLICT (game_id, category_group) DO NOTHING RETURNING game_id` is what the tests assert.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/api/push-evaluations.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/push-evaluations/route.ts __tests__/api/push-evaluations.test.ts
git commit -m "feat: push-evaluations cron route — game_info → game_evaluations"
```

---

### Task 5: `POST /api/cron/assign-evaluators`

**Files:**
- Create: `app/api/cron/assign-evaluators/route.ts`
- Test: `__tests__/api/assign-evaluators.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { POST } from '@/app/api/cron/assign-evaluators/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

function setupSql({ roster = [] as Record<string, unknown>[], games = [] as Record<string, unknown>[] }) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('FROM evaluator_roster')) return Promise.resolve(roster)
    if (q.includes('initial_evaluator IS NULL')) return Promise.resolve(games)
    return Promise.resolve([]) // UPDATEs
  })
}

function post(body: unknown, secret = 's3cret') {
  return POST(new NextRequest('http://localhost/api/cron/assign-evaluators', {
    method: 'POST',
    headers: { 'x-webhook-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('POST /api/cron/assign-evaluators', () => {
  const realSecret = process.env.WEBHOOK_SECRET
  beforeAll(() => { process.env.WEBHOOK_SECRET = 's3cret'; process.env.SKIP_AUTH = 'false' })
  afterAll(() => { process.env.WEBHOOK_SECRET = realSecret })

  it('rejects a wrong secret with 401', async () => {
    setupSql({})
    const res = await post({ category: 'puzzle' }, 'wrong')
    expect(res.status).toBe(401)
  })

  it('returns ok with zero assignments when no unassigned games', async () => {
    setupSql({ roster: [{ name: 'A', game_platform: 'all', weight: 100 }], games: [] })
    const res = await post({ category: 'puzzle' })
    const json = await res.json()
    expect(json.assigned).toBe(0)
  })

  it('returns 409 when the available roster is empty', async () => {
    setupSql({ roster: [], games: [{ id: 1, os: 'ios' }] })
    const res = await post({ category: 'puzzle' })
    expect(res.status).toBe(409)
  })

  it('assigns games and reports per-evaluator counts', async () => {
    setupSql({
      roster: [
        { name: 'A', game_platform: 'all', weight: 100 },
        { name: 'B', game_platform: 'all', weight: 100 },
      ],
      games: [{ id: 1, os: 'ios' }, { id: 2, os: 'android' }, { id: 3, os: 'ios' }, { id: 4, os: 'ios' }],
    })
    const res = await post({ category: 'puzzle' })
    const json = await res.json()
    expect(json.assigned).toBe(4)
    expect(json.per_evaluator).toEqual({ A: 2, B: 2 })
    const q = sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? c[0].join(' ') : '')).join('\n')
    expect(q).toContain('UPDATE game_evaluations')
    expect(q).toContain('assigned_date')
  })

  it('dryRun computes the split without updating', async () => {
    setupSql({
      roster: [{ name: 'A', game_platform: 'all', weight: 100 }],
      games: [{ id: 1, os: 'ios' }],
    })
    const res = await post({ category: 'puzzle', dryRun: true })
    const json = await res.json()
    expect(json.dryRun).toBe(true)
    expect(json.assigned).toBe(1)
    const q = sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? c[0].join(' ') : '')).join('\n')
    expect(q).not.toContain('UPDATE game_evaluations')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/api/assign-evaluators.test.ts`
Expected: FAIL — route module not found.

- [ ] **Step 3: Implement the route**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { assignGames } from '@/lib/assign-evaluators'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// DB replacement for the "auto-assign-game-evaluator" n8n flow: distribute
// unassigned game_evaluations rows among today's available evaluators
// (evaluator_roster, list_type 'initial') by weight, platform-aware.
// Run AFTER /api/cron/push-evaluations and /api/admin/sync-roster.

const CATEGORIES = ['puzzle', 'arcade', 'simulation']

function hasWebhookSecret(req: NextRequest): boolean {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

export async function POST(req: NextRequest) {
  if (!hasWebhookSecret(req)) {
    const guard = await requireRole(['admin'])
    if (guard) return guard
  }

  let body: { category?: string; dryRun?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const category = body.category || ''
  if (!CATEGORIES.includes(category)) {
    return NextResponse.json({ error: `category must be one of ${CATEGORIES.join(', ')}` }, { status: 400 })
  }

  try {
    // Roster: available initial evaluators whose category matches (blank = any).
    const roster = await sql`
      SELECT name, game_platform, weight
      FROM evaluator_roster
      WHERE list_type = 'initial'
        AND today_available = TRUE
        AND (game_category IS NULL OR game_category = '' OR lower(game_category) = ${category})
      ORDER BY sort_order NULLS LAST, name
    `

    // Unassigned rows of this category, with the game's platform.
    const games = await sql`
      SELECT ge.id, gi.os
      FROM game_evaluations ge
      JOIN game_info gi ON ge.game_id = gi.game_id
      WHERE ge.category_group = ${category}
        AND ge.initial_evaluator IS NULL
      ORDER BY ge.imported_at
    `

    if (games.length === 0) {
      return NextResponse.json({ ok: true, dryRun: !!body.dryRun, category, assigned: 0, per_evaluator: {} })
    }
    if (roster.length === 0) {
      return NextResponse.json({ error: 'no available evaluators in roster' }, { status: 409 })
    }

    const assignment = assignGames(
      games.map(g => ({ id: g.id, os: g.os })),
      roster.map(r => ({ name: r.name, platform: r.game_platform, weight: r.weight })),
    )

    if (!body.dryRun) {
      // One UPDATE per evaluator (grouped), assigned_date = today VN.
      const byEvaluator = new Map<string, number[]>()
      for (const [id, name] of assignment) {
        const ids = byEvaluator.get(name) || []
        ids.push(id)
        byEvaluator.set(name, ids)
      }
      for (const [name, ids] of byEvaluator) {
        await sql`
          UPDATE game_evaluations
          SET initial_evaluator = ${name},
              assigned_date = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
          WHERE id IN ${sql(ids)}
        `
      }
    }

    const perEvaluator: Record<string, number> = {}
    for (const name of assignment.values()) perEvaluator[name] = (perEvaluator[name] || 0) + 1

    return NextResponse.json({
      ok: true,
      dryRun: !!body.dryRun,
      category,
      assigned: assignment.size,
      unassigned: games.length - assignment.size,
      per_evaluator: perEvaluator,
    })
  } catch (err) {
    console.error('POST /api/cron/assign-evaluators error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/api/assign-evaluators.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the whole suite + lint**

Run: `npx jest && npx next lint --file app/api/cron/assign-evaluators/route.ts`
Expected: new tests pass; pre-existing failures in `evaluators.test.ts`/`workflows-trigger.test.ts` (old `manager` role — known) are the only failures.

- [ ] **Step 6: Commit**

```bash
git add app/api/cron/assign-evaluators/route.ts __tests__/api/assign-evaluators.test.ts
git commit -m "feat: assign-evaluators cron route — weighted DB assignment"
```

---

### Task 6: n8n orchestrator flow `workflows/db-push-assign.json`

One flow, daily schedule (07:00 VN — after `[unified]-import-daily-game` finishes and after flow 2's 06:00 sync; adjust on import). Chain: read config sheet → read Evaluator List sheet → sync roster → per category: push → assign → summary → Google Chat + `flow_log`. Uses HTTP Request nodes (NOT Code-node helpers — they fail on n8n cloud) with header `x-webhook-secret`.

**Files:**
- Create: `workflows/db-push-assign.json` (placeholder `REPLACE_WITH_APP_URL` / `REPLACE_WITH_WEBHOOK_SECRET`, same convention as `smartsheet-to-db-evaluations.json`)

- [ ] **Step 1: Author the workflow JSON**

Node graph (follow the JSON structure of `workflows/smartsheet-db-update-sync.json` as the template — schedule trigger, Google Sheets nodes with cred id `UMl5XCc7aOcf9yi3`, HTTP Request typeVersion 4.2, Google Chat notify to `spaces/AAQAYTKWM1I`, flow_log append with columns date/name/status/note):

1. **Schedule Trigger** — cron `0 7 * * *` Asia/Ho_Chi_Minh, plus a Manual Trigger for testing.
2. **Read Config** (Google Sheets) — doc `1yb558PpmunJcdDYCyVzdDpBfKDiIArMBG4IBI-eR0dg` tab "N8N configs"; Code node ports the existing `Parse Config` logic: rows with `field` like `<Group> smartsheet ID` → `{ category_group, categories: categories_list.split(',') }`.
3. **Read Evaluator List** (Google Sheets) — doc `1kR6I3DnYCn67GUqZv0ms6cksUnRTHEBQniVjOuoEqlo` tab "Evaluator List" (ALL rows, including Today Available=No — the route stores availability).
4. **HTTP: Sync Roster** — `POST {APP_URL}/api/admin/sync-roster`, body `{ "rows": <sheet rows> }`, header `x-webhook-secret`.
5. **Split per category** (Code) — one item per `{ category, categories }` from step 2.
6. **HTTP: Push** — `POST {APP_URL}/api/cron/push-evaluations`, body `={{ { category: $json.category, categories: $json.categories, dryRun: true } }}` (dryRun flipped to false at cutover).
7. **HTTP: Assign** — `POST {APP_URL}/api/cron/assign-evaluators`, body `={{ { category: $json.category, dryRun: true } }}`.
8. **Summary** (Code) — aggregate `pushed`/`assigned`/`per_evaluator` across categories into one message string (VN time date header).
9. **Google Chat notify** + **Append flow_log** (Google Sheets append: date, `db-push-assign`, status, note = summary).
10. **Error Trigger → Google Chat** — same error-notification pattern as the unified push flow.

- [ ] **Step 2: Validate the JSON parses and force-add**

Run: `python3 -c "import json; json.load(open('workflows/db-push-assign.json')); print('ok')"`
Expected: `ok`

```bash
git add -f workflows/db-push-assign.json
git commit -m "feat: n8n orchestrator flow for DB push+assign (dry-run defaults)"
```

- [ ] **Step 3: Import into n8n (manual, user)**

Import the JSON at `autoai9.app.n8n.cloud`, fill `REPLACE_WITH_APP_URL` (Replit deployment URL) + `REPLACE_WITH_WEBHOOK_SECRET`, wire Google Sheets cred `UMl5XCc7aOcf9yi3` and Chat cred, run once manually, check the Chat dry-run summary.

---

### Task 7: Parallel validation + cutover (runbook — no code)

- [ ] **Step 1: Apply migrations** — run 009, 010, 011 manually against Neon Postgres (in order).
- [ ] **Step 2: Activate the new flow in dry-run** — schedule on, both HTTP bodies `dryRun: true`. For 2–3 days compare the Chat dry-run summary against the old pipeline's push notification: `pushed` counts should match the Smartsheet flow's "new games" counts (note: DB dedupe is per-category `ON CONFLICT`, the old ledger was global — small drift means a game already in `game_evaluations` from the one-time import; investigate only if counts diverge consistently).
- [ ] **Step 3: Cutover morning (pick a low-traffic day):**
  1. Deactivate in n8n: `[unified]-database-to-smartsheet` (or remove its `Call 'Auto Assign Game Evaluator'` link if the import flow chain needs it), `auto-assign-game-evaluator`, `smartsheet-db-update-sync` (flow 2 — MUST be off, it would overwrite DB assignments with Smartsheet's empty cells).
  2. Flip both HTTP bodies in `db-push-assign` to `dryRun: false`; run once manually; verify rows appear unassigned then assigned in the Evaluations page, `per_evaluator` split looks sane.
  3. Announce to evaluators: from today, work in the web app, not Smartsheet.
- [ ] **Step 4: Post-cutover cleanup (after ~1 week stable):** archive the Smartsheet push/assign flows and the "[Signal] Imported Game IDs" ledger sheet; update memory (`evaluation-pipeline-to-db` phases 2–3 done); plan the follow-up to move roster management off the Evaluator List sheet into the Team page (drops the sync-roster step).

**Rollback:** reactivate the three old flows and set `dryRun: true` on the new flow. Smartsheet still has all rows up to cutover; flow 2 re-syncs any edits made in Smartsheet during the gap.

---

## Self-review notes

- Old behaviors intentionally NOT ported: the per-row 3-day "modified since" window (DB assign targets `initial_evaluator IS NULL` directly — strictly more correct); the Imported-IDs ledger (replaced by the UNIQUE constraint — see the no-hard-delete rule); Smartsheet column-id lookups (gone).
- `assignGames` Phase 1 target uses the evaluator's global weighted target like the original (`splitByWeight` over ALL evaluators), and Phase 2 re-splits the remainder over `all` evaluators only — matches `assigned2` exactly.
- Types consistent: `AssignableGame {id, os}` ↔ assign route SELECT `ge.id, gi.os`; `RosterEvaluator.platform` ↔ roster `game_platform`.
- Case drift: roster names come from the sheet; migration 010 normalizes `game_evaluations` to `dashboard_users` casing. The sync-roster route stores sheet casing as-is — assignment writes that casing into `initial_evaluator`. Sheet names already match dashboard_users casing (KietCD, HuyDD…); if drift appears, normalize in sync-roster against `dashboard_users` (same pass-1 rule as migration 010).
```
