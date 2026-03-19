# Admin Dashboard — Technical Design Spec
> Date: 2026-03-19
> Status: Draft v2 — Post spec review fixes

---

## Overview

A centralized management site for the Athena/Signal automation ecosystem. Replaces fragmented monitoring across Google Chat, Google Sheets, Smartsheet, and manual n8n triggers.

**Principle:** Dashboard is UI + DB only. All external API calls (Drive, Smartsheet, Sheets) go through n8n webhooks — credentials stay in n8n.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 14 (App Router) |
| Runtime | Node.js 20 on Replit |
| Auth | NextAuth.js + Google OAuth |
| Database | Neon PostgreSQL (existing, read/write) |
| DB Client | postgres.js (raw SQL) |
| Styling | Tailwind CSS |
| Data fetching | useEffect + setInterval (10s polling, active-trigger only) |

---

## Authentication & Authorization

### Google OAuth Flow
1. User hits site → redirect to `/login`
2. Click "Login with Google" → NextAuth Google OAuth
3. Callback: check `users` table by email
4. If found: set `{ id, email, name, role }` in session → redirect by role
   - `manager` → `/dashboard`
   - `evaluator` → `/handover`
5. If not found: redirect to `/login?error=unauthorized`

### Route Protection — `middleware.ts`

```
/dashboard/*    → requires role = manager
/operations/*   → requires role = manager
/team/*         → requires role = manager
/youtube/*      → requires role = manager
/handover/*     → requires role = evaluator
/drive-videos/* → requires role = evaluator
/api/stats      → requires role = manager (session)
/api/logs GET   → requires role = manager (session)
/api/logs POST  → requires WEBHOOK_SECRET header (see Security)
/api/workflows/* → requires role = manager (session)
/api/evaluators/* → requires role = manager (session)
/api/handover   → requires role = evaluator (session) — both GET and POST
/api/youtube/*  → requires role = manager (session)
```

Unauthenticated requests to protected routes → redirect to `/login`.
Wrong role → redirect to role's default page.

### Role Matrix

| Feature | Manager | Evaluator |
|---------|---------|---------|
| Dashboard tab | ✅ | ❌ |
| Operations tab | ✅ | ❌ |
| Team tab | ✅ | ❌ |
| YouTube tab | ✅ | ❌ |
| Handover page | ❌ | ✅ |
| Drive Videos page | ❌ | ✅ (future) |

---

## Database Schema

### New table: `users`
```sql
CREATE TABLE users (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) UNIQUE NOT NULL,
  name       VARCHAR(255),
  role       VARCHAR(20) NOT NULL CHECK (role IN ('manager', 'evaluator')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```
Manually populated by admin before launch. Google OAuth validates email against this table.

### New table: `ops_logs`
```sql
CREATE TABLE ops_logs (
  id            SERIAL PRIMARY KEY,
  workflow_name VARCHAR(100) NOT NULL,
  triggered_by  VARCHAR(255),  -- session email (dashboard-triggered) or n8n workflow name (scheduled)
  status        VARCHAR(20) NOT NULL CHECK (status IN ('running', 'success', 'error')),
  summary       JSONB,
  error_message TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

**`triggered_by` rules:**
- Dashboard-triggered: server injects `session.user.email` before forwarding to n8n; n8n echoes it back in the log POST
- Scheduled/automated: n8n sets a static string e.g. `"scheduled"` or the workflow name

**`summary` JSONB shapes by workflow:**

| workflow_name | summary shape |
|---|---|
| `import_daily_game` | `{ total, puzzle, arcade, sim, ios, android }` |
| `database_to_smartsheet` | `{ total, puzzle, arcade, sim }` |
| `auto_assign` | `{ assignments: [{ evaluator, games_assigned, category }] }` |
| `delete_die_link` | `{ deleted }` |
| `handover` | `{ from, to: [string], games }` |

> `auto_assign` uses an array to support multi-evaluator assignment in a single run.

### New table: `daily_stats`
```sql
CREATE TABLE daily_stats (
  id              SERIAL PRIMARY KEY,
  stat_date       DATE NOT NULL,
  evaluator_name  VARCHAR(255),      -- NULL = global record (pulled/pushed totals)
  games_pulled    INT DEFAULT 0,     -- global only: total games pulled that day
  games_pushed    INT DEFAULT 0,     -- global only: total games pushed to Smartsheet
  games_assigned  INT DEFAULT 0,     -- per evaluator: assigned that day
  games_evaluated INT DEFAULT 0,     -- per evaluator: evaluated (from Smartsheet evaluate_date)
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (stat_date, evaluator_name)
);
```

**Write pattern:** n8n UPSERTs into this table at the end of each relevant workflow:
- `import_daily_game` → UPSERT global row (`evaluator_name = NULL`), update `games_pulled`
- `database_to_smartsheet` → UPSERT global row, update `games_pushed`
- `auto_assign` → UPSERT one row per evaluator, update `games_assigned`
- n8n reads Smartsheet `evaluate_date` column and UPSERTs `games_evaluated` daily (separate scheduled flow or at end of assign flow)

**No changes to `game_info` table.**

### Migration
Run manually against Neon before first deploy:
```sql
-- migrations/001_initial.sql
CREATE TABLE users ( ... );
CREATE TABLE ops_logs ( ... );
CREATE TABLE daily_stats ( ... );
```

---

## n8n Integration

### Security — Shared Webhook Secret (C1 fix)
All n8n → dashboard calls must include:
```
X-Webhook-Secret: <value of WEBHOOK_SECRET env var>
```
`POST /api/logs` validates this header before writing to DB. Returns `401` if missing or wrong.
n8n HTTP Request node: add header `X-Webhook-Secret` = `{{ $env.DASHBOARD_WEBHOOK_SECRET }}`.

### Dashboard → n8n (trigger)
1. Manager clicks button → `POST /api/workflows/trigger` with `{ workflow: "pull_ios", triggered_by: session.email }`
2. API route calls the corresponding n8n webhook URL from env vars
3. API route inserts a `running` row into `ops_logs` with `created_at = now()` and returns `{ triggered_at: <ISO timestamp> }` to client
4. Client stores `triggered_at` and polls `GET /api/logs?workflow=pull_ios&since=<triggered_at>` until a non-`running` entry appears

### n8n → Dashboard (log + stats)
At the end of each workflow, add HTTP Request nodes:

**1. Write ops log** (`/api/logs`):
```
POST https://<dashboard-url>/api/logs
Headers: { X-Webhook-Secret: <secret> }
Body: {
  "workflow_name": "database_to_smartsheet",
  "triggered_by": "manager@athena.com",
  "status": "success",
  "summary": { "total": 38, "puzzle": 18, "arcade": 12, "sim": 8 }
}
```

**2. Upsert daily stats** (`/api/stats`) — only for relevant workflows:
```
POST https://<dashboard-url>/api/stats
Headers: { X-Webhook-Secret: <secret> }
Body (global):     { "stat_date": "2026-03-19", "games_pulled": 45 }
Body (evaluator):  { "stat_date": "2026-03-19", "evaluator_name": "Nam", "games_assigned": 12 }
```
The endpoint performs `INSERT ... ON CONFLICT (stat_date, evaluator_name) DO UPDATE`.

---

## API Routes

### Standard Error Response
All routes return errors in this shape:
```json
{ "error": "message describing what went wrong" }
```
HTTP status codes: `400` bad input, `401` unauthenticated, `403` wrong role, `500` server error.

### Route Table

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/logs` | `X-Webhook-Secret` header | Write ops log entry from n8n |
| POST | `/api/stats` | `X-Webhook-Secret` header | Upsert daily_stats row from n8n |
| GET | `/api/logs` | manager session | Recent 20 log entries; accepts `?workflow=&since=` query params |
| GET | `/api/stats` | manager session | Aggregated dashboard stats |
| POST | `/api/workflows/trigger` | manager session | Trigger n8n webhook; returns `{ triggered_at }` |
| GET | `/api/evaluators` | manager session | Call n8n webhook → returns evaluator list with availability + weekly stats |
| PATCH | `/api/evaluators/:id` | manager session | Toggle availability; `:id` = `users.id` |
| POST | `/api/handover` | evaluator session | Submit handover; name taken from session; inserts running row |
| GET | `/api/handover` | evaluator session | Handover history for current user from ops_logs |
| GET | `/api/youtube/queue` | manager session | Call n8n → Drive video list; 15s timeout |
| POST | `/api/youtube/trigger` | manager session | Trigger upload workflow |

### `GET /api/stats` — Response Shape
```json
{
  "today": {
    "total": 45,
    "puzzle": 20,
    "arcade": 15,
    "sim": 10,
    "ios": 25,
    "android": 20
  },
  "workflows": [
    { "workflow_name": "import_daily_game", "status": "success", "created_at": "..." },
    { "workflow_name": "database_to_smartsheet", "status": "error", "created_at": "..." }
  ]
}
```
Two sources:
- **Game counts** (`games_pulled`, `games_pushed`): read from `daily_stats` WHERE `stat_date = today AND evaluator_name IS NULL`
- **Workflow status list**: read from `ops_logs` — one entry per `workflow_name`, most recent row

```sql
-- today's global stats
SELECT games_pulled, games_pushed
FROM daily_stats
WHERE stat_date = CURRENT_DATE AND evaluator_name IS NULL;

-- last run per workflow
SELECT DISTINCT ON (workflow_name) workflow_name, status, created_at
FROM ops_logs
ORDER BY workflow_name, created_at DESC;
```

> `total`, `puzzle`, `arcade`, `sim`, `ios`, `android` breakdowns still come from `ops_logs` `import_daily_game` summary JSONB (latest successful run today) — those are detailed import stats, not aggregated pull counts.

### `GET /api/evaluators` — Data Flow
1. API route calls `WEBHOOK_GET_EVALUATORS` n8n webhook
2. n8n reads Google Sheets "Evaluator List" → returns:
```json
[
  { "name": "Nam", "email": "nam@athena.com", "is_available": true },
  ...
]
```
3. API route reads per-evaluator stats from `daily_stats`:
```sql
SELECT evaluator_name, games_assigned, games_evaluated
FROM daily_stats
WHERE stat_date = CURRENT_DATE AND evaluator_name IS NOT NULL;
```
4. Merges into each evaluator entry by matching on `name` field (string equality).
   > **Contract:** `daily_stats.evaluator_name` must exactly match the `name` field from Google Sheets. This is an n8n-side responsibility.
5. Returns merged response. If no `daily_stats` row for an evaluator, defaults to `0`.

### `POST /api/handover` — Security (C3 fix)
- `evaluator_name` is **always taken from `session.user.name`** — client form value is ignored
- Server inserts a `running` row into `ops_logs` with `triggered_by = session.user.email` before calling n8n (same pattern as `/api/workflows/trigger`)
- Payload sent to n8n: `{ evaluator_name: session.user.name, start_date, end_date, triggered_by: session.user.email }`
- Frontend pre-fills and disables the name field (UI only)

### `GET /api/handover` — Handover History
- Protected: evaluator session only
- Returns `ops_logs` entries WHERE `workflow_name = 'handover' AND triggered_by = session.user.email`
- Page fetches this on mount to render history list
- Only completed entries (`status = 'success' | 'error'`) are meaningful for history; `running` entries show as "In Progress"

### `GET /api/youtube/queue`
- Calls `WEBHOOK_YTB_QUEUE` with 15s timeout (`AbortController`)
- On timeout: returns `{ error: "Drive request timed out, try again" }` with `504`
- On n8n error: returns `{ error: <n8n error message> }` with `502`

---

## Pages

### Manager Layout
Persistent sidebar with 4 tabs. All manager routes protected by `middleware.ts`.

### Tab 1: Dashboard (`/dashboard`)
- Stats cards: total games today + per category + per OS (from `/api/stats`)
- Workflow status row: last run time + status badge per workflow
- Activity feed: last 20 log entries (from `/api/logs`)
- Polling: 10s only when a workflow trigger is active; otherwise 60s

### Tab 2: Operations (`/operations`)
Trigger buttons:

| Button | Env Var | Note |
|--------|---------|------|
| Pull iOS Games | `WEBHOOK_PULL_IOS` | |
| Pull Android Games | `WEBHOOK_PULL_ANDROID` | |
| Push to Smartsheet | `WEBHOOK_PUSH_SMARTSHEET` | |
| Assign Evaluator | `WEBHOOK_ASSIGN_EVALUATOR` | Same flow for now, split later |
| Assign Initial Evaluator | `WEBHOOK_ASSIGN_INITIAL` | Same flow for now, split later |
| Clean Dead Links | `WEBHOOK_CLEAN_LINKS` | |

UX flow:
1. Click → button disables, shows spinner
2. Client stores `triggered_at` from response
3. Polls `GET /api/logs?workflow=<name>&since=<triggered_at>` every 5s
4. When status = `success` or `error` → show result inline, re-enable button

### Tab 3: Team (`/team`)
- Fetches from `/api/evaluators` (n8n → Google Sheets availability + `daily_stats` for counts)
- Table columns: name, available toggle, games assigned today, games evaluated today
- Toggle → `PATCH /api/evaluators/:id` (uses `users.id`, not name) → n8n → Google Sheets

### Tab 4: YouTube (`/youtube`)
- Fetches `/api/youtube/queue` on mount; shows loading skeleton during 15s window
- Error state: "Could not load video list — [Retry]"
- [Upload All] → `POST /api/youtube/trigger` → same disable/poll UX as Operations

### Evaluator: Handover (`/handover`)
- Form fields:
  - Evaluator Name: pre-filled from `session.user.name`, **read-only**
  - Start Date: date picker
  - End Date: date picker
- Submit → `POST /api/handover` → server uses session name, ignores any client name
- History: `ops_logs` entries WHERE `workflow_name = 'handover' AND triggered_by = session.email`

### Evaluator: Drive Videos (`/drive-videos`) — Future
- Calls n8n webhook to get Drive video list
- [Request Push] per video → creates request for manager to approve

---

## Environment Variables

```env
# Auth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
NEXTAUTH_SECRET=
NEXTAUTH_URL=

# Security
WEBHOOK_SECRET=        # shared secret for n8n → /api/logs POST

# Database
DATABASE_URL=          # Neon PostgreSQL connection string

# n8n Webhook URLs — Dashboard → n8n
WEBHOOK_PULL_IOS=
WEBHOOK_PULL_ANDROID=
WEBHOOK_PUSH_SMARTSHEET=
WEBHOOK_ASSIGN_EVALUATOR=
WEBHOOK_ASSIGN_INITIAL=
WEBHOOK_CLEAN_LINKS=
WEBHOOK_HANDOVER=
WEBHOOK_YTB_TRIGGER=

# n8n Webhook URLs — n8n → Dashboard (data fetch)
WEBHOOK_GET_EVALUATORS=
WEBHOOK_YTB_QUEUE=
```

---

## Project Structure

```
signal-smartsheet-management/
├── app/
│   ├── (auth)/login/page.tsx
│   ├── (manager)/
│   │   ├── layout.tsx
│   │   ├── dashboard/page.tsx
│   │   ├── operations/page.tsx
│   │   ├── team/page.tsx
│   │   └── youtube/page.tsx
│   └── (evaluator)/
│       ├── handover/page.tsx
│       └── drive-videos/page.tsx        # future
├── app/api/
│   ├── auth/[...nextauth]/route.ts
│   ├── logs/route.ts                    # GET + POST
│   ├── stats/route.ts
│   ├── workflows/trigger/route.ts
│   ├── evaluators/route.ts              # GET
│   ├── evaluators/[id]/route.ts         # PATCH (id = users.id)
│   ├── handover/route.ts
│   └── youtube/
│       ├── queue/route.ts
│       └── trigger/route.ts
├── middleware.ts                        # route protection by role
├── lib/
│   ├── db.ts                            # postgres.js Neon client
│   └── auth.ts                          # NextAuth config + role check
├── components/
│   ├── StatsCard.tsx
│   ├── TriggerButton.tsx
│   ├── ActivityFeed.tsx
│   └── EvaluatorTable.tsx
├── migrations/
│   └── 001_initial.sql                  # CREATE TABLE users, ops_logs
├── docs/
│   ├── proposal.md
│   └── superpowers/specs/
│       └── 2026-03-19-admin-dashboard-design.md
└── workflows/                           # n8n JSON backups
```

---

## Out of Scope (this phase)

- Mobile responsive (desktop-first)
- Email notifications
- Real-time WebSocket (polling sufficient given 2x/day run cadence)
- Drive Videos page (evaluator) — included in design, built in later phase
- Splitting Assign Evaluator / Assign Initial Evaluator into separate n8n flows
