# Eliminate Smartsheet — Plan A: Move processing flows into the app

**Date:** 2026-06-30
**Status:** Design — approved for planning
**Scope:** Plan A of a two-part effort. Plan A removes **Smartsheet**. Plan B (separate spec, later) removes the remaining **Google Sheets** plumbing.

## Goal

Make the Next.js app + Postgres the single source of truth and reduce n8n to a
**stateless trigger** (cron fires an authenticated HTTP POST; no business logic, no
Smartsheet/Sheet reads in the workflow). After Plan A, Smartsheet is fully
disconnected: no workflow reads or writes it, capacity tracking and delete-monitoring
are gone, and credentials/tokens are removed.

## Context (verified by audit, 2026-06-30)

- **The team already works entirely in the app.** Smartsheet is no longer a human
  work surface. Eval data is canonical in Postgres `game_evaluations`.
- **Nothing is Smartsheet-only.** Everything synced to Smartsheet is mirrored in
  `game_evaluations`. So dropping Smartsheet loses no live data.
- **Push + auto-assign are already built in the app** but unfinished — gated behind
  `dryRun:true`, a `sync-roster` ON-CONFLICT bug, and unapplied migrations 014–016.
- **Handover + re-assign still run their real logic in n8n** (a 2-phase,
  platform-aware, weighted quota assignment) and mutate **Smartsheet rows**; the app
  routes (`/api/operations/reassign`, `/api/handover-puzzle`) are pure proxies.
- **Evaluator availability/platform/weight/category** lives in the Google Sheet
  "Evaluator List" today. The `evaluator_roster` table exists (migrations 011/016) but
  is not yet the live source.

### Explicitly out of scope (deferred)

- Arcade/simulation **historical eval backfill** (puzzle has ~26k rows; arcade/sim = 0).
- Old puzzle-sheet one-time sync.
- The remaining Google Sheets plumbing — `flow_log` logging, `ytb_uploaded`,
  `drive-video-link-sync`, `N8N configs`, handover Logging sheet. These move in **Plan B**.
- Until Plan B, n8n workflows may still **log to the `flow_log` Google Sheet**; that's
  acceptable — it is logging, not processing, and touches no Smartsheet.

## Architecture after Plan A

```
Cron (n8n)  ──HTTP POST + WEBHOOK_SECRET──▶  Next.js route  ──▶  Postgres
                                                  │
UI action (manager/evaluator) ───────────────────┘   (handover, re-assign: direct, synchronous)
```

- **n8n keeps only:** `db-push-assign.json` as the daily orchestrator
  (sync-roster → push → assign, per category). It carries no logic — just HTTP calls.
- **n8n loses entirely (deleted):** all Smartsheet push/pull/sync/capacity workflows
  and all handover/re-assign workflows (their logic moves into the app; their trigger
  becomes a direct UI action).
- **Single source of truth:** `game_evaluations`, `evaluator_roster`,
  `handover_requests`, `app_config` (all Postgres).

## Component design

### 1. Roster foundation (do FIRST — every flow depends on it)

Push, assign, handover, and re-assign all need evaluator availability/platform/
weight/category. The app **fully owns** `evaluator_roster`; the "Evaluator List" Google
Sheet and the `team/initial` n8n webhooks are dropped.

- **One-time backfill** "Evaluator List" → `evaluator_roster`. Reuse `/api/admin/sync-roster`
  after fixing it (see bug below). Run once, then retire the sheet as a source.
- **Team page becomes the CRUD owner** of `evaluator_roster`: availability
  (`today_available`), `game_platform`, `weight`, `game_category`. This replaces:
  - n8n webhooks `WEBHOOK_TEAM_INITIAL_GET` / `WEBHOOK_TEAM_INITIAL_AVAILABILITY` /
    `WEBHOOK_TEAM_INITIAL_PLATFORM`
  - the direct sheet write in `/api/team/initial/weight/route.ts`
  - `app/api/team/initial/route.ts` GET now reads `evaluator_roster` directly.
- **Hourly availability cron** (`/api/handover-puzzle/check-availability`, fired by
  `instrumentation.ts`) reads active leave windows from `handover_requests` (Postgres)
  instead of the Logging sheet, and flips `today_available` in `evaluator_roster`
  instead of calling the n8n webhook.

**`sync-roster` bug to fix (blocks push + assign too):** the route's `ON CONFLICT
(list_type, name)` no longer matches migration 016's `UNIQUE (list_type,
category_group, name)`. Add a `category_group` field to the upsert and update the
ON CONFLICT clause. Until fixed, per-category roster rows fail or are silently skipped.

### 2. Push (game distribution) — finish, don't rebuild

Logic is complete in `/api/cron/push-evaluations` + `/api/admin/push-split`:
all 5 eligibility filters (release ≤30d, type sync/null, app_link present, is_active,
category overlap) and the genre→bucket split for all three buckets via the
`category_mappings` table. Remaining work:

- Apply migrations 014 (config_options), 015 (category_mappings, seeded), 016
  (roster category_group).
- Fix `sync-roster` (above).
- In `db-push-assign.json`: flip `dryRun:true` → `false`, replace
  `REPLACE_WITH_APP_URL` / `REPLACE_WITH_WEBHOOK_SECRET` placeholders.
- Deactivate + delete n8n `[unified]-database-to-smartsheet`.

### 3. Auto-assign initial — finish, don't rebuild

`lib/assign-evaluators.ts` is a complete port of the n8n algorithm (largest-remainder
weighted split, 2-phase: platform-specific evaluators first, then `all` evaluators by
weight; platform-aware). `/api/cron/assign-evaluators` reads `evaluator_roster`.
Remaining work: same gate as push (migrations + dryRun flip), then deactivate + delete
n8n `auto-assign-game-evaluator`.

### 4. Re-assign — port logic into the app

Today `/api/operations/reassign` only proxies n8n. Port
`Handover-ReAssign-ByDateRange` logic into the route:

- Filter `game_evaluations`: `initial_evaluator = <unavailable>`,
  `initial_conclusion` empty, `assigned_date` within `[start_date, end_date]`.
- Apply the **shared 2-phase assignment** (`lib/assign-evaluators.ts`).
- Honor the `selected_evaluators[]` override (use only those; exclude the unavailable one).
- Write `initial_evaluator` + `assigned_date = today` back to `game_evaluations`
  (NOT Smartsheet).
- Trigger = **direct UI action** (manager clicks Re-assign in Operations). Synchronous;
  returns the per-evaluator distribution for display. Delete the n8n workflow.

### 5. Handover — port logic into the app

Same shared assignment, triggered when an evaluator goes on leave:

- Trigger = **direct UI action** (no Google Form, no n8n). Evaluator/manager submits a
  leave window in the app.
- Reads availability from `evaluator_roster`, redistributes the evaluator's pending
  games via the shared assignment, writes to `game_evaluations`, records the leave
  window in `handover_requests`.
- The hourly availability cron then manages `today_available` based on
  `handover_requests`.
- Delete n8n `Handover`, `handover-puzzle`, `handover-game-list`.

### Shared assignment core

Auto-assign, re-assign, and handover all collapse onto one `lib/assign-evaluators.ts`
(2-phase weighted platform-aware split). This is the main consolidation win and the
focus of testing.

## Trigger contract

- n8n cron → `POST <APP_URL>/api/...` with header carrying `WEBHOOK_SECRET`.
- All such routes already follow `hasWebhookSecret OR requireRole(['admin'])`.
- Handover/re-assign are NOT n8n-triggered after Plan A — they are direct authenticated
  UI actions.

## Error handling & idempotency

- Routes return structured JSON `{ ok, summary, perEvaluator, errors }`.
- Assignment is **idempotent**: re-running over the same pending set yields the same
  split (deterministic largest-remainder, no randomness).
- **Never hard-delete** `game_evaluations` rows (mark `Link_dead`) — a deleted row in
  the 30-day window would get re-pushed.
- Until Plan B, n8n orchestrator still appends a run summary to `flow_log`.

## Testing

- Extend the existing 23 `lib/assign-evaluators.ts` tests with: re-assign date-range
  filtering, `selected_evaluators` override, handover availability gating.
- **Parity test:** feed a captured Smartsheet re-assign input through the ported route
  and assert the same per-evaluator distribution as the n8n run produced.
- Dry-run validation: run push + assign with `dryRun:true` for 1–2 days, compare counts
  against the (still-running) Smartsheet pipeline before flipping.

## Cutover sequence (low risk — team already in app)

1. Apply migrations 014 → 015 → 016 to Neon Postgres (in order).
2. Fix `sync-roster` ON-CONFLICT + add `category_group`. Run roster backfill once.
3. Build Team-page CRUD over `evaluator_roster`; switch availability cron to
   `handover_requests`.
4. Flip `dryRun:false` on push + assign; replace n8n placeholders. Validate 1–2 days.
5. Deactivate + delete n8n `[unified]-database-to-smartsheet` and
   `auto-assign-game-evaluator`.
6. Ship ported `/api/operations/reassign` + handover routes (direct UI). Delete n8n
   `Handover`, `handover-puzzle`, `handover-game-list`, `Handover-ReAssign-ByDateRange`.
7. Remove Smartsheet surface: capacity widget (`components/SmartsheetCapacity.tsx`,
   dashboard/operations references), `/api/smartsheet-sheets/*` + `smartsheet-refresh`
   workflow, delete-monitor + webhook-register/cleanup workflows, drop `smartsheet_sheets`
   / `smartsheet_webhooks` / `smartsheet_delete_events` tables, remove Smartsheet
   tokens and `WEBHOOK_*SMARTSHEET*` env vars.

Each step is independently shippable with a rollback point (re-activate the n8n flow).

## Success criteria

- No n8n workflow reads or writes Smartsheet.
- Push, auto-assign, re-assign, handover all execute in the app against Postgres.
- Smartsheet tokens/webhooks/capacity widget/tables removed.
- Assignment parity test passes; existing eval workflows for the team are unaffected.
