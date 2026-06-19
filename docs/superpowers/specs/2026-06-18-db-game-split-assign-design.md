# Design: Move game split + evaluator assignment into Postgres

**Date:** 2026-06-18
**Status:** Design — pending implementation plan
**Author:** Khang / Claude

## Goal

Move the **game-splitting (genre → evaluation bucket) + `game_evaluations` row creation + evaluator
assignment** off Google Sheets and Smartsheet into Postgres + Next.js. Drop the `categories_list` and
"Imported Game IDs" Google Sheets and the DB→Smartsheet push-back. Run alongside the existing Smartsheet
flow as a **pilot** (one team on the site, one team on Smartsheet), then cut over fully later.

This is the "push/split game in backend" migration that `migration 014` explicitly deferred.

## Background — current state (audit)

### Import pipeline (KEEP — unchanged)
n8n scheduled orchestrator → **Category Processor** (per OS, reads platform config from Google Sheet
`15J_ENHIKsGJV3ipyIAzM92pK5P6nms8QiOH-hQnQRGQ`) → fetches SensorTower app IDs over 3/15/30-day lookbacks →
**Batch Processor** ("SQL Check - New Games Only" against `game_info`) → **Import Daily Game** maps
SensorTower (`7xxx`) / Google Play (`game_xxx`) category IDs to category **names** and upserts into
`game_info` (`metadata.categories` = array of names like `Puzzle`, `Word`, `Arcade`, `Simulation`).

`game_info` (external, Signal-Sense-Pack; Postgres cred `KBZC0RGIJsc8d7GK`) relevant columns:
`game_id` (PK), `title`, `publisher_id`, `os`, `icon_url`, `app_link`, `metadata` (JSON, `.categories`
array of names), `initial_release`, `update_release`, `temp_release`, `type`, `is_active`,
`publisher_country`.

### Split + evaluate pipeline (REPLACE)
- Games split into **puzzle / arcade / simulation** via `categories_list` config in the **"N8N configs"**
  Google Sheet + the **"[Signal] Imported Game IDs"** sheet (`1uY2BgcS2_r3uPghBPn4pyV9q66QSapkJPXOBoZgiank`,
  tabs per bucket) → pushed to 3 Smartsheet sheets.
- Smartsheet sheet IDs: puzzle `2184120410001284`, arcade `3926172768358276`, simulation `7899099241074564`.
- **`smartsheet-db-update-sync`** (daily 06:00 + manual) is now the **only** sync direction:
  Smartsheet→DB, upsert into `game_evaluations` with `COALESCE` (Smartsheet non-null wins, NULL never
  erases; app-only columns `final_*`, `record_*`, screenshots never touched). StoreKit images →
  `/api/admin/import-screenshots`.
- DB→Smartsheet push-back (`db-to-smartsheet-eval-sync`) is **retired** — no longer used.

### Already in Postgres (REUSE)
- `game_evaluations` — eval store, `UNIQUE(game_id, category_group)`, `category_group ∈
  {puzzle, arcade, simulation}`.
- `evaluator_roster` — `list_type` (initial/final), `name`, `today_available`, `game_platform`,
  `game_category`, `weight`, `sort_order`.
- `config_options` — editable dropdown lists (conclusion / final_conclusion), CRUD via `/api/config`.
- `lib/assign-evaluators.ts` — weighted largest-remainder assignment (partial).
- `lib/config.ts`, `lib/db.ts` (`postgres` client, `DATABASE_URL`).

## Decisions (confirmed)

1. **Execution:** Next.js cron API routes (reuse `lib/config`, `evaluator_roster`, `lib/assign-evaluators`).
2. **Category mapping:** editable in the **Config tab** (new table + UI, like `config_options`).
3. **Smartsheet:** keep running as **pilot** (site team + Smartsheet team). Sync is **Smartsheet→DB only**.
   Cut over (disable Smartsheet flows) in a later phase.
4. **Trigger:** n8n orchestrator calls the Next.js routes (HTTP) after `Import Daily Game` completes.
5. Eval store stays **`game_evaluations`** (no second eval table). Only a new `category_mappings` config
   table is added.
6. During pilot, DB push creates rows for **all** eligible games (site = full mirror); dedupe via the
   unique constraint.

## Architecture

```
n8n (KEEP)                         Next.js app (NEW logic)            Postgres
─────────                          ───────────────────────            ────────
SensorTower import ──► game_info
        │
        └─(HTTP, CRON_SECRET)─► POST /api/cron/push-evaluations ──► game_evaluations (insert split rows)
                                       │  reads category_mappings, game_info
        └─(HTTP, CRON_SECRET)─► POST /api/cron/assign-evaluators ──► game_evaluations (set initial_evaluator)
                                       │  reads evaluator_roster, lib/assign-evaluators

Smartsheet (pilot) ──► smartsheet-db-update-sync (Smartsheet→DB only) ──► game_evaluations (COALESCE upsert)
```

## Components

### 1. `category_mappings` table (migration 015) — replaces `categories_list` sheet

| column | type | notes |
|--------|------|-------|
| id | SERIAL PK | |
| genre | TEXT NOT NULL | a category **name** as stored in `game_info.metadata.categories` (e.g. `Puzzle`, `Word`) |
| category_group | TEXT NOT NULL | target bucket (`puzzle` / `arcade` / `simulation`; extensible) |
| priority | INT NOT NULL DEFAULT 0 | when a game matches multiple buckets, highest priority wins |
| active | BOOLEAN NOT NULL DEFAULT true | |
| created_at | TIMESTAMPTZ DEFAULT now() | |
| UNIQUE(genre, category_group) | | |

Index: `(active, category_group, priority DESC)`.

- The set of buckets is the distinct `category_group` over active rows — adding a bucket = adding rows.
- **Seed:** dump the current `categories_list` mapping from the "N8N configs" Google Sheet (implementation
  task — must read the live sheet; do not invent). Genre names must match the mapped names emitted by
  Import Daily Game's "Convert Category Name" node.

### 2. `POST /api/cron/push-evaluations` (NEW)

- Auth: `CRON_SECRET` header (shared with n8n). 401 otherwise.
- Select eligible games from `game_info` **not yet** in `game_evaluations` for their computed bucket.
  Eligibility (port from current Smartsheet push / `db-push-assign` plan — confirm exact rules against
  the live flow during implementation):
  - has `app_link`
  - `type` is not `invalid_countries` (and any other excluded types)
  - release-date window (recently released/updated)
  - `metadata.categories` overlaps at least one active `category_mappings.genre`
- Compute `category_group`: join `metadata.categories` → `category_mappings`, pick the match with the
  highest `priority` (deterministic tie-break by `category_group`).
- `INSERT INTO game_evaluations (game_id, category_group, imported_at) ... ON CONFLICT (game_id,
  category_group) DO NOTHING`.
- Return `{ inserted_by_bucket: {puzzle, arcade, simulation, ...}, total }`. Log to `operation_logs`
  (and/or `game_flow_logs` flow_type='pull').

### 3. `POST /api/cron/assign-evaluators` (NEW)

- Auth: `CRON_SECRET` header.
- For rows with `initial_evaluator IS NULL`, group by `category_group` (+ platform from `game_info.os`),
  run `lib/assign-evaluators.ts` against `evaluator_roster` (`list_type='initial'`, `today_available`,
  `game_platform`, `weight`). Set `initial_evaluator` + `assigned_date`.
- Idempotent: only fills NULL assignees; re-running never reassigns.
- Return `{ assigned_by_evaluator, total }`. Log to `operation_logs` / `daily_stats.games_assigned`.

> **NOTE (per-bucket assignment on/off — add config later, implement later):** Today assignment runs
> for **puzzle only**. Need a per-bucket toggle (in `app_config` or a Config-tab "Operations" section)
> to enable/disable auto-assign per bucket (puzzle / arcade / simulation / future), so push and assign
> can be turned on independently per bucket during rollout. Note now; build later.
>
> **NOTE (final evaluators):** `assignGames` only assigns the **initial** evaluator. `evaluator_roster`
> `list_type='final'` is currently **empty** — final assignment is a separate, rarely-used moderator
> step (manual). If auto final-assign is wanted, populate the final roster and add separate logic.
>
> **NOTE (category filtering):** `lib/assign-evaluators.ts` currently uses platform + weight only; it
> does **not** filter by `evaluator_roster.game_category`. Add category-aware assignment only if needed.
>
> **NOTE (improved "balanced" algorithm — DEFERRED, pilot still on Smartsheet):** The current
> `lib/assign-evaluators.ts` (ported from n8n `assigned2`) has two quirks confirmed in dry-runs:
> (1) `all`-platform evaluators get a lopsided platform mix (Phase 2 slices the remaining pool in
> order, not balanced); (2) when a platform is scarce, platform-only evaluators are filled
> first-come (first evaluator grabs all, the rest get 0). A `assignBalanced` variant was prototyped
> and verified that fixes both: `all` evaluators receive ios/android **proportional to the remaining
> pool**, and a scarce platform is **split evenly by weight** among its platform-only evaluators
> (e.g. 20 ios between two ios-only w100 → 10/10, not 20/0); overflow of the other platform flows to
> `all`; with no `all` evaluator the surplus is reported as unassigned. **Do not apply yet** — half
> the team still evaluates on Smartsheet (Smartsheet keeps pushing/splitting; Smartsheet→DB sync
> brings their work over gradually). Apply `assignBalanced` to `lib/assign-evaluators.ts` when the
> DB-side assignment actually goes live (Phase A enablement / cut-over).

### 4. Config tab — "Category Mapping" section (NEW UI + route)

- New route `/api/config/categories` (GET manage list, POST add, PATCH rename/toggle/reorder-priority,
  DELETE) mirroring `/api/config` semantics. Admin + moderator only for writes.
- UI section in the Config tab: table of genre → bucket rows, add/edit/activate/reorder, add new bucket.
- Keeps the genre→bucket rules editable at runtime, replacing the "N8N configs" sheet.

### 5. n8n changes (minimal)

- In the orchestrator, after `Import Daily Game`: add two HTTP Request nodes →
  `POST {APP_URL}/api/cron/push-evaluations` then `POST {APP_URL}/api/cron/assign-evaluators`
  (header `x-cron-secret`). Sequential (push before assign).
- **Keep** the Smartsheet push flow and `smartsheet-db-update-sync` running during pilot. Do **not** wire
  `db-to-smartsheet-eval-sync` (retired).

### 6. Evaluator roster in DB (completes "move evaluator config")

- `evaluator_roster` is already in DB. Add a management UI (Config or Users Management tab) for
  availability / weight / platform / category so the "Evaluator List" Google Sheet dependency can be
  dropped. After this, n8n no longer needs to sync the roster sheet.

## Phasing

- **Phase A** — `category_mappings` (migration 015) + `/api/config/categories` + Config UI +
  `push-evaluations` + `assign-evaluators` + n8n trigger nodes. Runs **alongside** Smartsheet pilot.
- **Phase B** — Evaluator roster management UI; retire the Evaluator List sheet sync.
- **Phase C** (cut-over, later) — disable Smartsheet push flow, "Imported Game IDs" + "N8N configs"
  sheets, and `smartsheet-db-update-sync`. n8n left with: SensorTower import + trigger API.

## Error handling

- Cron routes: bad/missing `CRON_SECRET` → 401. DB errors → 500 with logged message; n8n surfaces to
  Google Chat via its Error Trigger (space `spaces/AAQAYTKWM1I`).
- `push-evaluations`: games whose genres match no active mapping → counted as `unmapped`, not inserted,
  returned in the summary (no silent drop).
- Both routes idempotent — safe to retry. Unique constraint + NULL-only assignment prevent duplicates /
  reassignment.

## Testing

- `lib/assign-evaluators.ts`: unit tests for weighted split (largest-remainder, platform/category
  filtering, `today_available`, zero-available edge case).
- Category resolution: unit test for multi-genre games (priority tie-break) and unmapped genres.
- Route tests: auth gate (401), idempotency (re-run inserts/assigns nothing new), `ON CONFLICT` dedupe.
- Manual: run push then assign on a snapshot; verify per-bucket counts and that Smartsheet→DB sync still
  converges (no clobber of app edits for site-team games).

## Risks / assumptions

- **Pilot double-edit:** `smartsheet-db-update-sync` uses `COALESCE` (Smartsheet non-null overwrites DB).
  A game must be actively evaluated by only **one** team. Operational rule, documented; not enforced by
  code in Phase A.
- **Seed accuracy:** `category_mappings` seed must come from the live "N8N configs" sheet; genre names
  must exactly match Import Daily Game's mapped names. Verify before relying on it.
- **Eligibility parity:** the exact eligibility rules must be read from the current Smartsheet push flow
  during implementation so DB push selects the same games.
