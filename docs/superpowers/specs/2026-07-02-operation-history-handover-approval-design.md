# Operation History + Handover Approval — Design

**Date:** 2026-07-02
**Scope:** Team Operations → Reassign & Handover panels.

## Goal

1. Add a **History** container above the Reassign and Handover panels. One row per
   operation, with a **Details** button opening a popup that shows the Source pool
   and the resulting Distribution as they were at that time.
2. Handover gains an **approval workflow**: submitting a handover creates a
   `pending` request; a manager reviews it and **approves** (which performs the
   redistribution) or **rejects** (discards, no DB change). History shows the
   status pill (pending / approved / rejected) + Details.

## Decisions (from brainstorming)

- **Approve commits.** Submit writes NOTHING to `game_evaluations`; it stores a
  pending request + preview snapshot. Approve redistributes; reject discards.
- **Any manager (admin/moderator)** can approve/reject, **except their own**
  submitted request (self-approval is blocked, 403).
- **Recompute at approve time** — approve re-runs the distribution against the
  current pending games + currently-available roster. The submit-time snapshot is
  reference only (shown in Details).
- Reassign has **no** approval — it commits immediately as today and just logs a run.

## Data model — `operation_runs` (migration 028)

One row per operation (contrast `assignment_history`, which is per-evaluator).
Stores a full `DistResult`-shaped snapshot so Details re-renders exactly.

```sql
CREATE TABLE operation_runs (
  id             SERIAL PRIMARY KEY,
  kind           TEXT NOT NULL,          -- 'reassign' | 'handover'
  category_group TEXT NOT NULL,
  from_evaluator TEXT NOT NULL,
  params         JSONB NOT NULL,         -- mode, start/end, count, selected_evaluators, weights
  snapshot       JSONB NOT NULL,         -- DistResult at submit/commit time
  result         JSONB,                  -- committed DistResult (handover approve); NULL until then
  status         TEXT NOT NULL,          -- reassign: 'committed'; handover: pending|approved|rejected
  game_count     INT NOT NULL DEFAULT 0,
  submitted_by   TEXT, submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by    TEXT, reviewed_at TIMESTAMPTZ, review_note TEXT
);
```

`assignment_history` (Assign-tab daily per-evaluator view) is unchanged; reassign &
handover-approve still write to it too.

## Flows

- **Reassign commit** (`POST /api/operations/reassign`, `dryRun:false`): unchanged,
  plus one `operation_runs` row (`kind='reassign'`, `status='committed'`, snapshot =
  committed DistResult).
- **Handover submit** (`POST /api/operations/handover`, `dryRun:false`): compute the
  enriched preview (now including `by_date`/`by_platform`/per-evaluator-platform, to
  match reassign) → insert `status='pending'` row. No game changes.
- **Handover resolve** (`POST /api/operations/handover/resolve`, `{id, action, note?}`):
  manager guard; reviewer ≠ submitter; row must be `pending` (else 409). Approve →
  recompute fresh → `commitAssignment` → insert `handover_requests` (status `done`,
  drives the availability cron) → `writeAssignmentHistory(action='handover')` → update
  run to `approved` + store committed `result`. Reject → mark `rejected`.
- **List** (`GET /api/operations/runs?kind=&category=&limit=`): returns rows (incl.
  snapshot/result) + `viewer` (session email, for the self-approve guard in the UI).

## UI

- `components/OperationHistory.tsx` — history card mounted above the form in both
  panels, scoped to the panel's bucket. Columns: date · from · (reassign) targets /
  (handover) window · games · (handover) status pill + Approve/Reject · Details.
- `components/OperationDetailModal.tsx` — reuses `eval-modal-backdrop` + shared
  `DistributionResult` to show the snapshot (or committed result).
- `ReassignPanel` / `HandoverPanel` refresh their history after commit / submit /
  approve / reject. Handover's "Commit handover" button becomes "Submit request".

## Shared helpers — `lib/operation-runs.ts`

- `sourceBreakdowns(candidates)` → `{ by_platform, by_date }`
- `perEvaluatorPlatform(candidates, assignment)` → per-evaluator platform split
- `insertOperationRun(...)`, run-status types. Reassign route refactored to reuse
  the breakdown helpers (removes duplicated inline math).
