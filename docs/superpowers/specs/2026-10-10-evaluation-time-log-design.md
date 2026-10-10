# Evaluation time log — design

**Date:** 2026-10-10
**Status:** Revised after three reviews (spec, code-grounded, SQL run on local PG 14); pending user approval
**Replaces:** the unbuilt event log in `2026-06-26-eval-split-event-log-design.md` (its migration
number 022 was taken by `record_bucket`; nothing from it shipped)

## Why

The Evaluator Hours report (artifact "Evaluator Hours", data as of 2026-10-09) has to *infer*
working time from one timestamp per game, `game_evaluations.evaluate_date`. That forced every
workaround in it:

| Workaround in the report | Root cause |
|---|---|
| "Trust timestamps from 28/9" picker, 1–6% rows restamped | No history; every save before `5dd98a3` restamped `evaluate_date` |
| "Dồn" flag from gaps < 10 s | Cannot tell a burst of saves from real work |
| +60 s "lead-in" per session, or +5 min padding | No "game opened" event |
| Seven competing methods (Session, Tight, Padded, Norm, Span, Hybrid, Combo) | No ground truth |
| 15 min session break, 5 min slow gap, ×1.5 / ×2.5 multipliers, "unconfirmed" | Cannot see download/play time |
| Admin edits and add-to-record overrides counted as the evaluator's work | `evaluate_date` has no actor |

Goal: record what happened, so time is summed instead of guessed.

**What the new number is, honestly:** *panel time on saved work* — the time a game was on screen
in the panel before each successful save, per person. It is not total working time: time after the
last save, time on a game opened but never saved, and play on a phone with the panel not showing
the game are not in it. The name in any UI must say "panel time", not "working hours".

## Decisions

1. **One append-only table, `evaluation_log`.** One row per successful write of an evaluation.
2. **Time per save is measured in the panel** (server GETs mean nothing: the panel prefetches
   neighbours, `EvalDetailPanel.tsx:782-802`). The client sends elapsed seconds, never a clock time.
3. **Time belongs to the actor** (who pressed save), not the owner (`initial_evaluator`).
4. **The log row is written in the same SQL statement as the UPDATE.** Not best-effort: the log is
   the source of truth for time, and the old-value read must be atomic.
5. **Cap 30 min per save interval** in v1. `hidden_s` / `idle_s` are recorded, clamped to the
   interval, reported next to the hours, and not subtracted.
6. **`evaluate_date` stops moving when someone other than the owner changes the verdict**, with
   three exceptions (unjudged game, no actor, batch-stamping promotion to List_Idea).
7. **Seed old data** into the log, once before Republish and once right after.
8. **"Unjudged" means `evaluate_date IS NULL`**, not `initial_conclusion IS NULL`:
   `Stale_release` rows carry a conclusion but no date (`scripts/prune-stale-release-evals.mjs:6-10`).
9. Out of scope (phase 2): a "viewed but not saved" beacon; switching Report / Effort feed /
   status-log sheet to read the log; per-conclusion caps; subtracting hidden/idle time.

## Schema — `migrations/045_evaluation_log.sql`

```sql
CREATE TABLE IF NOT EXISTS evaluation_log (
  id                 BIGSERIAL PRIMARY KEY,
  -- SET NULL, not CASCADE: an append-only time log must survive row cleanups; game_id still names the game
  game_evaluation_id INT REFERENCES game_evaluations(id) ON DELETE SET NULL,
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
```

`actor_role`, `final_before/after` and `confidence` have no reader in v1; they are kept because an
audit log that drops them cannot get them back. The seed (below) follows the DDL in the same file;
the whole file is idempotent (verified: re-run inserts 0 rows).

## Write path

### Client — `components/EvalDetailPanel.tsx`

New prop `logContext: 'evaluate' | 'shortlist' | 'record' | 'tagging'`. Five mounts in four files:

| Mount | `logContext` |
|---|---|
| `app/(manager)/evaluations/page.tsx:1542` (Evaluate list) | `evaluate` |
| `app/(manager)/evaluations/page.tsx:908` (Short List, `showFinalConclusion`) | `shortlist` |
| `app/(manager)/evaluations/[gameId]/page.tsx` | `evaluate` |
| `app/(manager)/youtube/page.tsx:1897` | `record` |
| `components/TaggingTab.tsx:172` | `tagging` |

**View timer**, held in a ref (no re-renders):

```
view = { gameId, startedAt, hiddenMs, hiddenSince, idleMs, lastInputAt }

startView(gameId, t):  all counters zero; startedAt = lastInputAt = t;
                       hiddenSince = document.hidden ? t : null
- on mount and on every currentGameId change      → startView(currentGameId, now)
- visibilitychange: hidden → hiddenSince = now
                    visible → hiddenMs += now - hiddenSince; hiddenSince = null
- pointerdown / keydown / wheel / pointermove (throttled 1 s):
      gap = now - max(lastInputAt, startedAt); if gap > 120 000 → idleMs += gap; lastInputAt = now
```

All durations come from `Date.now()` differences, so background-tab timer throttling does not
matter. Input inside iframes (YouTube demo) does not reach the document, so watching a demo counts
as idle — one reason idle is not subtracted.

**Snapshot at the start of `save()`, not when the PATCH is sent.** `save()` awaits the screenshot
flush and the trend-tag PUT before the PATCH (`EvalDetailPanel.tsx:918, 928`), and Prev/Next and the
arrow keys stay enabled while saving (`:807, 1085, 1097, 1686`). Measured at send time, a Save → Next
would log the new game's timer under the old game and then wipe it.

```
first line of save(), synchronously:
  t = now
  snap = (view.gameId === ev.game_id)
       ? { gameId, t, view_s, hidden_s, idle_s }    // closes an open hidden stretch at t
       : null                                        // ev is stale (uncached load) → send no timing
on res.ok:
  if (view.gameId === snap.gameId) startView(snap.gameId, snap.t)   // contiguous with the next save
on failure: leave the timer running (a 400 then a fixed save counts the whole stretch)
```

Body gains `view_s`, `hidden_s`, `idle_s`, `context` when `snap` is non-null.

**Side fix in the same function:** after the refetch, `applyData(fresh)` (`:982`) runs with no check
that the user is still on that game, so a slow save paints the old game over the new one. Keep the
cache write, but only call `applyData` when `currentGameIdRef.current === ev.game_id`.

Short List inline editors (`evaluations/page.tsx:261, 402, 478`) and `lib/drive-link-client.ts:6`
are unchanged: no `view_s`, so the server logs them as `source = 'other'`.

### Server — `PATCH /api/evaluations` (`app/api/evaluations/route.ts`)

Inputs:
- `source = 'panel'` when `body.view_s` is a number, else `'other'`.
- `context` accepted only from the four allowed values and only with `source = 'panel'`.
- `view_s` clamped to an integer in `[0, 86400]`; `hidden_s`, `idle_s` clamped to `[0, view_s]`.
- `role` is declared inside the auth block (`:549`); hoist it next to `actor` for `actor_role`.
- `initialTouched` = any of `initial_note` / `initial_note_parts` / `initial_conclusion` / `batch` /
  `game_alike` / `drive_link` provided. `finalTouched` = `final_conclusion` or `final_note` provided.

`kind`, from the pre-update row (never from earlier log rows, so it works with or without seed):

```sql
CASE
  WHEN NOT ${initialTouched} AND ${finalTouched} THEN 'final'
  WHEN NOT ${initialTouched} THEN 'other'
  WHEN old.evaluate_date IS NULL
       AND upd.initial_conclusion IS NOT NULL
       AND upd.initial_conclusion <> 'Stale_release'
       AND old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion THEN 'first'
  WHEN old.initial_conclusion IS NOT NULL AND upd.initial_conclusion IS NULL THEN 'clear'
  ELSE 'revise'
END
```

`Stale_release → Bypass` is `first`; re-saving an imported row that has a conclusion but no date,
without changing it, is `revise` (so it is not counted as a new game on every save).

**One statement**, so the old value is read under a row lock and the log costs no extra round trip
(~225 ms each to Neon us-east-2):

```sql
WITH old AS (
  SELECT id, game_id, initial_conclusion, initial_evaluator, final_conclusion, evaluate_date
  FROM game_evaluations WHERE id = ${id}
  FOR NO KEY UPDATE
), upd AS (
  UPDATE game_evaluations ge SET
    ... existing SET list, right-hand sides qualified with ge. (see below) ...
  FROM old WHERE ge.id = old.id
  RETURNING ge.*
), logged AS (
  INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, actor_role, owner, source,
    context, kind, conclusion_before, conclusion_after, final_before, final_after, changed,
    view_s, hidden_s, idle_s)
  SELECT old.id, old.game_id, ${actor}, ${role}, old.initial_evaluator, ${source}, ${context},
    <kind CASE above>,
    old.initial_conclusion, upd.initial_conclusion,
    old.final_conclusion, upd.final_conclusion,
    old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion,
    ${viewS}, ${hiddenS}, ${idleS}
  FROM old JOIN upd ON upd.id = old.id
)
SELECT * FROM upd
```

Verified on PG 14 (no version-sensitive features; prod is Neon 16/17):

- **`UPDATE … FROM old` is required for the log to exist at all.** Without the join the UPDATE runs
  first, then `old`'s `FOR NO KEY UPDATE` meets a row this statement already modified and silently returns
  nothing: zero log rows, even for a single uncontended save.
- With the join, a second concurrent save waits on the lock and then reads the first save's result:
  session A `first | - | Bypass`, session B `revise | Bypass | List_Idea`.
- `old` exposes `id`, `game_id`, `initial_conclusion`, `initial_evaluator`, `final_conclusion`,
  `evaluate_date`. Every **right-hand side** reference to these in the SET list must be `ge.`-qualified
  (Postgres raises "column reference is ambiguous" otherwise): `evaluate_date` CASE (`:621-625`),
  `final_conclusion = COALESCE(…, ge.final_conclusion)` (`:626`), the `batch` CASE (`:644`), and the
  new owner check. SET **targets** stay unqualified (`SET ge.x =` is invalid).
- An ambiguous column fails only at runtime, as a 500 on every panel save. The mocked API tests cannot
  catch it (see Tests).

If the table is missing, Postgres raises `42P01`. In the existing catch (`:672`), return
`500 { error: 'evaluation_log missing — apply migration 045' }`.

An admin saving from the panel always sends the note parts (`canEditEval`, `:943-946`), so their rows
are `revise` even when they only changed the final conclusion. Harmless: admins are filtered out of
time by title.

### `evaluate_date` rule

Today (`:621-625`) it moves whenever the verdict changes, including when an admin changes it. New rule
(RHS qualified, ready to paste):

```sql
evaluate_date = CASE
  WHEN ${concProvided} AND ${concVal}::text IS NOT NULL
    AND ge.initial_conclusion IS DISTINCT FROM ${concVal}::text
    AND (   ${actor}::text IS NULL                                   -- SKIP_AUTH
         OR lower(ge.initial_evaluator) = lower(${actor}::text)      -- owner
         OR ge.evaluate_date IS NULL                                 -- unjudged (incl. Stale_release)
         OR (${concVal}::text = 'List_Idea'                          -- batch-stamping promotion
             AND ${batch ?? null}::text IS NOT NULL
             AND ge.batch IS DISTINCT FROM ${batch ?? null}::text))
    THEN NOW()
  WHEN ${concProvided} AND ${concVal}::text IS NULL THEN NULL
  ELSE ge.evaluate_date END,
```

Why the List_Idea exception: `lib/report-batches.ts:53-65` takes a batch's start as the minimum
`evaluate_date` of its games. When a manager promotes an old game to List_Idea, the panel stamps the
current batch (`EvalDetailPanel.tsx:1336`). If the date stayed old, the current batch's start would
jump back by weeks and shift every `lead()` window. Keeping today's behaviour for this one case keeps
batch windows stable; time is unaffected because time comes from the log, not `evaluate_date`.

Readers affected, and how:

| Reader | Effect |
|---|---|
| Report, `cron/report-rollup`, `report/daily` | Admin corrections no longer move a game to the admin's day. Intended |
| `api/external/effort-sessions` | Same; the feed stops showing admin times as the evaluator's sessions. Update its comment (`:26`) |
| `lib/rescue-core.ts:54` (recent activity) | Same, intended |
| `lib/report-batches.ts` | Unchanged thanks to the List_Idea exception. Update its stale comment (`:4-5`, "written in exactly one place") |
| `lib/evaluations-filters.ts:47` (Short List "evaluated" month) | A game an admin corrects stays in its original month. Intended, note in release notes |
| quick-stats, missing-demo, evaluations GET | Read only; same semantics as above |
| n8n `smartsheet-to-db-evaluations`, `smartsheet-db-update-sync` | `ON CONFLICT DO UPDATE` on `evaluate_date` bypasses the rule. Exports look inactive — confirm on n8n cloud before rollout |

### `POST /api/evaluations/add-to-record`

The route is two statements (an INSERT of a missing row at `:59`, then the UPDATE). The log row joins
to the UPDATE in the same CTE pattern as PATCH (`old … FOR NO KEY UPDATE`, `UPDATE … FROM old`, `INSERT`).

**Decision (user, 2026-10-10): add-to-record behaves exactly as today and, like a Short List inline
edit, never counts as time.** It writes one log row with `source = 'add_to_record'` (its own label, so
"which games were pulled into Record by the shortcut, by whom, over which verdict" is one filter) and
no timing. Today's behaviour is unchanged: an initial conclusion that is empty or `%bypass%` becomes
`Shortcut` + List_Idea with the bucket's final; a game with a real evaluation keeps it.

| | Override branch | Legacy branch |
|---|---|---|
| `source` | `add_to_record` | `add_to_record` |
| `actor` | session user (route is `requireManager`) | session user, NULL if none |
| `owner` | `initial_evaluator` before the write (the override may change it) | same |
| `kind` | the shared `kind` CASE, with `initialTouched` = an initial evaluator or conclusion was given, `finalTouched` = a final conclusion or final evaluator was given | the shared `kind` CASE with both flags true |
| `evaluate_date` | **unchanged from today** (moves when the conclusion changes) | **unchanged from today** (auto-fill stamps NOW()) |

Keeping today's `evaluate_date` here also keeps batch windows stable: this route stamps the batch.

### Not logged

Imports (`/api/admin/import-evaluations`, n8n Smartsheet syncs), `scripts/*`, cron push/assign.
Reassign / handover / rescue are already in `assignment_history` and only touch games with no verdict.

## Side fix — assignment writes must not move judged games

`commitAssignment` (`lib/reassign-core.ts:87-94`) and the cron's own UPDATE
(`app/api/cron/assign-evaluators/route.ts:131-137`) do not re-check the verdict. A game judged
between selection and commit (seconds: one UPDATE per evaluator, ~225 ms each) is moved to someone else.

- Add `AND initial_conclusion IS NULL` and `RETURNING id` to both UPDATEs.
- Every caller builds its history and counts from the returned ids: reassign (`operation_runs.game_count`,
  snapshot, ~`:137`), handover resolve (~`:124`), rescue (history built from its own `s.sub` map at
  `:183-190` — switch to the returned ids), cron assign.
- `__tests__/api/reassign.test.ts` and siblings: mocks must return RETURNING rows.

## Seed

Copies the one timestamp each judged game already has into the log, so the log covers history. It adds
no precision: it copies what exists, flagged by confidence.

```sql
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

Verified on PG 14: parses, idempotent, `corrected` takes the earliest owner tag (`MIN`), tags by
someone other than the owner are ignored, the `+07` boundary is right in UTC / VN / NY session
time zones, and after a panel row exists only games judged before it are seeded.

- **Confidence.** `corrected`: `evaluate_date` was > 30 min after the owner's earliest tag (restamp
  evidence, ~54 rows on 2026-10-09), so the tag time is used; this wins over `low`. `low`: last written
  by a manager who is not the owner, or before 28/9 with no tag to check. System accounts (`Shortcut`,
  `pj202-backfill`, `vinhtd`) are seeded too; readers exclude them.
- **`evaluate_date < cutover`** keeps the seed from inventing a second `first` for a game re-judged
  after Republish.
- **Unlogged writers after cutover** (imports, n8n syncs if still active) never get a log row, and later
  seed re-runs skip them. Acceptable because those writers are not panel work; confirm the n8n syncs are
  off (rollout step 1).
- **Lost for good:** edit history before the log, and every "opened" time before it. Old time stays an
  estimate.

## Reading time — `lib/evaluation-hours.ts` + `GET /api/admin/evaluation-hours?from&to`

Consumer in v1: the Evaluator Hours artifact (refreshed from this endpoint instead of re-deriving from
`evaluate_date`). Report, Effort feed and the status-log sheet move in phase 2.

```sql
-- Panel time per person per VN day. Intervals are merged per person across days first, then each
-- merged block is credited to the VN day it ends in, so overlaps at midnight count once.
WITH iv AS (
  SELECT lower(l.actor) AS who,
         l.created_at - make_interval(secs => LEAST(l.view_s, 1800)) AS s,
         l.created_at AS e,
         l.view_s > 1800 AS capped,
         l.idle_s, l.hidden_s
  FROM evaluation_log l
  JOIN dashboard_users du ON lower(du.name) = lower(l.actor)
  WHERE l.source = 'panel'
    AND l.view_s IS NOT NULL                       -- LEAST(NULL, 1800) = 1800, so this is required
    AND du.title = ANY(${titles}::text[])          -- default ARRAY['Fulltime','Freelancer']
    AND l.created_at >= ${from} AND l.created_at < ${to}
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
SELECT who, (block_end AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day,
       SUM(EXTRACT(EPOCH FROM (block_end - block_start))) / 3600.0 AS hours,
       SUM(n_capped) AS capped_saves,
       SUM(idle_s) AS idle_s, SUM(hidden_s) AS hidden_s
FROM blocks
GROUP BY 1, 2;
```

- **Who counts:** only actors whose `dashboard_users.title` is in `titles` (default Fulltime +
  Freelancer, same as Report). This is what excludes admins, moderators and system accounts — the
  query does not rely on the reader to filter.
- **What counts:** every panel save by those people, any context and kind. The number is panel time;
  `context` lets a reader split evaluate / shortlist / record / tagging later.
- **Games per day** = distinct `game_evaluation_id` with `kind = 'first'`, same title filter, VN day of
  `created_at`.
- `idle_s` / `hidden_s` sums are returned so a manager can see "open but untouched" time; the 30-min cap
  is per save, so a save every 25 min keeps a game open indefinitely — idle is what reveals it.
- **Before the cutover** the artifact keeps its "Kết hợp" estimate from seed rows (owner + `created_at`),
  labelled *estimate*. That method lives in the artifact, not the repo. For the first 3–4 weeks after
  cutover the artifact also computes the estimate on live days and shows the ratio measured / estimate,
  so a drop in the number is not read as a drop in work. A month spanning the cutover shows both parts.
- **Tuning after a week:** `view_s` percentiles per `conclusion_after` (per-conclusion caps), and whether
  `hidden_s` should be subtracted.

Verified on PG 14 with synthetic rows: two overlapping tabs, an interval contained in an earlier one
(the `MAX(e)` frame merges it where `LAG` would split it), a retry duplicate, an 80-min view capped to
30, an autosave burst, and system / record / final / other rows excluded — totals matched a hand count.
Re-run after the revision (midnight merge, title join, `view_s IS NOT NULL`): 23:45–23:55 + 23:50–00:10
now gives 25 min (was 30); admins, `Shortcut`, NULL actor and NULL `view_s` rows are excluded; the
qualified PATCH CTE with the new `kind` CASE and `evaluate_date` rule gave the expected row for each of
owner first, note fix, admin correction (date kept), admin on `Stale_release` (`first`, date moved),
List_Idea promotion with batch (date moved), imported resave (`revise`, date stays NULL), final-only,
record-only, clear, and NULL actor.

## Cases checked

| # | Case | Result |
|---|---|---|
| 1 | Open, play, save | interval = `view_s` |
| 2 | Save, fix note, save again | contiguous intervals (timer restarts at the first save's snapshot); 1 game |
| 3 | Open A, go to B, back to A, save | counted from the latest time A was shown |
| 4 | Neighbour prefetch | not counted (timer follows `currentGameId`) |
| 5 | Save rejected 400, fix, save | timer not reset on failure, full stretch counted |
| 6 | Left open over lunch | capped at 30 min, counted in `capped_saves` |
| 7 | Laptop sleeps with game open | capped; `hidden_s` may miss sleep |
| 8 | Open 23:50, save 00:10 | credited to the save's day; merged with any overlapping 23:5x save |
| 9 | Two tabs, two games in parallel | union, wall time once |
| 10 | Two tabs, same game, near-simultaneous save | `FOR NO KEY UPDATE` + join: `first` + `revise` (verified) |
| 11 | Response lost, user retries | near-identical intervals merge; second row is `revise` |
| 12 | Admin changes an evaluator's verdict | time to admin, dropped by the title filter; `evaluate_date` unchanged |
| 13 | Admin judges an unjudged game | `evaluate_date` moves; time to admin |
| 14 | Evaluator has game open, admin edits, evaluator saves over it | both logged; last write wins (unchanged, out of scope) |
| 15 | Final set, evaluator can only edit the note | `revise`, `changed = false`, time counted |
| 16 | Admin clears verdict, evaluator redoes it | two `first` rows; games/day counts distinct games |
| 17 | Save at the same moment as a reassign | time to actor; side fix stops the move |
| 18 | A has game open, it is reassigned, A saves | 403, A's time lost — phase 2 |
| 19 | Add-to-record (override or legacy) | `source = add_to_record`, no time (like a Short List edit); behaviour and `evaluate_date` as today |
| 20 | Recorder saves a drive link in the panel | `context = record`; counts as panel time if their title is in `titles` |
| 21 | Short List inline edit | no `view_s` → `source = other` |
| 22 | Plays 20 games on a phone, then saves them in a burst | each `view_s` is seconds: low panel time. Process issue, not a bug |
| 23 | Auto-save on (1.5 s debounce, per-user localStorage) | several rows per game, contiguous intervals, same total |
| 24 | Deploy-reload guard flushes an unsaved edit | normal save with `view_s`; if unload cuts the request, no row |
| 25 | Save, then Next before the save returns | snapshot taken at click: old game gets its time; the new game's timer is untouched; stale `applyData` skipped |
| 26 | Save pressed while the next game is still loading (old `ev` on screen) | timer belongs to the new game → no timing sent, row is `source = other` |
| 27 | Game marked `Stale_release`, later judged by someone | `first`; `evaluate_date` moves (unjudged) |
| 28 | Admin promotes an old game to List_Idea (batch stamped) | `evaluate_date` moves, as today; batch windows stable |
| 29 | Small edit every 25 min to keep a game "active" | each save capped at 30 min, so not stopped; shows up as high `idle_s` |

## Process note (not code)

Case 22: tell evaluators to keep the game open in the panel while they play it. Otherwise the log
correctly shows little panel time for burst-savers, and their real play time is invisible.

## Rollout

1. On n8n cloud, confirm `smartsheet-to-db-evaluations` and `smartsheet-db-update-sync` are inactive.
2. Run `scripts/verify-evaluation-log.sh` (below) on a throwaway local Postgres. Then apply `045` on a
   Neon branch of prod and run the PATCH CTE once there by hand.
3. Apply `migrations/045_evaluation_log.sql` on prod. **Must precede Republish**: the PATCH writes the
   log in the same statement, so without the table every panel save fails.
4. Republish on Replit.
5. Re-run `045` immediately (seed catch-up for games judged between steps 3 and 4).
6. Smoke test: save one game in the panel; check one `source = 'panel'` row with a sane `view_s`.

## Tests

API tests mock `sql` entirely and only match SQL text with regexes
(`__tests__/api/evaluations-final-fields.test.ts:6-11`); there is no test database. So:

- **Unit (Jest, mocked `sql`):** `kind` inputs (`initialTouched` / `finalTouched`), `source` from
  `view_s`, `context` whitelist, clamping (`hidden_s`, `idle_s` ≤ `view_s`), `actor_role` bound, 42P01
  message, assignment callers use returned ids. Update
  `__tests__/api/evaluations-note-required.test.ts:114`, whose regex matches the old
  `IS DISTINCT FROM … THEN NOW()` text.
- **Panel (Jest + RTL):** timer starts on mount and on game change, ignores prefetch; snapshot taken at
  the start of `save()`; reset only on `res.ok` and only for the same game; Save → Next keeps both games'
  time apart; stale `applyData` skipped.
- **SQL (real Postgres):** `scripts/verify-evaluation-log.sh` — ported from the review harness: start a
  throwaway PG on a local port, load minimal tables, then run 045 + re-run, the PATCH CTE through
  first/revise/clear/final/other, two concurrent sessions on one row, the `evaluate_date` rule cases
  (owner, admin judged, admin unjudged, Stale_release, List_Idea promotion, NULL actor), and the time
  query on synthetic rows including a midnight overlap and a NULL `view_s`. It never reads
  `DATABASE_URL`. Run before every change to these statements.

## Files touched

- `migrations/045_evaluation_log.sql` (new: DDL + seed)
- `app/api/evaluations/route.ts` (PATCH: CTE write, `evaluate_date` rule, 42P01 message, hoist `role`)
- `app/api/evaluations/add-to-record/route.ts` (log row via CTE)
- `lib/reassign-core.ts`, `app/api/cron/assign-evaluators/route.ts`, `app/api/operations/reassign/route.ts`,
  `app/api/operations/handover/resolve/route.ts`, `app/api/operations/rescue/route.ts` (guard + returned ids)
- `components/EvalDetailPanel.tsx` (view timer, snapshot, `logContext` prop, stale `applyData` guard,
  stale "~800ms" comment at `:1010`)
- Mounts: `app/(manager)/evaluations/page.tsx` (two), `app/(manager)/evaluations/[gameId]/page.tsx`,
  `app/(manager)/youtube/page.tsx`, `components/TaggingTab.tsx`
- `lib/evaluation-hours.ts`, `app/api/admin/evaluation-hours/route.ts` (new)
- Comment updates: `app/api/external/effort-sessions/route.ts:26`, `lib/report-batches.ts:4-5`
- `scripts/verify-evaluation-log.sh` (new)
- Tests under `__tests__/api/` and `__tests__/components/`
