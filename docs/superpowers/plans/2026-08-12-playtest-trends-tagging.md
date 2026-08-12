# Playtest Trends Tagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let evaluators tag Trends on a game inside the evaluation modal, stage those tags for admin review in a new Evaluations > Tagging subtab, and only write them into Signal Sense's `custom_field_values` when an admin confirms.

**Architecture:** A new `playtest_tags` table in the shared Neon database holds proposals. Pure decision logic in `lib/playtest-tags.ts` classifies each proposal against Signal Sense's existing tags; Next route handlers under `/api/playtest-tags` read, replace, confirm, and reject. Two UI surfaces: a `TrendTagsField` inside `components/EvalDetailPanel.tsx` riding the existing save/auto-save flow, and a `TaggingTab` rendered by the `?cat=tagging` branch of the evaluations router.

**Tech Stack:** Next 14 App Router, TypeScript, `postgres` (the `sql` tagged-template client in `lib/db.ts`), next-auth, jest + ts-jest, plain CSS classes from `app/globals.css`.

**Spec:** `docs/superpowers/specs/2026-08-12-playtest-trends-tagging-design.md`

## Global Constraints

- Signal Sense's schema must not change. `custom_field_values` keeps `UNIQUE (game_id, field_name, field_value)` exactly as-is, because `customFieldValueRepository.ts:662` in the Signal Sense repo runs `ON CONFLICT (game_id, field_name, field_value) DO NOTHING`, an inference clause that breaks if the index widens.
- A tag's identity is `(game_id, 'Trends', field_value)`. The sub-value is an attribute of that tag, never part of its identity.
- Field name is always the string `Trends`, exported as `TRENDS_FIELD` from `lib/playtest-tags.ts`. Never inline the literal elsewhere.
- Writes into `custom_field_values` always set both `created_by` and `updated_by` to `'playtest_sync'` — the system account created by migration 035.
- Evaluators may only tag a game where `game_evaluations.initial_evaluator` equals their session name; admins may tag any game. Every route except `GET /api/playtest-tags?gameId=` is admin-only via `requireManager()` from `lib/auth-guard.ts`.
- New Trends values and new sub-values are never created from this app. The combobox only offers rows already in `custom_field_definitions` / `sub_value_definitions`.
- Timezone for any date display is `Asia/Ho_Chi_Minh` (UTC+7).
- Never run `npm run build` while the dev server is running — it corrupts `.next`.
- Every route handler exports `export const dynamic = 'force-dynamic'`.
- Test files that touch the database mock `@/lib/db` with a callable jest mock that also carries a `.json` member, and set `process.env.SKIP_AUTH = 'true'` in `beforeAll` (see `__tests__/api/rescue.test.ts:7-13`).

## File Structure

| File | Responsibility |
|---|---|
| `migrations/035_playtest_tags.sql` (create) | `playtest_tags` table, indexes, `playtest_sync` system account |
| `lib/playtest-tags.ts` (create) | `TRENDS_FIELD`, shared types, pure `classifyTag` + `resolveConfirm` |
| `app/api/trends/options/route.ts` (create) | active Trends values + sub-values, cached |
| `app/api/playtest-tags/route.ts` (create) | `GET` one game's tags, `PUT` replace that game's pending set |
| `app/api/playtest-tags/confirm/route.ts` (create) | apply the sync rules for one game in a transaction |
| `app/api/playtest-tags/reject/route.ts` (create) | mark ids rejected |
| `app/api/playtest-tags/pending/route.ts` (create) | admin queue grouped by game, with conflict data |
| `app/api/playtest-tags/history/route.ts` (create) | paged, filtered history |
| `components/TrendTagsField.tsx` (create) | tag rows + searchable value combobox + read-only existing chips |
| `components/TaggingTab.tsx` (create) | the Tagging subtab: Pending cards + History table |
| `components/EvalDetailPanel.tsx` (modify) | mount `TrendTagsField`, load/save tags with the eval |
| `app/(manager)/evaluations/page.tsx` (modify) | route `?cat=tagging` to `TaggingTab` |
| `app/(manager)/layout.tsx` (modify) | sidebar entry for the subtab |
| `__tests__/lib/playtest-tags.test.ts` (create) | classify + resolve unit tests |
| `__tests__/api/playtest-tags.test.ts` (create) | GET/PUT authorisation and replace semantics |
| `__tests__/api/playtest-tags-confirm.test.ts` (create) | mixed-batch confirm, overwrite, reject |

---

### Task 1: Migration and the decision logic

**Files:**
- Create: `migrations/035_playtest_tags.sql`
- Create: `lib/playtest-tags.ts`
- Test: `__tests__/lib/playtest-tags.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TRENDS_FIELD: 'Trends'`, `SYNC_USER: 'playtest_sync'`, types `PendingTag`, `ExistingTag`, `TagAction`, `SyncResult`, `ConfirmOutcome`, and functions `classifyTag(pending: PendingTag, existing: ExistingTag | undefined): TagAction` and `resolveConfirm(action: TagAction, overwrite: boolean): ConfirmOutcome`.

- [ ] **Step 1: Write the migration**

Create `migrations/035_playtest_tags.sql`:

```sql
-- Migration 035: playtest_tags — Trends tags proposed while testing a game.
--
-- Evaluators tag trends in the evaluation modal. Nothing reaches Signal Sense
-- until an admin confirms in Evaluations > Tagging; only then do we write into
-- custom_field_values (Signal Sense's table, same Neon database).
--
-- Attribution is two-tiered. Signal Sense's custom_field_values.created_by is a
-- FK to users(id) and its tag history joins through it, so free-text provenance
-- cannot go there. Confirmed tags are credited to the playtest_sync system
-- account (same pattern as the existing signal_sense_user row); the real
-- provenance -- who tagged, who confirmed, when -- lives in this table and is
-- what the Tagging > History view reads.

CREATE TABLE IF NOT EXISTS playtest_tags (
  id            serial PRIMARY KEY,
  game_id       varchar(255) NOT NULL REFERENCES game_info(game_id) ON DELETE CASCADE,
  field_value   text NOT NULL,
  sub_value_id  integer REFERENCES sub_value_definitions(id),
  status        varchar(16) NOT NULL DEFAULT 'pending',
  tagged_by     varchar(255) NOT NULL,
  tagged_at     timestamp NOT NULL DEFAULT now(),
  confirmed_by  varchar(255),
  confirmed_at  timestamp,
  sync_result   varchar(16)
);

-- One live proposal per (game, value); history for the same pair may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS playtest_tags_pending_uniq
  ON playtest_tags (game_id, field_value) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS playtest_tags_status_idx
  ON playtest_tags (status, tagged_at DESC);
CREATE INDEX IF NOT EXISTS playtest_tags_game_idx ON playtest_tags (game_id);

-- System account credited for every tag synced from playtest. is_active = false
-- and no password hash, so it can never log in.
INSERT INTO users (id, first_name, last_name, email, is_active, password_hash)
VALUES ('playtest_sync', 'Signal Playtest', 'Sync', 'playtest-sync@athena.studio', false, NULL)
ON CONFLICT (id) DO NOTHING;
```

- [ ] **Step 2: Write the failing unit tests**

Create `__tests__/lib/playtest-tags.test.ts`:

```ts
import { classifyTag, resolveConfirm, TRENDS_FIELD, SYNC_USER } from '@/lib/playtest-tags'

const pending = (sub: number | null) => ({ id: 1, field_value: 'Balatro', sub_value_id: sub })
const existing = (sub: number | null) => ({ field_value: 'Balatro', sub_value_id: sub })

describe('constants', () => {
  it('names the Signal Sense field and system account', () => {
    expect(TRENDS_FIELD).toBe('Trends')
    expect(SYNC_USER).toBe('playtest_sync')
  })
})

describe('classifyTag', () => {
  it('inserts when Signal Sense has no tag for the value', () => {
    expect(classifyTag(pending(1), undefined)).toEqual({ kind: 'insert' })
  })

  it('is a duplicate when value and sub-value both match', () => {
    expect(classifyTag(pending(1), existing(1))).toEqual({ kind: 'duplicate' })
  })

  it('is a duplicate when neither side has a sub-value', () => {
    expect(classifyTag(pending(null), existing(null))).toEqual({ kind: 'duplicate' })
  })

  it('enriches when their sub-value is empty and ours is set', () => {
    expect(classifyTag(pending(2), existing(null))).toEqual({ kind: 'enrich' })
  })

  it('is a duplicate when ours is empty and theirs is set (they know more)', () => {
    expect(classifyTag(pending(null), existing(2))).toEqual({ kind: 'duplicate' })
  })

  it('conflicts when both have a sub-value and they differ', () => {
    expect(classifyTag(pending(1), existing(2))).toEqual({ kind: 'conflict', theirSubValueId: 2 })
  })
})

describe('resolveConfirm', () => {
  it('writes an insert as synced/inserted', () => {
    expect(resolveConfirm({ kind: 'insert' }, false))
      .toEqual({ write: 'insert', status: 'synced', result: 'inserted' })
  })

  it('writes nothing for a duplicate but still leaves Pending', () => {
    expect(resolveConfirm({ kind: 'duplicate' }, false))
      .toEqual({ write: null, status: 'synced', result: 'duplicate' })
  })

  it('updates the sub-value for an enrich', () => {
    expect(resolveConfirm({ kind: 'enrich' }, false))
      .toEqual({ write: 'update', status: 'synced', result: 'enriched' })
  })

  it('keeps the Signal Sense value when a conflict is not overwritten', () => {
    expect(resolveConfirm({ kind: 'conflict', theirSubValueId: 2 }, false))
      .toEqual({ write: null, status: 'rejected', result: 'kept' })
  })

  it('overwrites the sub-value when the admin forces it', () => {
    expect(resolveConfirm({ kind: 'conflict', theirSubValueId: 2 }, true))
      .toEqual({ write: 'update', status: 'synced', result: 'overwritten' })
  })

  it('ignores overwrite for non-conflict actions', () => {
    expect(resolveConfirm({ kind: 'insert' }, true).result).toBe('inserted')
    expect(resolveConfirm({ kind: 'duplicate' }, true).result).toBe('duplicate')
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest __tests__/lib/playtest-tags.test.ts`
Expected: FAIL — `Cannot find module '@/lib/playtest-tags'`.

- [ ] **Step 4: Write `lib/playtest-tags.ts`**

```ts
// Trends tags proposed during playtest, and the rules for merging them into
// Signal Sense's custom_field_values on confirm.
//
// A tag's identity there is (game_id, field_name, field_value) -- enforced by
// `unique_game_field_value` -- and the sub-value is an attribute of that tag,
// not part of its identity. Signal Sense relies on that exact 3-column index in
// an ON CONFLICT inference clause, so we merge into the existing row instead of
// ever adding a second row for the same value.

export const TRENDS_FIELD = 'Trends'

/** System account credited for tags synced from playtest (migration 035). */
export const SYNC_USER = 'playtest_sync'

export interface PendingTag {
  id: number
  field_value: string
  sub_value_id: number | null
}

/** A Trends row already in Signal Sense for the same game + value. */
export interface ExistingTag {
  field_value: string
  sub_value_id: number | null
}

export type TagAction =
  | { kind: 'insert' }
  | { kind: 'duplicate' }
  | { kind: 'enrich' }
  | { kind: 'conflict'; theirSubValueId: number }

export type SyncResult = 'inserted' | 'duplicate' | 'enriched' | 'overwritten' | 'kept'

export interface ConfirmOutcome {
  /** What to do to custom_field_values. */
  write: 'insert' | 'update' | null
  /** Where the playtest_tags row lands. */
  status: 'synced' | 'rejected'
  result: SyncResult
}

/** Compare one proposal against the Signal Sense row for the same value. */
export function classifyTag(pending: PendingTag, existing: ExistingTag | undefined): TagAction {
  if (!existing) return { kind: 'insert' }
  const theirs = existing.sub_value_id ?? null
  const ours = pending.sub_value_id ?? null
  if (theirs === ours) return { kind: 'duplicate' }
  // Their sub-value is empty and we have one: fill it in.
  if (theirs === null) return { kind: 'enrich' }
  // We have none and they do: they already know more, nothing to add.
  if (ours === null) return { kind: 'duplicate' }
  return { kind: 'conflict', theirSubValueId: theirs }
}

/** Turn an action into the write + the row's final state. `overwrite` only
 *  matters for a conflict: true means the playtest sub-value wins. A conflict
 *  left alone ends as `rejected`/`kept` because nothing was written. */
export function resolveConfirm(action: TagAction, overwrite: boolean): ConfirmOutcome {
  switch (action.kind) {
    case 'insert':
      return { write: 'insert', status: 'synced', result: 'inserted' }
    case 'enrich':
      return { write: 'update', status: 'synced', result: 'enriched' }
    case 'conflict':
      return overwrite
        ? { write: 'update', status: 'synced', result: 'overwritten' }
        : { write: null, status: 'rejected', result: 'kept' }
    case 'duplicate':
    default:
      return { write: null, status: 'synced', result: 'duplicate' }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest __tests__/lib/playtest-tags.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 6: Commit**

```bash
git add migrations/035_playtest_tags.sql lib/playtest-tags.ts __tests__/lib/playtest-tags.test.ts
git commit -m "feat(tagging): playtest_tags migration + Trends merge rules"
```

---

### Task 2: Trends options endpoint

**Files:**
- Create: `app/api/trends/options/route.ts`

**Interfaces:**
- Consumes: `TRENDS_FIELD` from `lib/playtest-tags.ts`.
- Produces: `GET /api/trends/options` → `{ values: string[]; subValues: { id: number; name: string }[] }`.

- [ ] **Step 1: Write the route**

Create `app/api/trends/options/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { TRENDS_FIELD } from '@/lib/playtest-tags'

export const dynamic = 'force-dynamic'

interface Options {
  values: string[]
  subValues: { id: number; name: string }[]
}

// ~351 Trends values and 2 sub-values that change rarely, but the combobox is
// opened on every game. Cache in module scope for 10 minutes.
const TTL_MS = 10 * 60 * 1000
let cache: { at: number; data: Options } | null = null

// GET /api/trends/options — the Trends values and sub-values an evaluator may
// pick. Definitions are Signal Sense's to own; this app never creates them.
export async function GET(_req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  if (cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json(cache.data, { headers: { 'Cache-Control': 'no-store' } })
  }

  const [values, subValues] = await Promise.all([
    sql`
      SELECT DISTINCT field_value
      FROM custom_field_definitions
      WHERE field_name = ${TRENDS_FIELD} AND is_active
      ORDER BY field_value
    `,
    sql`SELECT id, name FROM sub_value_definitions WHERE is_active ORDER BY name`,
  ])

  const data: Options = {
    values: values.map(r => r.field_value as string),
    subValues: subValues.map(r => ({ id: r.id as number, name: r.name as string })),
  }
  cache = { at: Date.now(), data }
  return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
}
```

- [ ] **Step 2: Verify against the real database**

Run: `npx tsc -p tsconfig.check.json --noEmit`
Expected: no new errors.

Then, with the dev server already running on port 3333 (`npm run dev` in another terminal, `SKIP_AUTH=true` in `.env.local` for local checks):

Run: `curl -s localhost:3333/api/trends/options | head -c 300`
Expected: JSON with a `values` array of Trends names and `subValues` containing `Change Theme` and `Gameplay Variant`.

- [ ] **Step 3: Commit**

```bash
git add app/api/trends/options/route.ts
git commit -m "feat(tagging): Trends value + sub-value options endpoint"
```

---

### Task 3: Per-game read and replace

**Files:**
- Create: `app/api/playtest-tags/route.ts`
- Test: `__tests__/api/playtest-tags.test.ts`

**Interfaces:**
- Consumes: `TRENDS_FIELD` from `lib/playtest-tags.ts`.
- Produces:
  - `GET /api/playtest-tags?gameId=<id>` → `{ pending: { id: number; field_value: string; sub_value_id: number | null; tagged_by: string; tagged_by_name: string | null }[]; existing: { field_value: string; sub_value_id: number | null; sub_value_name: string | null }[] }`
  - `PUT /api/playtest-tags` with body `{ game_id: string; tags: { field_value: string; sub_value_id: number | null }[] }` → `{ ok: true; count: number }`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/api/playtest-tags.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => {
  const fn = jest.fn() as jest.Mock & { json: jest.Mock }
  fn.json = jest.fn((v: unknown) => v)
  return { sql: fn }
})
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { GET, PUT } from '@/app/api/playtest-tags/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

function putReq(body: unknown) {
  return new NextRequest('http://localhost/api/playtest-tags', {
    method: 'PUT', body: JSON.stringify(body),
  } as never)
}
function getReq(gameId: string) {
  return new NextRequest(`http://localhost/api/playtest-tags?gameId=${gameId}`)
}

// Answers queries by the text of the template so tests do not depend on call order.
function routeSql(handlers: { match: RegExp; rows: unknown[] }[]) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const text = (strings as string[]).join(' ')
    const h = handlers.find(x => x.match.test(text))
    calls.push({ text, binds })
    return Promise.resolve(h ? h.rows : [])
  })
}
let calls: { text: string; binds: unknown[] }[] = []

describe('/api/playtest-tags', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { calls = [] })

  it('returns 401 without a session', async () => {
    sessionMock.mockResolvedValue(null)
    routeSql([])
    expect((await GET(getReq('g1'))).status).toBe(401)
  })

  it('returns pending tags and the live Signal Sense tags', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    routeSql([
      { match: /FROM playtest_tags/, rows: [{ id: 7, field_value: 'Balatro', sub_value_id: 1, tagged_by: 'mitt@athena.studio', tagged_by_name: 'Mitt' }] },
      { match: /FROM custom_field_values/, rows: [{ field_value: 'Backpack', sub_value_id: null, sub_value_name: null }] },
    ])
    const body = await (await GET(getReq('g1'))).json()
    expect(body.pending).toHaveLength(1)
    expect(body.pending[0].field_value).toBe('Balatro')
    expect(body.existing[0].field_value).toBe('Backpack')
  })

  it('refuses an evaluator writing tags on someone else\'s game', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([
      { match: /FROM game_evaluations/, rows: [{ initial_evaluator: 'MyTL' }] },
    ])
    const r = await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: null }] }))
    expect(r.status).toBe(403)
    expect(calls.some(c => /INSERT INTO playtest_tags/.test(c.text))).toBe(false)
  })

  it('lets an evaluator replace the pending set on their own game', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([
      { match: /FROM game_evaluations/, rows: [{ initial_evaluator: 'Mitt' }] },
      { match: /field_value = ANY/, rows: [{ field_value: 'Balatro' }] },
    ])
    const r = await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: 2 }] }))
    expect(await r.json()).toEqual({ ok: true, count: 1 })
    expect(calls.some(c => /DELETE FROM playtest_tags/.test(c.text))).toBe(true)
    const insert = calls.find(c => /INSERT INTO playtest_tags/.test(c.text))
    expect(insert?.binds).toEqual(expect.arrayContaining(['g1', 'Balatro', 2, 'mitt@athena.studio']))
  })

  it('rejects a value that is not an active Trends definition', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    routeSql([
      { match: /FROM game_evaluations/, rows: [{ initial_evaluator: 'Mitt' }] },
      { match: /field_value = ANY/, rows: [] },
    ])
    const r = await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Not A Trend', sub_value_id: null }] }))
    expect(r.status).toBe(400)
    expect(calls.some(c => /INSERT INTO playtest_tags/.test(c.text))).toBe(false)
  })

  it('clears the pending set when tags is empty', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    routeSql([{ match: /FROM game_evaluations/, rows: [{ initial_evaluator: 'Mitt' }] }])
    const r = await PUT(putReq({ game_id: 'g1', tags: [] }))
    expect(await r.json()).toEqual({ ok: true, count: 0 })
    expect(calls.some(c => /DELETE FROM playtest_tags/.test(c.text))).toBe(true)
    expect(calls.some(c => /INSERT INTO playtest_tags/.test(c.text))).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest __tests__/api/playtest-tags.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/playtest-tags/route'`.

- [ ] **Step 3: Write the route**

Create `app/api/playtest-tags/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import { TRENDS_FIELD } from '@/lib/playtest-tags'

export const dynamic = 'force-dynamic'

interface SessionInfo { isManager: boolean; name: string; email: string }

async function resolveSession(): Promise<SessionInfo> {
  if (process.env.SKIP_AUTH === 'true') {
    return { isManager: true, name: '', email: 'skip-auth@local' }
  }
  const session = await getServerSession(authOptions)
  return {
    isManager: session?.user?.role === 'admin',
    name: session?.user?.name || '',
    email: session?.user?.email || '',
  }
}

// GET /api/playtest-tags?gameId=<id> — this game's pending proposals plus the
// Trends tags it already carries in Signal Sense (shown read-only in the modal
// so nobody re-tags what is there).
export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const gameId = (req.nextUrl.searchParams.get('gameId') || '').trim()
  if (!gameId) return NextResponse.json({ error: 'gameId required' }, { status: 400 })

  const [pending, existing] = await Promise.all([
    sql`
      SELECT pt.id, pt.field_value, pt.sub_value_id, pt.tagged_by, du.name AS tagged_by_name
      FROM playtest_tags pt
      LEFT JOIN dashboard_users du ON du.email = pt.tagged_by
      WHERE pt.game_id = ${gameId} AND pt.status = 'pending'
      ORDER BY pt.field_value
    `,
    sql`
      SELECT cfv.field_value, cfv.sub_value_id, sv.name AS sub_value_name
      FROM custom_field_values cfv
      LEFT JOIN sub_value_definitions sv ON sv.id = cfv.sub_value_id
      WHERE cfv.game_id = ${gameId} AND cfv.field_name = ${TRENDS_FIELD}
      ORDER BY cfv.field_value
    `,
  ])

  return NextResponse.json({ pending, existing }, { headers: { 'Cache-Control': 'no-store' } })
}

// PUT /api/playtest-tags — replace the whole pending set for one game. Called
// from the evaluation modal's save(), so the payload is the full list the user
// sees: anything missing from it is dropped.
export async function PUT(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  let body: { game_id?: string; tags?: { field_value?: string; sub_value_id?: number | null }[] }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const gameId = (body.game_id || '').trim()
  if (!gameId) return NextResponse.json({ error: 'game_id required' }, { status: 400 })

  const tags = (body.tags || [])
    .map(t => ({ field_value: (t.field_value || '').trim(), sub_value_id: t.sub_value_id ?? null }))
    .filter(t => t.field_value)
  // The pending set is keyed on (game, value); collapse a repeated value rather
  // than tripping the partial unique index.
  const unique = [...new Map(tags.map(t => [t.field_value, t])).values()]

  const { isManager, name, email } = await resolveSession()

  // Own-only: an evaluator may tag their own game, an admin any game.
  const evRows = await sql`
    SELECT initial_evaluator FROM game_evaluations WHERE game_id = ${gameId} LIMIT 1
  `
  if (evRows.length === 0) return NextResponse.json({ error: 'Game not found' }, { status: 404 })
  const owner = (evRows[0].initial_evaluator as string | null) || ''
  if (!isManager && owner.toLowerCase() !== name.toLowerCase()) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Values must exist as active Trends definitions — this app never creates them.
  if (unique.length > 0) {
    const wanted = unique.map(t => t.field_value)
    const ok = await sql`
      SELECT DISTINCT field_value FROM custom_field_definitions
      WHERE field_name = ${TRENDS_FIELD} AND is_active AND field_value = ANY(${wanted})
    `
    const allowed = new Set(ok.map(r => r.field_value as string))
    const bad = wanted.filter(v => !allowed.has(v))
    if (bad.length > 0) {
      return NextResponse.json({ error: `Unknown Trends value: ${bad.join(', ')}` }, { status: 400 })
    }
  }

  // Replace: only pending rows are touched, so confirmed/rejected history stays.
  await sql`DELETE FROM playtest_tags WHERE game_id = ${gameId} AND status = 'pending'`
  for (const t of unique) {
    await sql`
      INSERT INTO playtest_tags (game_id, field_value, sub_value_id, tagged_by)
      VALUES (${gameId}, ${t.field_value}, ${t.sub_value_id}, ${email})
    `
  }

  return NextResponse.json({ ok: true, count: unique.length })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest __tests__/api/playtest-tags.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add app/api/playtest-tags/route.ts __tests__/api/playtest-tags.test.ts
git commit -m "feat(tagging): read + replace a game's pending Trends tags"
```

---

### Task 4: Confirm and reject

**Files:**
- Create: `app/api/playtest-tags/confirm/route.ts`
- Create: `app/api/playtest-tags/reject/route.ts`
- Test: `__tests__/api/playtest-tags-confirm.test.ts`

**Interfaces:**
- Consumes: `classifyTag`, `resolveConfirm`, `TRENDS_FIELD`, `SYNC_USER` from `lib/playtest-tags.ts`.
- Produces:
  - `POST /api/playtest-tags/confirm` body `{ game_id: string; overwrite?: number[] }` → `{ ok: true; results: { id: number; result: SyncResult }[] }`
  - `POST /api/playtest-tags/reject` body `{ ids: number[] }` → `{ ok: true; count: number }`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/api/playtest-tags-confirm.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => {
  const fn = jest.fn() as jest.Mock & { json: jest.Mock; begin: jest.Mock }
  fn.json = jest.fn((v: unknown) => v)
  // begin(cb) runs the callback with the same mock, so a transaction behaves
  // like the plain client in tests.
  fn.begin = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(fn)))
  return { sql: fn }
})
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { POST as CONFIRM } from '@/app/api/playtest-tags/confirm/route'
import { POST as REJECT } from '@/app/api/playtest-tags/reject/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

let calls: { text: string; binds: unknown[] }[] = []

function routeSql(handlers: { match: RegExp; rows: unknown[] }[]) {
  sqlMock.mockReset()
  ;(sqlMock as unknown as { begin: jest.Mock }).begin =
    jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(sqlMock)))
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const text = (strings as string[]).join(' ')
    calls.push({ text, binds })
    const h = handlers.find(x => x.match.test(text))
    return Promise.resolve(h ? h.rows : [])
  })
}

function req(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) } as never)
}

describe('POST /api/playtest-tags/confirm', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { calls = []; sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } }) })

  it('is admin only', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([])
    expect((await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))).status).toBe(403)
  })

  it('handles a mixed batch: insert, duplicate, enrich, conflict', async () => {
    routeSql([
      { match: /FROM playtest_tags/, rows: [
        { id: 1, field_value: 'New Trend', sub_value_id: 1 },   // not in Signal Sense → insert
        { id: 2, field_value: 'Same', sub_value_id: 1 },        // identical → duplicate
        { id: 3, field_value: 'Empty Sub', sub_value_id: 2 },   // theirs NULL → enrich
        { id: 4, field_value: 'Clash', sub_value_id: 1 },       // theirs 2 → conflict, kept
      ] },
      { match: /FROM custom_field_values/, rows: [
        { field_value: 'Same', sub_value_id: 1 },
        { field_value: 'Empty Sub', sub_value_id: null },
        { field_value: 'Clash', sub_value_id: 2 },
      ] },
    ])
    const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))).json()
    expect(body.results).toEqual([
      { id: 1, result: 'inserted' },
      { id: 2, result: 'duplicate' },
      { id: 3, result: 'enriched' },
      { id: 4, result: 'kept' },
    ])
    const inserts = calls.filter(c => /INSERT INTO custom_field_values/.test(c.text))
    expect(inserts).toHaveLength(1)
    expect(inserts[0].binds).toEqual(expect.arrayContaining(['g1', 'Trends', 'New Trend', 1, 'playtest_sync']))
    const updates = calls.filter(c => /UPDATE custom_field_values/.test(c.text))
    expect(updates).toHaveLength(1)
    expect(updates[0].binds).toEqual(expect.arrayContaining([2, 'Empty Sub']))
  })

  it('overwrites only the conflict ids the admin listed', async () => {
    routeSql([
      { match: /FROM playtest_tags/, rows: [
        { id: 4, field_value: 'Clash', sub_value_id: 1 },
        { id: 5, field_value: 'Clash Two', sub_value_id: 1 },
      ] },
      { match: /FROM custom_field_values/, rows: [
        { field_value: 'Clash', sub_value_id: 2 },
        { field_value: 'Clash Two', sub_value_id: 2 },
      ] },
    ])
    const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1', overwrite: [4] }))).json()
    expect(body.results).toEqual([
      { id: 4, result: 'overwritten' },
      { id: 5, result: 'kept' },
    ])
    expect(calls.filter(c => /UPDATE custom_field_values/.test(c.text))).toHaveLength(1)
  })

  it('stamps confirmed_by and the per-row status', async () => {
    routeSql([
      { match: /FROM playtest_tags/, rows: [{ id: 1, field_value: 'New Trend', sub_value_id: null }] },
      { match: /FROM custom_field_values/, rows: [] },
    ])
    await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))
    const stamp = calls.find(c => /UPDATE playtest_tags/.test(c.text))
    expect(stamp?.binds).toEqual(expect.arrayContaining(['synced', 'inserted', 'vinhtd@athena.studio', 1]))
  })

  it('returns an empty result set when the game has no pending tags', async () => {
    routeSql([{ match: /FROM playtest_tags/, rows: [] }])
    const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))).json()
    expect(body).toEqual({ ok: true, results: [] })
  })
})

describe('POST /api/playtest-tags/reject', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { calls = [] })

  it('is admin only', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([])
    expect((await REJECT(req('/api/playtest-tags/reject', { ids: [1] }))).status).toBe(403)
  })

  it('marks the ids rejected with the admin email', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    routeSql([{ match: /UPDATE playtest_tags/, rows: [{ id: 1 }, { id: 2 }] }])
    const body = await (await REJECT(req('/api/playtest-tags/reject', { ids: [1, 2] }))).json()
    expect(body).toEqual({ ok: true, count: 2 })
    const upd = calls.find(c => /UPDATE playtest_tags/.test(c.text))
    expect(upd?.binds).toEqual(expect.arrayContaining(['vinhtd@athena.studio', [1, 2]]))
  })

  it('rejects a body with no ids', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    routeSql([])
    expect((await REJECT(req('/api/playtest-tags/reject', { ids: [] }))).status).toBe(400)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest __tests__/api/playtest-tags-confirm.test.ts`
Expected: FAIL — module not found for both routes.

- [ ] **Step 3: Write the confirm route**

Create `app/api/playtest-tags/confirm/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireManager } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import {
  classifyTag, resolveConfirm, TRENDS_FIELD, SYNC_USER,
  type ExistingTag, type PendingTag, type SyncResult,
} from '@/lib/playtest-tags'

export const dynamic = 'force-dynamic'

// POST /api/playtest-tags/confirm — sync one game's pending Trends tags into
// Signal Sense. Runs in a transaction so a failure leaves every tag of the game
// pending rather than half-applied. `overwrite` carries the conflict ids whose
// playtest sub-value should replace Signal Sense's.
export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  let body: { game_id?: string; overwrite?: number[] }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const gameId = (body.game_id || '').trim()
  if (!gameId) return NextResponse.json({ error: 'game_id required' }, { status: 400 })
  const overwrite = new Set((body.overwrite || []).filter(n => Number.isInteger(n)))

  const session = process.env.SKIP_AUTH === 'true' ? null : await getServerSession(authOptions)
  const admin = session?.user?.email || 'skip-auth@local'

  const results: { id: number; result: SyncResult }[] = []

  await sql.begin(async tx => {
    const pending = await tx`
      SELECT id, field_value, sub_value_id
      FROM playtest_tags
      WHERE game_id = ${gameId} AND status = 'pending'
      ORDER BY id
    ` as unknown as PendingTag[]
    if (pending.length === 0) return

    const theirs = await tx`
      SELECT field_value, sub_value_id
      FROM custom_field_values
      WHERE game_id = ${gameId} AND field_name = ${TRENDS_FIELD}
    ` as unknown as ExistingTag[]
    const byValue = new Map(theirs.map(t => [t.field_value, t]))

    for (const p of pending) {
      const action = classifyTag(p, byValue.get(p.field_value))
      const outcome = resolveConfirm(action, overwrite.has(p.id))

      if (outcome.write === 'insert') {
        await tx`
          INSERT INTO custom_field_values
            (game_id, field_name, field_value, sub_value_id, created_by, updated_by)
          VALUES (${gameId}, ${TRENDS_FIELD}, ${p.field_value}, ${p.sub_value_id}, ${SYNC_USER}, ${SYNC_USER})
          ON CONFLICT (game_id, field_name, field_value) DO NOTHING
        `
      } else if (outcome.write === 'update') {
        await tx`
          UPDATE custom_field_values
          SET sub_value_id = ${p.sub_value_id}, updated_by = ${SYNC_USER}, updated_at = now()
          WHERE game_id = ${gameId} AND field_name = ${TRENDS_FIELD} AND field_value = ${p.field_value}
        `
      }

      await tx`
        UPDATE playtest_tags
        SET status = ${outcome.status}, sync_result = ${outcome.result},
            confirmed_by = ${admin}, confirmed_at = now()
        WHERE id = ${p.id}
      `
      results.push({ id: p.id, result: outcome.result })
    }
  })

  return NextResponse.json({ ok: true, results })
}
```

- [ ] **Step 4: Write the reject route**

Create `app/api/playtest-tags/reject/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireManager } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST /api/playtest-tags/reject — drop proposals without touching Signal Sense.
// Rows are kept as `rejected` so the History view still explains what happened.
export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  let body: { ids?: number[] }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const ids = (body.ids || []).filter(n => Number.isInteger(n))
  if (ids.length === 0) return NextResponse.json({ error: 'ids required' }, { status: 400 })

  const session = process.env.SKIP_AUTH === 'true' ? null : await getServerSession(authOptions)
  const admin = session?.user?.email || 'skip-auth@local'

  const rows = await sql`
    UPDATE playtest_tags
    SET status = 'rejected', confirmed_by = ${admin}, confirmed_at = now()
    WHERE status = 'pending' AND id = ANY(${ids})
    RETURNING id
  `
  return NextResponse.json({ ok: true, count: rows.length })
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest __tests__/api/playtest-tags-confirm.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add app/api/playtest-tags/confirm/route.ts app/api/playtest-tags/reject/route.ts __tests__/api/playtest-tags-confirm.test.ts
git commit -m "feat(tagging): confirm syncs Trends tags to Signal Sense, reject keeps history"
```

---

### Task 5: Admin queue and history endpoints

**Files:**
- Create: `app/api/playtest-tags/pending/route.ts`
- Create: `app/api/playtest-tags/history/route.ts`

**Interfaces:**
- Consumes: `TRENDS_FIELD` from `lib/playtest-tags.ts`.
- Produces:
  - `GET /api/playtest-tags/pending` → `{ games: PendingGame[] }` where
    `PendingGame = { game_id: string; title: string; publisher_name: string | null; initial_evaluator: string | null; icon_url: string | null; tags: PendingRow[] }`
    and `PendingRow = { id: number; field_value: string; sub_value_id: number | null; sub_value_name: string | null; tagged_by_name: string | null; tagged_at: string; their_sub_value_id: number | null; their_sub_value_name: string | null; conflict: boolean }`
  - `GET /api/playtest-tags/history?page=1&limit=50&tagger=<email>&from=<date>&to=<date>` → `{ rows: HistoryRow[]; total: number; page: number; limit: number }` where
    `HistoryRow = { id: number; game_id: string; title: string; field_value: string; sub_value_name: string | null; tagged_by_name: string | null; tagged_at: string; confirmed_by_name: string | null; confirmed_at: string | null; status: string; sync_result: string | null }`

- [ ] **Step 1: Write the pending route**

Create `app/api/playtest-tags/pending/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { TRENDS_FIELD } from '@/lib/playtest-tags'

export const dynamic = 'force-dynamic'

interface Row {
  id: number
  game_id: string
  title: string
  publisher_name: string | null
  icon_url: string | null
  initial_evaluator: string | null
  field_value: string
  sub_value_id: number | null
  sub_value_name: string | null
  tagged_by_name: string | null
  tagged_at: string
  their_sub_value_id: number | null
  their_sub_value_name: string | null
}

// GET /api/playtest-tags/pending — the admin review queue, grouped by game.
// `conflict` marks a tag whose value already exists in Signal Sense with a
// different sub-value; confirming does not write it unless the admin overwrites.
export async function GET(_req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const rows = await sql`
    SELECT
      pt.id, pt.game_id, pt.field_value, pt.sub_value_id, pt.tagged_at,
      gi.title, gi.icon_url,
      COALESCE(dev.developer_name, dev.dev_company) AS publisher_name,
      ge.initial_evaluator,
      du.name AS tagged_by_name,
      sv.name AS sub_value_name,
      cfv.sub_value_id AS their_sub_value_id,
      their_sv.name AS their_sub_value_name
    FROM playtest_tags pt
    JOIN game_info gi ON gi.game_id = pt.game_id
    LEFT JOIN developer dev ON gi.publisher_id = dev.id
    LEFT JOIN game_evaluations ge ON ge.game_id = pt.game_id
    LEFT JOIN dashboard_users du ON du.email = pt.tagged_by
    LEFT JOIN sub_value_definitions sv ON sv.id = pt.sub_value_id
    LEFT JOIN custom_field_values cfv
      ON cfv.game_id = pt.game_id AND cfv.field_name = ${TRENDS_FIELD} AND cfv.field_value = pt.field_value
    LEFT JOIN sub_value_definitions their_sv ON their_sv.id = cfv.sub_value_id
    WHERE pt.status = 'pending'
    ORDER BY pt.tagged_at DESC, pt.field_value
  ` as unknown as Row[]

  // Group in JS: one card per game, tags in the order the query returned them.
  const games = new Map<string, {
    game_id: string; title: string; publisher_name: string | null
    icon_url: string | null; initial_evaluator: string | null; tags: unknown[]
  }>()
  for (const r of rows) {
    let g = games.get(r.game_id)
    if (!g) {
      g = {
        game_id: r.game_id, title: r.title, publisher_name: r.publisher_name,
        icon_url: r.icon_url, initial_evaluator: r.initial_evaluator, tags: [],
      }
      games.set(r.game_id, g)
    }
    // A conflict needs both sides to carry a sub-value and to disagree; the
    // fill-an-empty-sub-value case is applied silently on confirm.
    const conflict = r.their_sub_value_id !== null
      && r.sub_value_id !== null
      && r.their_sub_value_id !== r.sub_value_id
    g.tags.push({
      id: r.id, field_value: r.field_value, sub_value_id: r.sub_value_id,
      sub_value_name: r.sub_value_name, tagged_by_name: r.tagged_by_name,
      tagged_at: r.tagged_at, their_sub_value_id: r.their_sub_value_id,
      their_sub_value_name: r.their_sub_value_name, conflict,
    })
  }

  return NextResponse.json({ games: [...games.values()] }, { headers: { 'Cache-Control': 'no-store' } })
}
```

- [ ] **Step 2: Write the history route**

Create `app/api/playtest-tags/history/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/playtest-tags/history — everything that left the queue (synced or
// rejected), with the provenance Signal Sense cannot store: who tagged, who
// confirmed, and what the sync actually did.
export async function GET(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const sp = req.nextUrl.searchParams
  const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1)
  const limit = Math.min(200, Math.max(1, parseInt(sp.get('limit') || '50', 10) || 50))
  const tagger = (sp.get('tagger') || '').trim()
  const from = (sp.get('from') || '').trim()
  const to = (sp.get('to') || '').trim()

  const taggerFilter = tagger ? sql`AND pt.tagged_by = ${tagger}` : sql``
  const fromFilter = from ? sql`AND pt.tagged_at >= ${from}::date` : sql``
  const toFilter = to ? sql`AND pt.tagged_at < (${to}::date + 1)` : sql``

  const [rows, totals] = await Promise.all([
    sql`
      SELECT
        pt.id, pt.game_id, pt.field_value, pt.status, pt.sync_result,
        pt.tagged_at, pt.confirmed_at,
        gi.title, sv.name AS sub_value_name,
        tagger.name AS tagged_by_name, confirmer.name AS confirmed_by_name
      FROM playtest_tags pt
      JOIN game_info gi ON gi.game_id = pt.game_id
      LEFT JOIN sub_value_definitions sv ON sv.id = pt.sub_value_id
      LEFT JOIN dashboard_users tagger ON tagger.email = pt.tagged_by
      LEFT JOIN dashboard_users confirmer ON confirmer.email = pt.confirmed_by
      WHERE pt.status <> 'pending'
        ${taggerFilter} ${fromFilter} ${toFilter}
      ORDER BY pt.confirmed_at DESC NULLS LAST, pt.id DESC
      LIMIT ${limit} OFFSET ${(page - 1) * limit}
    `,
    sql`
      SELECT count(*)::int AS total
      FROM playtest_tags pt
      WHERE pt.status <> 'pending'
        ${taggerFilter} ${fromFilter} ${toFilter}
    `,
  ])

  return NextResponse.json(
    { rows, total: totals[0]?.total ?? 0, page, limit },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
```

- [ ] **Step 3: Typecheck and smoke-test against the real database**

Run: `npx tsc -p tsconfig.check.json --noEmit`
Expected: no new errors.

With the dev server running and migration 035 applied locally:

Run: `curl -s localhost:3333/api/playtest-tags/pending`
Expected: `{"games":[]}` before any tag exists.

Run: `curl -s "localhost:3333/api/playtest-tags/history?limit=5"`
Expected: `{"rows":[],"total":0,"page":1,"limit":5}`.

- [ ] **Step 4: Commit**

```bash
git add app/api/playtest-tags/pending/route.ts app/api/playtest-tags/history/route.ts
git commit -m "feat(tagging): admin pending queue + history endpoints"
```

---

### Task 6: `TrendTagsField` and the modal wiring

**Files:**
- Create: `components/TrendTagsField.tsx`
- Modify: `components/EvalDetailPanel.tsx` (state block near line 470-505, `applyData` near line 469, `save()` near line 621, auto-save deps near line 718, render near line 1086)

**Interfaces:**
- Consumes: `GET /api/trends/options`, `GET /api/playtest-tags?gameId=`, `PUT /api/playtest-tags`.
- Produces: `export interface TrendTag { field_value: string; sub_value_id: number | null }`, `export interface ExistingTrendTag { field_value: string; sub_value_name: string | null }`, and
  `export function TrendTagsField({ value, existing, options, subValues, onChange, disabled }: { value: TrendTag[]; existing: ExistingTrendTag[]; options: string[]; subValues: { id: number; name: string }[]; onChange: (next: TrendTag[]) => void; disabled?: boolean })`.

- [ ] **Step 1: Write the component**

Create `components/TrendTagsField.tsx`. It reuses the `wf-chips` / `wf-chip` / `wf-gamesearch` / `wf-hits` classes already in `app/globals.css` (see `components/weekly-feedback/GameSearch.tsx` for the same pattern), so no new CSS is needed.

```tsx
'use client'
import { useMemo, useState } from 'react'

export interface TrendTag {
  field_value: string
  sub_value_id: number | null
}

export interface ExistingTrendTag {
  field_value: string
  sub_value_name: string | null
}

interface Props {
  value: TrendTag[]
  /** Trends tags this game already carries in Signal Sense (read-only). */
  existing: ExistingTrendTag[]
  /** Active Trends values; the only values that may be picked. */
  options: string[]
  subValues: { id: number; name: string }[]
  onChange: (next: TrendTag[]) => void
  disabled?: boolean
}

// Trends tagging for one game. Proposals only: nothing here reaches Signal Sense
// until an admin confirms in Evaluations > Tagging. New Trends values are never
// created from this app, so the combobox filters a fixed list.
export function TrendTagsField({ value, existing, options, subValues, onChange, disabled }: Props) {
  const tags = value || []
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')

  const taken = useMemo(() => new Set(tags.map(t => t.field_value)), [tags])
  const existingByValue = useMemo(
    () => new Map(existing.map(e => [e.field_value, e])), [existing])

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 1) return []
    return options.filter(o => o.toLowerCase().includes(q) && !taken.has(o)).slice(0, 12)
  }, [query, options, taken])

  const add = (fieldValue: string) => {
    onChange([...tags, { field_value: fieldValue, sub_value_id: null }])
    setQuery('')
    setAdding(false)
  }
  const remove = (i: number) => onChange(tags.filter((_, x) => x !== i))
  const setSub = (i: number, subId: number | null) =>
    onChange(tags.map((t, x) => (x === i ? { ...t, sub_value_id: subId } : t)))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {existing.length > 0 && (
        <div>
          <span style={{ fontSize: 11, color: 'var(--faint)' }}>Already in Signal Sense</span>
          <ul className="wf-chips">
            {existing.map(e => (
              <li key={e.field_value} className="wf-chip">
                <span>{e.field_value}</span>
                {e.sub_value_name && (
                  <span style={{ fontSize: 11, color: 'var(--faint)' }}>· {e.sub_value_name}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {tags.length === 0 && disabled && (
        <span style={{ fontSize: 12, color: 'var(--faint)' }}>—</span>
      )}

      {tags.map((t, i) => {
        const theirs = existingByValue.get(t.field_value)
        return (
          <div key={`${t.field_value}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className="wf-chip" style={{ margin: 0 }}>
              <span>{t.field_value}</span>
              {!disabled && (
                <button type="button" title="Remove tag" onClick={() => remove(i)}>✕</button>
              )}
            </span>
            <select
              className="input"
              style={{ width: 170, fontSize: 12 }}
              value={t.sub_value_id ?? ''}
              disabled={disabled}
              onChange={e => setSub(i, e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">-- None --</option>
              {subValues.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {theirs && (
              <span style={{ fontSize: 11, color: 'var(--warn, #b45309)' }}>
                already in Signal Sense{theirs.sub_value_name ? ` · ${theirs.sub_value_name}` : ''}
              </span>
            )}
          </div>
        )
      })}

      {!disabled && (adding ? (
        <div className="wf-gamesearch" style={{ position: 'relative' }}>
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { setAdding(false); setQuery('') }
              if (e.key === 'Enter' && hits.length === 1) add(hits[0])
            }}
            placeholder="Type to search Trends…"
            style={{ width: '100%' }}
          />
          {query.trim() && hits.length === 0 && (
            <span className="wf-hint">no matching Trends value — ask an admin to add it in Signal Sense</span>
          )}
          {hits.length > 0 && (
            <ul className="wf-hits" style={{ position: 'absolute', zIndex: 20, width: '100%' }}>
              {hits.map(h => (
                <li key={h}>
                  <button type="button" onClick={() => add(h)}>
                    <span className="wf-hit-title">{h}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }}
          onClick={() => setAdding(true)}>+ Add trend</button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Add state and loading to `EvalDetailPanel`**

In `components/EvalDetailPanel.tsx`, add the import next to the other component imports:

```tsx
import { TrendTagsField, type TrendTag, type ExistingTrendTag } from './TrendTagsField'
```

Add state beside the other field state (the block that declares `gameAlike`, `note`, `driveLink`):

```tsx
const [trendTags, setTrendTags] = useState<TrendTag[]>([])
const [existingTrends, setExistingTrends] = useState<ExistingTrendTag[]>([])
const [trendOptions, setTrendOptions] = useState<string[]>([])
const [trendSubValues, setTrendSubValues] = useState<{ id: number; name: string }[]>([])
```

Load the option list once, on mount:

```tsx
useEffect(() => {
  fetch('/api/trends/options')
    .then(r => r.ok ? r.json() : { values: [], subValues: [] })
    .then(d => { setTrendOptions(d.values || []); setTrendSubValues(d.subValues || []) })
    .catch(() => {})
}, [])
```

Load this game's tags whenever the displayed game changes. The guard on
`currentGameId` keeps a late response for a game we navigated away from from
overwriting the visible state, mirroring `updateManualShots`:

```tsx
useEffect(() => {
  let live = true
  setTrendTags([]); setExistingTrends([])
  fetch(`/api/playtest-tags?gameId=${encodeURIComponent(currentGameId)}`)
    .then(r => r.ok ? r.json() : { pending: [], existing: [] })
    .then(d => {
      if (!live) return
      setTrendTags((d.pending || []).map((p: { field_value: string; sub_value_id: number | null }) =>
        ({ field_value: p.field_value, sub_value_id: p.sub_value_id })))
      setExistingTrends(d.existing || [])
    })
    .catch(() => {})
  return () => { live = false }
}, [currentGameId])
```

- [ ] **Step 3: Persist the tags from `save()`**

Inside `save()` in `components/EvalDetailPanel.tsx`, immediately after the
screenshot flush and before the eval `PATCH`, add:

```tsx
// Trends tags are their own resource (they stage for admin review, they are not
// evaluation columns), so they save alongside the eval rather than inside it.
if (canEditGameAlike) {
  const tagRes = await fetch('/api/playtest-tags', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ game_id: ev.game_id, tags: trendTags }),
  })
  if (!tagRes.ok) {
    const err = await tagRes.json().catch(() => ({}))
    showToast(err.error || 'Failed to save trend tags', true)
    setSaving(false)
    return
  }
}
```

Add `trendTags` to the auto-save effect's dependency array (the long list ending
in `stagedShots`) so editing a tag arms the timer.

- [ ] **Step 4: Render the field**

In `components/EvalDetailPanel.tsx`, directly after the Game Alike `div.field`
(around line 1086), insert:

```tsx
<div className="field">
  <span className="label">Trends Tags</span>
  <TrendTagsField
    value={trendTags}
    existing={existingTrends}
    options={trendOptions}
    subValues={trendSubValues}
    onChange={next => { setTrendTags(next); setDirty(true) }}
    disabled={!canEditGameAlike}
  />
</div>
```

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc -p tsconfig.check.json --noEmit && npx next lint`
Expected: no new errors or warnings.

- [ ] **Step 6: Verify by hand**

With the dev server on port 3333 and migration 035 applied locally:

1. Open `/evaluations?cat=evaluate`, click a game with an evaluator assigned.
2. Type two letters in the Trends search — a filtered list appears; pick a value.
3. Set its sub-value to `Change Theme`. The save badge shows pending edits.
4. Save. Reopen the same game: the tag is still there.
5. Confirm the row exists:
   `psql "$DATABASE_URL" -c "SELECT game_id, field_value, sub_value_id, status, tagged_by FROM playtest_tags;"`
6. Confirm nothing reached Signal Sense yet:
   `psql "$DATABASE_URL" -c "SELECT count(*) FROM custom_field_values WHERE created_by = 'playtest_sync';"` → 0.

- [ ] **Step 7: Commit**

```bash
git add components/TrendTagsField.tsx components/EvalDetailPanel.tsx
git commit -m "feat(tagging): Trends tagging in the evaluation modal"
```

---

### Task 7: The Tagging subtab

**Files:**
- Create: `components/TaggingTab.tsx`
- Modify: `app/(manager)/evaluations/page.tsx` (the `EvaluationsRouter` dispatch, around line 917-922)
- Modify: `app/(manager)/layout.tsx` (the Evaluations `children` array, around line 47-50)

**Interfaces:**
- Consumes: `GET /api/playtest-tags/pending`, `POST /api/playtest-tags/confirm`, `POST /api/playtest-tags/reject`, `GET /api/playtest-tags/history`.
- Produces: `export function TaggingTab()`.

- [ ] **Step 1: Write the component**

Create `components/TaggingTab.tsx`:

```tsx
'use client'
import { useCallback, useEffect, useState } from 'react'

interface PendingRow {
  id: number
  field_value: string
  sub_value_id: number | null
  sub_value_name: string | null
  tagged_by_name: string | null
  tagged_at: string
  their_sub_value_id: number | null
  their_sub_value_name: string | null
  conflict: boolean
}

interface PendingGame {
  game_id: string
  title: string
  publisher_name: string | null
  icon_url: string | null
  initial_evaluator: string | null
  tags: PendingRow[]
}

interface HistoryRow {
  id: number
  game_id: string
  title: string
  field_value: string
  sub_value_name: string | null
  tagged_by_name: string | null
  tagged_at: string
  confirmed_by_name: string | null
  confirmed_at: string | null
  status: string
  sync_result: string | null
}

const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: 'short', year: 'numeric' }) : '—'

// Admin review of Trends tags proposed during playtest. A tag only reaches
// Signal Sense's custom_field_values when it is confirmed here.
export function TaggingTab() {
  const [view, setView] = useState<'pending' | 'history'>('pending')
  return (
    <div>
      <h1 className="h-title">Tagging</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className={`btn btn-sm ${view === 'pending' ? 'btn-primary' : ''}`} onClick={() => setView('pending')}>Pending</button>
        <button className={`btn btn-sm ${view === 'history' ? 'btn-primary' : ''}`} onClick={() => setView('history')}>History</button>
      </div>
      {view === 'pending' ? <PendingView /> : <HistoryView />}
    </div>
  )
}

function PendingView() {
  const [games, setGames] = useState<PendingGame[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [overwrite, setOverwrite] = useState<Set<number>>(new Set())
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/playtest-tags/pending')
      const d = r.ok ? await r.json() : { games: [] }
      setGames(d.games || [])
    } catch { setGames([]) }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const toggleOverwrite = (id: number) => setOverwrite(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const confirmGame = async (g: PendingGame) => {
    setBusy(g.game_id)
    try {
      const ids = g.tags.map(t => t.id).filter(id => overwrite.has(id))
      const r = await fetch('/api/playtest-tags/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game_id: g.game_id, overwrite: ids }),
      })
      const d = await r.json()
      if (!r.ok) setMsg(d.error || 'Confirm failed')
      else {
        const counts = (d.results || []).reduce((acc: Record<string, number>, x: { result: string }) => {
          acc[x.result] = (acc[x.result] || 0) + 1
          return acc
        }, {})
        setMsg(`${g.title}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`)
      }
      await load()
    } catch { setMsg('Network error') }
    setBusy(null)
  }

  const rejectTag = async (id: number) => {
    try {
      await fetch('/api/playtest-tags/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      })
      await load()
    } catch { setMsg('Network error') }
  }

  const confirmClean = async () => {
    const clean = games.filter(g => !g.tags.some(t => t.conflict))
    for (const g of clean) await confirmGame(g)
  }

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--faint)' }}>Loading...</div>
  if (games.length === 0) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--faint)' }}>No tags waiting for review.</div>

  const cleanCount = games.filter(g => !g.tags.some(t => t.conflict)).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {msg && <div style={{ fontSize: 12, color: 'var(--faint)' }}>{msg}</div>}
      {cleanCount > 1 && (
        <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={confirmClean}>
          Confirm all {cleanCount} games without conflicts
        </button>
      )}
      {games.map(g => (
        <div key={g.game_id} className="card" style={{ margin: 0 }}>
          <div className="card-head">
            <span className="card-label">
              {g.icon_url && <img src={g.icon_url} alt="" width={20} height={20} style={{ verticalAlign: 'middle', marginRight: 6, borderRadius: 4 }} />}
              {g.title}
            </span>
            <span style={{ fontSize: 12, color: 'var(--faint)' }}>
              {g.publisher_name || '—'} · {g.initial_evaluator || 'unassigned'}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0' }}>
            {g.tags.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
                <strong>{t.field_value}</strong>
                <span style={{ color: 'var(--faint)' }}>{t.sub_value_name || 'no sub-value'}</span>
                <span style={{ color: 'var(--faint)', fontSize: 11 }}>
                  by {t.tagged_by_name || 'unknown'} · {fmt(t.tagged_at)}
                </span>
                {t.conflict && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--warn, #b45309)' }}>
                    <input type="checkbox" checked={overwrite.has(t.id)} onChange={() => toggleOverwrite(t.id)} />
                    Signal Sense has {t.their_sub_value_name} — overwrite
                  </label>
                )}
                <button className="btn btn-sm btn-ghost" onClick={() => rejectTag(t.id)}>✕</button>
              </div>
            ))}
          </div>
          <button className="btn btn-primary btn-sm" disabled={busy === g.game_id} onClick={() => confirmGame(g)}>
            {busy === g.game_id ? 'Confirming...' : 'Confirm game'}
          </button>
        </div>
      ))}
    </div>
  )
}

function HistoryView() {
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const limit = 50

  useEffect(() => {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) })
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    fetch(`/api/playtest-tags/history?${qs}`)
      .then(r => r.ok ? r.json() : { rows: [], total: 0 })
      .then(d => { setRows(d.rows || []); setTotal(d.total || 0) })
      .catch(() => { setRows([]); setTotal(0) })
  }, [page, from, to])

  const pages = Math.max(1, Math.ceil(total / limit))

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, fontSize: 12 }}>
        <label>From <input className="input" type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1) }} /></label>
        <label>To <input className="input" type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1) }} /></label>
        <span style={{ color: 'var(--faint)' }}>{total} rows</span>
      </div>
      <table className="table" style={{ fontSize: 13 }}>
        <thead>
          <tr>
            <th>Game</th><th>Trend</th><th>Sub-value</th><th>Tagged by</th>
            <th>Tagged</th><th>Confirmed by</th><th>Confirmed</th><th>Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>{r.title}</td>
              <td>{r.field_value}</td>
              <td>{r.sub_value_name || '—'}</td>
              <td>{r.tagged_by_name || '—'}</td>
              <td>{fmt(r.tagged_at)}</td>
              <td>{r.confirmed_by_name || '—'}</td>
              <td>{fmt(r.confirmed_at)}</td>
              <td>{r.sync_result || r.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--faint)' }}>Nothing confirmed or rejected yet.</div>
      )}
      {pages > 1 && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 10 }}>
          <button className="btn btn-sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Prev</button>
          <span style={{ fontSize: 12, alignSelf: 'center' }}>{page} / {pages}</span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Route `?cat=tagging`**

In `app/(manager)/evaluations/page.tsx`, add the import beside the other component imports:

```tsx
import { TaggingTab } from '@/components/TaggingTab'
```

and add the branch inside `EvaluationsRouter`, before the Short List line:

```tsx
if (category === 'tagging') return <TaggingTab />
```

- [ ] **Step 3: Add the sidebar entry**

In `app/(manager)/layout.tsx`, inside the Evaluations `children` array, after the
Weekly Feedback entry:

```tsx
// Reviewing tags proposed during playtest is an admin decision.
{ href: '/evaluations?cat=tagging', label: 'Tagging', roles: ['admin'] },
```

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc -p tsconfig.check.json --noEmit && npx next lint`
Expected: no new errors or warnings.

- [ ] **Step 5: Verify the full loop by hand**

With migration 035 applied locally and at least one tag staged from Task 6:

1. Open `/evaluations?cat=tagging` as an admin. The staged tag appears in a card.
2. Click **Confirm game**. The message reports `1 inserted`.
3. Check Signal Sense received it:
   `psql "$DATABASE_URL" -c "SELECT field_value, sub_value_id, created_by, updated_by FROM custom_field_values WHERE created_by = 'playtest_sync';"`
   Expected: the tag, both `created_by` and `updated_by` = `playtest_sync`.
4. Switch to **History**: the row shows the tagger, the confirming admin, and `inserted`.
5. Re-tag the same value on the same game in the modal, then confirm again.
   Expected: result `duplicate`, and no second row in `custom_field_values`.
6. Tag that value with a different sub-value and confirm. Expected: the card shows
   the overwrite checkbox; leaving it unchecked yields `kept`, checking it yields
   `overwritten` and updates `custom_field_values.sub_value_id`.
7. As an evaluator (or with `SKIP_AUTH` off and an evaluator account), confirm
   `/evaluations?cat=tagging` is not in the sidebar and the endpoint returns 403.

- [ ] **Step 6: Run the whole suite**

Run: `npx jest`
Expected: all tests pass, including the pre-existing ones.

- [ ] **Step 7: Commit**

```bash
git add components/TaggingTab.tsx "app/(manager)/evaluations/page.tsx" "app/(manager)/layout.tsx"
git commit -m "feat(tagging): Evaluations > Tagging subtab for admin review"
```

---

### Task 8: Apply to production

**Files:** none — this task applies migration 035 and verifies the deployed app.

- [ ] **Step 1: Apply migration 035 to the production database**

The user runs this themselves (bulk DB writes from the CLI are permission-blocked
in this environment):

```
! psql "$DATABASE_URL" -f migrations/035_playtest_tags.sql
```

Expected: `CREATE TABLE`, three `CREATE INDEX`, one `INSERT 0 1` (or `INSERT 0 0`
if `playtest_sync` already exists).

- [ ] **Step 2: Verify the table and the system account**

```
! psql "$DATABASE_URL" -c "SELECT count(*) FROM playtest_tags; SELECT id, first_name, last_name, is_active FROM users WHERE id = 'playtest_sync';"
```

Expected: `0` rows staged, and one `playtest_sync` / Signal Playtest / Sync /
`f` row.

- [ ] **Step 3: Confirm Signal Sense's constraint is untouched**

```
! psql "$DATABASE_URL" -c "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='custom_field_values'::regclass AND conname='unique_game_field_value';"
```

Expected: `UNIQUE (game_id, field_name, field_value)` — unchanged, so Signal
Sense's `ON CONFLICT` inference still resolves.

- [ ] **Step 4: Push and deploy**

```bash
git push origin main
```

Then republish from the Replit workspace (pushing to GitHub main does not deploy
on its own).

- [ ] **Step 5: Smoke-test production**

1. Tag one game in the evaluation modal, save.
2. Confirm it in Evaluations > Tagging.
3. Open that game in Signal Sense and check the Trends tag is present, credited
   to Signal Playtest Sync.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| Data model / migration 035 | 1 |
| `playtest_sync` system account | 1, 8 |
| Sync rules table + `classifyTag` | 1, 4 |
| `GET /api/trends/options` | 2 |
| `GET`/`PUT /api/playtest-tags` | 3 |
| `POST confirm` / `POST reject` | 4 |
| `GET pending` / `GET history` | 5 |
| Modal field + existing-tags display + `canEditGameAlike` gate | 6 |
| Tagging subtab Pending + History, sidebar, admin-only | 7 |
| Error handling: transaction per game, inactive value rejected, options failure | 3 (validation), 4 (transaction), 6 (empty options leaves the combobox with no hits and an inline hint) |
| Testing: classify outcomes, mixed batch, overwrite, replace semantics, authorisation | 1, 3, 4 |

Two spec details are deliberately simplified in the plan, both no-loss:

- The spec's History filter list included a tagger filter. The endpoint in Task 5
  supports `tagger`, but `HistoryView` only exposes the date range; the tagger
  select would need a distinct-tagger endpoint that earns its own task later.
  Noted rather than silently dropped.
- Cascade deletion of `playtest_tags` when a game leaves `game_info` is handled by
  the FK in Task 1; no code or test needed.

**Placeholder scan:** none. Every code step carries the real code; every verify
step carries the exact command and expected output.

**Type consistency:** `TrendTag` / `ExistingTrendTag` are defined in Task 6 and used
only there. `PendingTag` / `ExistingTag` / `TagAction` / `ConfirmOutcome` / `SyncResult`
come from Task 1 and are consumed with those names in Task 4. `TRENDS_FIELD` and
`SYNC_USER` are imported everywhere rather than inlined. The pending-row shape
declared in Task 5's `Produces` matches the `PendingRow` interface in Task 7.
