# Flow History Tree — Design Spec
Date: 2026-04-21

## Overview

Redesign the Games History section in the dashboard from a flat list into a lazy-loading tree (Year → Month → Day) with a Refresh button. Pull and Push entries are unified per day.

---

## Features

### 1. Lazy-Loading Tree Structure

**Year level (initial load)**
- On dashboard open, fetch distinct years that have data: `GET /api/flow-logs/years`
- Renders as collapsible rows: `▸ 2026  (click to load)`
- No data loaded for months/days yet

**Month level (on year click)**
- Clicking a collapsed year: `GET /api/flow-logs/months?year=2026`
- Returns list of months that have data (e.g. `[4, 3, 2]` for April, March, February)
- Renders month rows under the year: `▸ April  click to load`
- Already-loaded years are cached in component state — re-clicking does not re-fetch

**Day level (on month click)**
- Clicking a collapsed month: `GET /api/flow-logs/month?year=2026&month=4`
- Returns all entries for that month, grouped by day
- Renders day rows (collapsed by default, today auto-expanded)
- Already-loaded months are cached — re-clicking does not re-fetch

**Day entries**
Each day row expands to show:
- Pull Morning — total, iOS, Android
- Pull Afternoon — total, iOS, Android
- Push Morning — total per sheet (puzzle/arcade/simulation)
- Push Afternoon — total per sheet
- Pull rows use green badge (`#7A8C1E`), Push rows use brown badge (`#5A3E1B`)

### 2. Refresh Button

- Located in the Games History section header
- On click: `POST /api/flow-logs/refresh` (existing endpoint — snapshots current pull counts)
- After refresh responds: re-fetch today's month (reload `entriesByMonth["YYYY-M"]` for current month) to show the new snapshot
- Shows spinner while refreshing

### 3. Scroll Container

- Fixed-height scrollable container (height: ~350px, `overflow-y: auto`)
- Tree content scrolls inside — page layout does not shift

---

## API Changes

### New endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/flow-logs/years` | Returns `number[]` — distinct years with data, desc |
| GET | `/api/flow-logs/months?year=YYYY` | Returns `number[]` — distinct months for year, desc |
| GET | `/api/flow-logs/month?year=YYYY&month=M` | Returns grouped entries for that month |

**`/api/flow-logs/month` response shape:**
```ts
Array<{
  log_date: string          // "2026-04-21"
  entries: Array<{
    flow_type: 'pull' | 'push'
    period: 'morning' | 'afternoon'
    total: number
    detail: Record<string, number>  // platform (pull) or sheet (push)
    created_at: string
  }>  // entries sorted: pull before push, morning before afternoon
}>

```

All new routes require `manager` role via `requireRole`. All have `export const dynamic = 'force-dynamic'`.

### Existing endpoints (unchanged)
- `POST /api/flow-logs/refresh` — still used for the Refresh button
- `GET /api/flow-logs` — kept for backward compat but no longer used by dashboard

---

## Component Changes

### `FlowHistory.tsx` — full rewrite

**State:**
```ts
years: number[] | null                        // null = not loaded
monthsByYear: Record<number, number[] | null> // null = not loaded
entriesByMonth: Record<string, DayGroup[]>    // key = "YYYY-M"
openYears: Set<number>
openMonths: Set<string>                       // "YYYY-M"
openDays: Set<string>                         // "YYYY-MM-DD"
refreshing: boolean
```

**Behavior:**
- `loadYears()` on mount
- `loadMonths(year)` on year click (skip if already loaded)
- `loadMonth(year, month)` on month click (skip if already loaded)
- Today's date auto-opens its year, month, and day on first load
- Refresh button: calls `/api/flow-logs/refresh`, then reloads open months

**Props:** none (self-contained, fetches its own data)

### `dashboard/page.tsx`

- Remove `flowHistory` state and its fetch from `fetchData()`
- Remove `FlowHistory` prop passing — component is now self-contained
- Keep `<FlowHistory />` in JSX with no props

---

## Error Handling

- Failed year/month fetch: show inline error text with retry button
- Empty month: show "No data for this month"
- Refresh failure: show brief error, spinner stops

---

## Out of Scope

- Filtering by pull/push type
- Exporting data
- Pagination within a month (months are small enough to load fully)
