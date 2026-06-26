# Eval Modal: Initial/Final split + Activity event log

**Date:** 2026-06-26
**Status:** Design approved, pending spec review

## Goal

Two changes to the evaluation detail modal (`components/EvalDetailPanel.tsx`):

1. **Split the EVALUATION panel** into two cards: *Initial Evaluation* and *Final Evaluation*.
2. **Replace the Imported/Updated footer** with an *Activity* timeline backed by a real
   per-change event log (`game_evaluation_events`), written on every mutation and seeded
   once from existing milestone timestamps.

## A. Panel layout

The right-side `EVALUATION` card (currently `EvalDetailPanel.tsx` ~lines 879–1059) becomes two cards.

### Initial Evaluation
- Initial Conclusion (existing dropdown, `INITIAL_CONCLUSION_OPTIONS`)
- Batch (week)
- Initial Note
- Game Alike
- Demo Video (Drive) — `drive_link`

### Final Evaluation (manager-only fields keep existing guard)
- **Final Conclusion** — NEW dropdown. Options come from the same source the Short List /
  Config tab uses for `final_conclusion` (e.g. Priority I–IV…). Currently `final_conclusion`
  is stored + shown in the top stepper and Short List but has no input in this panel; we add
  the dropdown here. Guarded the same way as Final Note (`canEditFinalNote`; server PATCH
  already returns 403 for non-managers on `final_conclusion`).
- Final Note — `final_note` (existing, manager-only)
- YouTube Link — `youtube_link` (existing)

No data-model change for the layout: all fields already exist on `EvalDetail` and the PATCH
endpoint. This is JSX reorganization plus one new dropdown bound to `final_conclusion`.

## B. Event log — `game_evaluation_events`

### Schema — `migrations/022_eval_events.sql`

```sql
CREATE TABLE IF NOT EXISTS game_evaluation_events (
  id                 SERIAL PRIMARY KEY,
  game_evaluation_id INT NOT NULL REFERENCES game_evaluations(id) ON DELETE CASCADE,
  event_type         VARCHAR(40) NOT NULL,   -- update_initial | update_final | assign_record | recorded
  changes            JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{field, old, new}]
  actor_name         VARCHAR(100),
  actor_email        VARCHAR(150),
  actor_role         VARCHAR(20),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eval_events
  ON game_evaluation_events (game_evaluation_id, created_at DESC);
```

### Event types

| event_type       | When | Fields tracked |
|------------------|------|----------------|
| `update_initial` | PATCH touches an initial field | `initial_conclusion`, `initial_note`, `batch`, `game_alike`, `drive_link` |
| `update_final`   | PATCH touches a final field | `final_conclusion`, `final_note`, `youtube_link` |
| `assign_record`  | `confirm-records` sets `record_confirmed_at` | recording assignment confirmed |
| `recorded`       | (optional, later phase) record drive video link set | `record_5min_drive`, `record_20min_drive` |

A single PATCH that changes both an initial and a final field emits two events (rare in
practice). There is no separate `record_confirmed` event — confirmation **is** `assign_record`.

### Write path (mirrors `weekly_feedback_history`)

**PATCH `/api/evaluations` (`app/api/evaluations/route.ts`):**
1. Already loads `session = getServerSession(authOptions)` and the existing row.
2. Before/with the UPDATE, diff the changed fields against their old values
   (the handler already fetches the row for ownership/batch logic — reuse it; add a SELECT of
   the tracked columns if not already present).
3. Group changed fields into `update_initial` / `update_final` buckets.
4. For each non-empty bucket, INSERT one row: `event_type`, `changes` = `[{field, old, new}]`,
   `actor_name/email/role` from `session.user`.

**POST `/api/evaluations/confirm-records`:** after the UPDATE, INSERT one `assign_record`
event per confirmed id, with `actor_*` from session. Endpoint already uses
`requireRole(['admin','moderator'])`; add `getServerSession` to capture the actor.

Events are best-effort/non-blocking: a logging failure must not fail the mutation
(wrap inserts, log error, continue).

### Backfill (one-time, inside migration 022)

Seed events from existing milestone timestamps so old games aren't blank:

```sql
-- update_initial from evaluate_date
INSERT INTO game_evaluation_events (game_evaluation_id, event_type, actor_name, created_at)
SELECT id, 'update_initial', initial_evaluator, evaluate_date
FROM game_evaluations WHERE evaluate_date IS NOT NULL;

-- assign_record from record_confirmed_at
INSERT INTO game_evaluation_events (game_evaluation_id, event_type, actor_name, created_at)
SELECT id, 'assign_record',
       COALESCE(record_5min_assignee, record_20min_assignee),
       record_confirmed_at
FROM game_evaluations WHERE record_confirmed_at IS NOT NULL;

-- recorded (optional) from record drive dates
INSERT INTO game_evaluation_events (game_evaluation_id, event_type, actor_name, created_at)
SELECT id, 'recorded',
       COALESCE(record_5min_assignee, record_20min_assignee),
       COALESCE(record_5min_drive_date, record_20min_drive_date)
FROM game_evaluations
WHERE COALESCE(record_5min_drive_date, record_20min_drive_date) IS NOT NULL;
```

Backfilled events have `changes = '[]'` (no old→new known) and no `actor_email/role`.
`created_at` is set to the historical timestamp.

## C. Activity timeline UI

Replace the Imported/Updated footer card with an **Activity** card:
- Fetch via new `GET /api/evaluations/[gameId]/events` (separate endpoint to keep the detail
  payload small), returning events newest-first.
- Render each event: icon + label by `event_type`, actor name, time (`fmtDateTime`), and the
  `changes` list as `field: old → new` (compact; long values truncated).
- Keep the two small Imported / Updated lines below the timeline (faint), unchanged.

Labels: `update_initial` → "Initial evaluation updated", `update_final` → "Final evaluation
updated", `assign_record` → "Record assigned", `recorded` → "Video recorded".

## Out of scope / YAGNI
- No per-keystroke history; one event per logical PATCH bucket.
- `recorded` event wiring on the live write path is optional (backfill seeds it; live emit can
  follow in a later phase).
- No edit/delete of events; append-only.

## Files touched
- `migrations/022_eval_events.sql` (new — schema + backfill)
- `app/api/evaluations/route.ts` (PATCH: emit events)
- `app/api/evaluations/confirm-records/route.ts` (emit `assign_record`)
- `app/api/evaluations/[gameId]/events/route.ts` (new GET)
- `components/EvalDetailPanel.tsx` (split cards, Final Conclusion dropdown, Activity timeline)
