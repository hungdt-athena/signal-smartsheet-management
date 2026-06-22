# Weekly Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Weekly Feedback" tab where each evaluator writes a per-week rich-text feedback plus a structured "Game Alike" list, inserting games by pasting a store link (auto-matched against the DB) or typing a name to search.

**Architecture:** A new `weekly_feedback` Postgres table (one row per `batch`+`evaluator`). Next.js route handlers expose game search, batch list, and own-only CRUD reusing the existing own-only gate from `app/api/evaluations/route.ts`. A new client page at `/weekly-feedback` renders two views (batch editor + read-only list) built from Tiptap (rich text) and a structured Game Alike editor, sharing one game-search component.

**Tech Stack:** Next.js 14 (App Router), `postgres` (tagged-template `sql`), next-auth, Tiptap (`@tiptap/react` + StarterKit + Underline + Link + suggestion), Jest + Testing Library.

## Global Constraints

- Node/Next: Next.js `14.2.35`, React 18, TypeScript 5. App Router route handlers only.
- DB access ONLY via `import { sql } from '@/lib/db'` (tagged template). Never build raw strings.
- Own-only rule (verbatim from `app/api/evaluations/route.ts:20-26`): `isManager = SKIP_AUTH || role ∈ {'admin','moderator'}`; non-managers are forced to `session.user.name`; match `lower(evaluator) = lower(...)`. Write is own-only even for admins.
- Roles type: `'admin' | 'moderator' | 'evaluator'` (see `lib/auth-guard.ts`).
- All route handlers: `export const dynamic = 'force-dynamic'`.
- Path alias: `@/` → repo root (see `jest.config.ts` / `tsconfig.json`).
- Tests run with `npm test`. Node-environment API tests use `/** @jest-environment node */` and mock `@/lib/db` and `next-auth` as in `__tests__/api/evaluations.test.ts`.
- Batch label format is free text like `"W1 Jun, 2026"`, max 40 chars (matches `game_evaluations.batch VARCHAR(40)`).
- Timezone for any date display: `Asia/Ho_Chi_Minh` (UTC+7).
- Commit after every task. Co-author trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: Database migration — `weekly_feedback` table

**Files:**
- Create: `migrations/017_weekly_feedback.sql`

**Interfaces:**
- Produces: table `weekly_feedback(id, batch, evaluator, feedback jsonb, game_alike jsonb, created_at, updated_at)` with `UNIQUE(batch, evaluator)`.
- Consumes: existing trigger function `update_game_evaluations_timestamp()` (defined in `migrations/005_game_evaluations.sql`).

- [ ] **Step 1: Write the migration file**

```sql
-- Migration 017: Weekly Feedback
-- One feedback record per (batch, evaluator). `batch` reuses the weekly labels
-- from game_evaluations.batch (e.g. "W1 Jun, 2026"). `feedback` stores a Tiptap
-- document (rich text + inline game hyperlinks). `game_alike` stores structured
-- sections: [{ name: string|null, games: [{ game_id, title, app_link, icon_url, manual }] }].

CREATE TABLE IF NOT EXISTS weekly_feedback (
  id          SERIAL PRIMARY KEY,
  batch       VARCHAR(40)  NOT NULL,
  evaluator   VARCHAR(100) NOT NULL,
  feedback    JSONB,
  game_alike  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (batch, evaluator)
);

CREATE INDEX IF NOT EXISTS idx_weekly_feedback_evaluator ON weekly_feedback (lower(evaluator));
CREATE INDEX IF NOT EXISTS idx_weekly_feedback_batch     ON weekly_feedback (batch);

DROP TRIGGER IF EXISTS trg_weekly_feedback_updated ON weekly_feedback;
CREATE TRIGGER trg_weekly_feedback_updated
  BEFORE UPDATE ON weekly_feedback
  FOR EACH ROW
  EXECUTE FUNCTION update_game_evaluations_timestamp();
```

- [ ] **Step 2: Sanity-check SQL parses (dry, no DB needed)**

Run: `grep -c "CREATE TABLE IF NOT EXISTS weekly_feedback" migrations/017_weekly_feedback.sql`
Expected: `1`

- [ ] **Step 3: Commit**

```bash
git add migrations/017_weekly_feedback.sql
git commit -m "feat(weekly-feedback): migration 017 weekly_feedback table"
```

> NOTE for executor: migrations in this repo are applied manually against Neon (see prior migration notes). Do NOT attempt to auto-run it. Flag in the final summary that 017 needs manual apply.

---

### Task 2: Store-link parser utility (pure function, TDD)

**Files:**
- Create: `lib/game-link.ts`
- Test: `__tests__/lib/game-link.test.ts`

**Interfaces:**
- Produces:
  - `type StorePlatform = 'ios' | 'android'`
  - `interface ParsedStoreLink { platform: StorePlatform; storeId: string }`
  - `function parseStoreLink(input: string): ParsedStoreLink | null`
    - iOS: matches `id<digits>` anywhere in an `apps.apple.com` URL → `{ platform:'ios', storeId:'<digits>' }`.
    - Android: matches `play.google.com/...?id=<package>` (or `&id=`) → `{ platform:'android', storeId:'<package>' }`.
    - Returns `null` for anything else (plain text, junk, empty).
  - `function looksLikeUrl(input: string): boolean` — true if the trimmed input starts with `http://` or `https://`.

- [ ] **Step 1: Write the failing test**

```typescript
import { parseStoreLink, looksLikeUrl } from '@/lib/game-link'

describe('lib/game-link', () => {
  it('parses iOS App Store links to the numeric id', () => {
    expect(parseStoreLink('https://apps.apple.com/us/app/color-pop-master/id6757068097'))
      .toEqual({ platform: 'ios', storeId: '6757068097' })
    expect(parseStoreLink('https://apps.apple.com/us/app/id6757068097?l=en'))
      .toEqual({ platform: 'ios', storeId: '6757068097' })
  })

  it('parses Google Play links to the package id', () => {
    expect(parseStoreLink('https://play.google.com/store/apps/details?id=com.foo.bar&hl=en'))
      .toEqual({ platform: 'android', storeId: 'com.foo.bar' })
  })

  it('returns null for non-store text', () => {
    expect(parseStoreLink('Color Pop Master')).toBeNull()
    expect(parseStoreLink('')).toBeNull()
    expect(parseStoreLink('https://example.com/foo')).toBeNull()
  })

  it('looksLikeUrl detects http(s) inputs', () => {
    expect(looksLikeUrl('  https://apps.apple.com/x ')).toBe(true)
    expect(looksLikeUrl('Color Pop')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- game-link`
Expected: FAIL — "Cannot find module '@/lib/game-link'".

- [ ] **Step 3: Write the implementation**

```typescript
// Parses App Store / Google Play URLs into a platform + store id used to match
// against game_info. Pure + dependency-free so it runs identically on client and server.

export type StorePlatform = 'ios' | 'android'
export interface ParsedStoreLink { platform: StorePlatform; storeId: string }

export function looksLikeUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim())
}

export function parseStoreLink(input: string): ParsedStoreLink | null {
  const s = (input || '').trim()
  if (!s) return null

  if (/apps\.apple\.com/i.test(s)) {
    const m = s.match(/\/id(\d+)/i)
    if (m) return { platform: 'ios', storeId: m[1] }
  }

  if (/play\.google\.com/i.test(s)) {
    const m = s.match(/[?&]id=([a-zA-Z0-9._]+)/)
    if (m) return { platform: 'android', storeId: m[1] }
  }

  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- game-link`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/game-link.ts __tests__/lib/game-link.test.ts
git commit -m "feat(weekly-feedback): store-link parser util"
```

---

### Task 3: Game search API — `/api/games/search`

**Files:**
- Create: `app/api/games/search/route.ts`
- Test: `__tests__/api/games-search.test.ts`

**Interfaces:**
- Consumes: `parseStoreLink` (Task 2); `sql` from `@/lib/db`; `requireAuth` from `@/lib/auth-guard`.
- Produces: `GET /api/games/search` →
  `{ results: Array<{ game_id: string; title: string; app_link: string | null; icon_url: string | null }> }`
  - Query params: `q` (name substring) OR `link` (store URL). `link` takes precedence.
  - `link`: parse → match `game_info` where `game_id = storeId` OR `app_link ILIKE %storeId%`, limit 1.
  - `q`: `WHERE title ILIKE %q% AND is_active = true`, prefix matches first (`title ILIKE q%` ranked above), limit 10.
  - Empty/missing both → `{ results: [] }`.

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { GET } from '@/app/api/games/search/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

function get(qs: string) {
  return GET(new NextRequest(`http://localhost/api/games/search?${qs}`))
}

describe('GET /api/games/search', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { sqlMock.mockReset() })

  it('returns [] when neither q nor link given', async () => {
    const res = await get('')
    expect(await res.json()).toEqual({ results: [] })
    expect(sqlMock).not.toHaveBeenCalled()
  })

  it('searches by name when q is provided', async () => {
    sqlMock.mockResolvedValue([{ game_id: '1', title: 'Color Pop', app_link: 'x', icon_url: null }])
    const res = await get('q=color')
    expect(await res.json()).toEqual({
      results: [{ game_id: '1', title: 'Color Pop', app_link: 'x', icon_url: null }],
    })
    const text = (sqlMock.mock.calls[0][0] as string[]).join(' ')
    expect(text).toContain('ILIKE')
  })

  it('matches by store id when link is provided', async () => {
    sqlMock.mockResolvedValue([{ game_id: '6757068097', title: 'X', app_link: 'l', icon_url: null }])
    const res = await get('link=' + encodeURIComponent('https://apps.apple.com/us/app/x/id6757068097'))
    const body = await res.json()
    expect(body.results[0].game_id).toBe('6757068097')
  })

  it('returns [] for an unparseable link', async () => {
    const res = await get('link=' + encodeURIComponent('https://example.com/nope'))
    expect(await res.json()).toEqual({ results: [] })
    expect(sqlMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- games-search`
Expected: FAIL — cannot find route module.

- [ ] **Step 3: Write the implementation**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { parseStoreLink } from '@/lib/game-link'

export const dynamic = 'force-dynamic'

interface GameRow {
  game_id: string
  title: string
  app_link: string | null
  icon_url: string | null
}

export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const { searchParams } = req.nextUrl
  const link = (searchParams.get('link') || '').trim()
  const q = (searchParams.get('q') || '').trim()

  // Link wins: paste a store URL → exact game.
  if (link) {
    const parsed = parseStoreLink(link)
    if (!parsed) return NextResponse.json({ results: [] })
    const rows = await sql<GameRow[]>`
      SELECT game_id, title, app_link, icon_url
      FROM game_info
      WHERE game_id = ${parsed.storeId} OR app_link ILIKE ${'%' + parsed.storeId + '%'}
      LIMIT 1
    `
    return NextResponse.json({ results: rows })
  }

  if (q) {
    const rows = await sql<GameRow[]>`
      SELECT game_id, title, app_link, icon_url
      FROM game_info
      WHERE title ILIKE ${'%' + q + '%'} AND is_active = true
      ORDER BY (title ILIKE ${q + '%'}) DESC, length(title) ASC
      LIMIT 10
    `
    return NextResponse.json({ results: rows })
  }

  return NextResponse.json({ results: [] })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- games-search`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/api/games/search/route.ts __tests__/api/games-search.test.ts
git commit -m "feat(weekly-feedback): game search API (name + link)"
```

> NOTE for executor: the `game_id = storeId` match assumes iOS `game_id` equals the numeric App Store id. VERIFY against real `game_info` rows before relying on it; the `app_link ILIKE %storeId%` clause is the fallback that works regardless. If `game_id` is unrelated, the OR already covers it — no code change needed.

---

### Task 4: Batch list API — `/api/weekly-feedback/batches`

**Files:**
- Create: `app/api/weekly-feedback/batches/route.ts`
- Test: `__tests__/api/weekly-feedback-batches.test.ts`

**Interfaces:**
- Consumes: `sql`, `requireAuth`.
- Produces: `GET /api/weekly-feedback/batches` → `{ batches: string[] }`, distinct non-null `game_evaluations.batch`, most-recent first.

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
import { GET } from '@/app/api/weekly-feedback/batches/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

describe('GET /api/weekly-feedback/batches', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('returns the distinct batch labels', async () => {
    sqlMock.mockReset()
    sqlMock.mockResolvedValue([{ batch: 'W2 Jun, 2026' }, { batch: 'W1 Jun, 2026' }])
    const res = await GET()
    expect(await res.json()).toEqual({ batches: ['W2 Jun, 2026', 'W1 Jun, 2026'] })
    const text = (sqlMock.mock.calls[0][0] as string[]).join(' ')
    expect(text).toContain('DISTINCT')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- weekly-feedback-batches`
Expected: FAIL — cannot find route module.

- [ ] **Step 3: Write the implementation**

```typescript
import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const guard = await requireAuth()
  if (guard) return guard

  // Distinct weekly labels, newest activity first. Ordered by the latest
  // assignment date seen for each label so the dropdown reads top-down by week.
  const rows = await sql<{ batch: string }[]>`
    SELECT batch
    FROM game_evaluations
    WHERE batch IS NOT NULL
    GROUP BY batch
    ORDER BY MAX(COALESCE(assigned_date, imported_at::date)) DESC NULLS LAST
  `
  return NextResponse.json({ batches: rows.map(r => r.batch) })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- weekly-feedback-batches`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/weekly-feedback/batches/route.ts __tests__/api/weekly-feedback-batches.test.ts
git commit -m "feat(weekly-feedback): batch list API"
```

---

### Task 5: Weekly feedback CRUD API — `/api/weekly-feedback`

**Files:**
- Create: `app/api/weekly-feedback/route.ts`
- Test: `__tests__/api/weekly-feedback.test.ts`

**Interfaces:**
- Consumes: `sql`, `requireAuth`, `getServerSession`, `authOptions`.
- Produces:
  - `type GameAlikeGame = { game_id: string | null; title: string; app_link: string | null; icon_url: string | null; manual: boolean }`
  - `type GameAlikeSection = { name: string | null; games: GameAlikeGame[] }`
  - `type WeeklyFeedbackRecord = { batch: string; evaluator: string; feedback: unknown | null; game_alike: GameAlikeSection[]; updated_at: string }`
  - `GET /api/weekly-feedback?evaluator=…` → `{ records: WeeklyFeedbackRecord[] }` (list, all batches for the resolved evaluator).
  - `GET /api/weekly-feedback?batch=…&evaluator=…` → `{ record: WeeklyFeedbackRecord | null }`.
  - `PUT /api/weekly-feedback` body `{ batch, feedback, game_alike }` → upsert on `(batch, evaluator)`; `evaluator` server-resolved; returns `{ record }`. 403 if a non-self `evaluator` is requested by anyone (managers included — write is own-only).
- Own-only gate verbatim: `isManager = SKIP_AUTH || role ∈ {admin,moderator}`; non-manager `evaluator` forced to `session.user.name`.

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))

import { GET, PUT } from '@/app/api/weekly-feedback/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

function getReq(qs: string) {
  return GET(new NextRequest(`http://localhost/api/weekly-feedback?${qs}`))
}
function putReq(body: unknown) {
  return PUT(new NextRequest('http://localhost/api/weekly-feedback', {
    method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }))
}

describe('/api/weekly-feedback', () => {
  const realSkip = process.env.SKIP_AUTH
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { sqlMock.mockReset(); sessionMock.mockReset() })

  it('GET list forces evaluator to the session user for a non-manager', async () => {
    process.env.SKIP_AUTH = ''
    sessionMock.mockResolvedValue({ user: { name: 'Alice', role: 'evaluator' } })
    sqlMock.mockResolvedValue([])
    await getReq('evaluator=Bob') // attempts to read Bob's
    const text = (sqlMock.mock.calls[0][0] as string[]).join(' ')
    expect(text).toContain('lower(evaluator)')
    // bound param is Alice, not Bob:
    expect(sqlMock.mock.calls[0]).toContain('Alice')
    expect(sqlMock.mock.calls[0]).not.toContain('Bob')
  })

  it('PUT blocks writing to another evaluator (403)', async () => {
    process.env.SKIP_AUTH = ''
    sessionMock.mockResolvedValue({ user: { name: 'Alice', role: 'admin' } })
    const res = await putReq({ batch: 'W1 Jun, 2026', evaluator: 'Bob', feedback: {}, game_alike: [] })
    expect(res.status).toBe(403)
  })

  it('PUT upserts for the session user', async () => {
    process.env.SKIP_AUTH = ''
    sessionMock.mockResolvedValue({ user: { name: 'Alice', role: 'evaluator' } })
    sqlMock.mockResolvedValue([{ batch: 'W1 Jun, 2026', evaluator: 'Alice', feedback: {}, game_alike: [], updated_at: 'now' }])
    const res = await putReq({ batch: 'W1 Jun, 2026', feedback: { type: 'doc' }, game_alike: [] })
    expect(res.status).toBe(200)
    const text = (sqlMock.mock.calls[0][0] as string[]).join(' ')
    expect(text).toContain('ON CONFLICT')
  })

  it('PUT rejects a missing batch (400)', async () => {
    process.env.SKIP_AUTH = ''
    sessionMock.mockResolvedValue({ user: { name: 'Alice', role: 'evaluator' } })
    const res = await putReq({ feedback: {}, game_alike: [] })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- weekly-feedback.test`
Expected: FAIL — cannot find route module.

- [ ] **Step 3: Write the implementation**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

interface SessionInfo { isManager: boolean; name: string }

async function resolveSession(): Promise<SessionInfo> {
  if (process.env.SKIP_AUTH === 'true') return { isManager: true, name: '' }
  const session = await getServerSession(authOptions)
  const role = session?.user?.role
  return {
    isManager: role === 'admin' || role === 'moderator',
    name: session?.user?.name || '',
  }
}

export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const { isManager, name } = await resolveSession()
  const { searchParams } = req.nextUrl
  const batch = (searchParams.get('batch') || '').trim()

  // Managers may read any evaluator; everyone else is locked to themselves.
  const evaluator = isManager
    ? (searchParams.get('evaluator') || name || '')
    : (name || ' __no_evaluator__')

  if (batch) {
    const rows = await sql`
      SELECT batch, evaluator, feedback, game_alike, updated_at
      FROM weekly_feedback
      WHERE batch = ${batch} AND lower(evaluator) = lower(${evaluator})
      LIMIT 1
    `
    return NextResponse.json({ record: rows[0] ?? null })
  }

  const rows = await sql`
    SELECT batch, evaluator, feedback, game_alike, updated_at
    FROM weekly_feedback
    WHERE lower(evaluator) = lower(${evaluator})
    ORDER BY updated_at DESC
  `
  return NextResponse.json({ records: rows })
}

export async function PUT(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const { name } = await resolveSession()
  let body: { batch?: string; evaluator?: string; feedback?: unknown; game_alike?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }) }

  const batch = (body.batch || '').trim()
  if (!batch) return NextResponse.json({ error: 'batch is required' }, { status: 400 })

  // Write is own-only for everyone (admins included). A client that names a
  // different evaluator is rejected rather than silently rewritten.
  if (process.env.SKIP_AUTH !== 'true' && body.evaluator && body.evaluator.toLowerCase() !== name.toLowerCase()) {
    return NextResponse.json({ error: 'Forbidden: can only edit your own feedback' }, { status: 403 })
  }
  const evaluator = process.env.SKIP_AUTH === 'true' ? (body.evaluator || name || 'dev') : name
  if (!evaluator) return NextResponse.json({ error: 'No evaluator identity' }, { status: 400 })

  const feedback = body.feedback ?? null
  const gameAlike = Array.isArray(body.game_alike) ? body.game_alike : []

  const rows = await sql`
    INSERT INTO weekly_feedback (batch, evaluator, feedback, game_alike, updated_at)
    VALUES (${batch}, ${evaluator}, ${sql.json(feedback as object)}, ${sql.json(gameAlike)}, NOW())
    ON CONFLICT (batch, evaluator)
    DO UPDATE SET feedback = EXCLUDED.feedback, game_alike = EXCLUDED.game_alike, updated_at = NOW()
    RETURNING batch, evaluator, feedback, game_alike, updated_at
  `
  return NextResponse.json({ record: rows[0] })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- weekly-feedback.test`
Expected: PASS (4 tests). If the `not.toContain('Bob')` assertion is brittle (parameter array shape), assert on bound params: `expect(sqlMock.mock.calls[0][1]).toBe('Alice')` — adjust index to the first interpolated value.

- [ ] **Step 5: Commit**

```bash
git add app/api/weekly-feedback/route.ts __tests__/api/weekly-feedback.test.ts
git commit -m "feat(weekly-feedback): own-only CRUD API (list/get/upsert)"
```

---

### Task 6: Install Tiptap dependencies

**Files:**
- Modify: `package.json` (+ `package-lock.json`)

**Interfaces:**
- Produces: importable `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-underline`, `@tiptap/extension-link`, `@tiptap/suggestion`.

- [ ] **Step 1: Install pinned versions compatible with React 18**

Run:
```bash
npm install @tiptap/react@^2.11.0 @tiptap/starter-kit@^2.11.0 @tiptap/extension-underline@^2.11.0 @tiptap/extension-link@^2.11.0 @tiptap/suggestion@^2.11.0
```
Expected: dependencies added, no peer-dep errors against React 18.

- [ ] **Step 2: Verify the build still compiles**

Run: `npm run build`
Expected: build succeeds (no new type errors).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(weekly-feedback): add tiptap editor deps"
```

---

### Task 7: Shared types + `GameSearch` component

**Files:**
- Create: `components/weekly-feedback/types.ts`
- Create: `components/weekly-feedback/GameSearch.tsx`

**Interfaces:**
- Produces (`types.ts`):
  - `export interface GameHit { game_id: string; title: string; app_link: string | null; icon_url: string | null }`
  - `export interface GameAlikeGame { game_id: string | null; title: string; app_link: string | null; icon_url: string | null; manual: boolean }`
  - `export interface GameAlikeSection { name: string | null; games: GameAlikeGame[] }`
  - `export async function searchGames(opts: { q?: string; link?: string }): Promise<GameHit[]>` — wraps `GET /api/games/search`.
- Produces (`GameSearch.tsx`): `export function GameSearch({ onPick }: { onPick: (g: GameAlikeGame) => void })` — an input that, on a store-link paste, auto-matches and calls `onPick`; otherwise debounce-searches by name and shows a dropdown; picking a hit calls `onPick`. If a pasted link finds nothing, it offers "Add manually" (prompts for a title) producing `{ game_id:null, manual:true, app_link:<link>, title, icon_url:null }`.

- [ ] **Step 1: Write `types.ts`**

```typescript
export interface GameHit { game_id: string; title: string; app_link: string | null; icon_url: string | null }
export interface GameAlikeGame { game_id: string | null; title: string; app_link: string | null; icon_url: string | null; manual: boolean }
export interface GameAlikeSection { name: string | null; games: GameAlikeGame[] }

export async function searchGames(opts: { q?: string; link?: string }): Promise<GameHit[]> {
  const params = new URLSearchParams()
  if (opts.link) params.set('link', opts.link)
  else if (opts.q) params.set('q', opts.q)
  else return []
  const res = await fetch(`/api/games/search?${params.toString()}`)
  if (!res.ok) return []
  const data = await res.json()
  return data.results as GameHit[]
}
```

- [ ] **Step 2: Write `GameSearch.tsx`**

```tsx
'use client'
import { useState, useRef, useEffect, useCallback } from 'react'
import { GameHit, GameAlikeGame, searchGames } from './types'
import { looksLikeUrl, parseStoreLink } from '@/lib/game-link'

const hitToGame = (h: GameHit): GameAlikeGame => ({ ...h, manual: false })

export function GameSearch({ onPick }: { onPick: (g: GameAlikeGame) => void }) {
  const [text, setText] = useState('')
  const [hits, setHits] = useState<GameHit[]>([])
  const [loading, setLoading] = useState(false)
  const [noMatchLink, setNoMatchLink] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runSearch = useCallback(async (value: string) => {
    setNoMatchLink(null)
    if (looksLikeUrl(value)) {
      const parsed = parseStoreLink(value)
      if (!parsed) { setHits([]); return }
      setLoading(true)
      const results = await searchGames({ link: value })
      setLoading(false)
      if (results.length) { onPick(hitToGame(results[0])); setText(''); setHits([]) }
      else setNoMatchLink(value) // not in DB → offer manual add
      return
    }
    if (value.trim().length < 2) { setHits([]); return }
    setLoading(true)
    setHits(await searchGames({ q: value }))
    setLoading(false)
  }, [onPick])

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void runSearch(text) }, 250)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [text, runSearch])

  const addManual = () => {
    if (!noMatchLink) return
    const title = window.prompt('Game name (not found in DB):')?.trim()
    if (!title) return
    onPick({ game_id: null, title, app_link: noMatchLink, icon_url: null, manual: true })
    setText(''); setNoMatchLink(null)
  }

  return (
    <div className="wf-gamesearch" style={{ position: 'relative' }}>
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Paste a store link or type a game name…"
        style={{ width: '100%' }}
      />
      {loading && <span className="wf-hint">searching…</span>}
      {noMatchLink && (
        <button type="button" onClick={addManual} className="wf-addmanual">
          Not in DB — add “{noMatchLink}” manually
        </button>
      )}
      {hits.length > 0 && (
        <ul className="wf-hits" style={{ position: 'absolute', zIndex: 20, background: '#fff', width: '100%' }}>
          {hits.map(h => (
            <li key={h.game_id}>
              <button type="button" onClick={() => { onPick(hitToGame(h)); setText(''); setHits([]) }}>
                {h.icon_url && <img src={h.icon_url} alt="" width={20} height={20} />}
                {h.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors in `components/weekly-feedback/*`.

- [ ] **Step 4: Commit**

```bash
git add components/weekly-feedback/types.ts components/weekly-feedback/GameSearch.tsx
git commit -m "feat(weekly-feedback): shared game-search component + types"
```

---

### Task 8: `GameAlikeEditor` component

**Files:**
- Create: `components/weekly-feedback/GameAlikeEditor.tsx`

**Interfaces:**
- Consumes: `GameAlikeSection`, `GameAlikeGame` (Task 7); `GameSearch` (Task 7).
- Produces: `export function GameAlikeEditor({ value, onChange }: { value: GameAlikeSection[]; onChange: (v: GameAlikeSection[]) => void })` — render sections; each has an optional name input, a list of game chips (with remove), and a `GameSearch` to add games; buttons to add a section, remove a section, and move a section up/down.

- [ ] **Step 1: Write the component**

```tsx
'use client'
import { GameAlikeSection, GameAlikeGame } from './types'
import { GameSearch } from './GameSearch'

export function GameAlikeEditor({ value, onChange }: {
  value: GameAlikeSection[]
  onChange: (v: GameAlikeSection[]) => void
}) {
  const sections = value ?? []
  const update = (i: number, patch: Partial<GameAlikeSection>) =>
    onChange(sections.map((s, idx) => idx === i ? { ...s, ...patch } : s))
  const addSection = () => onChange([...sections, { name: '', games: [] }])
  const removeSection = (i: number) => onChange(sections.filter((_, idx) => idx !== i))
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= sections.length) return
    const next = [...sections]; [next[i], next[j]] = [next[j], next[i]]; onChange(next)
  }
  const addGame = (i: number, g: GameAlikeGame) =>
    update(i, { games: [...sections[i].games, g] })
  const removeGame = (i: number, gi: number) =>
    update(i, { games: sections[i].games.filter((_, idx) => idx !== gi) })

  return (
    <div className="wf-gamealike">
      {sections.map((s, i) => (
        <div key={i} className="wf-section">
          <div className="wf-section-head">
            <input
              value={s.name ?? ''}
              onChange={e => update(i, { name: e.target.value })}
              placeholder="Section name (optional)"
            />
            <button type="button" onClick={() => move(i, -1)} title="Move up">↑</button>
            <button type="button" onClick={() => move(i, 1)} title="Move down">↓</button>
            <button type="button" onClick={() => removeSection(i)} title="Remove section">✕</button>
          </div>
          <ul className="wf-chips">
            {s.games.map((g, gi) => (
              <li key={gi} className="wf-chip">
                {g.icon_url && <img src={g.icon_url} alt="" width={18} height={18} />}
                {g.app_link
                  ? <a href={g.app_link} target="_blank" rel="noopener">{g.title}</a>
                  : <span>{g.title}</span>}
                {g.manual && <span className="wf-manual" title="Not in DB">·manual</span>}
                <button type="button" onClick={() => removeGame(i, gi)}>✕</button>
              </li>
            ))}
          </ul>
          <GameSearch onPick={g => addGame(i, g)} />
        </div>
      ))}
      <button type="button" onClick={addSection} className="wf-addsection">+ Add section</button>
    </div>
  )
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/weekly-feedback/GameAlikeEditor.tsx
git commit -m "feat(weekly-feedback): Game Alike section editor"
```

---

### Task 9: `FeedbackEditor` (Tiptap) component

**Files:**
- Create: `components/weekly-feedback/FeedbackEditor.tsx`

**Interfaces:**
- Consumes: Tiptap (Task 6); `GameSearch` (Task 7) reused as a "insert game link" popover; `looksLikeUrl`/`parseStoreLink` not needed here (delegated to GameSearch).
- Produces: `export function FeedbackEditor({ value, onChange }: { value: unknown; onChange: (doc: unknown) => void })` — a Tiptap editor with a toolbar (bold/italic/underline/bullet list/link) plus an "Insert game" button that opens `GameSearch`; picking a game inserts a hyperlink (`title` text → `app_link`). `value`/`onChange` use Tiptap JSON (`editor.getJSON()`).

- [ ] **Step 1: Write the component**

```tsx
'use client'
import { useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import { GameSearch } from './GameSearch'
import { GameAlikeGame } from './types'

export function FeedbackEditor({ value, onChange }: { value: unknown; onChange: (doc: unknown) => void }) {
  const [showInsert, setShowInsert] = useState(false)
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
    ],
    content: (value as object) ?? '',
    onUpdate: ({ editor }) => onChange(editor.getJSON()),
    immediatelyRender: false,
  })
  if (!editor) return null

  const btn = (active: boolean) => ({ fontWeight: active ? 700 : 400 })
  const insertGame = (g: GameAlikeGame) => {
    setShowInsert(false)
    if (g.app_link) {
      editor.chain().focus()
        .insertContent(`<a href="${g.app_link}">${g.title}</a> `).run()
    } else {
      editor.chain().focus().insertContent(`${g.title} `).run()
    }
  }

  const setLink = () => {
    const url = window.prompt('URL:')?.trim()
    if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    else editor.chain().focus().unsetLink().run()
  }

  return (
    <div className="wf-editor">
      <div className="wf-toolbar">
        <button type="button" style={btn(editor.isActive('bold'))} onClick={() => editor.chain().focus().toggleBold().run()}>B</button>
        <button type="button" style={btn(editor.isActive('italic'))} onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></button>
        <button type="button" style={btn(editor.isActive('underline'))} onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></button>
        <button type="button" style={btn(editor.isActive('bulletList'))} onClick={() => editor.chain().focus().toggleBulletList().run()}>• List</button>
        <button type="button" style={btn(editor.isActive('link'))} onClick={setLink}>Link</button>
        <button type="button" onClick={() => setShowInsert(v => !v)}>+ Game</button>
      </div>
      {showInsert && <GameSearch onPick={insertGame} />}
      <EditorContent editor={editor} className="wf-prose" />
    </div>
  )
}
```

- [ ] **Step 2: Verify it type-checks and builds**

Run: `npx tsc --noEmit && npm run build`
Expected: success. (`immediatelyRender: false` avoids Next SSR hydration warnings.)

- [ ] **Step 3: Commit**

```bash
git add components/weekly-feedback/FeedbackEditor.tsx
git commit -m "feat(weekly-feedback): Tiptap feedback editor with game-link insert"
```

---

### Task 10: `FeedbackView` (read-only renderer)

**Files:**
- Create: `components/weekly-feedback/FeedbackView.tsx`

**Interfaces:**
- Consumes: Tiptap (`generateHTML`), `GameAlikeSection` (Task 7).
- Produces: `export function FeedbackView({ feedback, gameAlike }: { feedback: unknown; gameAlike: GameAlikeSection[] })` — renders the feedback JSON as read-only HTML and the Game Alike sections as static lists (used by the list view).

- [ ] **Step 1: Write the component**

```tsx
'use client'
import { useMemo } from 'react'
import { generateHTML } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import { GameAlikeSection } from './types'

const EXTS = [StarterKit, Underline, Link]

export function FeedbackView({ feedback, gameAlike }: { feedback: unknown; gameAlike: GameAlikeSection[] }) {
  const html = useMemo(() => {
    if (!feedback || typeof feedback !== 'object') return ''
    try { return generateHTML(feedback as object, EXTS) } catch { return '' }
  }, [feedback])

  return (
    <div className="wf-view">
      <div className="wf-prose" dangerouslySetInnerHTML={{ __html: html }} />
      <div className="wf-gamealike-view">
        {(gameAlike ?? []).map((s, i) => (
          <div key={i} className="wf-section-view">
            {s.name && <strong>{s.name}</strong>}
            <ul>
              {s.games.map((g, gi) => (
                <li key={gi}>
                  {g.app_link ? <a href={g.app_link} target="_blank" rel="noopener">{g.title}</a> : g.title}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/weekly-feedback/FeedbackView.tsx
git commit -m "feat(weekly-feedback): read-only feedback renderer"
```

---

### Task 11: Page + navigation wiring

**Files:**
- Create: `app/(manager)/weekly-feedback/page.tsx`
- Modify: `app/(manager)/layout.tsx` (add nav item; add `clipboard`-style icon if needed)

**Interfaces:**
- Consumes: `FeedbackEditor`, `GameAlikeEditor`, `FeedbackView`, types (Tasks 7-10); `registerUnsavedGuard` from `@/lib/unsaved-guard`; `useSession` from `next-auth/react`; `/api/weekly-feedback`, `/api/weekly-feedback/batches`, `/api/evaluators`.
- Produces: the `/weekly-feedback` route. Two views via `?view=batch|list`. Batch view: batch `<select>`, `FeedbackEditor` + `GameAlikeEditor`, a Save button (PUT). List view: a table of the evaluator's records rendered with `FeedbackView`, rows link to `?view=batch&batch=…`. Admin/moderator see an evaluator `<select>` (from `/api/evaluators`) and the editor is read-only when viewing someone else (uses `FeedbackView`); evaluators see no picker.

- [ ] **Step 1: Add the nav item in `app/(manager)/layout.tsx`**

Insert into `NAV_ITEMS` after the Evaluations entry (reuse the existing `clipboard` icon to avoid adding an SVG):

```tsx
  { href: '/weekly-feedback', label: 'Weekly Feedback', icon: 'clipboard',
    roles: ['admin', 'moderator', 'evaluator'], children: [
      { href: '/weekly-feedback?view=batch', label: 'By Week' },
      { href: '/weekly-feedback?view=list',  label: 'List' },
    ]},
```

- [ ] **Step 2: Write the page**

```tsx
'use client'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { FeedbackEditor } from '@/components/weekly-feedback/FeedbackEditor'
import { GameAlikeEditor } from '@/components/weekly-feedback/GameAlikeEditor'
import { FeedbackView } from '@/components/weekly-feedback/FeedbackView'
import { GameAlikeSection } from '@/components/weekly-feedback/types'
import { registerUnsavedGuard } from '@/lib/unsaved-guard'

interface Record { batch: string; evaluator: string; feedback: unknown; game_alike: GameAlikeSection[]; updated_at: string }

function Inner() {
  const { data: session } = useSession()
  const role = session?.user?.role
  const isManager = role === 'admin' || role === 'moderator'
  const params = useSearchParams()
  const router = useRouter()
  const view = params.get('view') === 'list' ? 'list' : 'batch'
  const selectedBatch = params.get('batch') || ''

  const [batches, setBatches] = useState<string[]>([])
  const [evaluators, setEvaluators] = useState<string[]>([])
  const [evaluator, setEvaluator] = useState('') // manager-only override
  const [feedback, setFeedback] = useState<unknown>(null)
  const [gameAlike, setGameAlike] = useState<GameAlikeSection[]>([])
  const [records, setRecords] = useState<Record[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const dirtyRef = useRef(false)

  const viewingSelf = !isManager || !evaluator || evaluator.toLowerCase() === (session?.user?.name || '').toLowerCase()

  useEffect(() => {
    fetch('/api/weekly-feedback/batches').then(r => r.json()).then(d => setBatches(d.batches || []))
    if (isManager) fetch('/api/evaluators').then(r => r.json()).then(d => setEvaluators(d.evaluators || d.names || []))
  }, [isManager])

  // Load the record for the selected batch (batch view).
  useEffect(() => {
    if (view !== 'batch' || !selectedBatch) return
    const qs = new URLSearchParams({ batch: selectedBatch })
    if (isManager && evaluator) qs.set('evaluator', evaluator)
    fetch(`/api/weekly-feedback?${qs}`).then(r => r.json()).then(d => {
      setFeedback(d.record?.feedback ?? null)
      setGameAlike(d.record?.game_alike ?? [])
      setDirty(false); dirtyRef.current = false
    })
  }, [view, selectedBatch, evaluator, isManager])

  // Load the list (list view).
  useEffect(() => {
    if (view !== 'list') return
    const qs = new URLSearchParams()
    if (isManager && evaluator) qs.set('evaluator', evaluator)
    fetch(`/api/weekly-feedback?${qs}`).then(r => r.json()).then(d => setRecords(d.records || []))
  }, [view, evaluator, isManager])

  const save = useCallback(async () => {
    setSaving(true)
    await fetch('/api/weekly-feedback', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch: selectedBatch, feedback, game_alike: gameAlike }),
    })
    setSaving(false); setDirty(false); dirtyRef.current = false
  }, [selectedBatch, feedback, gameAlike])

  // Unsaved guard so the deploy watcher / page close never drops edits.
  useEffect(() => registerUnsavedGuard({ isDirty: () => dirtyRef.current, flush: () => save() }), [save])
  const markDirty = () => { setDirty(true); dirtyRef.current = true }

  const goBatch = (b: string) => router.push(`/weekly-feedback?view=batch&batch=${encodeURIComponent(b)}`)

  return (
    <div className="bean-card wf-page">
      <div className="wf-head">
        <h1>Weekly Feedback</h1>
        {isManager && (
          <select value={evaluator} onChange={e => setEvaluator(e.target.value)}>
            <option value="">— my own —</option>
            {evaluators.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        )}
        <a href="/weekly-feedback?view=batch">By Week</a>
        <a href="/weekly-feedback?view=list">List</a>
      </div>

      {view === 'batch' && (
        <>
          <select value={selectedBatch} onChange={e => goBatch(e.target.value)}>
            <option value="">Select a week…</option>
            {batches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          {selectedBatch && (viewingSelf ? (
            <>
              <h3>Feedback</h3>
              <FeedbackEditor value={feedback} onChange={v => { setFeedback(v); markDirty() }} />
              <h3>Game Alike</h3>
              <GameAlikeEditor value={gameAlike} onChange={v => { setGameAlike(v); markDirty() }} />
              <button type="button" disabled={!dirty || saving} onClick={save}>
                {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
              </button>
            </>
          ) : (
            <FeedbackView feedback={feedback} gameAlike={gameAlike} />
          ))}
        </>
      )}

      {view === 'list' && (
        <table className="wf-list">
          <thead><tr><th>Week</th><th>Feedback</th><th>Game Alike</th></tr></thead>
          <tbody>
            {records.map(r => (
              <tr key={r.batch} onClick={() => goBatch(r.batch)} style={{ cursor: 'pointer' }}>
                <td>{r.batch}</td>
                <td colSpan={2}><FeedbackView feedback={r.feedback} gameAlike={r.game_alike} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default function WeeklyFeedbackPage() {
  return <Suspense><Inner /></Suspense>
}
```

- [ ] **Step 3: Confirm the evaluators endpoint shape**

Run: `grep -n "evaluators\|names\|NextResponse.json" app/api/evaluators/route.ts | head`
Expected: shows the JSON key the route returns. If it is neither `evaluators` nor `names`, adjust the `setEvaluators(...)` line in Step 2 to the actual key.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build succeeds; `/weekly-feedback` appears in the route list.

- [ ] **Step 5: Commit**

```bash
git add "app/(manager)/weekly-feedback/page.tsx" "app/(manager)/layout.tsx"
git commit -m "feat(weekly-feedback): page (batch + list views) and nav entry"
```

---

### Task 12: Styles + end-to-end manual verification

**Files:**
- Modify: `app/globals.css` (or the existing global stylesheet — confirm path via `grep -rl "bean-card" app`)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: minimal styling for `.wf-*` classes and a working, verified feature.

- [ ] **Step 1: Add minimal styles**

Append to the global stylesheet (path confirmed by the grep above):

```css
.wf-page .wf-toolbar { display: flex; gap: 6px; margin-bottom: 6px; }
.wf-page .wf-toolbar button { padding: 2px 8px; }
.wf-prose { border: 1px solid #ddd; border-radius: 6px; padding: 10px; min-height: 160px; }
.wf-prose:focus-within { border-color: #888; }
.wf-section { border: 1px solid #eee; border-radius: 6px; padding: 8px; margin: 8px 0; }
.wf-section-head { display: flex; gap: 6px; align-items: center; }
.wf-chips { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.wf-chip { display: inline-flex; align-items: center; gap: 4px; background: #f3f4f6; border-radius: 999px; padding: 2px 8px; }
.wf-hits { list-style: none; margin: 0; padding: 0; border: 1px solid #ddd; max-height: 240px; overflow: auto; }
.wf-hits li button { display: flex; gap: 8px; align-items: center; width: 100%; text-align: left; padding: 4px 8px; }
.wf-list td { vertical-align: top; border-bottom: 1px solid #eee; padding: 8px; }
```

- [ ] **Step 2: Run the app with auth bypassed**

Run: `SKIP_AUTH=true npm run dev`
Then open `http://localhost:3333/weekly-feedback?view=batch`.

- [ ] **Step 3: Manual verification checklist**

Verify each:
- Batch dropdown lists weeks from `game_evaluations`.
- In Feedback: bold/italic/underline/list/link work; "+ Game" → paste an iOS link → inserts a title hyperlink; type a name → suggestions appear → pick inserts a hyperlink.
- In Game Alike: add section, name it, add games by link and by name, remove a game, remove a section, reorder.
- Save → reload the page → content persists (requires migration 017 applied to the dev DB).
- `?view=list` shows rows; clicking a row opens that week in batch view.
- As a non-manager (set a session or temporarily hardcode), the evaluator picker is hidden and only your own data loads.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all suites pass (existing + new game-link, games-search, weekly-feedback, batches).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(weekly-feedback): styles + verification pass"
```

---

## Post-implementation notes (for the final summary)

- **Migration 017 must be applied manually** to Neon (consistent with prior migrations).
- **VERIFY** the `game_id` ↔ store-id relationship against real `game_info` rows (Task 3 note). The `app_link ILIKE` fallback covers the mismatch case.
- **VERIFY** the `/api/evaluators` response key used by the admin picker (Task 11 Step 3).
- Deferred (not in this plan): importing historical Google Sheet "Game Trends" data; per-category feedback.
```
