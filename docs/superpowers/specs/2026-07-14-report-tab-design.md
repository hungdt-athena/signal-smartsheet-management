# Report Tab — Design Spec

**Date:** 2026-07-14 (redesigned 2026-07-15 after visual review)
**Status:** Implemented + visually verified (headless screenshots)
**Branch:** `feat/report-tab`

## v2 redesign (2026-07-15)

After reviewing v1 the design changed materially:
- **Read path is now live SQL + in-memory cache** (`GET /api/report`), not the weekly
  rollup. ~40k rows aggregate sub-second; this serves every view mode + funnel +
  recording uniformly. The rollup table/cron remain only as an optional scale fallback.
- **Adaptive filter:** "View by" = Week / Month / Quarter / **Batch** / Custom, with a
  second control that adapts (a bucket dropdown, or from–to date inputs for Custom).
- **Recording is folded into each evaluator's profile** (recorded count, 5min/20min),
  not a separate domain/toggle.
- **Shortlist funnel:** Evaluated → Escalated → Triaged → Final Priority, with per-step
  conversion → measures pick quality (**survival rate** = final-priority ÷ escalated).
- **Radar** per evaluator + team overlay, plus an **all-rounder score** (mean of 5
  normalized axes: Volume · Consistency · Signal · Survival · Recording).
- Sub-tabs: Team Overview / Leaderboard / Individual / Compare / Activity.
- Charts hand-rolled (Funnel, Radar, HealthBars, StackedBars, ColumnChart, Donut,
  Heatmap, RankBars). Verified via Chrome headless screenshots during build.
- **Batch is sparse** (only ~800 shortlist rows carry a label); it is a shortlist/funnel
  lens, while Week/Month/Quarter/Custom use `evaluate_date`.

The sections below describe the original v1 rollup design (kept for history).

## Goal

A new **Report** tab: an "Evaluator Intelligence"-style analytics dashboard over
`game_evaluations`, focused on **objective, aggregatable metrics** (volume, speed,
consistency, conclusion mix) for **Initial Evaluators** (including admins who act as
initial evaluators) and for **Record Video** work. No note-quality / keyword / LLM
scoring in v1 — deliberately deferred.

## Decisions (from brainstorm)

- **Audience / scoping:** Admin sees the whole team + rankings. Evaluators see only
  their own numbers (reuse the `requireAuth()` + name-match scoping from
  `quick-stats`). No public cross-evaluator leaderboard for evaluators.
- **Metric domains:** `evaluation` (initial evaluation work) and `recording`
  (record-video work). A domain toggle switches the whole report.
- **Time granularity:** Week / Month / Quarter / Overall.
- **Time anchor = real timestamps, NOT the `batch` label.** `batch` is sparse
  (only set on `List_Idea` games), so it undercounts. Weeks are derived from
  `evaluate_date` (evaluation domain) and `record_confirmed_at` (recording domain),
  in `Asia/Ho_Chi_Minh`. Friendly labels ("W2 Jun 2026") are generated from the
  week-start date. Month/Quarter/Overall roll up from weeks.
- **Compute/cache = weekly rollup table + cron freeze.** Past weeks are immutable
  once computed; the current (and previous) week are recomputed on each cron run
  (cheap — one/two weeks). Read API only reads the rollup → fast, low cost.
- **Charting:** hand-rolled SVG/CSS, no new dependency (matches the app's existing
  inline-SVG style, keeps bundle/cost down). Light-only (app has no dark theme).

## Metrics catalog

Grouped by evaluator (`lower(initial_evaluator)` / recorder), sliceable by period.

**Evaluation domain** (rows with `evaluate_date IS NOT NULL`)
- **Volume** — count of evaluations
- **Throughput** — games ÷ active-days
- **Turnaround** — avg days `assigned_date → evaluate_date`
- **Trend** — % change vs previous comparable period
- **Conclusion distribution** — counts per `initial_conclusion` (excl. `Link_dead`)
- **Priority rate (discernment)** — share where `initial_conclusion ILIKE 'Priority%'`
- **Consistency** — active-days ÷ days-in-period

**Recording domain** (rows with `record_confirmed_at IS NOT NULL`)
- **Records done** — count of confirmed recordings. Recorders live in
  `record_5min_assignee` / `record_20min_assignee` (the flat `record_assignee`
  column is unused in prod); both slots are UNIONed, each filled slot = one record.
- **5min / 20min split** — derived from which slot is filled (the `record_bucket`
  column is too sparse to rely on).
- **Recording turnaround** — N/A: prod has no recording assign-date populated, so
  turnaround is left null for this domain.
- **Volume / trend** — over time

> **Discernment note:** initial evaluators almost never use "Priority" labels — the
> real positive signal is escalation vs bypass. The metric is therefore **Signal
> rate** = share of conclusions that are *not* a bypass (`List_Idea`, `Priority*`,
> …), not a literal "Priority rate".

Averages are stored as **sum + count** components so Month/Quarter/Overall
re-derive correctly (never average pre-averaged weeks).

## Sub-tabs

1. **Team Overview** — KPI cards (total games, avg throughput, active people, avg
   turnaround), volume-over-time bars, conclusion distribution donut, trend line.
   Evaluator role: team totals only, no per-person ranking.
2. **Leaderboard** (admin only) — ranked bars: volume, throughput, turnaround,
   priority rate, consistency; separate recorder ranking.
3. **Individual** — per-person deep dive (admin picks anyone; evaluator locked to
   self): KPIs, time series, conclusion mix, consistency, recording stats.
4. **Activity Heatmap** — week × person grid (games/week). Evaluator: own row only.

Radar chart from the reference dashboard is **dropped** (its axes lean on
note-quality scoring, which we're not doing).

## Data architecture

### `report_rollup` (migration 030)

Grain: `(period_week, category_group, evaluator, domain)`.

| Column | Type | Notes |
|---|---|---|
| `period_week` | DATE | Monday of the ISO week (VN tz) |
| `period_month` | TEXT | `YYYY-MM`, derived from `period_week` |
| `period_quarter` | TEXT | `YYYY-Qn`, derived from `period_week` |
| `category_group` | VARCHAR(20) | puzzle/arcade/simulation |
| `domain` | VARCHAR(12) | `evaluation` \| `recording` |
| `evaluator` | VARCHAR(100) | display name (mode of raw casings) |
| `evaluator_key` | VARCHAR(100) | `lower(evaluator)` — grouping key |
| `games` | INT | evaluations / records done |
| `active_days` | INT | distinct active dates that week |
| `turnaround_sum` | NUMERIC | Σ days assign→complete |
| `turnaround_count` | INT | # rows with both dates |
| `priority_count` | INT | evaluation only (Priority* conclusions) |
| `conclusions` | JSONB | `{conclusion: count}` (evaluation) / `{5min,20min,none}` (recording) |
| `computed_at` | TIMESTAMPTZ | last recompute |

PK: `(period_week, category_group, domain, evaluator_key)`.
Note: month/quarter `active_days` is summed from weeks — a slight approximation at
ISO-week/month boundaries; acceptable for a soft consistency metric.

### Cron: `POST /api/cron/report-rollup`

Guard: `x-webhook-secret` OR admin (same idiom as `push-evaluations`).
Body: `{ mode?: 'current' | 'all', week?: 'YYYY-MM-DD' }`.
- `current` (default): recompute the current + previous ISO week (both domains,
  all categories) via `INSERT … SELECT … ON CONFLICT DO UPDATE`.
- `all`: recompute every week present in the data (admin "Rebuild" button; run once).
- `week`: recompute a specific week.
Wire into the existing daily n8n orchestrator with `mode:current`, plus an admin
"Rebuild report" button for a full recompute.

### Read: `GET /api/report`

Guard: `requireAuth()`. Query: `period`, `category` (or `all`), `domain`,
`evaluator?`, `from?`, `to?`. Non-managers are name-scoped to themselves.
Reads only `report_rollup`, aggregates to the requested period in SQL, and returns
one bundle: `{ periods[], evaluators[], teamTotals, timeSeries[], heatmap, stale }`.
`stale:true` when the rollup is empty (prompts admin to Rebuild). Frontend renders
all four sub-tabs from the single payload.

## Pure logic (lib/report.ts) — unit-tested

- `weekStart(date)`, `weekLabel(date)` → "W2 Jun 2026"
- `monthKey(date)`, `quarterKey(date)`
- `mergeConclusions(rows)`, `rankBy(rows, metric)`, `pctChange(cur, prev)`
- `deriveMetrics(rollupRow[])` → volume/throughput/turnaround/priorityRate/consistency

## Files

- `migrations/030_report_rollup.sql`
- `lib/report.ts` + `__tests__/lib/report.test.ts`
- `app/api/cron/report-rollup/route.ts`
- `app/api/report/route.ts`
- `app/(manager)/report/page.tsx` + `components/report/*` (charts)
- `app/(manager)/layout.tsx` (nav), `middleware.ts` (matcher + role gate)

## Out of scope (v1)

Note-quality / Game Sense scoring, radar chart, moderator/final-evaluator
performance, dark mode, configurable scoring weights.
