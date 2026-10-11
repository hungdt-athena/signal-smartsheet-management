# Evaluation Time Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every evaluation save in an append-only `evaluation_log` with client-measured panel seconds, so evaluator panel time is summed instead of guessed from `evaluate_date`.

**Architecture:** One new table (migration 046, with a seed of old data). The PATCH and add-to-record routes write the log row in the same SQL statement as their UPDATE (CTE with `FOR UPDATE` + `UPDATE … FROM old`). The panel keeps a pure view timer (`lib/view-timer.ts`), snapshots it at the start of `save()` and sends `view_s` / `hidden_s` / `idle_s` / `context`. A read-only admin endpoint sums panel time per person per VN day.

**Tech Stack:** Next.js 14 app router, postgres.js (`sql` tagged templates, prepared statements on), Neon Postgres 16/17 (local verification on Homebrew PG 14), Jest 30 + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-10-evaluation-time-log-design.md` — read it before starting; this plan argues from it.

## Global Constraints

- Time zone everywhere: `Asia/Ho_Chi_Minh` (UTC+7). Days are VN days.
- Cap per save interval: **1800 s**. `view_s` clamped to `[0, 86400]`; `hidden_s`, `idle_s` clamped to `[0, view_s]`. Idle gap threshold: **120 000 ms**.
- `source` values: `panel` | `other` | `add_to_record` | `seed`. `context` values: `evaluate` | `shortlist` | `record` | `tagging`. `kind` values: `first` | `revise` | `clear` | `final` | `other`.
- Default titles counted as time: `['Fulltime', 'Freelancer']` (`dashboard_users.title`).
- "Unjudged" = `evaluate_date IS NULL` (covers `Stale_release`).
- The number is called **panel time**, never "working hours", in any UI or API field name.
- postgres.js sends JS numbers, strings and null as *untyped* parameters (only booleans, Dates, bigints are typed). **Every parameter in an `INSERT … SELECT` list still gets an explicit cast** (`::int`, `::text`) as a guard: Postgres currently infers them from the target columns, so Task 3's Jest text test, not the SQL harness, pins the casts.
- Inside `UPDATE game_evaluations ge … FROM old`, every **right-hand-side** column reference is written `ge.<col>`; SET **targets** stay unqualified.
- `app/api/evaluations/route.ts` contains a NUL byte: use `git diff --text` / `grep -a`.
- Never run `npm run build` while the user's dev server (port 3333) runs; build checks use `NEXT_DIST_DIR=.next-check` (see Task 10).
- The SQL harness never reads `DATABASE_URL` or any `.env*` file.
- Commit messages: conventional (`feat(scope): …`, `fix(scope): …`, `test(scope): …`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Baseline: some Jest tests already fail (their DB mock has no `sql.json`). Task 0 records the baseline; "pass" below means "no new failures versus baseline".

## Review Focus

1. **Save → Next while a save is in flight.** The saved game must get its own seconds and the next game's timer must not be wiped. Pinned in Task 6 (pure `restartAfterSave` only resets the same game) and Task 7 (source test: snapshot taken before the first `await` in `save()`).
2. **Untyped parameters in `INSERT … SELECT`.** Casts keep parameter types explicit if Postgres ever stops inferring them from the target columns. Pinned by Task 3's Jest test that the INSERT text carries the casts; the SQL harness cannot catch a missing cast.
3. **Migration not applied before Republish.** Every panel save would 500 with an opaque error. Pinned in Task 3 (42P01 → readable message).
4. **NULL `view_s`, admins and midnight in the time query.** `LEAST(NULL, 1800)` is 1800; admins must not appear; a 23:50→00:10 save overlapping a 23:55 save counts once. Pinned in Task 8's harness section (`panel_time` asserts) and Task 8's route test (`view_s IS NOT NULL`).
5. **`Stale_release` and imported rows (conclusion but no date).** Judging a `Stale_release` game must be `first` and move `evaluate_date`; re-saving an imported row unchanged must be `revise` and keep `evaluate_date` NULL. Pinned in Task 3's harness section (p3 / p5 / p6 asserts).

---

## File structure

| File | Responsibility |
|---|---|
| `migrations/046_evaluation_log.sql` (new) | Table, indexes, idempotent seed |
| `scripts/sql-verify/schema.sql` (new) | Minimal faithful copies of `game_info`, `dashboard_users`, `game_evaluations`, `playtest_tags` for the harness |
| `scripts/sql-verify/seed-fixtures.sql` (new) | Fixture rows loaded before the first 046 run so the seed has data to copy |
| `scripts/sql-verify/prepare-save.sql` (new) | The PATCH-shaped `PREPARE save`, shared by `checks.sql` and the two-session concurrency check |
| `scripts/sql-verify/checks.sql` (new) | Assertions: DDL, seed, CTE pattern, `evaluate_date` rule, untyped params, time query |
| `scripts/verify-evaluation-log.sh` (new) | Starts a throwaway local PG, runs schema + 046 (twice) + checks, tears down |
| `lib/evaluation-log.ts` (new) | Pure helpers: read timing from a body, touched flags, `kind` CASE fragment, missing-table detection |
| `app/api/evaluations/route.ts` | PATCH: CTE write, new `evaluate_date` rule, `role` hoist, 42P01 message |
| `app/api/evaluations/add-to-record/route.ts` | Log row (`source = 'add_to_record'`) in both branches; behaviour unchanged |
| `lib/reassign-core.ts` | `commitAssignment` guard + `CommitResult` |
| `app/api/operations/{reassign,rescue}/route.ts`, `app/api/operations/handover/resolve/route.ts`, `app/api/cron/assign-evaluators/route.ts` | Use `CommitResult` (moved ids) for history and counts |
| `lib/view-timer.ts` (new) | Pure view timer: start, visibility, input, snapshot, restart |
| `components/EvalDetailPanel.tsx` | `logContext` prop, timer wiring, snapshot at save start, stale `applyData` guard |
| 4 host files (5 mounts) | Pass `logContext` |
| `lib/evaluation-hours.ts` (new) | Panel time + games per day queries |
| `app/api/admin/evaluation-hours/route.ts` (new) | Admin GET endpoint |

---

### Task 0: Baseline

**Files:** none

- [ ] **Step 1: Record the Jest baseline**

Use the session scratchpad (the system prompt names it), not the repo:

Run: `SCRATCH=<session scratchpad>; rtk proxy npx jest > "$SCRATCH/baseline-jest.txt" 2>&1; grep -E '^(FAIL|Tests:|Test Suites:)' "$SCRATCH/baseline-jest.txt"`
Expected: the full FAIL list plus the totals. These failures are pre-existing.

- [ ] **Step 2: Record typecheck baseline**

Run: `npm run typecheck`
Expected: exit 0 (if not, note the existing errors; they are not this plan's).

- [ ] **Step 3: Commit the spec and plan**

They are untracked; Task 10's clean-tree check needs them committed.

```bash
git add docs/superpowers/specs/2026-10-10-evaluation-time-log-design.md docs/superpowers/plans/2026-10-10-evaluation-time-log.md
git commit -m "docs: evaluation time log spec and plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Migration 046 + SQL harness

**Files:**
- Create: `migrations/046_evaluation_log.sql`
- Create: `scripts/sql-verify/schema.sql`
- Create: `scripts/sql-verify/seed-fixtures.sql`
- Create: `scripts/sql-verify/checks.sql`
- Create: `scripts/verify-evaluation-log.sh`

**Interfaces:**
- Produces: table `evaluation_log` (columns exactly as below), used by Tasks 3, 4, 8.
- Produces: `scripts/verify-evaluation-log.sh` — exit 0 when every assertion passes; Tasks 3 and 8 append checks to `checks.sql`.

- [ ] **Step 1: Write the harness schema**

`scripts/sql-verify/schema.sql`:

```sql
-- Minimal copies of the prod tables evaluation_log touches. Columns and types follow
-- migrations 001/002/005/008/012/020-024/032/035/038/041/044. game_info is owned by the
-- Signal Sense repo, so only its key is copied.
SET TIME ZONE 'UTC';
CREATE TABLE game_info (game_id VARCHAR(255) PRIMARY KEY);
CREATE TABLE dashboard_users (
  id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, name VARCHAR(255),
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin','moderator','evaluator')),
  title TEXT, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE game_evaluations (
  id SERIAL PRIMARY KEY,
  game_id VARCHAR(255) NOT NULL REFERENCES game_info(game_id) ON DELETE CASCADE,
  category_group VARCHAR(20) NOT NULL DEFAULT 'puzzle',
  initial_evaluator VARCHAR(100), final_evaluator VARCHAR(100),
  evaluate_date TIMESTAMPTZ, initial_note TEXT, initial_conclusion VARCHAR(50),
  final_conclusion VARCHAR(50), final_conclusion_date TIMESTAMPTZ, batch VARCHAR(40),
  record_bucket TEXT, updated_at TIMESTAMPTZ DEFAULT NOW(), updated_by TEXT,
  UNIQUE (game_id, category_group));
CREATE TABLE playtest_tags (
  id serial PRIMARY KEY,
  game_id varchar(255) NOT NULL REFERENCES game_info(game_id) ON DELETE CASCADE,
  field_value text NOT NULL, status varchar(16) NOT NULL DEFAULT 'pending',
  tagged_by varchar(255) NOT NULL, tagged_at timestamptz NOT NULL DEFAULT now());

INSERT INTO dashboard_users (email, name, role, title) VALUES
 ('alice@x','Alice','evaluator','Freelancer'), ('bob@x','Bob','evaluator','Fulltime'),
 ('carol@x','Carol','evaluator','Freelancer'), ('dave@x','Dave','evaluator','Fulltime'),
 ('hung@x','HungDT','admin','Admin'), ('vinh@x','VinhTD','moderator','Admin');
```

- [ ] **Step 2: Write the seed-data + DDL/seed checks (they fail: no migration yet)**

`scripts/sql-verify/checks.sql` (first section; later tasks append):

```sql
\set ON_ERROR_STOP 1
SET TIME ZONE 'UTC';

-- ===== Task 1: DDL + seed =====
-- The runner loads seed fixtures BEFORE the first 046 run (see verify-evaluation-log.sh),
-- so here we only assert outcomes.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM evaluation_log WHERE source = 'seed';
  ASSERT n = 7, format('seed rows: expected 7, got %s', n);

  -- corrected: owner tagged 09:00, evaluate_date 10:00 -> created_at = tag time
  ASSERT (SELECT confidence FROM evaluation_log WHERE game_evaluation_id = 1) = 'corrected', 'g1 corrected';
  ASSERT (SELECT created_at FROM evaluation_log WHERE game_evaluation_id = 1) = '2026-10-01 09:00+07', 'g1 uses tag time';
  -- ok: tag within 30 min
  ASSERT (SELECT confidence FROM evaluation_log WHERE game_evaluation_id = 2) = 'ok', 'g2 ok';
  -- low: last written by an admin who is not the owner
  ASSERT (SELECT confidence FROM evaluation_log WHERE game_evaluation_id = 3) = 'low', 'g3 low (manager touched)';
  -- low: before 28/9 VN, no tag
  ASSERT (SELECT confidence FROM evaluation_log WHERE game_evaluation_id = 4) = 'low', 'g4 low (pre-28/9)';
  -- ok: 00:30 on 28/9 VN, untagged, is after the boundary
  ASSERT (SELECT confidence FROM evaluation_log WHERE game_evaluation_id = 5) = 'ok', 'g5 ok (boundary)';
  -- a tag by someone other than the owner is ignored
  ASSERT (SELECT confidence FROM evaluation_log WHERE game_evaluation_id = 6) = 'ok', 'g6 other-person tag ignored';
  -- earliest owner tag wins
  ASSERT (SELECT created_at FROM evaluation_log WHERE game_evaluation_id = 7) = '2026-10-02 08:00+07', 'g7 MIN tag';
  -- not seeded: no conclusion / no date
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id IN (8, 9)), 'g8/g9 not seeded';
END $$;

-- Re-running 046 inserts nothing.
\i migrations/046_evaluation_log.sql
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM evaluation_log WHERE source = 'seed') = 7, 'seed is idempotent';
END $$;

-- After a live panel row exists, only games judged before it are seeded.
INSERT INTO game_info VALUES ('c1'), ('c2');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, initial_conclusion, evaluate_date) VALUES
  (20, 'c1', 'Alice', 'Bypass', '2026-10-09 11:59+07'),
  (21, 'c2', 'Alice', 'Bypass', '2026-10-09 12:05+07');
INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, source, context, kind, view_s, created_at)
  VALUES (2, 'g2', 'Alice', 'panel', 'evaluate', 'revise', 30, '2026-10-09 12:00+07');
\i migrations/046_evaluation_log.sql
DO $$ BEGIN
  ASSERT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id = 20 AND source = 'seed'), 'c1 seeded (before cutover)';
  ASSERT NOT EXISTS (SELECT 1 FROM evaluation_log WHERE game_evaluation_id = 21 AND source = 'seed'), 'c2 skipped (after cutover)';
END $$;
DELETE FROM evaluation_log;   -- clean slate for later sections
```

Seed fixtures, `scripts/sql-verify/seed-fixtures.sql`:

```sql
SET TIME ZONE 'UTC';
INSERT INTO game_info VALUES ('g1'),('g2'),('g3'),('g4'),('g5'),('g6'),('g7'),('g8'),('g9');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, initial_conclusion, evaluate_date, updated_by) VALUES
 (1,'g1','Alice','Bypass','2026-10-01 10:00+07','Alice'),
 (2,'g2','Alice','Bypass','2026-10-01 10:00+07','Alice'),
 (3,'g3','alice','Bypass','2026-10-01 10:00+07','HungDT'),
 (4,'g4','Bob','Bypass','2026-09-20 10:00+07','Bob'),
 (5,'g5','Bob','Bypass','2026-09-28 00:30+07','Bob'),
 (6,'g6','Alice','Bypass','2026-10-01 10:00+07','Alice'),
 (7,'g7','Alice','List_Idea','2026-10-02 10:00+07','Alice'),
 (8,'g8','Alice',NULL,NULL,NULL),
 (9,'g9','Alice','Stale_release',NULL,NULL);
INSERT INTO playtest_tags (game_id, field_value, tagged_by, tagged_at) VALUES
 ('g1','t','ALICE@X','2026-10-01 09:00+07'),   -- case-insensitive email join
 ('g2','t','ALICE@x','2026-10-01 09:50+07'),
 ('g6','t','bob@x','2026-10-01 08:00+07'),
 ('g7','t','alice@x','2026-10-02 08:00+07'),
 ('g7','u','alice@x','2026-10-02 09:55+07');
```

- [ ] **Step 3: Write the runner**

`scripts/verify-evaluation-log.sh`:

```bash
#!/usr/bin/env bash
# Runs migration 046 and the evaluation_log SQL checks against a THROWAWAY local
# Postgres. Never reads DATABASE_URL or .env files. Needs initdb/pg_ctl/psql on PATH
# (Homebrew postgresql@14 or newer).
set -euo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
PORT=${VERIFY_PG_PORT:-54329}
cleanup() { pg_ctl -D "$TMP/pg" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
initdb -D "$TMP/pg" -U postgres --auth=trust >/dev/null
# timezone=UTC so the +07 boundary in the seed is really tested, whatever the machine's zone
pg_ctl -D "$TMP/pg" -o "-p $PORT -k $TMP -c listen_addresses=127.0.0.1 -c timezone=UTC" -l "$TMP/pg.log" -w start >/dev/null
P=(psql -h 127.0.0.1 -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1)
"${P[@]}" -d postgres -c "CREATE DATABASE verify"
"${P[@]}" -d verify -f scripts/sql-verify/schema.sql
"${P[@]}" -d verify -f scripts/sql-verify/seed-fixtures.sql
"${P[@]}" -d verify -f migrations/046_evaluation_log.sql
"${P[@]}" -d verify -f scripts/sql-verify/checks.sql
echo "evaluation_log SQL checks: OK"
```

Run: `chmod +x scripts/verify-evaluation-log.sh && scripts/verify-evaluation-log.sh`
Expected: FAIL — `psql: … migrations/046_evaluation_log.sql: No such file or directory`.

- [ ] **Step 4: Write the migration**

`migrations/046_evaluation_log.sql`:

```sql
-- Migration 046: evaluation_log — one append-only row per successful evaluation save.
-- Spec: docs/superpowers/specs/2026-10-10-evaluation-time-log-design.md
--
-- APPLY BEFORE REPUBLISH. The PATCH handler writes this table in the same statement as
-- its UPDATE, so without it every panel save fails. Then re-run this file once, right
-- after Republish, to seed games judged in between. The file is idempotent.

CREATE TABLE IF NOT EXISTS evaluation_log (
  id                 BIGSERIAL PRIMARY KEY,
  game_evaluation_id INT NOT NULL REFERENCES game_evaluations(id) ON DELETE CASCADE,
  game_id            TEXT NOT NULL,
  actor              TEXT,          -- session user name; NULL for seed rows and SKIP_AUTH
  actor_role         TEXT,          -- admin | moderator | evaluator (audit only)
  owner              TEXT,          -- initial_evaluator before the write
  source             TEXT NOT NULL, -- panel | other | add_to_record | seed
  context            TEXT,          -- evaluate | shortlist | record | tagging (source = panel only)
  kind               TEXT NOT NULL, -- first | revise | clear | final | other
  conclusion_before  TEXT,
  conclusion_after   TEXT,
  final_before       TEXT,          -- audit only
  final_after        TEXT,          -- audit only
  changed            BOOLEAN NOT NULL DEFAULT FALSE, -- initial conclusion changed
  view_s             INT,           -- seconds the game was the current game in the panel
  hidden_s           INT,           -- of which the tab was hidden (<= view_s)
  idle_s             INT,           -- of which no input for > 2 min stretches (<= view_s)
  confidence         TEXT,          -- seed rows only: ok | low | corrected
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evaluation_log_actor_time ON evaluation_log (actor, created_at);
CREATE INDEX IF NOT EXISTS idx_evaluation_log_game ON evaluation_log (game_evaluation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_evaluation_log_seed
  ON evaluation_log (game_evaluation_id) WHERE source = 'seed';

-- Seed: copy the one timestamp each judged game already has. Adds no precision;
-- `confidence` says how far to trust it.
WITH cutover AS (
  -- first live panel row; before Republish there is none, so NOW()
  SELECT COALESCE(MIN(created_at), NOW()) AS t FROM evaluation_log WHERE source = 'panel'
), tag AS (
  -- independent clock: trend tags are saved in the same click as the evaluation (~3 s apart)
  SELECT pt.game_id, lower(du.name) AS who, MIN(pt.tagged_at) AS tagged_at
  FROM playtest_tags pt JOIN dashboard_users du ON lower(du.email) = lower(pt.tagged_by)
  GROUP BY 1, 2
), src AS (
  SELECT ge.id, ge.game_id, ge.initial_evaluator, ge.initial_conclusion, ge.final_conclusion,
    ge.evaluate_date, tag.tagged_at,
    (tag.tagged_at IS NOT NULL AND ge.evaluate_date > tag.tagged_at + INTERVAL '30 minutes') AS restamped,
    EXISTS (SELECT 1 FROM dashboard_users m
            WHERE lower(m.name) = lower(ge.updated_by) AND m.role IN ('admin', 'moderator')
              AND lower(ge.updated_by) IS DISTINCT FROM lower(ge.initial_evaluator)) AS manager_touched
  FROM game_evaluations ge
  LEFT JOIN tag ON tag.game_id = ge.game_id AND tag.who = lower(ge.initial_evaluator)
  WHERE ge.initial_conclusion IS NOT NULL AND ge.evaluate_date IS NOT NULL
)
INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, owner, source, kind,
  conclusion_after, final_after, changed, confidence, created_at)
SELECT s.id, s.game_id, NULL, s.initial_evaluator, 'seed', 'first',
  s.initial_conclusion, s.final_conclusion, TRUE,
  CASE WHEN s.restamped THEN 'corrected'
       WHEN s.manager_touched THEN 'low'
       WHEN s.evaluate_date < '2026-09-28 00:00+07' AND s.tagged_at IS NULL THEN 'low'
       ELSE 'ok' END,
  CASE WHEN s.restamped THEN s.tagged_at ELSE s.evaluate_date END
FROM src s, cutover c
WHERE s.evaluate_date < c.t
ON CONFLICT (game_evaluation_id) WHERE source = 'seed' DO NOTHING;
```

- [ ] **Step 5: Run the harness**

Run: `scripts/verify-evaluation-log.sh`
Expected: `evaluation_log SQL checks: OK`.

- [ ] **Step 6: Commit**

```bash
git add migrations/046_evaluation_log.sql scripts/sql-verify scripts/verify-evaluation-log.sh
git commit -m "feat(db): evaluation_log table with a seed of old verdict times

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `lib/evaluation-log.ts` — pure helpers

**Files:**
- Create: `lib/evaluation-log.ts`
- Test: `__tests__/lib/evaluation-log.test.ts`

**Interfaces:**
- Produces:
  - `LOG_CONTEXTS: readonly ['evaluate','shortlist','record','tagging']`, `type LogContext`
  - `interface Timing { source: 'panel' | 'other'; context: LogContext | null; viewS: number | null; hiddenS: number | null; idleS: number | null }`
  - `readTiming(body: Record<string, unknown>): Timing`
  - `interface TouchedFlags { initialTouched: boolean; finalTouched: boolean }`
  - `touchedFlags(body: Record<string, unknown>): TouchedFlags`
  - `logKindSql(q: Sql, f: TouchedFlags)` (`import type { Sql } from 'postgres'`) — returns a `q`-tagged fragment; requires aliases `old` and `upd` in the enclosing statement. Not `any`: `.eslintrc` extends `next/typescript`, whose `no-explicit-any` fails `next build`
  - `EVALUATION_LOG_MISSING: string`, `isMissingLogTable(err: unknown): boolean`

- [ ] **Step 1: Write the failing tests**

`__tests__/lib/evaluation-log.test.ts`:

```ts
import {
  readTiming, touchedFlags, logKindSql, isMissingLogTable, EVALUATION_LOG_MISSING,
} from '@/lib/evaluation-log'

describe('readTiming', () => {
  it('is "other" with no timing when view_s is absent', () => {
    expect(readTiming({ id: 1, final_note: 'x' })).toEqual({
      source: 'other', context: null, viewS: null, hiddenS: null, idleS: null,
    })
  })
  it('is "other" when view_s is not a finite number', () => {
    expect(readTiming({ view_s: '30' }).source).toBe('other')
    expect(readTiming({ view_s: NaN }).source).toBe('other')
  })
  it('is "panel" and clamps view_s to [0, 86400]', () => {
    expect(readTiming({ view_s: -5 }).viewS).toBe(0)
    expect(readTiming({ view_s: 90000 }).viewS).toBe(86400)
    expect(readTiming({ view_s: 12.6 }).viewS).toBe(13)
  })
  it('clamps hidden_s and idle_s to view_s', () => {
    const t = readTiming({ view_s: 100, hidden_s: 500, idle_s: 40 })
    expect(t.hiddenS).toBe(100)
    expect(t.idleS).toBe(40)
  })
  it('accepts only known contexts', () => {
    expect(readTiming({ view_s: 1, context: 'record' }).context).toBe('record')
    expect(readTiming({ view_s: 1, context: 'hack' }).context).toBeNull()
  })
})

describe('touchedFlags', () => {
  it('sees an initial field', () => {
    expect(touchedFlags({ id: 1, initial_note_parts: {} })).toEqual({ initialTouched: true, finalTouched: false })
    expect(touchedFlags({ id: 1, drive_link: '' })).toEqual({ initialTouched: true, finalTouched: false })
  })
  it('sees a final-only write', () => {
    expect(touchedFlags({ id: 1, final_conclusion: 'Insight' })).toEqual({ initialTouched: false, finalTouched: true })
  })
  it('sees a record-only write as neither', () => {
    expect(touchedFlags({ id: 1, record_5min_drive: 'x' })).toEqual({ initialTouched: false, finalTouched: false })
  })
})

describe('logKindSql', () => {
  const tag = (strings: TemplateStringsArray, ...binds: unknown[]) => ({ text: strings.join('$'), binds })
  it('binds both flags and reads old/upd', () => {
    const f = logKindSql(tag as never, { initialTouched: true, finalTouched: false }) as unknown as { text: string; binds: unknown[] }
    expect(f.binds).toEqual([true, false, true]) // initialTouched, finalTouched, initialTouched
    expect(f.text).toMatch(/old\.evaluate_date IS NULL/)
    expect(f.text).toMatch(/'Stale_release'/)
    expect(f.text).toMatch(/THEN 'clear'/)
  })
})

describe('isMissingLogTable', () => {
  it('matches 42P01 on evaluation_log only', () => {
    expect(isMissingLogTable({ code: '42P01', message: 'relation "evaluation_log" does not exist' })).toBe(true)
    expect(isMissingLogTable({ code: '42P01', message: 'relation "other" does not exist' })).toBe(false)
    expect(isMissingLogTable(new Error('x'))).toBe(false)
    expect(EVALUATION_LOG_MISSING).toMatch(/046/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk proxy npx jest __tests__/lib/evaluation-log.test.ts`
Expected: FAIL — `Cannot find module '@/lib/evaluation-log'`.

- [ ] **Step 3: Implement**

`lib/evaluation-log.ts`:

```ts
// lib/evaluation-log.ts — helpers for writing evaluation_log rows (migration 046).
// Spec: docs/superpowers/specs/2026-10-10-evaluation-time-log-design.md
//
// Pure: no DB import at runtime (the postgres import is type-only). The `kind` CASE is
// returned as a fragment of the tag the caller passes (the route passes `sql`), so it
// can be unit-tested with a fake tag.
import type { Sql } from 'postgres'

export const LOG_CONTEXTS = ['evaluate', 'shortlist', 'record', 'tagging'] as const
export type LogContext = (typeof LOG_CONTEXTS)[number]

export interface Timing {
  source: 'panel' | 'other'
  context: LogContext | null
  viewS: number | null
  hiddenS: number | null
  idleS: number | null
}

const MAX_VIEW_S = 86_400

function clampInt(v: unknown, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0
  return Math.min(max, Math.max(0, n))
}

/** A save carries timing only when the panel measured it (`view_s` is a number). */
export function readTiming(body: Record<string, unknown>): Timing {
  const v = body.view_s
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { source: 'other', context: null, viewS: null, hiddenS: null, idleS: null }
  }
  const viewS = clampInt(v, MAX_VIEW_S)
  const context = (LOG_CONTEXTS as readonly string[]).includes(body.context as string)
    ? (body.context as LogContext)
    : null
  return {
    source: 'panel',
    context,
    viewS,
    hiddenS: clampInt(body.hidden_s, viewS),
    idleS: clampInt(body.idle_s, viewS),
  }
}

const INITIAL_FIELDS = ['initial_note', 'initial_note_parts', 'initial_conclusion', 'batch', 'game_alike', 'drive_link']
const FINAL_FIELDS = ['final_conclusion', 'final_note']

export interface TouchedFlags { initialTouched: boolean; finalTouched: boolean }

export function touchedFlags(body: Record<string, unknown>): TouchedFlags {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k)
  return { initialTouched: INITIAL_FIELDS.some(has), finalTouched: FINAL_FIELDS.some(has) }
}

/**
 * The log row's `kind`, read from the pre-update row (`old`) and the updated row (`upd`),
 * never from earlier log rows, so it is right with or without the seed. "Unjudged" is
 * `evaluate_date IS NULL`: Stale_release rows carry a conclusion but no date.
 */
export function logKindSql(q: Sql, f: TouchedFlags) {
  return q`CASE
    WHEN NOT ${f.initialTouched} AND ${f.finalTouched} THEN 'final'
    WHEN NOT ${f.initialTouched} THEN 'other'
    WHEN old.evaluate_date IS NULL
         AND upd.initial_conclusion IS NOT NULL
         AND upd.initial_conclusion <> 'Stale_release'
         AND old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion THEN 'first'
    WHEN old.initial_conclusion IS NOT NULL AND upd.initial_conclusion IS NULL THEN 'clear'
    ELSE 'revise'
  END`
}

export const EVALUATION_LOG_MISSING = 'evaluation_log missing — apply migration 046'

/** Postgres 42P01 (undefined_table) on evaluation_log: migration 046 was not applied. */
export function isMissingLogTable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null
  return !!e && e.code === '42P01' && /evaluation_log/.test(String(e.message ?? ''))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `rtk proxy npx jest __tests__/lib/evaluation-log.test.ts && npm run typecheck`
Expected: PASS (all 10 tests); typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/evaluation-log.ts __tests__/lib/evaluation-log.test.ts
git commit -m "feat(eval-log): helpers for timing, touched fields and the kind of a save

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: PATCH writes the log in the same statement

**Files:**
- Modify: `app/api/evaluations/route.ts` (PATCH, ~`:481-676`)
- Modify: `__tests__/api/evaluations-note-required.test.ts:107-114`
- Create: `__tests__/api/evaluations-log.test.ts`
- Modify: `scripts/sql-verify/checks.sql` (append CTE section)

**Interfaces:**
- Consumes: `readTiming`, `touchedFlags`, `logKindSql`, `isMissingLogTable`, `EVALUATION_LOG_MISSING` from Task 2; table from Task 1.
- Produces: PATCH accepts optional body fields `view_s`, `hidden_s`, `idle_s` (numbers) and `context` (LogContext). Response shape unchanged (`{ data: row }`).

- [ ] **Step 1: Add the PATCH-shaped prepared statement and the CTE checks to the harness (self-contained; they pass once added)**

Create `scripts/sql-verify/prepare-save.sql` (prepared statements are per session, so the concurrency check below loads it in each session):

```sql
-- Parameter types follow postgres.js: booleans typed, everything else unknown. Casts keep
-- parameter types explicit (postgres.js sends numbers/strings untyped).
-- $1 id, $2 concProvided(bool), $3 concVal, $4 batch, $5 final_conclusion,
-- $6 actor, $7 role, $8 source, $9 context, $10 view_s, $11 hidden_s, $12 idle_s,
-- $13 initialTouched(bool), $14 finalTouched(bool)
PREPARE save(unknown, boolean, unknown, unknown, unknown, unknown, unknown, unknown, unknown,
             unknown, unknown, unknown, boolean, boolean) AS
WITH old AS (
  SELECT id, game_id, initial_conclusion, initial_evaluator, final_conclusion, evaluate_date
  FROM game_evaluations WHERE id = $1
  FOR UPDATE
), upd AS (
  UPDATE game_evaluations ge SET
    -- every use of a reused parameter carries the same cast, or Postgres raises
    -- "inconsistent types deduced for parameter" (the route binds each use separately)
    initial_conclusion = CASE WHEN $2 THEN $3::text ELSE ge.initial_conclusion END,
    evaluate_date = CASE
      WHEN $2 AND $3::text IS NOT NULL
        AND ge.initial_conclusion IS DISTINCT FROM $3::text
        AND (   $6::text IS NULL
             OR lower(ge.initial_evaluator) = lower($6::text)
             OR ge.evaluate_date IS NULL
             OR ($3::text = 'List_Idea' AND $4::text IS NOT NULL
                 AND ge.batch IS DISTINCT FROM $4::text))
        THEN clock_timestamp()
      WHEN $2 AND $3::text IS NULL THEN NULL
      ELSE ge.evaluate_date END,
    final_conclusion = COALESCE($5::text, ge.final_conclusion),
    batch = CASE WHEN $4::text IS NULL THEN ge.batch ELSE $4::text END,
    updated_by = $6::text
  FROM old WHERE ge.id = old.id
  RETURNING ge.*
), logged AS (
  INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, actor_role, owner, source,
    context, kind, conclusion_before, conclusion_after, final_before, final_after, changed,
    view_s, hidden_s, idle_s)
  SELECT old.id, old.game_id, $6::text, $7::text, old.initial_evaluator, $8::text, $9::text,
    CASE
      WHEN NOT $13 AND $14 THEN 'final'
      WHEN NOT $13 THEN 'other'
      WHEN old.evaluate_date IS NULL AND upd.initial_conclusion IS NOT NULL
           AND upd.initial_conclusion <> 'Stale_release'
           AND old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion THEN 'first'
      WHEN old.initial_conclusion IS NOT NULL AND upd.initial_conclusion IS NULL THEN 'clear'
      ELSE 'revise' END,
    old.initial_conclusion, upd.initial_conclusion, old.final_conclusion, upd.final_conclusion,
    old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion,
    $10::int, $11::int, $12::int
  FROM old JOIN upd ON upd.id = old.id
)
SELECT id FROM upd;
```

Append to `scripts/sql-verify/checks.sql`:

```sql
-- ===== Task 3: PATCH CTE pattern, kind, evaluate_date rule, untyped params =====
\i scripts/sql-verify/prepare-save.sql

INSERT INTO game_info VALUES ('p1'),('p2'),('p3'),('p4'),('p5'),('p6');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, initial_conclusion, evaluate_date, batch) VALUES
 (31,'p1','Alice',NULL,NULL,NULL),
 (32,'p2','Alice','Bypass','2026-09-01 10:00+07',NULL),
 (33,'p3','Alice','Stale_release',NULL,NULL),
 (34,'p4','Alice','Bypass','2026-08-01 10:00+07','W1 Aug, 2026'),
 (35,'p5','Alice','Bypass',NULL,NULL),   -- imported: conclusion, no date
 (36,'p6','Alice',NULL,NULL,NULL);

EXECUTE save(31, true, 'Bypass', NULL, NULL, 'alice', 'evaluator', 'panel', 'evaluate', 60, 0, 0, true, false);
EXECUTE save(31, true, 'Bypass', NULL, NULL, 'Alice', 'evaluator', 'panel', 'evaluate', 30, 0, 0, true, false);
EXECUTE save(32, true, 'Link_dead', NULL, NULL, 'HungDT', 'admin', 'panel', 'evaluate', 40, 0, 0, true, false);
EXECUTE save(33, true, 'Bypass', NULL, NULL, 'HungDT', 'admin', 'panel', 'shortlist', 50, 0, 0, true, false);
EXECUTE save(34, true, 'List_Idea', 'W2 Oct, 2026', NULL, 'HungDT', 'admin', 'panel', 'evaluate', 20, 0, 0, true, false);
EXECUTE save(35, true, 'Bypass', NULL, NULL, 'Alice', 'evaluator', 'panel', 'evaluate', 10, 0, 0, true, false);
EXECUTE save(32, false, NULL, NULL, 'Priority I', 'HungDT', 'admin', 'other', NULL, NULL, NULL, NULL, false, true);
EXECUTE save(32, false, NULL, NULL, NULL, 'Rec', 'evaluator', 'panel', 'record', 15, 0, 0, false, false);
EXECUTE save(31, true, NULL, NULL, NULL, 'HungDT', 'admin', 'panel', 'evaluate', 5, 0, 0, true, false);
EXECUTE save(31, true, 'Bypass', NULL, NULL, NULL, NULL, 'other', NULL, NULL, NULL, NULL, true, false);
EXECUTE save(36, true, 'Stale_release', NULL, NULL, 'Alice', 'evaluator', 'panel', 'evaluate', 5, 0, 0, true, false); -- never 'first'

DO $$
DECLARE k text[];
BEGIN
  SELECT array_agg(kind ORDER BY id) INTO k FROM evaluation_log;
  ASSERT k = ARRAY['first','revise','revise','first','revise','revise','final','other','clear','first','revise'],
    format('kinds: %s', k);
  -- admin correcting a judged game keeps the owner's date
  ASSERT (SELECT evaluate_date FROM game_evaluations WHERE id = 32) = '2026-09-01 10:00+07', 'p2 date kept';
  -- admin judging Stale_release moves it (unjudged)
  ASSERT (SELECT evaluate_date FROM game_evaluations WHERE id = 33) > now() - interval '1 hour', 'p3 date moved';
  -- List_Idea promotion with a batch moves it (batch windows stay stable)
  ASSERT (SELECT evaluate_date FROM game_evaluations WHERE id = 34) > now() - interval '1 hour', 'p4 date moved';
  -- imported row re-saved unchanged keeps NULL
  ASSERT (SELECT evaluate_date FROM game_evaluations WHERE id = 35) IS NULL, 'p5 date stays NULL';
  -- typed ints landed as ints
  ASSERT (SELECT view_s FROM evaluation_log ORDER BY id LIMIT 1) = 60, 'view_s is an int';
END $$;

-- Without the join the log is empty: proves `UPDATE ... FROM old` is required.
PREPARE nojoin(unknown) AS
WITH old AS (SELECT id, game_id FROM game_evaluations WHERE id = $1 FOR UPDATE),
upd AS (UPDATE game_evaluations ge SET updated_by = 'x' WHERE ge.id = $1 RETURNING ge.*),
logged AS (INSERT INTO evaluation_log (game_evaluation_id, game_id, source, kind)
           SELECT old.id, old.game_id, 'other', 'other' FROM old)
SELECT id FROM upd;
-- (the server's EXECUTE cannot run inside PL/pgSQL, so it runs at top level)
CREATE TEMP TABLE c0 AS SELECT count(*) AS n FROM evaluation_log;
EXECUTE nojoin(31);
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM evaluation_log) = (SELECT n FROM c0),
    'expected no log row without the join (if this fails, Postgres changed; keep the join anyway)';
END $$;
DELETE FROM evaluation_log;
```

Then add the spec's two-session check to `scripts/verify-evaluation-log.sh`, after the `checks.sql` line and before the final `echo`:

```bash
# Two sessions on one fresh row: B waits on A's row lock, then logs 'revise' over A's verdict.
"${P[@]}" -d verify -c "INSERT INTO game_info VALUES ('cc1'); INSERT INTO game_evaluations (id, game_id, initial_evaluator) VALUES (90, 'cc1', 'Alice');"
"${P[@]}" -d verify -f scripts/sql-verify/prepare-save.sql \
  -c "BEGIN" \
  -c "EXECUTE save(90, true, 'Bypass', NULL, NULL, 'Alice', 'evaluator', 'panel', 'evaluate', 5, 0, 0, true, false)" \
  -c "SELECT pg_sleep(2)" -c "COMMIT" >/dev/null &
A=$!
sleep 0.5
"${P[@]}" -d verify -f scripts/sql-verify/prepare-save.sql \
  -c "EXECUTE save(90, true, 'List_Idea', NULL, NULL, 'Alice', 'evaluator', 'panel', 'evaluate', 5, 0, 0, true, false)" >/dev/null
wait $A
"${P[@]}" -d verify -c "DO \$\$ BEGIN
  ASSERT (SELECT array_agg(kind ORDER BY id) FROM evaluation_log WHERE game_evaluation_id = 90) = ARRAY['first','revise'], 'concurrent kinds';
  ASSERT (SELECT conclusion_before FROM evaluation_log WHERE game_evaluation_id = 90 ORDER BY id DESC LIMIT 1) = 'Bypass', 'B read A''s verdict';
END \$\$;"
```

Run: `scripts/verify-evaluation-log.sh`
Expected: `evaluation_log SQL checks: OK` (this verifies the SQL pattern the route will use; the route itself is checked by the Jest tests below and by the Neon-branch smoke in Rollout).

- [ ] **Step 2: Write the failing route tests**

`__tests__/api/evaluations-log.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => {
  const fn = jest.fn() as jest.Mock & { json: jest.Mock; begin: jest.Mock }
  fn.json = jest.fn((v: unknown) => v)
  fn.begin = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(fn)))
  return { sql: fn }
})
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))
jest.mock('@/lib/config', () => ({
  getConfigValues: jest.fn(async () => ['Priority IV', 'Insight', 'Bypass', 'List_Idea']),
}))

import { PATCH } from '@/app/api/evaluations/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

let calls: { text: string; binds: unknown[] }[] = []
function routeSql(row: Record<string, unknown> = { initial_evaluator: 'Alice', initial_conclusion: null }) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    calls.push({ text: (strings as string[]).join('$'), binds })
    return Promise.resolve([{ id: 1, ...row }])
  })
}
const patch = (body: unknown) => PATCH(new NextRequest('http://localhost/api/evaluations', {
  method: 'PATCH', body: JSON.stringify(body),
} as never))
const writeCall = () => calls.find(c => /INSERT INTO evaluation_log/.test(c.text))!

describe('PATCH /api/evaluations — evaluation_log', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { calls = []; sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Alice' } }) })

  it('writes the log in the same statement as the UPDATE, under a row lock', async () => {
    routeSql()
    const res = await patch({ id: 1, initial_conclusion: 'Bypass', initial_note: 'a real note here', view_s: 42, context: 'evaluate' })
    expect(res.status).toBe(200)
    const w = writeCall()
    expect(w.text).toMatch(/FOR UPDATE/)
    expect(w.text).toMatch(/UPDATE game_evaluations ge SET/)
    expect(w.text).toMatch(/FROM old WHERE ge\.id = old\.id/)
    expect(w.binds).toEqual(expect.arrayContaining(['Alice', 'evaluator', 'panel', 'evaluate', 42]))
  })

  it('casts every INSERT parameter (postgres.js sends numbers untyped)', async () => {
    routeSql()
    await patch({ id: 1, initial_note: 'a real note here', view_s: 5, context: 'evaluate' })
    const t = writeCall().text
    expect(t).toMatch(/\$::text, \$::text, old\.initial_evaluator, \$::text, \$::text/)
    expect(t).toMatch(/\$::int, \$::int, \$::int\s+FROM old JOIN upd/)
  })

  it('logs a save without view_s as source "other" with no timing', async () => {
    routeSql()
    await patch({ id: 1, game_alike: [] })
    const b = writeCall().binds
    expect(b).toContain('other')
    expect(b[b.indexOf('other') + 1]).toBeNull()   // context
    expect(b.slice(-3)).toEqual([null, null, null]) // view_s, hidden_s, idle_s
  })

  it('moves evaluate_date only for the owner, an unjudged game, no actor, or a List_Idea batch stamp', async () => {
    routeSql()
    await patch({ id: 1, initial_conclusion: 'Bypass', initial_note: 'a real note here' })
    const t = writeCall().text
    expect(t).toMatch(/lower\(ge\.initial_evaluator\) = lower\(\$::text\)/)
    expect(t).toMatch(/OR ge\.evaluate_date IS NULL/)
    expect(t).toMatch(/= 'List_Idea'/)
    // every right-hand side is ge.-qualified (an unqualified one is ambiguous under FROM old)
    expect(t).not.toMatch(/ELSE (?!ge\.)[a-z_]+\s+END/)
    expect(t).not.toMatch(/COALESCE\(\$, (?!ge\.)[a-z_]+\)/)
  })

  it('returns a readable error when migration 046 is missing', async () => {
    routeSql()
    sqlMock.mockImplementation((strings: unknown) => {
      if (Array.isArray(strings) && /INSERT INTO evaluation_log/.test((strings as string[]).join(' '))) {
        return Promise.reject(Object.assign(new Error('relation "evaluation_log" does not exist'), { code: '42P01' }))
      }
      return Promise.resolve([{ id: 1, initial_evaluator: 'Alice', initial_conclusion: null }])
    })
    const res = await patch({ id: 1, initial_note: 'a real note here', view_s: 5 })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/apply migration 046/)
  })
})
```

Run: `rtk proxy npx jest __tests__/api/evaluations-log.test.ts`
Expected: FAIL (no `INSERT INTO evaluation_log` in any call → `writeCall()` is undefined).

- [ ] **Step 3: Implement the route change**

In `app/api/evaluations/route.ts`:

(a) Add to the imports:

```ts
import {
  readTiming, touchedFlags, logKindSql, isMissingLogTable, EVALUATION_LOG_MISSING,
} from '@/lib/evaluation-log'
```

(b) Next to `let actor: string | null = null` (~`:544`) add `let role: string | null = null`, and inside the auth block replace `const role = session?.user?.role` with:

```ts
      role = session?.user?.role ?? null
```

(the following lines `isManager = isManagerRole(role)` and `isAdmin = role === 'admin'` keep working).

(c) Just before `const result = await sql\``, add:

```ts
    const timing = readTiming(body)
    const flags = touchedFlags(body)
```

(d) Replace the whole `const result = await sql\` UPDATE game_evaluations SET … RETURNING * \`` statement with:

```ts
    const result = await sql`
      WITH old AS (
        SELECT id, game_id, initial_conclusion, initial_evaluator, final_conclusion, evaluate_date
        FROM game_evaluations WHERE id = ${id}
        FOR UPDATE
      ), upd AS (
        UPDATE game_evaluations ge SET
          initial_note = CASE WHEN ${noteProvided} THEN ${noteVal} ELSE ge.initial_note END,
          initial_gameplay = CASE WHEN ${noteProvided} THEN ${part('gameplay')} ELSE ge.initial_gameplay END,
          initial_game_over = CASE WHEN ${noteProvided} THEN ${part('game_over')} ELSE ge.initial_game_over END,
          initial_level_complete = CASE WHEN ${noteProvided} THEN ${part('level_complete')} ELSE ge.initial_level_complete END,
          initial_self_note = CASE WHEN ${noteProvided} THEN ${part('self_note')} ELSE ge.initial_self_note END,
          final_note = CASE WHEN ${finalNoteProvided} THEN ${finalNoteVal} ELSE ge.final_note END,
          game_alike = CASE WHEN ${gaProvided} THEN ${sql.json(gaJson as unknown as Parameters<typeof sql.json>[0])}::jsonb ELSE ge.game_alike END,
          initial_conclusion = CASE WHEN ${concProvided} THEN ${concVal} ELSE ge.initial_conclusion END,
          -- Only a real change of verdict moves the stamp, and only when it is the
          -- owner's own verdict, the game was unjudged (incl. Stale_release), there is
          -- no actor (SKIP_AUTH), or a manager is stamping the current batch on a
          -- promotion to List_Idea (report-batches reads batch starts from this date).
          -- Time comes from evaluation_log, not from here.
          evaluate_date = CASE
            WHEN ${concProvided} AND ${concVal}::text IS NOT NULL
              AND ge.initial_conclusion IS DISTINCT FROM ${concVal}::text
              AND (   ${actor}::text IS NULL
                   OR lower(ge.initial_evaluator) = lower(${actor}::text)
                   OR ge.evaluate_date IS NULL
                   OR (${concVal}::text = 'List_Idea'
                       AND ${batch ?? null}::text IS NOT NULL
                       AND ge.batch IS DISTINCT FROM ${batch ?? null}::text))
              THEN NOW()
            WHEN ${concProvided} AND ${concVal}::text IS NULL THEN NULL
            ELSE ge.evaluate_date END,
          final_conclusion = COALESCE(${final_conclusion ?? null}, ge.final_conclusion),
          final_conclusion_date = CASE
            WHEN ${final_conclusion ?? null}::text IS NOT NULL THEN NOW()
            ELSE ge.final_conclusion_date END,
          final_evaluator = CASE
            WHEN ${final_conclusion ?? null}::text IS NOT NULL THEN ${actor}
            ELSE ge.final_evaluator END,
          -- Batch stamping (unchanged): managers set any batch; evaluators only stamp the
          -- current batch on the transition into List_Idea. ge.initial_conclusion is the
          -- pre-update value.
          batch = CASE
            WHEN ${batch ?? null}::text IS NULL THEN ge.batch
            WHEN ${isManager} THEN ${batch ?? null}
            WHEN ${concVal} = 'List_Idea' AND ge.initial_conclusion IS DISTINCT FROM 'List_Idea'
              THEN ${batch ?? null}
            ELSE ge.batch
          END,
          drive_link = CASE WHEN ${dlProvided} THEN ${dlVal} ELSE ge.drive_link END,
          drive_date = CASE
            WHEN ${dlProvided} AND ${dlVal}::text IS NOT NULL THEN NOW()
            WHEN ${dlProvided} AND ${dlVal}::text IS NULL THEN NULL
            ELSE ge.drive_date END,
          youtube_link = COALESCE(${youtube_link ?? null}, ge.youtube_link),
          record_5min_assignee = COALESCE(${record_5min_assignee ?? null}, ge.record_5min_assignee),
          record_5min_date = CASE WHEN ${record_5min_assignee ?? null}::text IS NOT NULL AND ge.record_5min_assignee IS NULL THEN NOW() ELSE ge.record_5min_date END,
          record_5min_drive = COALESCE(${record_5min_drive ?? null}, ge.record_5min_drive),
          record_5min_drive_date = CASE WHEN ${record_5min_drive ?? null}::text IS NOT NULL THEN NOW() ELSE ge.record_5min_drive_date END,
          record_20min_assignee = COALESCE(${record_20min_assignee ?? null}, ge.record_20min_assignee),
          record_20min_date = CASE WHEN ${record_20min_assignee ?? null}::text IS NOT NULL AND ge.record_20min_assignee IS NULL THEN NOW() ELSE ge.record_20min_date END,
          record_20min_drive = COALESCE(${record_20min_drive ?? null}, ge.record_20min_drive),
          record_20min_drive_date = CASE WHEN ${record_20min_drive ?? null}::text IS NOT NULL THEN NOW() ELSE ge.record_20min_drive_date END,
          updated_by = ${actor}
        -- The join is what makes the locked read of "old" run first. Without it the log
        -- row is silently never written (verified on PG 14, scripts/verify-evaluation-log.sh).
        FROM old WHERE ge.id = old.id
        RETURNING ge.*
      ), logged AS (
        -- Casts keep parameter types explicit (postgres.js sends numbers/strings untyped).
        INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, actor_role, owner, source,
          context, kind, conclusion_before, conclusion_after, final_before, final_after, changed,
          view_s, hidden_s, idle_s)
        SELECT old.id, old.game_id, ${actor}::text, ${role}::text, old.initial_evaluator, ${timing.source}::text, ${timing.context}::text,
          ${logKindSql(sql, flags)},
          old.initial_conclusion, upd.initial_conclusion,
          old.final_conclusion, upd.final_conclusion,
          old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion,
          ${timing.viewS}::int, ${timing.hiddenS}::int, ${timing.idleS}::int
        FROM old JOIN upd ON upd.id = old.id
      )
      SELECT * FROM upd
    `
```

(e) In the PATCH `catch (err)` block, before `console.error`, add:

```ts
    if (isMissingLogTable(err)) {
      console.error('PATCH /api/evaluations: evaluation_log missing — apply migration 046')
      return NextResponse.json({ error: EVALUATION_LOG_MISSING }, { status: 500 })
    }
```

- [ ] **Step 4: Update the old restamp test**

In `__tests__/api/evaluations-note-required.test.ts`, replace the `only restamps evaluate_date when the initial conclusion changes` assertion line:

```ts
    expect(upd.text).toMatch(/initial_conclusion IS DISTINCT FROM\s+\$?\s*::text THEN NOW\(\)/)
```

with:

```ts
    expect(upd.text).toMatch(/ge\.initial_conclusion IS DISTINCT FROM\s+\$?\s*::text\s+AND \(/)
```

- [ ] **Step 5: Run the PATCH tests**

Run: `rtk proxy npx jest __tests__/api/evaluations-log.test.ts __tests__/api/evaluations-note-required.test.ts __tests__/api/evaluations-final-fields.test.ts __tests__/api/evaluations.test.ts && npm run typecheck`
Expected: PASS (no new failures versus the Task 0 baseline). If a test's text join uses `' '` and the cast regexes expect `'$'`, that is because `evaluations-log.test.ts` joins with `'$'` on purpose.

- [ ] **Step 6: Commit**

```bash
git add app/api/evaluations/route.ts __tests__/api/evaluations-log.test.ts __tests__/api/evaluations-note-required.test.ts scripts/sql-verify/checks.sql scripts/sql-verify/prepare-save.sql scripts/verify-evaluation-log.sh
git commit -m "feat(evaluations): log every save with its panel time, in the same statement

evaluate_date no longer moves when someone other than the owner changes a
judged verdict, except on a List_Idea batch stamp.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: add-to-record writes a log row

**Files:**
- Modify: `app/api/evaluations/add-to-record/route.ts:93-137`
- Create: `__tests__/api/add-to-record-log.test.ts`

**Interfaces:**
- Consumes: `logKindSql`, `isMissingLogTable`, `EVALUATION_LOG_MISSING` (Task 2); `getSession` from `@/lib/session`.
- Produces: one `evaluation_log` row per call, `source = 'add_to_record'`, timing NULL. Behaviour and `evaluate_date` unchanged.

- [ ] **Step 1: Write the failing test**

`__tests__/api/add-to-record-log.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/auth-guard', () => ({ requireManager: jest.fn(async () => null) }))
jest.mock('@/lib/session', () => ({ getSession: jest.fn(async () => ({ user: { name: 'VinhTD', role: 'moderator' } })) }))
jest.mock('@/lib/config', () => ({ getConfigValues: jest.fn(async () => ['List_Idea', 'Bypass', 'Insight', 'Priority IV']) }))

import { POST } from '@/app/api/evaluations/add-to-record/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock
let calls: { text: string; binds: unknown[] }[] = []
beforeEach(() => {
  calls = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    calls.push({ text: (strings as string[]).join('$'), binds })
    return Promise.resolve([{ id: 7, game_id: 'g' }])
  })
})
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/evaluations/add-to-record', {
  method: 'POST', body: JSON.stringify(body),
} as never))
const logCall = () => calls.find(c => /INSERT INTO evaluation_log/.test(c.text))

describe('add-to-record logs itself', () => {
  it('override branch: one add_to_record row, no timing, same statement as the UPDATE', async () => {
    const res = await post({ game_id: 'g', category_group: 'puzzle', bucket: '5min', batch: 'W2 Oct, 2026',
      initial_evaluator: 'Shortcut', initial_conclusion: 'List_Idea', final_conclusion: 'Insight', final_evaluator: 'Shortcut' })
    expect(res.status).toBe(200)
    const c = logCall()!
    expect(c.text).toMatch(/FOR UPDATE/)
    expect(c.text).toMatch(/FROM old WHERE ge\.id = old\.id/)
    expect(c.binds).toEqual(expect.arrayContaining(['VinhTD', 'moderator']))
    expect(c.text).toMatch(/'add_to_record'/)
    expect(c.text).not.toMatch(/view_s/)
    expect(c.text).not.toMatch(/ELSE (?!ge\.)[a-z_]+\s+END/)
    expect(c.text).not.toMatch(/COALESCE\(\$, (?!ge\.)[a-z_]+\)/)
  })

  it('legacy branch: also logs, auto-fill logic unchanged', async () => {
    await post({ game_id: 'g', category_group: 'puzzle', bucket: '20min' })
    const c = logCall()!
    // the auto-fill test is its own sql`` fragment, so it shows up as a separate call
    expect(calls.some(x => /\(ge\.initial_conclusion IS NULL OR ge\.initial_conclusion ILIKE '%bypass%'\)/.test(x.text))).toBe(true)
    expect(c.text).not.toMatch(/ELSE (?!ge\.)[a-z_]+\s+END/)
    expect(c.text).toMatch(/'add_to_record'/)
  })
})
```

Run: `rtk proxy npx jest __tests__/api/add-to-record-log.test.ts`
Expected: FAIL (`logCall()` undefined).

- [ ] **Step 2: Implement**

In `app/api/evaluations/add-to-record/route.ts`:

(a) Imports:

```ts
import { getSession } from '@/lib/session'
import { logKindSql, isMissingLogTable, EVALUATION_LOG_MISSING } from '@/lib/evaluation-log'
```

(b) Before `let result`, add:

```ts
    const session = await getSession()
    const actor = session?.user?.name ?? null
    const role = session?.user?.role ?? null
```

(c) Replace the override-branch statement with the version below. `upd` returns the
columns the log needs: inside one statement a fresh `JOIN game_evaluations` would still see
the pre-update row (all sub-statements share one snapshot).

```ts
      result = await sql`
        WITH old AS (
          SELECT id, game_id, initial_conclusion, initial_evaluator, final_conclusion, evaluate_date
          FROM game_evaluations
          WHERE game_id = ${game_id} AND category_group = ${category_group}
          FOR UPDATE
        ), upd AS (
          UPDATE game_evaluations ge
          SET record_bucket = ${bucket},
              batch = COALESCE(${batchVal}, ge.batch),
              initial_evaluator = COALESCE(${initEval}, ge.initial_evaluator),
              initial_conclusion = COALESCE(${initConcl}, ge.initial_conclusion),
              evaluate_date = CASE
                WHEN ${initConcl}::text IS NOT NULL AND ge.initial_conclusion IS DISTINCT FROM ${initConcl}
                  THEN NOW() ELSE ge.evaluate_date END,
              final_conclusion = COALESCE(${finalConcl}, ge.final_conclusion),
              final_conclusion_date = CASE
                WHEN ${finalConcl}::text IS NOT NULL AND ge.final_conclusion IS DISTINCT FROM ${finalConcl}
                  THEN NOW() ELSE ge.final_conclusion_date END,
              final_evaluator = COALESCE(${finalEval}, ge.final_evaluator)
          FROM old WHERE ge.id = old.id
          RETURNING ge.id, ge.initial_conclusion, ge.final_conclusion
        ), logged AS (
          INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, actor_role, owner, source,
            kind, conclusion_before, conclusion_after, final_before, final_after, changed)
          SELECT old.id, old.game_id, ${actor}::text, ${role}::text, old.initial_evaluator, 'add_to_record',
            ${logKindSql(sql, { initialTouched: !!(initEval || initConcl), finalTouched: !!(finalConcl || finalEval) })},
            old.initial_conclusion, upd.initial_conclusion, old.final_conclusion, upd.final_conclusion,
            old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion
          FROM old JOIN upd ON upd.id = old.id
        )
        SELECT id FROM upd
      `
```

(d) Replace the legacy-branch statement with:

```ts
      const finalConclusion = FINAL_FOR_BUCKET[bucket as keyof typeof FINAL_FOR_BUCKET]
      const autoFill = sql`(ge.initial_conclusion IS NULL OR ge.initial_conclusion ILIKE '%bypass%')`
      result = await sql`
        WITH old AS (
          SELECT id, game_id, initial_conclusion, initial_evaluator, final_conclusion, evaluate_date
          FROM game_evaluations
          WHERE game_id = ${game_id} AND category_group = ${category_group}
          FOR UPDATE
        ), upd AS (
          UPDATE game_evaluations ge
          SET record_bucket = ${bucket},
              batch = COALESCE(${batchVal}, ge.batch),
              initial_evaluator = CASE WHEN ${autoFill} THEN ${AUTO_EVALUATOR} ELSE ge.initial_evaluator END,
              initial_conclusion = CASE WHEN ${autoFill} THEN 'List_Idea' ELSE ge.initial_conclusion END,
              evaluate_date = CASE WHEN ${autoFill} THEN NOW() ELSE ge.evaluate_date END,
              final_conclusion = CASE WHEN ${autoFill} THEN ${finalConclusion} ELSE ge.final_conclusion END,
              final_conclusion_date = CASE WHEN ${autoFill} THEN NOW() ELSE ge.final_conclusion_date END,
              final_evaluator = CASE WHEN ${autoFill} THEN ${AUTO_EVALUATOR} ELSE ge.final_evaluator END
          FROM old WHERE ge.id = old.id
          RETURNING ge.id, ge.initial_conclusion, ge.final_conclusion
        ), logged AS (
          INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, actor_role, owner, source,
            kind, conclusion_before, conclusion_after, final_before, final_after, changed)
          SELECT old.id, old.game_id, ${actor}::text, ${role}::text, old.initial_evaluator, 'add_to_record',
            ${logKindSql(sql, { initialTouched: true, finalTouched: true })},
            old.initial_conclusion, upd.initial_conclusion, old.final_conclusion, upd.final_conclusion,
            old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion
          FROM old JOIN upd ON upd.id = old.id
        )
        SELECT id FROM upd
      `
```

(e) In the `catch`, before `console.error`:

```ts
    if (isMissingLogTable(err)) {
      return NextResponse.json({ error: EVALUATION_LOG_MISSING }, { status: 500 })
    }
```

- [ ] **Step 3: Add the same pattern to the harness**

Append to `scripts/sql-verify/checks.sql`:

```sql
-- ===== Task 4: add-to-record legacy branch logs and keeps auto-fill =====
INSERT INTO game_info VALUES ('r1'), ('r2');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, initial_conclusion, evaluate_date) VALUES
 (41, 'r1', 'HuyDD', 'Bypass', '2026-10-01 10:00+07'),
 (42, 'r2', 'HuyDD', 'List_Idea', '2026-10-01 10:00+07');
PREPARE atr(unknown, unknown) AS
WITH old AS (
  SELECT id, game_id, initial_conclusion, initial_evaluator, final_conclusion, evaluate_date
  FROM game_evaluations WHERE game_id = $1 AND category_group = 'puzzle' FOR UPDATE
), upd AS (
  UPDATE game_evaluations ge SET
    initial_evaluator = CASE WHEN (ge.initial_conclusion IS NULL OR ge.initial_conclusion ILIKE '%bypass%') THEN 'Shortcut' ELSE ge.initial_evaluator END,
    initial_conclusion = CASE WHEN (ge.initial_conclusion IS NULL OR ge.initial_conclusion ILIKE '%bypass%') THEN 'List_Idea' ELSE ge.initial_conclusion END
  FROM old WHERE ge.id = old.id
  RETURNING ge.id, ge.initial_conclusion, ge.final_conclusion
), logged AS (
  INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, owner, source, kind,
    conclusion_before, conclusion_after, changed)
  SELECT old.id, old.game_id, $2::text, old.initial_evaluator, 'add_to_record', 'revise',
    old.initial_conclusion, upd.initial_conclusion, old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion
  FROM old JOIN upd ON upd.id = old.id
)
SELECT id FROM upd;
EXECUTE atr('r1', 'VinhTD');
EXECUTE atr('r2', 'VinhTD');
DO $$ BEGIN
  ASSERT (SELECT initial_evaluator FROM game_evaluations WHERE id = 41) = 'Shortcut', 'r1 auto-filled';
  ASSERT (SELECT initial_evaluator FROM game_evaluations WHERE id = 42) = 'HuyDD', 'r2 kept';
  ASSERT (SELECT owner || ':' || conclusion_before || '>' || conclusion_after FROM evaluation_log WHERE game_evaluation_id = 41)
         = 'HuyDD:Bypass>List_Idea', 'r1 log shows what was overridden';
  ASSERT (SELECT changed FROM evaluation_log WHERE game_evaluation_id = 42) = false, 'r2 logged, unchanged';
END $$;
DELETE FROM evaluation_log;
```

- [ ] **Step 4: Run**

Run: `rtk proxy npx jest __tests__/api/add-to-record-log.test.ts && scripts/verify-evaluation-log.sh && npm run typecheck`
Expected: PASS; `evaluation_log SQL checks: OK`.

- [ ] **Step 5: Commit**

```bash
git add app/api/evaluations/add-to-record/route.ts __tests__/api/add-to-record-log.test.ts scripts/sql-verify/checks.sql
git commit -m "feat(record): log add-to-record pulls as add_to_record, behaviour unchanged

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Assignment writes never move a judged game

**Files:**
- Modify: `lib/reassign-core.ts:70-101`
- Modify: `app/api/operations/reassign/route.ts:~121-160`
- Modify: `app/api/operations/handover/resolve/route.ts:~102-135`
- Modify: `app/api/operations/rescue/route.ts:~178-241`
- Modify: `app/api/cron/assign-evaluators/route.ts:~121-162`
- Modify: `__tests__/api/reassign.test.ts`, `__tests__/api/rescue.test.ts`, `__tests__/api/assign-evaluators.test.ts` (mocks + one drop-an-id test each). `__tests__/api/handover.test.ts` tests the *submit* route, which this task does not change; leave it (its failures, if any, are in the baseline)
- Create: `__tests__/lib/reassign-core-commit.test.ts`

**Interfaces:**
- Produces: `interface CommitResult { byEvaluator: Map<string, string[]>; movedIds: Set<number> }` and `commitAssignment(assignment: Map<number, string>, idToGameId: Map<number, string>): Promise<CommitResult>`.

- [ ] **Step 1: Write the failing test**

`__tests__/lib/reassign-core-commit.test.ts`:

```ts
/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
import { commitAssignment } from '@/lib/reassign-core'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

describe('commitAssignment', () => {
  it('only counts games the UPDATE actually moved (still unjudged)', async () => {
    const texts: string[] = []
    sqlMock.mockReset()
    sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
      if (!(Array.isArray(strings) && 'raw' in strings)) return { __ids: strings } // sql(ids): a plain array, no .raw
      texts.push((strings as string[]).join(' '))
      const ids = (binds.find(b => (b as { __ids?: number[] })?.__ids) as { __ids: number[] }).__ids
      return Promise.resolve(ids.filter(id => id !== 2).map(id => ({ id }))) // game 2 was judged meanwhile
    })
    const res = await commitAssignment(new Map([[1, 'A'], [2, 'A'], [3, 'B']]), new Map([[1, 'g1'], [2, 'g2'], [3, 'g3']]))
    expect(texts.every(t => /initial_conclusion IS NULL/.test(t) && /RETURNING id/.test(t))).toBe(true)
    expect(Array.from(res.movedIds).sort()).toEqual([1, 3])
    expect(res.byEvaluator.get('A')).toEqual(['g1'])
    expect(res.byEvaluator.get('B')).toEqual(['g3'])
  })
})
```

Run: `rtk proxy npx jest __tests__/lib/reassign-core-commit.test.ts`
Expected: FAIL (result is a Map, no `movedIds`).

- [ ] **Step 2: Implement `commitAssignment`**

Replace the body of `commitAssignment` in `lib/reassign-core.ts` (keep its doc comment, add the last paragraph shown):

```ts
// Persist an assignment (game_evaluations.id -> evaluator name), stamping
// assigned_date = today (VN). first_assigned_date is stamped only the first time
// a game is ever assigned (COALESCE) — reassign/handover restamp assigned_date but
// must not inflate team intake, which is counted on first_assigned_date
// (migration 033).
//
// Only games still unjudged move: a game judged between selection and this UPDATE
// (seconds — one round trip per evaluator) stays with whoever judged it. Callers
// must take history and counts from the result, not from `assignment`.
export interface CommitResult {
  byEvaluator: Map<string, string[]> // evaluator -> game_info.game_id values actually moved
  movedIds: Set<number>              // game_evaluations.id values actually moved
}

export async function commitAssignment(
  assignment: Map<number, string>,
  idToGameId: Map<number, string>,
): Promise<CommitResult> {
  const byEvaluatorIds = new Map<string, number[]>()
  assignment.forEach((name, id) => {
    const arr = byEvaluatorIds.get(name) || []
    arr.push(id)
    byEvaluatorIds.set(name, arr)
  })
  const byEvaluator = new Map<string, string[]>()
  const movedIds = new Set<number>()
  for (const [name, ids] of Array.from(byEvaluatorIds.entries())) {
    const rows = (await sql`
      UPDATE game_evaluations
      SET initial_evaluator = ${name},
          assigned_date = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
          first_assigned_date = COALESCE(first_assigned_date, (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date),
          updated_at = NOW()
      WHERE id IN ${sql(ids)} AND initial_conclusion IS NULL
      RETURNING id
    `) as unknown as { id: number }[]
    const moved = rows.map(r => r.id)
    moved.forEach(id => movedIds.add(id))
    if (moved.length) byEvaluator.set(name, moved.map(id => idToGameId.get(id)!).filter(Boolean))
  }
  return { byEvaluator, movedIds }
}
```

- [ ] **Step 3: Update the four callers**

Everything that reports what was committed must count moved games, not planned ones. Dry-run paths stay as they are.

`app/api/operations/reassign/route.ts` — replace

```ts
    const perEvaluatorGameIds = await commitAssignment(assignment, idToGameId)
```

with

```ts
    const { byEvaluator: perEvaluatorGameIds, movedIds } = await commitAssignment(assignment, idToGameId)
    const perEvaluatorMoved: Record<string, number> = Object.fromEntries(
      Array.from(perEvaluatorGameIds, ([name, ids]) => [name, ids.length]),
    )
```

In the committed `snapshot` (~`:136-144`) and the final response (~`:158-164`): `assigned: movedIds.size`, `unassignable: candidates.length - movedIds.size`, `per_evaluator: perEvaluatorMoved`; in `insertOperationRun({…})`: `gameCount: movedIds.size`.

`app/api/operations/handover/resolve/route.ts` — replace the `if (assignment.size > 0) { … }` block with:

```ts
    let moved = 0
    let perEvaluatorMoved: Record<string, number> = {}
    if (assignment.size > 0) {
      const idToGameId = new Map(candidates.map(c => [c.id, c.game_id]))
      const { byEvaluator, movedIds } = await commitAssignment(assignment, idToGameId)
      moved = movedIds.size
      perEvaluatorMoved = Object.fromEntries(Array.from(byEvaluator, ([name, ids]) => [name, ids.length]))
      await writeAssignmentHistory({
        category, action: 'handover', perEvaluator: byEvaluator,
        fromEvaluator: from, createdBy: reviewer,
      })
    }
```

and in `result`: `assigned: moved`, `unassignable: candidates.length - moved`, `per_evaluator: perEvaluatorMoved`; in the `UPDATE operation_runs`: `game_count = ${moved}`.

`app/api/operations/rescue/route.ts` — replace `await commitAssignment(assignment, idToGameId)` with `const { movedIds } = await commitAssignment(assignment, idToGameId)`. In the per-source loop, skip ids that did not move and count per source:

```ts
      s.sub.forEach((name, id) => {
        if (!movedIds.has(id)) return
        const arr = gameIdsByReceiver.get(name) || []
        arr.push(idToGameId.get(id)!)
        gameIdsByReceiver.set(name, arr)
      })
      if (gameIdsByReceiver.size === 0) continue
```

Replace `const moved = s.sub.size` (~`:210`) with

```ts
      const moved = Array.from(s.sub.keys()).filter(id => movedIds.has(id)).length
```

(it feeds `snapshot.assigned`, `unassignable: s.pulled - moved` and `gameCount: moved` — do **not** use `movedIds.size` inside the loop), and in that snapshot use `per_evaluator: Object.fromEntries(Array.from(gameIdsByReceiver, ([name, ids]) => [name, ids.length]))`. Only the final response (~`:241`) becomes `assigned: movedIds.size`.

`app/api/cron/assign-evaluators/route.ts`:
1. In the games SELECT, after `AND ge.initial_evaluator IS NULL` (~`:76`), add
   ```sql
           AND ge.initial_conclusion IS NULL   -- same predicate as commitAssignment's guard
   ```
2. Add `import { commitAssignment } from '@/lib/reassign-core'`.
3. Replace the `if (!body.dryRun) { … }` block **and** the following `const perEvaluator … assignment.forEach(…)` lines with:

```ts
    let moved = assignment.size
    let perEvaluator: Record<string, number> = {}
    assignment.forEach((name) => { perEvaluator[name] = (perEvaluator[name] || 0) + 1 })
    if (!body.dryRun) {
      const idToGameId = new Map<number, string>(games.map(g => [g.id, g.game_id]))
      const { byEvaluator, movedIds } = await commitAssignment(assignment, idToGameId)
      moved = movedIds.size
      perEvaluator = Object.fromEntries(Array.from(byEvaluator, ([name, ids]) => [name, ids.length]))
      // Daily trace: one assignment_history row per evaluator (action = 'assign').
      await writeAssignmentHistory({ category, action: 'assign', perEvaluator: byEvaluator, createdBy: 'cron' })
    }
```

4. In the response: `assigned: moved, unassigned: games.length - moved, per_evaluator: perEvaluator`. (`commitAssignment` also sets `updated_at`, which the cron's own UPDATE did not; harmless.)

- [ ] **Step 4: Fix the route-test mocks and add one drop-an-id test per caller**

A TemplateStringsArray has `.raw`; `sql(ids)` passes a plain `number[]`. The old `!Array.isArray(strings)` check never matched `sql(ids)`. The UPDATE now contains `initial_conclusion IS NULL` too, so route it **before** the candidate match.

`__tests__/api/reassign.test.ts`:
- Replace `jest.mock('@/lib/db', () => ({ sql: jest.fn() }))` with the json-capable mock (`insertOperationRun` binds JSONB via `sql.json`):
  ```ts
  jest.mock('@/lib/db', () => {
    const fn = jest.fn() as jest.Mock & { json: jest.Mock }
    fn.json = jest.fn((v: unknown) => v)
    return { sql: fn }
  })
  ```
- Replace `setupSql` with:
  ```ts
  function setupSql({ candidates = [] as Record<string, unknown>[], roster = [] as Record<string, unknown>[], drop = [] as number[] }) {
    sqlMock.mockReset()
    sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
      if (!(Array.isArray(strings) && 'raw' in strings)) return { __ids: strings } // sql(ids)
      const q = (strings as string[]).join(' ')
      if (q.includes('UPDATE game_evaluations')) {
        const ids = (binds.find(b => (b as { __ids?: number[] })?.__ids) as { __ids: number[] } | undefined)?.__ids ?? []
        return Promise.resolve(ids.filter(id => !drop.includes(id)).map(id => ({ id })))
      }
      if (q.includes('initial_conclusion IS NULL')) return Promise.resolve(candidates)
      if (q.includes('FROM evaluator_roster')) return Promise.resolve(roster)
      return Promise.resolve([]) // INSERT / fragments
    })
  }
  ```
- Add:
  ```ts
  it('counts only games the UPDATE moved (one was judged meanwhile)', async () => {
    setupSql({
      candidates: [{ id: 1, game_id: 'g1', os: 'ios' }, { id: 2, game_id: 'g2', os: 'android' }],
      roster: [{ name: 'A', game_platform: 'all', weight: 100 }, { name: 'B', game_platform: 'all', weight: 100 }],
      drop: [2],
    })
    const json = await (await post({ evaluator_name: 'Nam', category: 'puzzle', count: 5, selected_evaluators: ['A', 'B'] })).json()
    expect(json.assigned).toBe(1)
    expect(Object.values(json.per_evaluator as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(1)
  })
  ```

`__tests__/api/rescue.test.ts`:
- Add `drop?: number[]` to `setupSql`'s `opts` type, and make the mock's first lines:
  ```ts
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!(Array.isArray(strings) && 'raw' in strings)) return { __ids: strings } // sql(ids)
    const q = (strings as string[]).join(' ')
    if (q.includes('UPDATE game_evaluations')) {
      const ids = (binds.find(b => (b as { __ids?: number[] })?.__ids) as { __ids: number[] } | undefined)?.__ids ?? []
      return Promise.resolve(ids.filter(id => !(opts.drop ?? []).includes(id)).map(id => ({ id })))
    }
    // ... existing branches unchanged ...
  ```
- Add:
  ```ts
  it('commit counts only games the UPDATE moved', async () => {
    setupSql({ scan: ROSTER, stale: { Hung: HUNG_GAMES }, drop: [2] })
    const json = await (await post({ action: 'commit', category: 'puzzle', sources: ['Hung'], receivers: ['Minh'] })).json()
    expect(json.assigned).toBe(1)
    const histBinds = sqlMock.mock.calls
      .filter(c => Array.isArray(c[0]) && (c[0] as string[]).join(' ').includes('INSERT INTO assignment_history'))
      .flatMap(c => c.slice(1))
    expect(JSON.stringify(histBinds)).toContain('g1')
    expect(JSON.stringify(histBinds)).not.toContain('g2')
  })
  ```

`__tests__/api/assign-evaluators.test.ts`:
- Add `drop = [] as number[]` to `setupSql`'s parameters, change the mock to `(strings: unknown, ...binds: unknown[]) =>`, and make its first lines:
  ```ts
    if (!(Array.isArray(strings) && 'raw' in strings)) return { __ids: strings } // sql(ids)
    const q = (strings as string[]).join(' ')
    if (q.includes('UPDATE game_evaluations')) {
      const ids = (binds.find(b => (b as { __ids?: number[] })?.__ids) as { __ids: number[] } | undefined)?.__ids ?? []
      return Promise.resolve(ids.filter(id => !drop.includes(id)).map(id => ({ id })))
    }
  ```
- Add:
  ```ts
  it('reports only games the UPDATE moved', async () => {
    setupSql({
      roster: [{ name: 'A', game_platform: 'all', weight: 100 }],
      games: [{ id: 1, game_id: 'g1', os: 'ios' }, { id: 2, game_id: 'g2', os: 'ios' }],
      drop: [2],
    })
    const json = await (await post({ category: 'puzzle' })).json()
    expect(json.assigned).toBe(1)
    expect(json.per_evaluator).toEqual({ A: 1 })
  })
  ```

Wherever an existing assertion reads ids out of the UPDATE's binds, they now arrive as `{ __ids: [...] }`; read `.__ids`.

- [ ] **Step 5: Run**

Run: `rtk proxy npx jest __tests__/lib/reassign-core-commit.test.ts __tests__/api/reassign.test.ts __tests__/api/rescue.test.ts __tests__/api/assign-evaluators.test.ts && npm run typecheck`
Expected: PASS, except failures already listed in the Task 0 baseline; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/reassign-core.ts app/api/operations app/api/cron/assign-evaluators/route.ts __tests__/lib/reassign-core-commit.test.ts __tests__/api/reassign.test.ts __tests__/api/rescue.test.ts __tests__/api/assign-evaluators.test.ts
git commit -m "fix(assign): never move a game that was judged after it was selected

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `lib/view-timer.ts` — pure view timer

**Files:**
- Create: `lib/view-timer.ts`
- Test: `__tests__/lib/view-timer.test.ts`

**Interfaces:**
- Produces:
  - `IDLE_GAP_MS = 120_000`
  - `interface ViewTimer { gameId: string; startedAt: number; hiddenMs: number; hiddenSince: number | null; idleMs: number; lastInputAt: number }`
  - `interface ViewSnapshot { gameId: string; at: number; view_s: number; hidden_s: number; idle_s: number }`
  - `startView(gameId: string, at: number, hidden: boolean): ViewTimer`
  - `onVisibility(t: ViewTimer, hidden: boolean, at: number): ViewTimer`
  - `onInput(t: ViewTimer, at: number): ViewTimer`
  - `snapshot(t: ViewTimer, gameId: string, at: number): ViewSnapshot | null`
  - `restartAfterSave(t: ViewTimer, snap: ViewSnapshot, hidden: boolean): ViewTimer`

- [ ] **Step 1: Write the failing tests**

`__tests__/lib/view-timer.test.ts`:

```ts
import { startView, onVisibility, onInput, snapshot, restartAfterSave, IDLE_GAP_MS } from '@/lib/view-timer'

const S = 1000
describe('view timer', () => {
  it('measures seconds since the game was shown', () => {
    const t = startView('A', 0, false)
    expect(snapshot(t, 'A', 42 * S)).toEqual({ gameId: 'A', at: 42 * S, view_s: 42, hidden_s: 0, idle_s: 0 })
  })

  it('returns null for a game other than the one being timed (stale ev)', () => {
    expect(snapshot(startView('B', 0, false), 'A', 10 * S)).toBeNull()
  })

  it('adds hidden stretches, including one still open at the snapshot', () => {
    let t = startView('A', 0, false)
    t = onVisibility(t, true, 10 * S)
    t = onVisibility(t, false, 30 * S)
    t = onVisibility(t, true, 50 * S)
    expect(snapshot(t, 'A', 60 * S)!.hidden_s).toBe(30)
  })

  it('counts only input gaps longer than 2 minutes as idle, measured from the start', () => {
    let t = startView('A', 0, false)
    t = onInput(t, 60 * S)                       // 60 s gap: not idle
    t = onInput(t, 60 * S + IDLE_GAP_MS + S)     // 121 s gap: idle
    expect(snapshot(t, 'A', 200 * S)!.idle_s).toBe(121)
  })

  it('counts a trailing quiet stretch at save time as idle', () => {
    expect(snapshot(startView('A', 0, false), 'A', 300 * S)!.idle_s).toBe(300)
  })

  it('never reports hidden or idle above view', () => {
    let t = startView('A', 0, true)                // hidden from the start
    const s = snapshot(t, 'A', 500 * S)!
    expect(s.hidden_s).toBeLessThanOrEqual(s.view_s)
    expect(s.idle_s).toBeLessThanOrEqual(s.view_s)
  })

  it('restarts at the snapshot time after a successful save of the same game', () => {
    const t = startView('A', 0, false)
    const snap = snapshot(t, 'A', 40 * S)!
    const r = restartAfterSave(t, snap, false)
    expect(snapshot(r, 'A', 70 * S)!.view_s).toBe(30) // contiguous with the first save
  })

  it('does not touch the timer when the user already moved to another game', () => {
    const t = startView('A', 0, false)
    const snap = snapshot(t, 'A', 40 * S)!
    const moved = startView('B', 41 * S, false)
    expect(restartAfterSave(moved, snap, false)).toBe(moved)
  })

  it('does not rewind a timer that restarted after the snapshot (A -> B -> A)', () => {
    const snap = snapshot(startView('A', 0, false), 'A', 40 * S)!
    const back = startView('A', 50 * S, false)
    expect(restartAfterSave(back, snap, false)).toBe(back)
  })
})
```

Run: `rtk proxy npx jest __tests__/lib/view-timer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement**

`lib/view-timer.ts`:

```ts
// lib/view-timer.ts — how long a game has been on screen in the Eval panel, for
// evaluation_log.view_s (spec: docs/superpowers/specs/2026-10-10-evaluation-time-log-design.md).
//
// Pure and immutable so it can be tested without a DOM. All durations come from
// timestamp differences, never from interval counting, so background-tab timer
// throttling does not matter. Hidden and idle are recorded, not subtracted: play on
// a phone leaves the panel idle, and input inside an iframe (YouTube demo) never
// reaches the document.

export const IDLE_GAP_MS = 120_000

export interface ViewTimer {
  gameId: string
  startedAt: number
  hiddenMs: number
  hiddenSince: number | null
  idleMs: number
  lastInputAt: number
}

export interface ViewSnapshot { gameId: string; at: number; view_s: number; hidden_s: number; idle_s: number }

export function startView(gameId: string, at: number, hidden: boolean): ViewTimer {
  return { gameId, startedAt: at, hiddenMs: 0, hiddenSince: hidden ? at : null, idleMs: 0, lastInputAt: at }
}

export function onVisibility(t: ViewTimer, hidden: boolean, at: number): ViewTimer {
  if (hidden) return t.hiddenSince === null ? { ...t, hiddenSince: at } : t
  if (t.hiddenSince === null) return t
  return { ...t, hiddenMs: t.hiddenMs + Math.max(0, at - Math.max(t.hiddenSince, t.startedAt)), hiddenSince: null }
}

export function onInput(t: ViewTimer, at: number): ViewTimer {
  const gap = at - Math.max(t.lastInputAt, t.startedAt)
  return { ...t, idleMs: gap > IDLE_GAP_MS ? t.idleMs + gap : t.idleMs, lastInputAt: at }
}

/** Null when the timer belongs to another game (the panel still shows a stale `ev`). */
export function snapshot(t: ViewTimer, gameId: string, at: number): ViewSnapshot | null {
  if (t.gameId !== gameId) return null
  const viewMs = Math.max(0, at - t.startedAt)
  const openHidden = t.hiddenSince === null ? 0 : Math.max(0, at - Math.max(t.hiddenSince, t.startedAt))
  const trailing = at - Math.max(t.lastInputAt, t.startedAt)
  const idleMs = t.idleMs + (trailing > IDLE_GAP_MS ? trailing : 0)
  const sec = (ms: number) => Math.round(Math.min(ms, viewMs) / 1000)
  return { gameId, at, view_s: Math.round(viewMs / 1000), hidden_s: sec(t.hiddenMs + openHidden), idle_s: sec(idleMs) }
}

/** After a successful save: start the next interval where the saved one ended, same game only. */
export function restartAfterSave(t: ViewTimer, snap: ViewSnapshot, hidden: boolean): ViewTimer {
  // Same game AND same interval; a timer restarted after the snapshot (A -> B -> A) is newer, keep it.
  return t.gameId === snap.gameId && t.startedAt <= snap.at ? startView(snap.gameId, snap.at, hidden) : t
}
```

- [ ] **Step 3: Run**

Run: `rtk proxy npx jest __tests__/lib/view-timer.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 4: Commit**

```bash
git add lib/view-timer.ts __tests__/lib/view-timer.test.ts
git commit -m "feat(eval-panel): a pure timer for how long a game is on screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Panel sends its timing

**Files:**
- Modify: `components/EvalDetailPanel.tsx` (Props ~`:469-487`, component signature `:509`, state ~`:511`, `save()` ~`:904-990`, reset-record flow ~`:995-1007`, comment ~`:1010`)
- Modify: `app/(manager)/evaluations/page.tsx:908` and `:1542`, `app/(manager)/evaluations/[gameId]/page.tsx:30`, `app/(manager)/youtube/page.tsx:1897`, `components/TaggingTab.tsx:172`
- Create: `__tests__/components/eval-panel-timing.test.ts`

**Interfaces:**
- Consumes: `startView`, `onVisibility`, `onInput`, `snapshot`, `restartAfterSave`, `ViewTimer` (Task 6); `LogContext` (Task 2).
- Produces: `EvalDetailPanel` prop `logContext: LogContext` (required). PATCH body gains `view_s`, `hidden_s`, `idle_s`, `context` when the snapshot is non-null.

- [ ] **Step 1: Write the failing source test**

The panel is ~2,000 lines of hooks; like `eval-panel-category.test.tsx`, check the wiring as text (behaviour is covered by Task 6).

`__tests__/components/eval-panel-timing.test.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

describe('Eval panel timing wiring', () => {
  const src = read('components/EvalDetailPanel.tsx')
  const save = src.slice(src.indexOf('const save = async () => {'), src.indexOf('// Auto-save:'))

  it('snapshots the timer before the first await in save()', () => {
    const snap = save.indexOf('snapshot(viewRef.current')
    expect(snap).toBeGreaterThan(-1)
    expect(snap).toBeLessThan(save.indexOf('await '))
  })

  it('sends the timing fields with the PATCH', () => {
    expect(save).toMatch(/view_s: snap\.view_s/)
    expect(save).toMatch(/context: logContext/)
  })

  it('restarts the timer only on a successful save', () => {
    expect(save.indexOf('restartAfterSave(')).toBeGreaterThan(save.indexOf('if (!res.ok)'))
  })

  it('does not paint a refetched game the user has left', () => {
    expect(save).toMatch(/currentGameIdRef\.current === ev\.game_id/)
    expect(save).toMatch(/shownGameRef\.current === ev\.game_id/)
    expect(src).toMatch(/shownGameRef\.current = data\.game_id/)
  })

  it('starts the timer on every game change', () => {
    expect(src).toMatch(/viewRef\.current = startView\(currentGameId/)
  })

  it.each([
    ['app/(manager)/evaluations/page.tsx', ['shortlist', 'evaluate']],
    ['app/(manager)/evaluations/[gameId]/page.tsx', ['evaluate']],
    ['app/(manager)/youtube/page.tsx', ['record']],
    ['components/TaggingTab.tsx', ['tagging']],
  ])('%s passes the right logContext to each panel', (file, expected) => {
    const mounts = read(file).split('<EvalDetailPanel').slice(1).map(s => s.slice(0, s.indexOf('/>')))
    expect(mounts.map(m => (m.match(/logContext="(\w+)"/) || [])[1])).toEqual(expected)
  })
})
```

Run: `rtk proxy npx jest __tests__/components/eval-panel-timing.test.ts`
Expected: FAIL.

- [ ] **Step 2: Wire the panel**

In `components/EvalDetailPanel.tsx`:

(a) Imports:

```ts
import { startView, onVisibility, onInput, snapshot, restartAfterSave, type ViewTimer } from '@/lib/view-timer'
import type { LogContext } from '@/lib/evaluation-log'
```

(b) In `interface Props`, add:

```ts
  /** Which screen hosts the panel; stored on each evaluation_log row so panel time can
   *  be split by screen. Required so a new mount cannot forget it. */
  logContext: LogContext
```

and add `logContext` to the destructured props in `export default function EvalDetailPanel({ … })`.

(c) Right after `const [currentGameId, setCurrentGameId] = useState(initialGameId)`:

```ts
  // How long the current game has been on screen (evaluation_log.view_s). A ref, not
  // state: it changes on every input and must never re-render the panel.
  const viewRef = useRef<ViewTimer>(startView(initialGameId, Date.now(), false))
  const currentGameIdRef = useRef(currentGameId)
  currentGameIdRef.current = currentGameId
  // The game whose data the form currently shows (set in applyData). Differs from
  // currentGameId while the next game is still loading.
  const shownGameRef = useRef<string | null>(null)
  useEffect(() => {
    viewRef.current = startView(currentGameId, Date.now(), document.hidden)
  }, [currentGameId])
  useEffect(() => {
    const onVis = () => { viewRef.current = onVisibility(viewRef.current, document.hidden, Date.now()) }
    const onAny = () => { viewRef.current = onInput(viewRef.current, Date.now()) }
    let lastMove = 0
    const onMove = () => { const n = Date.now(); if (n - lastMove < 1000) return; lastMove = n; onAny() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pointerdown', onAny)
    window.addEventListener('keydown', onAny)
    window.addEventListener('wheel', onAny, { passive: true })
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pointerdown', onAny)
      window.removeEventListener('keydown', onAny)
      window.removeEventListener('wheel', onAny)
      window.removeEventListener('pointermove', onMove)
    }
  }, [])
```

(d) In `save()`, directly after `if (!ev || !canEdit) return`:

```ts
    // Taken now, before any await: Prev/Next stay enabled while the screenshot flush
    // and tag PUT run, so by PATCH time the timer may belong to the next game.
    const snap = snapshot(viewRef.current, ev.game_id, Date.now())
```

(e) Just before `const res = await fetch('/api/evaluations', {` in `save()`:

```ts
      if (snap) Object.assign(body, { view_s: snap.view_s, hidden_s: snap.hidden_s, idle_s: snap.idle_s, context: logContext })
```

(f) Replace the success branch's refetch block in `save()`:

```ts
        const fresh = await fetchEvalByGameId(ev.game_id, category)
        if (fresh) {
          cacheRef.current.set(ev.game_id, fresh)
          applyData(fresh)
          onSaved?.(fresh)
        }
```

with:

```ts
        if (snap) viewRef.current = restartAfterSave(viewRef.current, snap, document.hidden)
        const fresh = await fetchEvalByGameId(ev.game_id, category)
        if (fresh) {
          cacheRef.current.set(ev.game_id, fresh)
          // The user may have pressed Next while this save was in flight; painting the
          // saved game now would put its data under the new game's id.
          if (currentGameIdRef.current === ev.game_id) applyData(fresh)
          // Old game still on screen and already saved: clear dirty so auto-save does not fire again.
          else if (shownGameRef.current === ev.game_id) setDirty(false)
          onSaved?.(fresh)
        }
```

(f2) In `applyData` (`const applyData = useCallback((data: EvalDetail) => {`, ~`:612`), add as its first line:

```ts
    shownGameRef.current = data.game_id
```

(g) In the reset-record flow (~`:1001-1006`), wrap its `applyData(fresh)` the same way:

```ts
        if (currentGameIdRef.current === ev.game_id) applyData(fresh)
```

(h) Fix the stale comment above `const saveRef = useRef(save)`: change `~800ms` to `~1.5s`.

- [ ] **Step 3: Pass `logContext` at the five mounts**

- `app/(manager)/evaluations/page.tsx:908` (Short List panel, has `showFinalConclusion`): add `logContext="shortlist"`.
- `app/(manager)/evaluations/page.tsx:1542` (Evaluate panel): add `logContext="evaluate"`.
- `app/(manager)/evaluations/[gameId]/page.tsx:30`: add `logContext="evaluate"`.
- `app/(manager)/youtube/page.tsx:1897`: add `logContext="record"`.
- `components/TaggingTab.tsx:172`: add `logContext="tagging"`.

- [ ] **Step 4: Run tests and typecheck**

Run: `rtk proxy npx jest __tests__/components/eval-panel-timing.test.ts __tests__/components/eval-panel-category.test.tsx && npm run typecheck`
Expected: PASS; typecheck exit 0 (a missing `logContext` on any mount fails typecheck — that is the point of making it required).

- [ ] **Step 5: Commit**

```bash
git add components/EvalDetailPanel.tsx "app/(manager)/evaluations/page.tsx" "app/(manager)/evaluations/[gameId]/page.tsx" "app/(manager)/youtube/page.tsx" components/TaggingTab.tsx __tests__/components/eval-panel-timing.test.ts
git commit -m "feat(eval-panel): send how long the game was on screen with each save

Also stops a slow save from painting the old game over the next one.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Panel time query + admin endpoint

**Files:**
- Create: `lib/evaluation-hours.ts`
- Create: `app/api/admin/evaluation-hours/route.ts`
- Create: `__tests__/api/evaluation-hours.test.ts`
- Modify: `scripts/sql-verify/checks.sql` (append time-query section)

**Interfaces:**
- Consumes: table from Task 1.
- Produces:
  - `PANEL_CAP_S = 1800`, `DEFAULT_TITLES = ['Fulltime', 'Freelancer']`
  - `interface PanelTimeRow { who: string; day: string; hours: number; capped_saves: number; idle_s: number; hidden_s: number }`
  - `interface GamesRow { who: string; day: string; games: number }`
  - `loadPanelTime(opts: { from: string; to: string; titles?: string[] }): Promise<{ time: PanelTimeRow[]; games: GamesRow[] }>` — `from`/`to` are inclusive VN dates `YYYY-MM-DD`
  - `GET /api/admin/evaluation-hours?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ from, to, cap_s, titles, time, games }`, admin only, max 92 days.

- [ ] **Step 1: Append the time-query checks (the SQL is copied verbatim into the lib in Step 3)**

Append to `scripts/sql-verify/checks.sql`:

```sql
-- ===== Task 8: panel time query (keep identical to lib/evaluation-hours.ts) =====
INSERT INTO game_info SELECT 'h'||i FROM generate_series(1,20) i;
INSERT INTO game_evaluations (id, game_id) SELECT 100+i, 'h'||i FROM generate_series(1,20) i;
INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, source, context, kind, view_s, idle_s, hidden_s, created_at) VALUES
 (101,'h1','Carol','panel','evaluate','first', 600,0,0,'2026-10-05 09:10+07'),
 (102,'h2','Carol','panel','evaluate','first', 600,0,0,'2026-10-05 09:15+07'),
 (103,'h3','Carol','panel','evaluate','first',1800,0,0,'2026-10-05 09:50+07'),
 (104,'h4','Carol','panel','evaluate','first', 300,0,0,'2026-10-05 09:30+07'),
 (105,'h5','Carol','panel','evaluate','first', 900,0,0,'2026-10-05 10:00+07'),
 (106,'h6','Carol','panel','evaluate','first', 300,0,0,'2026-10-05 10:30:00+07'),
 (106,'h6','Carol','panel','evaluate','revise',302,0,0,'2026-10-05 10:30:02+07'),
 (107,'h7','Carol','panel','evaluate','first',4800,4000,0,'2026-10-05 12:00+07'),
 (108,'h8','Carol','panel','evaluate','first', 300,0,0,'2026-10-05 13:05:00+07'),
 (108,'h8','Carol','panel','evaluate','revise',  2,0,0,'2026-10-05 13:05:02+07'),
 (108,'h8','Carol','panel','evaluate','revise',  3,0,0,'2026-10-05 13:05:05+07'),
 (113,'h13','Carol','panel','record','other',3000,0,0,'2026-10-05 16:00+07'),
 (114,'h14','Carol','panel','evaluate','final',600,0,0,'2026-10-05 17:00+07'),
 (115,'h15','Carol','other','evaluate','first',600,0,0,'2026-10-05 18:00+07'),
 (109,'h9','Carol','panel','evaluate','first', 600,0,0,'2026-10-05 23:55+07'),
 (110,'h10','Carol','panel','evaluate','first',1200,0,0,'2026-10-06 00:10+07'),
 (111,'h11','Shortcut','panel','evaluate','first',600,0,0,'2026-10-05 09:10+07'),
 (112,'h12','VinhTD','panel','evaluate','first',600,0,0,'2026-10-05 09:10+07'),
 (116,'h16',NULL,'panel','evaluate','first',600,0,0,'2026-10-05 09:10+07'),
 (117,'h17','Dave','panel','evaluate','first',600,0,0,'2026-10-05 09:10+07'),
 (118,'h18','Dave','panel','evaluate','first',NULL,0,0,'2026-10-05 11:10+07'),
 (119,'h19','HungDT','panel','evaluate','revise',600,0,0,'2026-10-05 09:10+07');

PREPARE panel_time(unknown, unknown, text[]) AS
WITH iv AS (
  SELECT lower(l.actor) AS who,
         l.created_at - make_interval(secs => LEAST(l.view_s, 1800)) AS s,
         l.created_at AS e,
         l.view_s > 1800 AS capped,
         l.idle_s, l.hidden_s
  FROM evaluation_log l
  JOIN dashboard_users du ON lower(du.name) = lower(l.actor)
  WHERE l.source = 'panel'
    AND l.view_s IS NOT NULL
    AND du.title = ANY($3)
    AND l.created_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
    AND l.created_at <  ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
), ord AS (
  SELECT *, MAX(e) OVER (PARTITION BY who ORDER BY s, e
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_e
  FROM iv
), grp AS (
  SELECT *, SUM(CASE WHEN prev_e IS NULL OR s > prev_e THEN 1 ELSE 0 END)
              OVER (PARTITION BY who ORDER BY s, e) AS g
  FROM ord
), blocks AS (
  SELECT who, g, MIN(s) AS block_start, MAX(e) AS block_end,
         COUNT(*) FILTER (WHERE capped) AS n_capped,
         SUM(idle_s) AS idle_s, SUM(hidden_s) AS hidden_s
  FROM grp GROUP BY who, g
)
SELECT who, to_char((block_end AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS day,
       round(SUM(EXTRACT(EPOCH FROM (block_end - block_start))) / 3600.0, 4)::float8 AS hours,
       SUM(n_capped)::int AS capped_saves,
       COALESCE(SUM(idle_s), 0)::int AS idle_s, COALESCE(SUM(hidden_s), 0)::int AS hidden_s
FROM blocks
GROUP BY 1, 2
ORDER BY 1, 2;

```

Then load the result and assert (`CREATE TABLE … AS EXECUTE` runs a prepared statement into a table):

```sql
CREATE TEMP TABLE got AS EXECUTE panel_time('2026-10-01', '2026-10-09', ARRAY['Fulltime','Freelancer']);
DO $$ BEGIN
  -- 15 + 40 + 5.033 + 30 (capped) + 5.083 + 30 (record, capped) + 10 (final) = 135.117 min
  -- hours is rounded to 4 decimals, so compare minutes with a small tolerance
  ASSERT (SELECT abs(hours * 60 - 135.1167) < 0.01 FROM got WHERE who = 'carol' AND day = '2026-10-05'), 'carol 10-05';
  ASSERT (SELECT capped_saves FROM got WHERE who = 'carol' AND day = '2026-10-05') = 2, 'carol capped';
  ASSERT (SELECT idle_s FROM got WHERE who = 'carol' AND day = '2026-10-05') = 4000, 'carol idle';
  -- 23:45-23:55 and 23:50-00:10 merge into one 25-min block, credited to 10-06
  ASSERT (SELECT abs(hours * 60 - 25) < 0.01 FROM got WHERE who = 'carol' AND day = '2026-10-06'), 'midnight merge';
  -- NULL view_s is excluded (not a silent 30 min)
  ASSERT (SELECT abs(hours * 60 - 10) < 0.01 FROM got WHERE who = 'dave'), 'dave 10 (NULL view_s excluded)';
  -- admins, moderators, system accounts and NULL actors never appear
  ASSERT NOT EXISTS (SELECT 1 FROM got WHERE who IN ('hungdt', 'vinhtd', 'shortcut') OR who IS NULL), 'only titled people';
END $$;
```


Run: `scripts/verify-evaluation-log.sh`
Expected: `evaluation_log SQL checks: OK`.

- [ ] **Step 2: Write the failing route test**

`__tests__/api/evaluation-hours.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/auth-guard', () => ({ requireAdmin: jest.fn(async () => null) }))

import { GET } from '@/app/api/admin/evaluation-hours/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock
let calls: { text: string; binds: unknown[] }[] = []
beforeEach(() => {
  calls = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    calls.push({ text: (strings as string[]).join('$'), binds })
    return Promise.resolve([])
  })
})
const get = (q: string) => GET(new NextRequest(`http://localhost/api/admin/evaluation-hours?${q}`))

describe('GET /api/admin/evaluation-hours', () => {
  it('rejects bad or missing dates', async () => {
    expect((await get('from=2026-10-01')).status).toBe(400)
    expect((await get('from=2026-10-01&to=10/09/2026')).status).toBe(400)
    expect((await get('from=2026-10-09&to=2026-10-01')).status).toBe(400)
  })
  it('rejects ranges over 92 days', async () => {
    expect((await get('from=2026-01-01&to=2026-10-01')).status).toBe(400)
  })
  it('binds the VN dates and the default titles, and excludes NULL view_s', async () => {
    const res = await get('from=2026-10-01&to=2026-10-09')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ from: '2026-10-01', to: '2026-10-09', cap_s: 1800, titles: ['Fulltime', 'Freelancer'] })
    const timeQ = calls.find(c => /make_interval/.test(c.text))!
    expect(timeQ.text).toMatch(/view_s IS NOT NULL/)
    expect(timeQ.binds).toEqual(expect.arrayContaining(['2026-10-01', '2026-10-09', ['Fulltime', 'Freelancer']]))
  })
})
```

Run: `rtk proxy npx jest __tests__/api/evaluation-hours.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the lib**

`lib/evaluation-hours.ts`:

```ts
// lib/evaluation-hours.ts — panel time per person per VN day, from evaluation_log.
// "Panel time" = the time a game was on screen before each successful save. It is not
// total working time (see the spec). The SQL is mirrored in scripts/sql-verify/checks.sql;
// change both together and run scripts/verify-evaluation-log.sh.
import { sql } from '@/lib/db'

export const PANEL_CAP_S = 1800
export const DEFAULT_TITLES = ['Fulltime', 'Freelancer']

export interface PanelTimeRow { who: string; day: string; hours: number; capped_saves: number; idle_s: number; hidden_s: number }
export interface GamesRow { who: string; day: string; games: number }

export async function loadPanelTime(opts: { from: string; to: string; titles?: string[] }): Promise<{ time: PanelTimeRow[]; games: GamesRow[] }> {
  const titles = opts.titles?.length ? opts.titles : DEFAULT_TITLES
  const [time, games] = await Promise.all([
    sql<PanelTimeRow[]>`
      WITH iv AS (
        SELECT lower(l.actor) AS who,
               l.created_at - make_interval(secs => LEAST(l.view_s, ${PANEL_CAP_S}::int)) AS s,
               l.created_at AS e,
               l.view_s > ${PANEL_CAP_S}::int AS capped,
               l.idle_s, l.hidden_s
        FROM evaluation_log l
        JOIN dashboard_users du ON lower(du.name) = lower(l.actor)
        WHERE l.source = 'panel'
          AND l.view_s IS NOT NULL
          AND du.title = ANY(${titles}::text[])
          AND l.created_at >= (${opts.from}::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
          AND l.created_at <  (${opts.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
      ), ord AS (
        SELECT *, MAX(e) OVER (PARTITION BY who ORDER BY s, e
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_e
        FROM iv
      ), grp AS (
        SELECT *, SUM(CASE WHEN prev_e IS NULL OR s > prev_e THEN 1 ELSE 0 END)
                    OVER (PARTITION BY who ORDER BY s, e) AS g
        FROM ord
      ), blocks AS (
        SELECT who, g, MIN(s) AS block_start, MAX(e) AS block_end,
               COUNT(*) FILTER (WHERE capped) AS n_capped,
               SUM(idle_s) AS idle_s, SUM(hidden_s) AS hidden_s
        FROM grp GROUP BY who, g
      )
      SELECT who, to_char((block_end AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS day,
             round(SUM(EXTRACT(EPOCH FROM (block_end - block_start))) / 3600.0, 4)::float8 AS hours,
             SUM(n_capped)::int AS capped_saves,
             COALESCE(SUM(idle_s), 0)::int AS idle_s, COALESCE(SUM(hidden_s), 0)::int AS hidden_s
      FROM blocks
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
    sql<GamesRow[]>`
      SELECT lower(l.actor) AS who,
             to_char((l.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS day,
             count(DISTINCT l.game_evaluation_id)::int AS games
      FROM evaluation_log l
      JOIN dashboard_users du ON lower(du.name) = lower(l.actor)
      WHERE l.kind = 'first'
        AND du.title = ANY(${titles}::text[])
        AND l.created_at >= (${opts.from}::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
        AND l.created_at <  (${opts.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
  ])
  return { time, games }
}
```

The harness's `PREPARE panel_time` uses literal `1800` where the lib binds `${PANEL_CAP_S}::int`; everything else must match character for character.

- [ ] **Step 4: Implement the route**

`app/api/admin/evaluation-hours/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { loadPanelTime, PANEL_CAP_S, DEFAULT_TITLES } from '@/lib/evaluation-hours'

export const dynamic = 'force-dynamic'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 92

// Panel time per person per VN day (evaluation_log). Admin only: it is per-person time.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin()
  if (guard) return guard
  const from = req.nextUrl.searchParams.get('from') ?? ''
  const to = req.nextUrl.searchParams.get('to') ?? ''
  if (!DATE.test(from) || !DATE.test(to)) {
    return NextResponse.json({ error: 'from and to must be YYYY-MM-DD' }, { status: 400 })
  }
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000
  if (!(days >= 0)) return NextResponse.json({ error: 'to must not be before from' }, { status: 400 })
  if (days > MAX_DAYS) return NextResponse.json({ error: `range over ${MAX_DAYS} days` }, { status: 400 })
  try {
    const { time, games } = await loadPanelTime({ from, to })
    return NextResponse.json({ from, to, cap_s: PANEL_CAP_S, titles: DEFAULT_TITLES, time, games })
  } catch (err) {
    console.error('GET /api/admin/evaluation-hours error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
```

- [ ] **Step 5: Run**

Run: `rtk proxy npx jest __tests__/api/evaluation-hours.test.ts && scripts/verify-evaluation-log.sh`
Expected: PASS; `evaluation_log SQL checks: OK`.

- [ ] **Step 6: Commit**

```bash
git add lib/evaluation-hours.ts app/api/admin/evaluation-hours/route.ts __tests__/api/evaluation-hours.test.ts scripts/sql-verify/checks.sql
git commit -m "feat(report): panel time per person per day, from the evaluation log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Stale comments

**Files:**
- Modify: `app/api/external/effort-sessions/route.ts:26`
- Modify: `lib/report-batches.ts:4-5`

- [ ] **Step 1: Update the comments**

`app/api/external/effort-sessions/route.ts:26-27`: replace the whole `sessions:` bullet

```ts
// - sessions: evaluate_date, the last time the initial conclusion CHANGED. It is
//   not moved by a final conclusion, nor by re-saving an unchanged verdict.
```

with:

```ts
// - sessions: evaluate_date, the last time the initial conclusion CHANGED. Not moved by
//   a final conclusion or an unchanged re-save. Since migration 046 a non-owner change of
//   a judged verdict in the panel no longer moves it, except a List_Idea batch stamp;
//   add-to-record still moves it as before. Measured panel time lives in evaluation_log
//   (/api/admin/evaluation-hours).
```

`lib/report-batches.ts:4-5`: the text spans two lines. Replace

```
range in the schema: `game_evaluations.batch` is a label, written in exactly one place
   (`/api/evaluations/add-to-record`) and therefore carried by only ~5% of rows, almost
```

with

```
range in the schema: `game_evaluations.batch` is a label, written by add-to-record and by
   a manager's List_Idea promotion in the PATCH handler, and therefore carried by only ~5% of rows, almost
```

- [ ] **Step 2: Commit**

```bash
git add app/api/external/effort-sessions/route.ts lib/report-batches.ts
git commit -m "docs(evaluations): say who moves evaluate_date now

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full test run**

Run: `rtk proxy npx jest > "$SCRATCH/final-jest.txt" 2>&1; diff <(grep '^FAIL' "$SCRATCH/baseline-jest.txt" | sort) <(grep '^FAIL' "$SCRATCH/final-jest.txt" | sort)`
Expected: no line starting with `>` (no new FAIL).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: SQL harness**

Run: `scripts/verify-evaluation-log.sh`
Expected: `evaluation_log SQL checks: OK`.

- [ ] **Step 4: Production build in an isolated dist (lint errors block Replit publish)**

Check the user's dev server first: `lsof -i :3333 -sTCP:LISTEN` — the isolated dist below is safe either way.

Run: `NEXT_DIST_DIR=.next-check NODE_OPTIONS=--max-old-space-size=6144 rtk proxy npx next build 2>&1 | tail -n 60`
Expected: build succeeds with no `Error:` lines (warnings like `no-img-element` are pre-existing).

Then: `git checkout -- tsconfig.json version.json && rm -rf .next-check`

- [ ] **Step 5: Confirm a clean tree**

Run: `git status --short`
Expected: empty.

---

## Rollout (manual, by the user — not part of the task loop)

1. On n8n cloud, confirm `smartsheet-to-db-evaluations` and `smartsheet-db-update-sync` are **inactive** (they upsert `evaluate_date` and bypass the new rule).
2. Create a Neon branch of prod. Apply `migrations/046_evaluation_log.sql` there. Start a throwaway server against the branch: `env DATABASE_URL=<branch url> NEXT_DIST_DIR=.next-probe SKIP_AUTH=true npx next dev -p 3336`, save one game through `/api/evaluations` (PATCH with `view_s`), and check one `source = 'panel'` row. Stop it, then `rm -rf .next-probe && git checkout -- tsconfig.json`.
3. Apply `migrations/046_evaluation_log.sql` on prod. **Before Republish.**
4. Push `main` and Republish on Replit.
5. Re-run `migrations/046_evaluation_log.sql` on prod immediately (seed catch-up).
6. Smoke test on prod: save one game in the panel; `SELECT * FROM evaluation_log WHERE source = 'panel' ORDER BY id DESC LIMIT 1` shows a sane `view_s`.
7. Tell evaluators: keep the game open in the panel while playing it (spec, case 22).
