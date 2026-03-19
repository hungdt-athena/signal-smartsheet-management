# Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a centralized Next.js admin dashboard for the Athena/Signal n8n automation ecosystem with Google OAuth, role-based access (manager/evaluator), and Neon PostgreSQL integration.

**Architecture:** Next.js 14 App Router on Replit with route groups for role separation `(manager)` / `(evaluator)`. All external API calls go through n8n webhooks — dashboard only reads/writes Neon DB directly. Auth via NextAuth + Google OAuth with email whitelist in `users` table.

**Tech Stack:** Next.js 14, NextAuth.js, postgres.js, Tailwind CSS, Jest + @testing-library/react

---

## File Map

| File | Responsibility |
|------|---------------|
| `package.json` | Dependencies |
| `next.config.ts` | Next.js config |
| `tailwind.config.ts` | Tailwind config |
| `middleware.ts` | Route protection by role |
| `lib/db.ts` | postgres.js Neon client singleton |
| `lib/auth.ts` | NextAuth config, Google OAuth, role lookup |
| `migrations/001_initial.sql` | CREATE TABLE users, ops_logs, daily_stats |
| `app/layout.tsx` | Root layout (SessionProvider) |
| `app/(auth)/login/page.tsx` | Login page with Google OAuth button |
| `app/(manager)/layout.tsx` | Manager shell with sidebar nav |
| `app/(manager)/dashboard/page.tsx` | Stats + workflow status + activity feed |
| `app/(manager)/operations/page.tsx` | Trigger buttons |
| `app/(manager)/team/page.tsx` | Evaluator availability table |
| `app/(manager)/youtube/page.tsx` | YouTube upload queue |
| `app/(evaluator)/layout.tsx` | Evaluator shell |
| `app/(evaluator)/handover/page.tsx` | Handover request form + history |
| `app/api/auth/[...nextauth]/route.ts` | NextAuth handler |
| `app/api/logs/route.ts` | GET (manager) + POST (webhook secret) |
| `app/api/stats/route.ts` | GET (manager) + POST (webhook secret) |
| `app/api/workflows/trigger/route.ts` | POST — trigger n8n webhook |
| `app/api/evaluators/route.ts` | GET — list evaluators |
| `app/api/evaluators/[id]/route.ts` | PATCH — toggle availability |
| `app/api/handover/route.ts` | GET + POST — handover history + submit |
| `app/api/youtube/queue/route.ts` | GET — video queue via n8n |
| `app/api/youtube/trigger/route.ts` | POST — trigger upload |
| `components/StatsCard.tsx` | Reusable stat display card |
| `components/TriggerButton.tsx` | Button with disable/poll UX |
| `components/ActivityFeed.tsx` | Ops log feed |
| `components/EvaluatorTable.tsx` | Team availability table |

---

## Task 1: Project Initialization

**Files:**
- Create: `package.json`, `next.config.ts`, `tailwind.config.ts`, `tsconfig.json`, `.env.local`, `.gitignore`

- [ ] **Step 1: Initialize Next.js project in existing directory**

```bash
npx create-next-app@14 . --typescript --tailwind --eslint --app --no-src-dir --import-alias "@/*"
```

When prompted: choose defaults. This overwrites the empty directory scaffold.

- [ ] **Step 2: Install additional dependencies**

```bash
npm install next-auth@4 postgres @types/pg
npm install --save-dev jest @testing-library/react @testing-library/jest-dom jest-environment-jsdom @types/jest ts-jest
```

- [ ] **Step 3: Configure Jest**

Create `jest.config.ts`:
```typescript
import type { Config } from 'jest'
import nextJest from 'next/jest.js'

const createJestConfig = nextJest({ dir: './' })

const config: Config = {
  coverageProvider: 'v8',
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
}

export default createJestConfig(config)
```

Create `jest.setup.ts`:
```typescript
import '@testing-library/jest-dom'
```

- [ ] **Step 4: Create `.env.local` with placeholder values**

```env
# Auth
GOOGLE_CLIENT_ID=placeholder
GOOGLE_CLIENT_SECRET=placeholder
NEXTAUTH_SECRET=dev-secret-change-in-prod
NEXTAUTH_URL=http://localhost:3000

# Security
WEBHOOK_SECRET=dev-webhook-secret

# Database
DATABASE_URL=postgresql://user:pass@host/db

# n8n Webhook URLs — Dashboard → n8n
WEBHOOK_PULL_IOS=
WEBHOOK_PULL_ANDROID=
WEBHOOK_PUSH_SMARTSHEET=
WEBHOOK_ASSIGN_EVALUATOR=
WEBHOOK_ASSIGN_INITIAL=
WEBHOOK_CLEAN_LINKS=
WEBHOOK_HANDOVER=
WEBHOOK_YTB_TRIGGER=
WEBHOOK_TOGGLE_EVALUATOR=   # n8n webhook that updates evaluator availability in Google Sheets

# n8n Webhook URLs — n8n → Dashboard (data fetch)
WEBHOOK_GET_EVALUATORS=
WEBHOOK_YTB_QUEUE=
```

- [ ] **Step 5: Verify Next.js boots**

```bash
npm run dev
```
Expected: server starts on http://localhost:3000

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: initialize Next.js 14 project with auth and test dependencies"
```

---

## Task 2: Database Migration

**Files:**
- Create: `migrations/001_initial.sql`
- Create: `lib/db.ts`

- [ ] **Step 1: Write migration SQL**

Create `migrations/001_initial.sql`:
```sql
CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) UNIQUE NOT NULL,
  name       VARCHAR(255),
  role       VARCHAR(20) NOT NULL CHECK (role IN ('manager', 'evaluator')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ops_logs (
  id            SERIAL PRIMARY KEY,
  workflow_name VARCHAR(100) NOT NULL,
  triggered_by  VARCHAR(255),
  status        VARCHAR(20) NOT NULL CHECK (status IN ('running', 'success', 'error')),
  summary       JSONB,
  error_message TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_stats (
  id              SERIAL PRIMARY KEY,
  stat_date       DATE NOT NULL,
  evaluator_name  VARCHAR(255),
  games_pulled    INT DEFAULT 0,
  games_pushed    INT DEFAULT 0,
  games_assigned  INT DEFAULT 0,
  games_evaluated INT DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (stat_date, evaluator_name)
);
```

- [ ] **Step 2: Run migration against Neon**

```bash
psql "$DATABASE_URL" -f migrations/001_initial.sql
```
Expected: `CREATE TABLE` × 3

- [ ] **Step 3: Write the db.ts test first**

Create `__tests__/lib/db.test.ts`:
```typescript
import { sql } from '@/lib/db'

jest.mock('postgres', () => {
  const mockSql = jest.fn()
  mockSql.mockResolvedValue([{ id: 1 }])
  return jest.fn(() => mockSql)
})

describe('db', () => {
  it('exports a sql function', () => {
    expect(typeof sql).toBe('function')
  })
})
```

- [ ] **Step 4: Run test — expect fail**

```bash
npx jest __tests__/lib/db.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 5: Implement `lib/db.ts`**

```typescript
import postgres from 'postgres'

const connectionString = process.env.DATABASE_URL!

// Singleton to avoid creating new connections on every hot reload
const globalForDb = globalThis as unknown as { sql: ReturnType<typeof postgres> }

export const sql = globalForDb.sql ?? postgres(connectionString, { ssl: 'require' })

if (process.env.NODE_ENV !== 'production') globalForDb.sql = sql
```

- [ ] **Step 6: Run test — expect pass**

```bash
npx jest __tests__/lib/db.test.ts
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add migrations/ lib/db.ts __tests__/lib/db.test.ts
git commit -m "feat: add DB migration and postgres.js singleton client"
```

---

## Task 3: Authentication

**Files:**
- Create: `lib/auth.ts`
- Create: `app/api/auth/[...nextauth]/route.ts`
- Create: `app/layout.tsx`
- Create: `app/(auth)/login/page.tsx`
- Create: `middleware.ts`

- [ ] **Step 1: Write auth config test**

Create `__tests__/lib/auth.test.ts`:
```typescript
import { authOptions } from '@/lib/auth'

jest.mock('@/lib/db', () => ({
  sql: jest.fn().mockImplementation(() => Promise.resolve([]))
}))

describe('authOptions', () => {
  it('has Google provider configured', () => {
    expect(authOptions.providers).toHaveLength(1)
    expect(authOptions.providers[0].id).toBe('google')
  })

  it('has callbacks defined', () => {
    expect(authOptions.callbacks?.signIn).toBeDefined()
    expect(authOptions.callbacks?.session).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test — expect fail**

```bash
npx jest __tests__/lib/auth.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement `lib/auth.ts`**

```typescript
import GoogleProvider from 'next-auth/providers/google'
import type { NextAuthOptions } from 'next-auth'
import { sql } from '@/lib/db'

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      const rows = await sql`SELECT id, role FROM users WHERE email = ${user.email}`
      return rows.length > 0  // block if not in whitelist
    },
    async session({ session }) {
      if (!session.user?.email) return session
      const rows = await sql`SELECT id, name, role FROM users WHERE email = ${session.user.email}`
      if (rows.length > 0) {
        session.user.id = rows[0].id
        session.user.role = rows[0].role
        session.user.name = rows[0].name
      }
      return session
    },
    async redirect({ url, baseUrl }) {
      return url.startsWith(baseUrl) ? url : baseUrl
    },
  },
  pages: { signIn: '/login', error: '/login' },
}
```

- [ ] **Step 4: Extend NextAuth types**

Create `types/next-auth.d.ts`:
```typescript
import 'next-auth'

declare module 'next-auth' {
  interface Session {
    user: {
      id: number
      email: string
      name: string
      role: 'manager' | 'evaluator'
    }
  }
}
```

- [ ] **Step 5: Run test — expect pass**

```bash
npx jest __tests__/lib/auth.test.ts
```
Expected: PASS

- [ ] **Step 6: Create NextAuth route handler**

Create `app/api/auth/[...nextauth]/route.ts`:
```typescript
import NextAuth from 'next-auth'
import { authOptions } from '@/lib/auth'

const handler = NextAuth(authOptions)
export { handler as GET, handler as POST }
```

- [ ] **Step 7: Create root layout with SessionProvider**

Create `app/layout.tsx`:
```typescript
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = { title: 'Signal Management' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
```

Create `app/providers.tsx`:
```typescript
'use client'
import { SessionProvider } from 'next-auth/react'

export function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>
}
```

- [ ] **Step 8: Create login page**

Create `app/(auth)/login/page.tsx`:
```typescript
'use client'
import { signIn } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'

export default function LoginPage() {
  const params = useSearchParams()
  const error = params.get('error')

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white p-8 rounded-lg shadow-md w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Signal Management</h1>
        <p className="text-gray-500 mb-6 text-sm">Athena automation dashboard</p>
        {error === 'unauthorized' && (
          <p className="text-red-500 text-sm mb-4">Your account is not authorized. Contact your manager.</p>
        )}
        <button
          onClick={() => signIn('google', { callbackUrl: '/dashboard' })}
          className="w-full flex items-center justify-center gap-2 bg-white border border-gray-300 rounded-md py-2 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Sign in with Google
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 9: Write and implement middleware**

Create `__tests__/middleware.test.ts`:
```typescript
// Middleware is hard to unit test in isolation — test via integration
// Verify the config matcher exports expected paths
import { config } from '@/middleware'

describe('middleware config', () => {
  it('matches manager routes', () => {
    const matcher = config.matcher as string[]
    expect(matcher.some(m => m.includes('dashboard'))).toBe(true)
  })
})
```

Create `middleware.ts`:
```typescript
import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'

export default withAuth(
  function middleware(req) {
    const { pathname } = req.nextUrl
    const role = req.nextauth.token?.role as string | undefined

    const managerPaths = ['/dashboard', '/operations', '/team', '/youtube']
    const evaluatorPaths = ['/handover', '/drive-videos']

    const isManagerPath = managerPaths.some(p => pathname.startsWith(p))
    const isEvaluatorPath = evaluatorPaths.some(p => pathname.startsWith(p))

    if (isManagerPath && role !== 'manager') {
      return NextResponse.redirect(new URL('/handover', req.url))
    }
    if (isEvaluatorPath && role !== 'evaluator') {
      return NextResponse.redirect(new URL('/dashboard', req.url))
    }
  },
  {
    callbacks: {
      authorized: ({ token }) => !!token,
    },
  }
)

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/operations/:path*',
    '/team/:path*',
    '/youtube/:path*',
    '/handover/:path*',
    '/drive-videos/:path*',
  ],
}
```

- [ ] **Step 10: Run all tests**

```bash
npx jest --passWithNoTests
```
Expected: all PASS

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: add Google OAuth auth, middleware role protection, login page"
```

---

## Task 4: API — Logs & Stats Ingest (n8n → Dashboard)

**Files:**
- Create: `app/api/logs/route.ts`
- Create: `app/api/stats/route.ts`
- Create: `__tests__/api/logs.test.ts`
- Create: `__tests__/api/stats.test.ts`

- [ ] **Step 1: Write failing test for POST /api/logs**

Create `__tests__/api/logs.test.ts`:
```typescript
import { POST } from '@/app/api/logs/route'
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({
  sql: jest.fn().mockResolvedValue([{ id: 1 }])
}))

const validSecret = 'test-secret'
process.env.WEBHOOK_SECRET = validSecret

function makeRequest(body: object, secret?: string) {
  return new NextRequest('http://localhost/api/logs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'x-webhook-secret': secret } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/logs', () => {
  it('returns 401 without secret', async () => {
    const res = await POST(makeRequest({ workflow_name: 'test', status: 'success' }))
    expect(res.status).toBe(401)
  })

  it('returns 401 with wrong secret', async () => {
    const res = await POST(makeRequest({ workflow_name: 'test', status: 'success' }, 'wrong'))
    expect(res.status).toBe(401)
  })

  it('returns 400 with missing required fields', async () => {
    const res = await POST(makeRequest({ workflow_name: 'test' }, validSecret))
    expect(res.status).toBe(400)
  })

  it('returns 200 with valid payload', async () => {
    const res = await POST(makeRequest({
      workflow_name: 'import_daily_game',
      status: 'success',
      triggered_by: 'test@example.com',
      summary: { total: 10 }
    }, validSecret))
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run test — expect fail**

```bash
npx jest __tests__/api/logs.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement `app/api/logs/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

function verifyWebhookSecret(req: NextRequest) {
  return req.headers.get('x-webhook-secret') === process.env.WEBHOOK_SECRET
}

export async function POST(req: NextRequest) {
  if (!verifyWebhookSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { workflow_name, status, triggered_by, summary, error_message } = body

  if (!workflow_name || !status) {
    return NextResponse.json({ error: 'workflow_name and status are required' }, { status: 400 })
  }

  await sql`
    INSERT INTO ops_logs (workflow_name, triggered_by, status, summary, error_message)
    VALUES (${workflow_name}, ${triggered_by ?? null}, ${status}, ${summary ? JSON.stringify(summary) : null}, ${error_message ?? null})
  `

  return NextResponse.json({ ok: true })
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const workflow = searchParams.get('workflow')
  const since = searchParams.get('since')

  let rows
  if (workflow && since) {
    rows = await sql`
      SELECT * FROM ops_logs
      WHERE workflow_name = ${workflow} AND created_at > ${since}::timestamptz
      ORDER BY created_at DESC LIMIT 20
    `
  } else {
    rows = await sql`
      SELECT * FROM ops_logs ORDER BY created_at DESC LIMIT 20
    `
  }

  return NextResponse.json(rows)
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npx jest __tests__/api/logs.test.ts
```
Expected: all PASS

- [ ] **Step 5: Write failing test for POST /api/stats**

Create `__tests__/api/stats.test.ts`:
```typescript
import { POST, GET } from '@/app/api/stats/route'
import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'

jest.mock('@/lib/db', () => ({
  sql: jest.fn().mockResolvedValue([])
}))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

process.env.WEBHOOK_SECRET = 'test-secret'

describe('POST /api/stats', () => {
  it('returns 401 without secret', async () => {
    const req = new NextRequest('http://localhost/api/stats', {
      method: 'POST',
      body: JSON.stringify({ stat_date: '2026-03-19', games_pulled: 45 }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('upserts global row with valid payload', async () => {
    const { sql } = require('@/lib/db')
    const req = new NextRequest('http://localhost/api/stats', {
      method: 'POST',
      headers: { 'x-webhook-secret': 'test-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ stat_date: '2026-03-19', games_pulled: 45 }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(sql).toHaveBeenCalled()
  })
})

describe('GET /api/stats', () => {
  it('returns 401 without manager session', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue(null)
    const req = new NextRequest('http://localhost/api/stats')
    const res = await GET(req)
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 6: Implement `app/api/stats/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

function verifyWebhookSecret(req: NextRequest) {
  return req.headers.get('x-webhook-secret') === process.env.WEBHOOK_SECRET
}

export async function POST(req: NextRequest) {
  if (!verifyWebhookSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { stat_date, evaluator_name = null, games_pulled, games_pushed, games_assigned, games_evaluated } = body

  if (!stat_date) {
    return NextResponse.json({ error: 'stat_date is required' }, { status: 400 })
  }

  await sql`
    INSERT INTO daily_stats (stat_date, evaluator_name, games_pulled, games_pushed, games_assigned, games_evaluated)
    VALUES (
      ${stat_date}::date,
      ${evaluator_name},
      ${games_pulled ?? 0},
      ${games_pushed ?? 0},
      ${games_assigned ?? 0},
      ${games_evaluated ?? 0}
    )
    ON CONFLICT (stat_date, evaluator_name) DO UPDATE SET
      games_pulled    = daily_stats.games_pulled    + EXCLUDED.games_pulled,
      games_pushed    = daily_stats.games_pushed    + EXCLUDED.games_pushed,
      games_assigned  = daily_stats.games_assigned  + EXCLUDED.games_assigned,
      games_evaluated = daily_stats.games_evaluated + EXCLUDED.games_evaluated,
      updated_at      = NOW()
  `

  return NextResponse.json({ ok: true })
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Global stats today
  const [globalStats] = await sql`
    SELECT games_pulled, games_pushed
    FROM daily_stats
    WHERE stat_date = CURRENT_DATE AND evaluator_name IS NULL
  `

  // Latest successful import run today for category/OS breakdown
  const [latestImport] = await sql`
    SELECT summary FROM ops_logs
    WHERE workflow_name = 'import_daily_game'
      AND status = 'success'
      AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'
    ORDER BY created_at DESC
    LIMIT 1
  `

  // Last run per workflow
  const workflows = await sql`
    SELECT DISTINCT ON (workflow_name) workflow_name, status, created_at
    FROM ops_logs
    ORDER BY workflow_name, created_at DESC
  `

  return NextResponse.json({
    today: {
      games_pulled: globalStats?.games_pulled ?? 0,
      games_pushed: globalStats?.games_pushed ?? 0,
      ...(latestImport?.summary ?? { total: 0, puzzle: 0, arcade: 0, sim: 0, ios: 0, android: 0 }),
    },
    workflows,
  })
}
```

- [ ] **Step 7: Run all tests**

```bash
npx jest __tests__/api/
```
Expected: all PASS

- [ ] **Step 8: Commit**

```bash
git add app/api/logs/ app/api/stats/ __tests__/api/
git commit -m "feat: add /api/logs and /api/stats ingest endpoints with webhook secret auth"
```

---

## Task 5: API — Workflow Trigger

**Files:**
- Create: `app/api/workflows/trigger/route.ts`
- Create: `__tests__/api/workflows-trigger.test.ts`

- [ ] **Step 1: Write failing test**

Create `__tests__/api/workflows-trigger.test.ts`:
```typescript
import { POST } from '@/app/api/workflows/trigger/route'
import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'

jest.mock('@/lib/db', () => ({ sql: jest.fn().mockResolvedValue([{ id: 1 }]) }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

const managerSession = { user: { email: 'mgr@test.com', role: 'manager', id: 1, name: 'Mgr' } }

describe('POST /api/workflows/trigger', () => {
  beforeEach(() => {
    ;(getServerSession as jest.Mock).mockResolvedValue(managerSession)
    global.fetch = jest.fn().mockResolvedValue({ ok: true })
    process.env.WEBHOOK_PULL_IOS = 'https://n8n.test/webhook/pull-ios'
  })

  it('returns 401 without manager session', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue(null)
    const req = new NextRequest('http://localhost/api/workflows/trigger', {
      method: 'POST',
      body: JSON.stringify({ workflow: 'pull_ios' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('returns 400 for unknown workflow', async () => {
    const req = new NextRequest('http://localhost/api/workflows/trigger', {
      method: 'POST',
      body: JSON.stringify({ workflow: 'unknown_workflow' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('inserts running log and returns triggered_at', async () => {
    const req = new NextRequest('http://localhost/api/workflows/trigger', {
      method: 'POST',
      body: JSON.stringify({ workflow: 'pull_ios' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.triggered_at).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test — expect fail**

```bash
npx jest __tests__/api/workflows-trigger.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement route**

Create `app/api/workflows/trigger/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

const WEBHOOK_MAP: Record<string, string | undefined> = {
  pull_ios:          process.env.WEBHOOK_PULL_IOS,
  pull_android:      process.env.WEBHOOK_PULL_ANDROID,
  push_smartsheet:   process.env.WEBHOOK_PUSH_SMARTSHEET,
  assign_evaluator:  process.env.WEBHOOK_ASSIGN_EVALUATOR,
  assign_initial:    process.env.WEBHOOK_ASSIGN_INITIAL,
  clean_links:       process.env.WEBHOOK_CLEAN_LINKS,
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { workflow } = await req.json()
  const webhookUrl = WEBHOOK_MAP[workflow]

  if (!webhookUrl) {
    return NextResponse.json({ error: `Unknown workflow: ${workflow}` }, { status: 400 })
  }

  const triggeredAt = new Date().toISOString()

  // Insert running row before calling n8n
  await sql`
    INSERT INTO ops_logs (workflow_name, triggered_by, status, created_at)
    VALUES (${workflow}, ${session.user.email}, 'running', ${triggeredAt}::timestamptz)
  `

  // Fire-and-forget: call n8n webhook
  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ triggered_by: session.user.email }),
  }).catch(console.error)

  return NextResponse.json({ triggered_at: triggeredAt })
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npx jest __tests__/api/workflows-trigger.test.ts
```
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/workflows/ __tests__/api/workflows-trigger.test.ts
git commit -m "feat: add /api/workflows/trigger with running log insertion"
```

---

## Task 6: API — Evaluators & Handover

**Files:**
- Create: `app/api/evaluators/route.ts`
- Create: `app/api/evaluators/[id]/route.ts`
- Create: `app/api/handover/route.ts`

- [ ] **Step 1: Write failing tests**

Create `__tests__/api/evaluators.test.ts`:
```typescript
import { GET } from '@/app/api/evaluators/route'
import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'

jest.mock('@/lib/db', () => ({
  sql: jest.fn().mockResolvedValue([])
}))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

describe('GET /api/evaluators', () => {
  it('returns 401 without manager session', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue(null)
    const res = await GET(new NextRequest('http://localhost/api/evaluators'))
    expect(res.status).toBe(401)
  })

  it('returns 200 for manager', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue({
      user: { role: 'manager', email: 'mgr@test.com' }
    })
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ name: 'Nam', email: 'nam@test.com', is_available: true }]
    })
    const res = await GET(new NextRequest('http://localhost/api/evaluators'))
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Implement `app/api/evaluators/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Fetch availability from n8n → Google Sheets
  const webhookUrl = process.env.WEBHOOK_GET_EVALUATORS
  if (!webhookUrl) return NextResponse.json({ error: 'Evaluator webhook not configured' }, { status: 500 })

  const n8nRes = await fetch(webhookUrl)
  if (!n8nRes.ok) return NextResponse.json({ error: 'Failed to fetch evaluator list' }, { status: 502 })
  const evaluators: { name: string; email: string; is_available: boolean }[] = await n8nRes.json()

  // Fetch today's stats from daily_stats
  const stats = await sql`
    SELECT evaluator_name, games_assigned, games_evaluated
    FROM daily_stats
    WHERE stat_date = CURRENT_DATE AND evaluator_name IS NOT NULL
  `

  const statsMap = Object.fromEntries(stats.map(s => [s.evaluator_name, s]))

  const merged = evaluators.map(ev => ({
    ...ev,
    games_assigned: statsMap[ev.name]?.games_assigned ?? 0,
    games_evaluated: statsMap[ev.name]?.games_evaluated ?? 0,
  }))

  return NextResponse.json(merged)
}
```

- [ ] **Step 3: Implement `app/api/evaluators/[id]/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { is_available } = await req.json()
  const webhookUrl = process.env.WEBHOOK_TOGGLE_EVALUATOR
  if (!webhookUrl) return NextResponse.json({ error: 'Toggle webhook not configured' }, { status: 500 })

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: params.id, is_available }),
  })

  if (!res.ok) return NextResponse.json({ error: 'Failed to update availability' }, { status: 502 })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Implement `app/api/handover/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'evaluator') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rows = await sql`
    SELECT id, status, summary, error_message, created_at
    FROM ops_logs
    WHERE workflow_name = 'handover' AND triggered_by = ${session.user.email}
    ORDER BY created_at DESC LIMIT 20
  `
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'evaluator') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { start_date, end_date } = await req.json()
  if (!start_date || !end_date) {
    return NextResponse.json({ error: 'start_date and end_date are required' }, { status: 400 })
  }

  const triggeredAt = new Date().toISOString()

  // Insert running row
  await sql`
    INSERT INTO ops_logs (workflow_name, triggered_by, status, created_at)
    VALUES ('handover', ${session.user.email}, 'running', ${triggeredAt}::timestamptz)
  `

  // Call n8n webhook — name always from session
  const webhookUrl = process.env.WEBHOOK_HANDOVER
  if (webhookUrl) {
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evaluator_name: session.user.name,
        start_date,
        end_date,
        triggered_by: session.user.email,
      }),
    }).catch(console.error)
  }

  return NextResponse.json({ triggered_at: triggeredAt })
}
```

- [ ] **Step 5: Run all API tests**

```bash
npx jest __tests__/api/
```
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add app/api/evaluators/ app/api/handover/ __tests__/api/evaluators.test.ts
git commit -m "feat: add evaluators and handover API routes"
```

---

## Task 7: API — YouTube

**Files:**
- Create: `app/api/youtube/queue/route.ts`
- Create: `app/api/youtube/trigger/route.ts`

- [ ] **Step 1: Implement both routes**

Create `app/api/youtube/queue/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const webhookUrl = process.env.WEBHOOK_YTB_QUEUE
  if (!webhookUrl) return NextResponse.json({ error: 'YouTube queue webhook not configured' }, { status: 500 })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  try {
    const res = await fetch(webhookUrl, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return NextResponse.json({ error: 'n8n returned error' }, { status: 502 })
    const data = await res.json()
    return NextResponse.json(data)
  } catch (err: unknown) {
    clearTimeout(timeout)
    if (err instanceof Error && err.name === 'AbortError') {
      return NextResponse.json({ error: 'Drive request timed out, try again' }, { status: 504 })
    }
    return NextResponse.json({ error: 'Failed to fetch video queue' }, { status: 502 })
  }
}
```

Create `app/api/youtube/trigger/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const triggeredAt = new Date().toISOString()
  await sql`
    INSERT INTO ops_logs (workflow_name, triggered_by, status, created_at)
    VALUES ('upload_ytb', ${session.user.email}, 'running', ${triggeredAt}::timestamptz)
  `

  const webhookUrl = process.env.WEBHOOK_YTB_TRIGGER
  if (webhookUrl) {
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggered_by: session.user.email }),
    }).catch(console.error)
  }

  return NextResponse.json({ triggered_at: triggeredAt })
}
```

- [ ] **Step 2: Run full test suite**

```bash
npx jest
```
Expected: all PASS

- [ ] **Step 3: Commit**

```bash
git add app/api/youtube/
git commit -m "feat: add YouTube queue and trigger API routes with 15s timeout"
```

---

## Task 8: Shared UI Components

**Files:**
- Create: `components/StatsCard.tsx`
- Create: `components/TriggerButton.tsx`
- Create: `components/ActivityFeed.tsx`
- Create: `components/EvaluatorTable.tsx`

- [ ] **Step 1: Implement `StatsCard`**

Create `components/StatsCard.tsx`:
```typescript
interface StatsCardProps {
  label: string
  value: number | string
  sub?: string
}

export function StatsCard({ label, value, sub }: StatsCardProps) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-3xl font-bold text-gray-900 mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  )
}
```

- [ ] **Step 2: Implement `TriggerButton`**

Create `components/TriggerButton.tsx`:
```typescript
'use client'
import { useState } from 'react'

interface TriggerResult {
  status: 'success' | 'error'
  summary?: Record<string, unknown>
  error_message?: string
}

interface TriggerButtonProps {
  label: string
  workflow: string
}

export function TriggerButton({ label, workflow }: TriggerButtonProps) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<TriggerResult | null>(null)

  async function handleClick() {
    setLoading(true)
    setResult(null)

    const res = await fetch('/api/workflows/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow }),
    })
    const { triggered_at } = await res.json()

    // Poll for result
    const poll = setInterval(async () => {
      const logRes = await fetch(`/api/logs?workflow=${workflow}&since=${triggered_at}`)
      const logs = await logRes.json()
      const done = logs.find((l: { status: string }) => l.status !== 'running')
      if (done) {
        clearInterval(poll)
        setResult({ status: done.status, summary: done.summary, error_message: done.error_message })
        setLoading(false)
      }
    }, 5000)

    // Stop polling after 10 minutes
    setTimeout(() => { clearInterval(poll); setLoading(false) }, 600000)
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={handleClick}
        disabled={loading}
        className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white px-4 py-2 rounded-md text-sm font-medium"
      >
        {loading ? (
          <><span className="animate-spin">⟳</span> Running...</>
        ) : (
          <>▶ {label}</>
        )}
      </button>
      {result && (
        <p className={`text-xs ${result.status === 'success' ? 'text-green-600' : 'text-red-600'}`}>
          {result.status === 'success'
            ? `✓ Done — ${JSON.stringify(result.summary)}`
            : `✗ Error — ${result.error_message}`}
        </p>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Implement `ActivityFeed`**

Create `components/ActivityFeed.tsx`:
```typescript
interface LogEntry {
  id: number
  workflow_name: string
  triggered_by: string
  status: 'running' | 'success' | 'error'
  created_at: string
  summary?: Record<string, unknown>
}

const STATUS_COLORS = {
  success: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
  running: 'bg-yellow-100 text-yellow-700',
}

export function ActivityFeed({ logs }: { logs: LogEntry[] }) {
  if (logs.length === 0) return <p className="text-gray-400 text-sm">No activity yet.</p>

  return (
    <ul className="space-y-2">
      {logs.map(log => (
        <li key={log.id} className="flex items-start gap-3 text-sm">
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[log.status]}`}>
            {log.status}
          </span>
          <div>
            <span className="font-medium">{log.workflow_name}</span>
            {log.triggered_by && <span className="text-gray-400"> · {log.triggered_by}</span>}
            <p className="text-gray-400 text-xs">{new Date(log.created_at).toLocaleString()}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 4: Implement `EvaluatorTable`**

Create `components/EvaluatorTable.tsx`:
```typescript
'use client'

interface Evaluator {
  name: string
  email: string
  is_available: boolean
  games_assigned: number
  games_evaluated: number
  id?: number
}

interface EvaluatorTableProps {
  evaluators: Evaluator[]
  onToggle: (id: number, isAvailable: boolean) => void
}

export function EvaluatorTable({ evaluators, onToggle }: EvaluatorTableProps) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-gray-500">
          <th className="pb-2">Name</th>
          <th className="pb-2">Available</th>
          <th className="pb-2">Assigned Today</th>
          <th className="pb-2">Evaluated Today</th>
        </tr>
      </thead>
      <tbody>
        {evaluators.map(ev => (
          <tr key={ev.email} className="border-b hover:bg-gray-50">
            <td className="py-3 font-medium">{ev.name}</td>
            <td className="py-3">
              <button
                onClick={() => ev.id && onToggle(ev.id, !ev.is_available)}
                className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${ev.is_available ? 'bg-green-500' : 'bg-gray-300'}`}
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5 ${ev.is_available ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </button>
            </td>
            <td className="py-3">{ev.games_assigned}</td>
            <td className="py-3">{ev.games_evaluated}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add components/
git commit -m "feat: add StatsCard, TriggerButton, ActivityFeed, EvaluatorTable components"
```

---

## Task 9: Manager Pages

**Files:**
- Create: `app/(manager)/layout.tsx`
- Create: `app/(manager)/dashboard/page.tsx`
- Create: `app/(manager)/operations/page.tsx`
- Create: `app/(manager)/team/page.tsx`
- Create: `app/(manager)/youtube/page.tsx`

- [ ] **Step 1: Create manager layout with sidebar**

Create `app/(manager)/layout.tsx`:
```typescript
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from 'next-auth/react'

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/operations', label: 'Operations' },
  { href: '/team', label: 'Team' },
  { href: '/youtube', label: 'YouTube' },
]

export default function ManagerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="flex h-screen bg-gray-50">
      <aside className="w-56 bg-white border-r flex flex-col">
        <div className="p-4 border-b">
          <h1 className="font-bold text-gray-900">Signal</h1>
          <p className="text-xs text-gray-400">Management</p>
        </div>
        <nav className="flex-1 p-2">
          {NAV_ITEMS.map(item => (
            <Link
              key={item.href}
              href={item.href}
              className={`block px-3 py-2 rounded-md text-sm mb-1 ${
                pathname === item.href
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="p-4 border-t">
          <button onClick={() => signOut({ callbackUrl: '/login' })} className="text-xs text-gray-400 hover:text-gray-600">
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto p-6">{children}</main>
    </div>
  )
}
```

- [ ] **Step 2: Create Dashboard page**

Create `app/(manager)/dashboard/page.tsx`:
```typescript
'use client'
import { useEffect, useState, useRef } from 'react'
import { StatsCard } from '@/components/StatsCard'
import { ActivityFeed } from '@/components/ActivityFeed'

export default function DashboardPage() {
  const [stats, setStats] = useState<Record<string, unknown> | null>(null)
  const [logs, setLogs] = useState<unknown[]>([])
  const intervalRef = useRef<NodeJS.Timeout>()

  async function fetchData() {
    const [statsRes, logsRes] = await Promise.all([
      fetch('/api/stats'),
      fetch('/api/logs'),
    ])
    if (statsRes.ok) setStats(await statsRes.json())
    if (logsRes.ok) setLogs(await logsRes.json())
  }

  useEffect(() => {
    fetchData()
    intervalRef.current = setInterval(fetchData, 60000)
    return () => clearInterval(intervalRef.current)
  }, [])

  const today = (stats as { today?: Record<string, number> })?.today ?? {}
  const workflows = (stats as { workflows?: unknown[] })?.workflows ?? []

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">Dashboard</h2>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatsCard label="Pulled Today" value={today.games_pulled ?? 0} />
        <StatsCard label="Pushed Today" value={today.games_pushed ?? 0} />
        <StatsCard label="Total Imported" value={today.total ?? 0} sub={`iOS: ${today.ios ?? 0} · Android: ${today.android ?? 0}`} />
        <StatsCard label="By Category" value={`P:${today.puzzle ?? 0} A:${today.arcade ?? 0} S:${today.sim ?? 0}`} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg border p-4">
          <h3 className="font-medium mb-3">Workflow Status</h3>
          <ul className="space-y-2">
            {(workflows as Array<{ workflow_name: string; status: string; created_at: string }>).map(w => (
              <li key={w.workflow_name} className="flex justify-between text-sm">
                <span className="text-gray-600">{w.workflow_name}</span>
                <span className={w.status === 'success' ? 'text-green-600' : w.status === 'error' ? 'text-red-600' : 'text-yellow-600'}>
                  {w.status}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-white rounded-lg border p-4">
          <h3 className="font-medium mb-3">Recent Activity</h3>
          <ActivityFeed logs={logs as Parameters<typeof ActivityFeed>[0]['logs']} />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Create Operations page**

Create `app/(manager)/operations/page.tsx`:
```typescript
import { TriggerButton } from '@/components/TriggerButton'

const OPERATIONS = [
  { label: 'Pull iOS Games', workflow: 'pull_ios' },
  { label: 'Pull Android Games', workflow: 'pull_android' },
  { label: 'Push to Smartsheet', workflow: 'push_smartsheet' },
  { label: 'Assign Evaluator', workflow: 'assign_evaluator' },
  { label: 'Assign Initial Evaluator', workflow: 'assign_initial' },
  { label: 'Clean Dead Links', workflow: 'clean_links' },
]

export default function OperationsPage() {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">Operations</h2>
      <div className="bg-white rounded-lg border p-6">
        <p className="text-sm text-gray-500 mb-6">Manually trigger n8n workflows. Each button shows live status after firing.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {OPERATIONS.map(op => (
            <TriggerButton key={op.workflow} label={op.label} workflow={op.workflow} />
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Create Team page**

Create `app/(manager)/team/page.tsx`:
```typescript
'use client'
import { useEffect, useState } from 'react'
import { EvaluatorTable } from '@/components/EvaluatorTable'

export default function TeamPage() {
  const [evaluators, setEvaluators] = useState([])
  const [loading, setLoading] = useState(true)

  async function fetchEvaluators() {
    const res = await fetch('/api/evaluators')
    if (res.ok) setEvaluators(await res.json())
    setLoading(false)
  }

  async function handleToggle(id: number, isAvailable: boolean) {
    await fetch(`/api/evaluators/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_available: isAvailable }),
    })
    fetchEvaluators()
  }

  useEffect(() => { fetchEvaluators() }, [])

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">Team</h2>
      <div className="bg-white rounded-lg border p-6">
        {loading ? (
          <p className="text-gray-400 text-sm">Loading evaluators...</p>
        ) : (
          <EvaluatorTable evaluators={evaluators} onToggle={handleToggle} />
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Create YouTube page**

Create `app/(manager)/youtube/page.tsx`:
```typescript
'use client'
import { useEffect, useState } from 'react'
import { TriggerButton } from '@/components/TriggerButton'

interface VideoItem {
  id: string
  name: string
  status: string
}

export default function YouTubePage() {
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function fetchQueue() {
    setLoading(true)
    setError(null)
    const res = await fetch('/api/youtube/queue')
    if (res.ok) {
      setVideos(await res.json())
    } else {
      const body = await res.json()
      setError(body.error ?? 'Failed to load')
    }
    setLoading(false)
  }

  useEffect(() => { fetchQueue() }, [])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">YouTube Upload Queue</h2>
        <TriggerButton label="Upload All" workflow="upload_ytb" />
      </div>

      <div className="bg-white rounded-lg border p-6">
        {loading && <p className="text-gray-400 text-sm">Loading video list from Drive... (up to 15s)</p>}
        {error && (
          <div className="flex items-center gap-2 text-red-500 text-sm">
            <span>{error}</span>
            <button onClick={fetchQueue} className="underline">Retry</button>
          </div>
        )}
        {!loading && !error && videos.length === 0 && (
          <p className="text-gray-400 text-sm">No videos pending upload.</p>
        )}
        {!loading && !error && videos.length > 0 && (
          <ul className="space-y-2">
            {videos.map(v => (
              <li key={v.id} className="flex items-center justify-between text-sm border-b pb-2">
                <span>{v.name}</span>
                <span className="text-gray-400">{v.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Add root redirect**

Create `app/page.tsx`:
```typescript
import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export default async function RootPage() {
  const session = await getServerSession(authOptions)
  if (!session) redirect('/login')
  if (session.user.role === 'manager') redirect('/dashboard')
  redirect('/handover')
}
```

- [ ] **Step 7: Commit**

```bash
git add app/\(manager\)/ app/page.tsx
git commit -m "feat: add manager layout, dashboard, operations, team, youtube pages"
```

---

## Task 10: Evaluator Handover Page

**Files:**
- Create: `app/(evaluator)/layout.tsx`
- Create: `app/(evaluator)/handover/page.tsx`

- [ ] **Step 1: Create evaluator layout**

Create `app/(evaluator)/layout.tsx`:
```typescript
'use client'
import { signOut } from 'next-auth/react'
import { useSession } from 'next-auth/react'

export default function EvaluatorLayout({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession()

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-6 py-3 flex justify-between items-center">
        <h1 className="font-bold text-gray-900">Signal</h1>
        <div className="flex items-center gap-4 text-sm text-gray-500">
          <span>{session?.user?.name}</span>
          <button onClick={() => signOut({ callbackUrl: '/login' })} className="hover:text-gray-700">Sign out</button>
        </div>
      </header>
      <main className="max-w-xl mx-auto p-6">{children}</main>
    </div>
  )
}
```

- [ ] **Step 2: Create Handover page**

Create `app/(evaluator)/handover/page.tsx`:
```typescript
'use client'
import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'

interface HandoverEntry {
  id: number
  status: string
  summary?: { from: string; to: string[]; games: number }
  created_at: string
}

export default function HandoverPage() {
  const { data: session } = useSession()
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [history, setHistory] = useState<HandoverEntry[]>([])

  async function fetchHistory() {
    const res = await fetch('/api/handover')
    if (res.ok) setHistory(await res.json())
  }

  useEffect(() => { fetchHistory() }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setMessage(null)

    const res = await fetch('/api/handover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_date: startDate, end_date: endDate }),
    })

    if (res.ok) {
      setMessage({ type: 'success', text: 'Handover request submitted. Your games will be redistributed shortly.' })
      setStartDate('')
      setEndDate('')
      fetchHistory()
    } else {
      const body = await res.json()
      setMessage({ type: 'error', text: body.error ?? 'Submission failed' })
    }
    setSubmitting(false)
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold">Game List Handover</h2>
        <p className="text-gray-500 text-sm mt-1">Submit a request to redistribute your assigned games while you&apos;re unavailable.</p>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-lg border p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Evaluator Name</label>
          <input
            value={session?.user?.name ?? ''}
            disabled
            className="w-full border rounded-md px-3 py-2 text-sm bg-gray-50 text-gray-500"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              required
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              required
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>
        </div>
        {message && (
          <p className={`text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
            {message.text}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white py-2 rounded-md text-sm font-medium"
        >
          {submitting ? 'Submitting...' : 'Submit Handover Request'}
        </button>
      </form>

      {history.length > 0 && (
        <div className="bg-white rounded-lg border p-6">
          <h3 className="font-medium mb-3">Handover History</h3>
          <ul className="space-y-2">
            {history.map(entry => (
              <li key={entry.id} className="flex justify-between text-sm border-b pb-2">
                <div>
                  <span className={entry.status === 'success' ? 'text-green-600' : entry.status === 'error' ? 'text-red-600' : 'text-yellow-600'}>
                    {entry.status === 'running' ? 'In Progress' : entry.status}
                  </span>
                  {entry.summary && (
                    <span className="text-gray-400 ml-2">· {entry.summary.games} games redistributed</span>
                  )}
                </div>
                <span className="text-gray-400">{new Date(entry.created_at).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Run final test suite**

```bash
npx jest
```
Expected: all PASS

- [ ] **Step 4: Test full app manually**

```bash
npm run dev
```

Visit http://localhost:3000 — should redirect to `/login`. Sign in with Google — should redirect based on role.

- [ ] **Step 5: Commit**

```bash
git add app/\(evaluator\)/
git commit -m "feat: add evaluator layout and handover page with history"
```

---

## Task 11: Replit Deployment

**Files:**
- Create: `.replit`
- Create: `replit.nix`

- [ ] **Step 1: Create Replit config**

Create `.replit`:
```toml
modules = ["nodejs-20"]
run = "npm run start"

[nix]
channel = "stable-24_05"

[deployment]
deploymentTarget = "cloudrun"
run = ["sh", "-c", "npm run start"]
```

- [ ] **Step 2: Create Next.js production start script**

Update `package.json` scripts:
```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start -p ${PORT:-3000}",
    "lint": "next lint",
    "test": "jest"
  }
}
```

- [ ] **Step 3: Build and verify**

```bash
npm run build
```
Expected: build succeeds with no errors

- [ ] **Step 4: Set environment variables in Replit Secrets**

In Replit dashboard → Secrets, add all variables from `.env.local` with real values:
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `NEXTAUTH_SECRET` (generate with `openssl rand -base64 32`)
- `NEXTAUTH_URL` (set to Replit deployment URL)
- `WEBHOOK_SECRET`
- `DATABASE_URL`
- All `WEBHOOK_*` URLs

- [ ] **Step 5: Final commit and push**

```bash
git add .replit package.json
git commit -m "feat: add Replit deployment config"
git push origin main
```

---

## Post-Deploy Checklist

- [ ] Run `migrations/001_initial.sql` against production Neon DB
- [ ] Insert at least one manager row: `INSERT INTO users (email, name, role) VALUES ('your@email.com', 'Your Name', 'manager')`
- [ ] Verify Google OAuth redirect URI is set to `https://<replit-url>/api/auth/callback/google` in Google Cloud Console
- [ ] Test login with manager account → lands on `/dashboard`
- [ ] Add evaluator rows to `users` table and test evaluator login → lands on `/handover`
- [ ] Add `X-Webhook-Secret` header to n8n HTTP Request nodes that call `/api/logs` and `/api/stats`
- [ ] Create n8n webhook for `WEBHOOK_TOGGLE_EVALUATOR` that accepts `{ user_id, is_available }` and updates the Google Sheets "Today Available" column
