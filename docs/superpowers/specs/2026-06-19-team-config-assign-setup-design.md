# Design: Team weights + Config genre→bucket + Assign Setup subtab

**Date:** 2026-06-19
**Status:** Design — pending implementation plan
**Author:** Khang / Claude

## Goal

Three related additions that move evaluator/assignment configuration toward the Postgres-native model
described in `docs/superpowers/specs/2026-06-18-db-game-split-assign-design.md`, while the Smartsheet/Sheet
pilot keeps running:

1. **Team tab** — add an editable **Weight** column (dropdown 30/50/70/100) to the Initial table,
   written back to the Evaluator List Google Sheet via n8n (Team stays sheet-backed).
2. **Config tab** — add a **Genre → Bucket** section: fixed buckets (puzzle/arcade/simulation) with an
   editable genre list per bucket. Adding a genre warns (non-blocking) if it has never appeared in the DB.
   Backed by the existing `category_mappings` table (migration 015).
3. **Evaluations → "Assign Setup" subtab** — a DB-backed roster editor that prepares the future BE-side
   game split/assign. Three bucket tabs (puzzle/arcade/simulation), each with Initial + Final lists,
   editing `evaluator_roster` directly. **Assign Setup is the sole writer of `evaluator_roster`.**

This does NOT implement the BE split/assign cron routes (`push-evaluations` / `assign-evaluators`) — those
remain a later phase. Assign Setup only prepares the roster config those routes will consume.

## Background — current state

- **Team tab** (`app/(manager)/team/page.tsx`) reads/writes the **Evaluator List Google Sheet** through n8n
  webhooks: `GET /api/team/initial` (env `WEBHOOK_TEAM_INITIAL_GET`), plus write-backs
  `/api/team/initial/availability`, `/api/team/initial/platform`, `/api/team/initial/append`,
  `/api/team/initial/remove`, and the Final equivalents. The Initial table columns today are
  Name · Today Available · Game Platform · Game Category. There is **no Weight column** in the sheet flow.
- **Config tab** (`app/(manager)/config/page.tsx` + `/api/config`) edits `config_options` (conclusion /
  final_conclusion). The `category_mappings` table (migration 015) already exists and is seeded
  (puzzle=puzzle,word,trivia,music,casual · arcade=arcade,adventure,action · simulation=simulation,strategy)
  but has **no UI yet** — section 4 of the 2026-06-18 spec.
- **`evaluator_roster`** (migration 008) — `id, list_type(initial|final), name, today_available,
  game_platform, game_category VARCHAR(50), sort_order, updated_at, UNIQUE(list_type, name)`. Plus
  `weight INT DEFAULT 100` (migration 011). It is **not** read by the Team tab (Team reads the sheet
  directly). Going forward, Assign Setup is its sole writer; no n8n sheet→roster sync runs.
- **`game_info`** (external Postgres, cred `KBZC0RGIJsc8d7GK`) — `metadata` JSON with `.categories` array
  of category names (e.g. `Puzzle`, `Word`). Used to validate genres exist in the DB.
- **Nav** (`app/(manager)/layout.tsx`) — Evaluations has child items via `?cat=` query param
  (Puzzle / Arcade / Simulation / Short List). `app/(manager)/evaluations/page.tsx` dispatches on
  `searchParams.get('cat')` (default `puzzle`; `short_list` → `ShortListEvalTab`).
- **Roles** — admin / moderator / evaluator (recent gating alignment, commit `63c287f`).

## Decisions (confirmed)

1. **Roster model:** per-bucket rows — add `category_group` to `evaluator_roster`. Same person may appear in
   multiple buckets as separate rows with independent avail/platform/category/weight.
2. **Data target:** Assign Setup reads/writes `evaluator_roster` directly. It is the real config the future
   `/api/cron/assign-evaluators` consumes and the **sole writer** of the table (no n8n sheet→roster sync).
3. **New-user provisioning:** a brand-new id (not in recommendations) → email `<id>@athena.studio` → create
   `dashboard_users` row (role `evaluator`) if missing, then add the roster row.
4. **Final list:** full parity with Initial (avail, platform, category, weight) — per bucket.
5. **Category options:** the multi-select in a bucket tab lists only **that bucket's** genres (from
   `category_mappings` active rows for that `category_group`); sentinel **`All`** = all of the bucket's genres.
6. **Team weights:** I wire UI + `/api/team/initial/weight` route → `WEBHOOK_TEAM_INITIAL_WEIGHT`. The
   sheet `Weight` column + the n8n write-back webhook are added by the user.
7. **Recommend source:** the add-eval autocomplete suggests from `dashboard_users` (all users), by name /
   email-prefix.

## Components

### 1. Migration 016 — `evaluator_roster` per-bucket

```sql
ALTER TABLE evaluator_roster ADD COLUMN IF NOT EXISTS category_group TEXT;
UPDATE evaluator_roster SET category_group = 'puzzle' WHERE category_group IS NULL;  -- pilot is puzzle
ALTER TABLE evaluator_roster ALTER COLUMN category_group SET NOT NULL;
ALTER TABLE evaluator_roster ALTER COLUMN game_category TYPE TEXT;   -- multi-select needs > 50 chars
ALTER TABLE evaluator_roster DROP CONSTRAINT IF EXISTS evaluator_roster_list_type_name_key;
ALTER TABLE evaluator_roster ADD CONSTRAINT evaluator_roster_bucket_name_key
  UNIQUE (list_type, category_group, name);
```

- `category_group ∈ {puzzle, arcade, simulation}` (matches `category_mappings.category_group` buckets).
- `game_category` stores the multi-select as the sentinel string `'All'` **or** a comma-joined list of
  genre names (e.g. `puzzle,word`). `weight` already exists (migration 011), default 100; UI offers
  30/50/70/100.
- Backfill default `'puzzle'` because the live pilot bucket is puzzle. Verify the actual constraint name
  in the DB before dropping (the literal above is Postgres' default for `UNIQUE(list_type, name)`).

### 2. Config tab — "Genre → Bucket" section + `/api/config/categories`

**Route `app/api/config/categories/route.ts`** (mirrors `/api/config` semantics; admin+moderator writes):
- `GET` → active mappings grouped by `category_group` (any auth).
- `GET?manage=1` → full rows incl. inactive (admin+mod).
- `POST { genre, category_group }` → insert (`ON CONFLICT (genre, category_group) DO NOTHING`).
- `PATCH { id, active }` → toggle (rename not needed — genre is the value; delete+add instead).
- `DELETE { id }` → remove a mapping.
- `GET?check=<genre>` → genre-existence probe: `SELECT 1 FROM game_info WHERE EXISTS (SELECT 1 FROM
  jsonb_array_elements_text(metadata->'categories') c WHERE lower(c) = lower($1)) LIMIT 1`. Returns
  `{ exists: boolean }`. (Read-only; admin+mod.)

**UI** (new section in `app/(manager)/config/page.tsx`): one card per bucket (puzzle/arcade/simulation),
each listing its genres with a delete (✕) and On/Off toggle, plus an "Add genre" text input. On add:
1. call `GET?check=<genre>`;
2. if `exists=false`, show a non-blocking inline ⚠️ ("genre not found in DB — add anyway?") with a confirm;
3. on confirm (or if it exists), `POST` the mapping and refresh.

Buckets are fixed in the UI (no add-bucket control this round). A `hooks/useCategoryMappings.ts` client hook
fetches active mappings for reuse by Assign Setup's category multi-select.

### 3. Team tab — Weight column

- **Migration:** none (sheet-backed).
- **Route `app/api/team/initial/weight/route.ts`** — `POST { row_number, weight }` → forwards to
  `WEBHOOK_TEAM_INITIAL_WEIGHT` (new env var), mirroring `app/api/team/initial/platform/route.ts`. Validate
  `weight ∈ {30,50,70,100}`. admin+moderator guard.
- **GET transform:** `app/api/team/initial/route.ts` maps the sheet's `Weight` column → `weight: number`
  (default 100 when blank), and the `InitialEvaluator` interface gains `weight`.
- **UI:** new "Weight" column in the Initial table with a `StyledSelect` (30/50/70/100) + the existing
  dirty→Confirm pattern (`pendingWeight` / `savingWeight`), identical to Platform. Add-row form gains a
  weight select (default 100).
- **User-side (out of code scope):** add a `Weight` column to the Evaluator List sheet and an n8n webhook
  that writes it; set `WEBHOOK_TEAM_INITIAL_WEIGHT`.

### 4. Evaluations — "Assign Setup" subtab

**Nav** (`app/(manager)/layout.tsx`): add child `{ href: '/evaluations?cat=assign_setup',
label: 'Assign Setup', roles: ['admin','moderator'] }` under Evaluations.

**Dispatch** (`app/(manager)/evaluations/page.tsx`): when `cat==='assign_setup'`, render a new
`<AssignSetupTab/>` (new file `components/AssignSetup.tsx` to keep `page.tsx` from growing further).

**`AssignSetupTab`:**
- Internal bucket tabs: Puzzle / Arcade / Simulation (local state, default puzzle).
- For the active bucket, two tables — **Initial** and **Final** — each rendering rows for that
  `(category_group, list_type)`. Columns: Name · Today Available (Yes/No) · Platform (all/ios/android) ·
  Category (multi-select) · Weight (30/50/70/100) · Remove. Edits use the same dirty→Confirm pattern as Team,
  or save-on-change — implementer's choice, consistent across fields.
- **Category multi-select:** a popover/tickbox listing the active genres of the current bucket (from
  `useCategoryMappings`), plus an **All** option at top. Selecting All clears specific picks; selecting any
  specific genre clears All. Stored as `'All'` or comma-joined genres.
- **Add eval:** an input with autocomplete suggesting `dashboard_users` (name + email-prefix). 
  - Pick a suggestion → POST adds the roster row for `(bucket, list_type)`.
  - Type a value not matching any suggestion → on Add, POST with a `provision: true` flag; the route builds
    `<id>@athena.studio`, upserts `dashboard_users` (role `evaluator`) if absent, then inserts the roster row.

**Routes** (`app/api/assign-setup/...`, admin+moderator):
- `GET ?group=<bucket>` → `{ initial: RosterRow[], final: RosterRow[] }` from `evaluator_roster`.
- `GET /api/assign-setup/recommend?q=<text>` → matching `dashboard_users` (name/email-prefix, limit ~10).
- `POST` `{ category_group, list_type, name, today_available, game_platform, game_category, weight,
  provision? }` → optional `dashboard_users` upsert (when `provision`), then
  `INSERT INTO evaluator_roster (...) ON CONFLICT (list_type, category_group, name) DO NOTHING`.
- `PATCH` `{ id, field, value }` → update a single field (`today_available` | `game_platform` |
  `game_category` | `weight`). Validate enums/weights.
- `DELETE` `{ id }` → remove a roster row.

## Architecture / data flow

```
Config tab ──► /api/config/categories ──► category_mappings (genres per bucket)
                       │  GET?check=<genre> ──► game_info.metadata.categories (existence warning)
                       └──► useCategoryMappings (client hook)
                                   │
Assign Setup ──► /api/assign-setup ──► evaluator_roster   (sole writer; per (bucket, list_type))
   add new id ──► dashboard_users upsert (<id>@athena.studio, role evaluator)
   category multi-select ◄── useCategoryMappings (bucket's genres + All)

Team tab ──► /api/team/initial/weight ──► WEBHOOK_TEAM_INITIAL_WEIGHT (n8n) ──► Evaluator List Sheet
         ◄── /api/team/initial (GET) maps sheet Weight → weight

[later phase] /api/cron/assign-evaluators reads evaluator_roster (prepared here)
```

## Error handling

- All write routes: missing/invalid auth → 401/403 (`requireRole(['admin','moderator'])`). Invalid enum /
  weight → 400. Webhook failures (Team weight) → 502, surfaced as an inline error like the existing Team
  write-backs.
- Genre-existence check is **advisory only** — a `false` never blocks the add; it only shows a warning.
- Add-eval is idempotent via `ON CONFLICT DO NOTHING`; `dashboard_users` upsert is idempotent on email.
- `category_mappings` toggle/delete only affects future option lists — existing `evaluator_roster.game_category`
  strings are kept verbatim (no bulk rewrite), consistent with the `config_options` rename decision.

## Testing

- **Migration 016:** apply on a snapshot; verify backfill (`category_group='puzzle'`), new unique constraint
  allows the same name across buckets but blocks dup within a (bucket, list_type), and `game_category` holds
  long multi-genre strings.
- **`/api/config/categories`:** auth gate; add/toggle/delete; `?check` returns correct exists/false for a
  known vs invented genre.
- **Team weight:** GET maps blank→100; POST validates the 30/50/70/100 set; webhook error → 502.
- **Assign Setup:** GET groups by bucket+list_type; POST with `provision` creates `dashboard_users` once and
  is idempotent on re-add; PATCH updates a single field; multi-select All vs specific round-trips correctly.
- **Manual:** add an evaluator to Puzzle Initial and the same person to Arcade Initial with different
  platform/weight; confirm both persist independently and surface in `evaluator_roster`.

## Risks / assumptions

- **Sole-writer assumption:** confirmed — no n8n flow writes `evaluator_roster`. If one is later added it
  must be disabled to avoid clobbering Assign Setup edits.
- **Constraint name:** the `DROP CONSTRAINT` uses Postgres' default name for `UNIQUE(list_type, name)`;
  verify the live name (`\d evaluator_roster`) before applying.
- **Genre name matching:** the `?check` probe and `category_mappings.genre` compare case-insensitively
  against `game_info.metadata.categories`; genres must match the names emitted by the import pipeline.
- **No migrate script in repo:** migration 016 is applied manually via the Supabase SQL editor (same as
  014/015).
- **Pilot coexistence:** Team tab (sheet) and Assign Setup (DB) describe two different stores during the
  pilot; they are not synced. That is intentional until the later cut-over.
```
