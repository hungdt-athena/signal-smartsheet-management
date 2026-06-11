# Evaluations Load Optimization — Design

**Date:** 2026-06-11
**Scope:** `/api/evaluations` (GET), Evaluations page, Short List tab (Videos page)

## Problem

Evaluation data has grown. Current loading is wasteful:

1. **Double-fetch on page open.** Evaluations page first fetches with *All months* (full-table scan + count), then sets the default month from `available_months[0]` and refetches. The heaviest request is thrown away.
2. **Heavy list payload.** The list query selects `gi.metadata->'screenshot_urls'` and `categories` for every row, but the table never renders them. Screenshots are only needed in the detail modal, which already loads its own data via `/api/evaluations/[gameId]`.
3. **Redundant side queries.** `available_months`, `available_conclusions`, and `count` run on every infinite-scroll page (2, 3, 4…) even though their results don't change.
4. **Wrong stats.** Stats cards (Total / Evaluated / Pending / Dead Links) are computed client-side from loaded rows only — incorrect once data exceeds one page (200 rows).
5. **Short List tab** has the same `filterMonth = null` default → loads all months with `limit=500`.

## Decisions (confirmed with user)

- All month pickers default to the **current month/year**; if the current month has no data, **fall back to the most recent month that has data**.
- Scope: **Evaluations page + Short List tab**. (YouTube tab untouched this round.)
- The detail modal keeps its lazy-load-on-open behavior (already correct).

## Design

### 1. API — `GET /api/evaluations`

**a. `month=auto` (server-resolved default month)**
- When the client sends `month=auto` (no `year`), the server resolves the month: current month (Asia/Ho_Chi_Minh, UTC+7) if it appears in `available_months`, otherwise `available_months[0]` (most recent with data). If there is no data at all, no month filter is applied.
- The resolved month is returned as `applied_month: { year, month } | null` in the response. Explicit `year`+`month` params keep working unchanged.
- Implementation note: the `available_months` query must run **before** the list/count queries in the auto case (it determines the month filter), so the auto path is: months query → resolve month → list + stats in parallel.

**b. Slim list payload**
- Remove `gi.metadata->'screenshot_urls'` and `gi.metadata->'categories'` from the list SELECT. The detail endpoint (`/api/evaluations/[gameId]`) keeps returning them.
- Drop `screenshot_urls` from the page's `Evaluation` interface (unused in the table).
- Keep all `record_*` columns — Short List tab renders them.

**c. Page-1-only meta queries**
- `available_months`, `available_conclusions`, and the stats/count query run **only when `page === 1`**. For `page > 1`, the API runs the list query alone and returns `data` (client already has `total` and meta). Filter changes always reset to page 1, so meta stays fresh.

**d. Single stats query (replaces bare count)**
```sql
SELECT count(*)::int AS total,
       count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL)::int AS evaluated,
       count(*) FILTER (WHERE ge.initial_conclusion = 'Link_dead')::int AS dead_links
FROM game_evaluations ge
WHERE <same filters as list>
```
Returned as `stats: { total, evaluated, pending, dead_links }` (`pending = total - evaluated`). `total` stays at the top level too, for compatibility with other consumers (assign-records page, YouTube tab) until they're migrated.

### 2. Evaluations page (`app/(manager)/evaluations/page.tsx`)

- Remove the `monthInitialized` / `available_months[0]` two-step. First fetch sends `month=auto`; on response, set `filterMonth` from `applied_month` **without retriggering a fetch** (track an `autoApplied` ref so the `filterMonth` effect skips the echo).
- User picking a month sends explicit `year`/`month`; picking "All" sends neither (and not `auto`).
- Stats cards read from `json.stats` (full filtered counts) instead of computing from loaded rows.
- Infinite scroll unchanged, but pages > 1 receive only `data`.

### 3. Short List tab (`app/(manager)/youtube/page.tsx` → `ShortListTab`)

- Same `month=auto` first fetch + `applied_month` sync.
- Keep single `limit=500` fetch (Assign/Review/Extract modals need the full in-scope list); now scoped to one month with a slim payload.
- Top stat cards (Total/Assigned/Unassigned/With Drive) keep client-side computation — the tab loads its full filtered set in one request, so the counts are correct as-is.

### 4. DB index

New migration `009_eval_list_index.sql`:
```sql
CREATE INDEX IF NOT EXISTS idx_game_evaluations_cat_assigned
  ON game_evaluations(category_group, assigned_date DESC);
```
Every list/stats/months query filters on `category_group` and filters/sorts on `assigned_date`. Existing `idx_game_evaluations_unassigned` is partial (`WHERE initial_evaluator IS NULL`) and doesn't cover this.

Month filtering currently uses `EXTRACT(YEAR/MONTH FROM assigned_date)`, which defeats the index for the month predicate. Rewrite the month filter to a range: `assigned_date >= make_date(y, m, 1) AND assigned_date < make_date(y, m, 1) + interval '1 month'`.

## Non-goals

- YouTube tab and assign-records page refactors (they keep working — `total`, `available_months`, `conclusion_options` remain in page-1 responses).
- Changing the detail modal's prefetch behavior.
- Server-side search (search stays client-side over loaded rows).

## Error handling

- `month=auto` with empty table → `applied_month: null`, empty data, no error.
- Invalid `year`/`month` params → ignored (current behavior, `parseInt || 0`).

## Testing

- API: page 1 with `month=auto` returns `applied_month` = current month when data exists there; falls back when not; `page=2` response has no `stats`/`available_months`; list rows contain no `screenshot_urls`.
- UI: open Evaluations page → exactly **one** `/api/evaluations` request; picker shows resolved month; stats match SQL counts; scrolling appends pages; switching month/filters refetches page 1 with meta.
- Short List: opens scoped to resolved month; assign modals still receive the full filtered list.
