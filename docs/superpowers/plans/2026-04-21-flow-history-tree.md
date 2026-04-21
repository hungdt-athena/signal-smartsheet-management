# Flow History Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign Games History into a lazy-loading Year→Month→Day tree with unified Pull+Push per day and a Refresh button.

**Architecture:** Three new API routes handle lazy loading by level (years/months/month-data). `FlowHistory.tsx` becomes self-contained — no props from dashboard. Dashboard removes its `flowHistory` state/fetch entirely.

**Tech Stack:** Next.js 14 App Router, TypeScript, postgres (`sql` tag), React hooks, Tailwind + inline styles (Mr Bean theme).

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `app/api/flow-logs/years/route.ts` | Create | Returns distinct years with data |
| `app/api/flow-logs/months/route.ts` | Create | Returns distinct months for a year |
| `app/api/flow-logs/month/route.ts` | Create | Returns all day-grouped entries for a year+month |
| `__tests__/api/flow-logs-tree.test.ts` | Create | Auth + shape tests for the 3 new routes |
| `components/FlowHistory.tsx` | Rewrite | Self-contained lazy tree component |
| `app/(manager)/dashboard/page.tsx` | Modify | Remove flowHistory state + fetch |

---

## Task 1: `/api/flow-logs/years` route

**Files:**
- Create: `app/api/flow-logs/years/route.ts`
- Create: `__tests__/api/flow-logs-tree.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/api/flow-logs-tree.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { GET as getYears } from '@/app/api/flow-logs/years/route'
import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

const { sql } = require('@/lib/db')

describe('GET /api/flow-logs/years', () => {
  it('returns 401 without manager session', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue(null)
    const res = await getYears(new NextRequest('http://localhost/api/flow-logs/years'))
    expect(res.status).toBe(401)
  })

  it('returns sorted year list', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue({ user: { role: 'manager' } })
    sql.mockResolvedValue([{ year: 2026 }, { year: 2025 }])
    const res = await getYears(new NextRequest('http://localhost/api/flow-logs/years'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([2026, 2025])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/anhhung/Desktop/athena/n8n-anti/athena-n8n-signal-auto/signal-smartsheet-management
npm test -- --testPathPattern="flow-logs-tree" --no-coverage 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '@/app/api/flow-logs/years/route'`

- [ ] **Step 3: Implement the route**

Create `app/api/flow-logs/years/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireRole } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const rows = await sql<{ year: number }[]>`
    SELECT DISTINCT EXTRACT(YEAR FROM log_date)::int AS year
    FROM game_flow_logs
    ORDER BY year DESC
  `

  return NextResponse.json(
    rows.map(r => r.year),
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --testPathPattern="flow-logs-tree" --no-coverage 2>&1 | tail -20
```

Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/flow-logs/years/route.ts __tests__/api/flow-logs-tree.test.ts
git commit -m "feat: add /api/flow-logs/years route"
```

---

## Task 2: `/api/flow-logs/months` route

**Files:**
- Create: `app/api/flow-logs/months/route.ts`
- Modify: `__tests__/api/flow-logs-tree.test.ts`

- [ ] **Step 1: Add failing tests for months route**

Append to `__tests__/api/flow-logs-tree.test.ts`:

```ts
import { GET as getMonths } from '@/app/api/flow-logs/months/route'

describe('GET /api/flow-logs/months', () => {
  it('returns 401 without manager session', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue(null)
    const res = await getMonths(new NextRequest('http://localhost/api/flow-logs/months?year=2026'))
    expect(res.status).toBe(401)
  })

  it('returns 400 when year param missing', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue({ user: { role: 'manager' } })
    const res = await getMonths(new NextRequest('http://localhost/api/flow-logs/months'))
    expect(res.status).toBe(400)
  })

  it('returns sorted month list for a year', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue({ user: { role: 'manager' } })
    sql.mockResolvedValue([{ month: 4 }, { month: 3 }])
    const res = await getMonths(new NextRequest('http://localhost/api/flow-logs/months?year=2026'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([4, 3])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --testPathPattern="flow-logs-tree" --no-coverage 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '@/app/api/flow-logs/months/route'`

- [ ] **Step 3: Implement the route**

Create `app/api/flow-logs/months/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireRole } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const year = new URL(req.url).searchParams.get('year')
  if (!year) return NextResponse.json({ error: 'year is required' }, { status: 400 })

  const rows = await sql<{ month: number }[]>`
    SELECT DISTINCT EXTRACT(MONTH FROM log_date)::int AS month
    FROM game_flow_logs
    WHERE EXTRACT(YEAR FROM log_date) = ${parseInt(year)}
    ORDER BY month DESC
  `

  return NextResponse.json(
    rows.map(r => r.month),
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --testPathPattern="flow-logs-tree" --no-coverage 2>&1 | tail -20
```

Expected: PASS (5 tests total)

- [ ] **Step 5: Commit**

```bash
git add app/api/flow-logs/months/route.ts __tests__/api/flow-logs-tree.test.ts
git commit -m "feat: add /api/flow-logs/months route"
```

---

## Task 3: `/api/flow-logs/month` route

**Files:**
- Create: `app/api/flow-logs/month/route.ts`
- Modify: `__tests__/api/flow-logs-tree.test.ts`

- [ ] **Step 1: Add failing tests for month route**

Append to `__tests__/api/flow-logs-tree.test.ts`:

```ts
import { GET as getMonth } from '@/app/api/flow-logs/month/route'

describe('GET /api/flow-logs/month', () => {
  it('returns 401 without manager session', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue(null)
    const res = await getMonth(new NextRequest('http://localhost/api/flow-logs/month?year=2026&month=4'))
    expect(res.status).toBe(401)
  })

  it('returns 400 when params missing', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue({ user: { role: 'manager' } })
    const res = await getMonth(new NextRequest('http://localhost/api/flow-logs/month?year=2026'))
    expect(res.status).toBe(400)
  })

  it('groups rows into DayGroup array', async () => {
    ;(getServerSession as jest.Mock).mockResolvedValue({ user: { role: 'manager' } })
    sql.mockResolvedValue([
      { log_date: new Date('2026-04-21'), flow_type: 'pull', period: 'morning', sheet: null, platform: 'all', count: '100', created_at: '2026-04-21T04:00:00Z' },
      { log_date: new Date('2026-04-21'), flow_type: 'pull', period: 'morning', sheet: null, platform: 'ios', count: '40', created_at: '2026-04-21T04:00:00Z' },
      { log_date: new Date('2026-04-21'), flow_type: 'pull', period: 'morning', sheet: null, platform: 'android', count: '60', created_at: '2026-04-21T04:00:00Z' },
      { log_date: new Date('2026-04-21'), flow_type: 'push', period: 'morning', sheet: 'puzzle', platform: 'all', count: '50', created_at: '2026-04-21T03:30:00Z' },
    ])
    const res = await getMonth(new NextRequest('http://localhost/api/flow-logs/month?year=2026&month=4'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].log_date).toBe('2026-04-21')
    expect(body[0].entries).toHaveLength(2) // pull-morning + push-morning
    const pullMorning = body[0].entries.find((e: { flow_type: string; period: string }) => e.flow_type === 'pull' && e.period === 'morning')
    expect(pullMorning.total).toBe(100)
    expect(pullMorning.detail).toEqual({ ios: 40, android: 60 })
    const pushMorning = body[0].entries.find((e: { flow_type: string; period: string }) => e.flow_type === 'push' && e.period === 'morning')
    expect(pushMorning.total).toBe(50)
    expect(pushMorning.detail).toEqual({ puzzle: 50 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --testPathPattern="flow-logs-tree" --no-coverage 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '@/app/api/flow-logs/month/route'`

- [ ] **Step 3: Implement the route**

Create `app/api/flow-logs/month/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireRole } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

interface RawRow {
  log_date: Date
  flow_type: string
  period: string
  sheet: string | null
  platform: string
  count: string
  created_at: string
}

interface EntryRow {
  flow_type: 'pull' | 'push'
  period: 'morning' | 'afternoon'
  total: number
  detail: Record<string, number>
  created_at: string
}

interface DayGroup {
  log_date: string
  entries: EntryRow[]
}

const ENTRY_ORDER = ['pull-morning', 'pull-afternoon', 'push-morning', 'push-afternoon']

export async function GET(req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const params = new URL(req.url).searchParams
  const year = params.get('year')
  const month = params.get('month')
  if (!year || !month) {
    return NextResponse.json({ error: 'year and month are required' }, { status: 400 })
  }

  const rows = await sql<RawRow[]>`
    SELECT log_date, flow_type, period, sheet, platform, count, created_at
    FROM game_flow_logs
    WHERE EXTRACT(YEAR FROM log_date) = ${parseInt(year)}
      AND EXTRACT(MONTH FROM log_date) = ${parseInt(month)}
    ORDER BY log_date DESC, flow_type, period
  `

  const dayMap: Record<string, DayGroup> = {}

  for (const row of rows) {
    const dateStr = new Date(row.log_date).toISOString().slice(0, 10)
    if (!dayMap[dateStr]) dayMap[dateStr] = { log_date: dateStr, entries: [] }

    const day = dayMap[dateStr]
    let entry = day.entries.find(e => e.flow_type === row.flow_type && e.period === row.period)
    if (!entry) {
      entry = { flow_type: row.flow_type as 'pull' | 'push', period: row.period as 'morning' | 'afternoon', total: 0, detail: {}, created_at: row.created_at }
      day.entries.push(entry)
    }

    if (row.flow_type === 'pull') {
      if (row.platform === 'all') entry.total = Number(row.count)
      else entry.detail[row.platform] = Number(row.count)
    } else {
      if (row.sheet && row.platform === 'all') {
        entry.total += Number(row.count)
        entry.detail[row.sheet] = Number(row.count)
      }
    }
  }

  for (const day of Object.values(dayMap)) {
    day.entries.sort((a, b) =>
      ENTRY_ORDER.indexOf(`${a.flow_type}-${a.period}`) - ENTRY_ORDER.indexOf(`${b.flow_type}-${b.period}`)
    )
  }

  const result = Object.values(dayMap).sort((a, b) => b.log_date.localeCompare(a.log_date))

  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --testPathPattern="flow-logs-tree" --no-coverage 2>&1 | tail -20
```

Expected: PASS (8 tests total)

- [ ] **Step 5: Commit**

```bash
git add app/api/flow-logs/month/route.ts __tests__/api/flow-logs-tree.test.ts
git commit -m "feat: add /api/flow-logs/month route with day grouping"
```

---

## Task 4: Rewrite `FlowHistory.tsx`

**Files:**
- Modify: `components/FlowHistory.tsx` (full rewrite)

- [ ] **Step 1: Replace the entire file**

Overwrite `components/FlowHistory.tsx` with:

```tsx
'use client'
import { useState, useEffect, useCallback } from 'react'

interface EntryRow {
  flow_type: 'pull' | 'push'
  period: 'morning' | 'afternoon'
  total: number
  detail: Record<string, number>
  created_at: string
}

interface DayGroup {
  log_date: string
  entries: EntryRow[]
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']
const PUSH_ICONS: Record<string, string> = { puzzle: '🧩', arcade: '🕹️', simulation: '🚗' }
const PUSH_ORDER = ['puzzle', 'arcade', 'simulation']

function getTodayVN() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function toVNTime(iso: string) {
  return new Date(iso).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' })
}

function EntryItem({ entry }: { entry: EntryRow }) {
  const isPull = entry.flow_type === 'pull'
  const periodLabel = entry.period === 'morning' ? 'Morning' : 'Afternoon'
  const detailKeys = isPull
    ? Object.keys(entry.detail)
    : PUSH_ORDER.filter(k => k in entry.detail)

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0', borderBottom: '1px dashed #D4C4A0' }}>
      <span style={{
        background: isPull ? '#7A8C1E' : '#5A3E1B',
        color: '#fff', borderRadius: 4, padding: '1px 7px',
        fontSize: 10, fontWeight: 700, flexShrink: 0, marginTop: 2
      }}>{isPull ? 'Pull' : 'Push'}</span>
      <span style={{ fontWeight: 600, color: '#2A1F08', fontSize: 12, flexShrink: 0, width: 64 }}>{periodLabel}</span>
      <span style={{ fontWeight: 800, color: '#2A1F08', fontSize: 13 }}>{entry.total.toLocaleString()}</span>
      <span style={{ color: '#6B5A3A', fontSize: 11, marginLeft: 4 }}>
        {detailKeys.map(k => (
          <span key={k} style={{ marginRight: 6 }}>
            {isPull ? k : (PUSH_ICONS[k] ?? k)}{' '}{(entry.detail[k] ?? 0).toLocaleString()}
          </span>
        ))}
      </span>
      <span style={{ color: '#9A8A6A', fontSize: 10, marginLeft: 'auto', flexShrink: 0 }}>{toVNTime(entry.created_at)}</span>
    </div>
  )
}

function DayRow({ day, open, onToggle }: { day: DayGroup; open: boolean; onToggle: () => void }) {
  const today = getTodayVN()
  const isToday = day.log_date === today
  const [, m, d] = day.log_date.split('-')
  const label = isToday ? 'Today' : `${d}/${m}`

  return (
    <div style={{ border: '2px solid #D4C4A0', borderRadius: 8, overflow: 'hidden', marginBottom: 3 }}>
      <button
        onClick={onToggle}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: '#EFE3C8', padding: '5px 10px', border: 'none', cursor: 'pointer', textAlign: 'left' }}
      >
        <span style={{ fontSize: 10 }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontWeight: 700, color: '#2A1F08', fontSize: 12 }}>{label}</span>
        {isToday && <span style={{ background: '#7A8C1E', color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>Today</span>}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6B5A3A' }}>
          {day.entries.filter(e => e.flow_type === 'pull').length} pull · {day.entries.filter(e => e.flow_type === 'push').length} push
        </span>
      </button>
      {open && (
        <div style={{ padding: '6px 12px', background: '#FAF5EC' }}>
          {day.entries.map((e, i) => <EntryItem key={`${e.flow_type}-${e.period}-${i}`} entry={e} />)}
        </div>
      )}
    </div>
  )
}

function MonthRow({
  year, month, open, loaded, days, error,
  onToggle, openDays, onToggleDay
}: {
  year: number; month: number; open: boolean; loaded: boolean
  days: DayGroup[]; error: string | null
  onToggle: () => void
  openDays: Set<string>; onToggleDay: (date: string) => void
}) {
  return (
    <div style={{ marginBottom: 4 }}>
      <button
        onClick={onToggle}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: '#C8B896', border: 'none', borderRadius: 7, padding: '5px 10px', cursor: 'pointer', textAlign: 'left' }}
      >
        <span style={{ fontSize: 10 }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontWeight: 700, color: '#2A1F08', fontSize: 12 }}>{MONTH_NAMES[month - 1]}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6B5A3A' }}>
          {!loaded ? 'click to load' : `${days.length} days`}
        </span>
      </button>
      {open && (
        <div style={{ marginLeft: 14, marginTop: 3 }}>
          {!loaded && (
            <p style={{ fontSize: 11, color: '#9A8A6A', padding: '4px 6px' }}>Loading...</p>
          )}
          {error && (
            <p style={{ fontSize: 11, color: '#b91c1c', padding: '4px 6px' }}>{error}</p>
          )}
          {loaded && days.length === 0 && (
            <p style={{ fontSize: 11, color: '#9A8A6A', padding: '4px 6px' }}>No data for this month.</p>
          )}
          {loaded && days.map(day => (
            <DayRow
              key={day.log_date}
              day={day}
              open={openDays.has(day.log_date)}
              onToggle={() => onToggleDay(day.log_date)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function FlowHistory() {
  const [years, setYears] = useState<number[] | null>(null)
  const [monthsByYear, setMonthsByYear] = useState<Record<number, number[] | null>>({})
  const [entriesByMonth, setEntriesByMonth] = useState<Record<string, DayGroup[]>>({})
  const [loadingMonths, setLoadingMonths] = useState<Set<number>>(new Set())
  const [loadingMonth, setLoadingMonth] = useState<Set<string>>(new Set())
  const [monthErrors, setMonthErrors] = useState<Record<string, string>>({})
  const [openYears, setOpenYears] = useState<Set<number>>(new Set())
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set())
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  const fetchYears = useCallback(async () => {
    const res = await fetch('/api/flow-logs/years', { cache: 'no-store' })
    if (!res.ok) return []
    return await res.json() as number[]
  }, [])

  const fetchMonths = useCallback(async (year: number) => {
    const res = await fetch(`/api/flow-logs/months?year=${year}`, { cache: 'no-store' })
    if (!res.ok) return []
    return await res.json() as number[]
  }, [])

  const fetchMonth = useCallback(async (year: number, month: number): Promise<DayGroup[]> => {
    const res = await fetch(`/api/flow-logs/month?year=${year}&month=${month}`, { cache: 'no-store' })
    if (!res.ok) throw new Error('Failed to load')
    return await res.json() as DayGroup[]
  }, [])

  // Auto-open today on mount
  useEffect(() => {
    async function init() {
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
      const todayYear = now.getFullYear()
      const todayMonth = now.getMonth() + 1
      const todayDate = getTodayVN()

      const fetchedYears = await fetchYears()
      setYears(fetchedYears)
      if (!fetchedYears.includes(todayYear)) return

      setOpenYears(new Set([todayYear]))
      setLoadingMonths(s => new Set([...s, todayYear]))
      const fetchedMonths = await fetchMonths(todayYear)
      setMonthsByYear({ [todayYear]: fetchedMonths })
      setLoadingMonths(s => { const n = new Set(s); n.delete(todayYear); return n })
      if (!fetchedMonths.includes(todayMonth)) return

      const mk = `${todayYear}-${todayMonth}`
      setOpenMonths(new Set([mk]))
      setLoadingMonth(s => new Set([...s, mk]))
      try {
        const days = await fetchMonth(todayYear, todayMonth)
        setEntriesByMonth({ [mk]: days })
        if (days.some(d => d.log_date === todayDate)) {
          setOpenDays(new Set([todayDate]))
        }
      } catch {
        setMonthErrors({ [mk]: 'Failed to load' })
      } finally {
        setLoadingMonth(s => { const n = new Set(s); n.delete(mk); return n })
      }
    }
    init()
  }, [fetchYears, fetchMonths, fetchMonth])

  async function toggleYear(year: number) {
    setOpenYears(s => {
      const n = new Set(s)
      n.has(year) ? n.delete(year) : n.add(year)
      return n
    })
    if (monthsByYear[year] !== undefined) return // already loaded
    setLoadingMonths(s => new Set([...s, year]))
    const months = await fetchMonths(year)
    setMonthsByYear(s => ({ ...s, [year]: months }))
    setLoadingMonths(s => { const n = new Set(s); n.delete(year); return n })
  }

  async function toggleMonth(year: number, month: number) {
    const mk = `${year}-${month}`
    setOpenMonths(s => {
      const n = new Set(s)
      n.has(mk) ? n.delete(mk) : n.add(mk)
      return n
    })
    if (entriesByMonth[mk] !== undefined) return // already loaded
    setLoadingMonth(s => new Set([...s, mk]))
    try {
      const days = await fetchMonth(year, month)
      setEntriesByMonth(s => ({ ...s, [mk]: days }))
    } catch {
      setMonthErrors(s => ({ ...s, [mk]: 'Failed to load. Try again.' }))
    } finally {
      setLoadingMonth(s => { const n = new Set(s); n.delete(mk); return n })
    }
  }

  function toggleDay(date: string) {
    setOpenDays(s => {
      const n = new Set(s)
      n.has(date) ? n.delete(date) : n.add(date)
      return n
    })
  }

  async function doRefresh() {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const res = await fetch('/api/flow-logs/refresh', { method: 'POST' })
      if (!res.ok) throw new Error('Refresh failed')
      // Reload today's month
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
      const year = now.getFullYear()
      const month = now.getMonth() + 1
      const mk = `${year}-${month}`
      const days = await fetchMonth(year, month)
      setEntriesByMonth(s => ({ ...s, [mk]: days }))
      const todayDate = getTodayVN()
      if (days.some(d => d.log_date === todayDate)) {
        setOpenDays(s => new Set([...s, todayDate]))
      }
    } catch {
      setRefreshError('Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <p className="bean-section-label">Games History</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {refreshError && <span style={{ fontSize: 11, color: '#b91c1c' }}>{refreshError}</span>}
          <button
            onClick={doRefresh}
            disabled={refreshing}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              background: '#D4C4A0', color: '#5A3E1B', border: 'none',
              borderRadius: 8, padding: '4px 10px', fontWeight: 700,
              fontSize: 12, cursor: 'pointer', opacity: refreshing ? 0.6 : 1
            }}
          >
            <span style={{ display: 'inline-block', animation: refreshing ? 'spin 1s linear infinite' : 'none' }}>↻</span>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Scroll container */}
      <div style={{ height: 350, overflowY: 'auto', paddingRight: 4 }}>
        {years === null && (
          <p style={{ fontSize: 12, color: '#9A8A6A', padding: '8px 4px' }}>Loading...</p>
        )}
        {years !== null && years.length === 0 && (
          <p style={{ fontSize: 12, color: '#9A8A6A', padding: '8px 4px' }}>No history yet.</p>
        )}
        {years !== null && years.map(year => (
          <div key={year} style={{ marginBottom: 6 }}>
            {/* Year row */}
            <button
              onClick={() => toggleYear(year)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                background: '#D4C4A0', border: 'none', borderRadius: 8,
                padding: '6px 10px', cursor: 'pointer', textAlign: 'left', marginBottom: 4
              }}
            >
              <span style={{ fontSize: 10 }}>{openYears.has(year) ? '▾' : '▸'}</span>
              <span style={{ fontWeight: 700, color: '#2A1F08', fontSize: 13 }}>{year}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6B5A3A' }}>
                {loadingMonths.has(year) ? 'loading...' : monthsByYear[year] == null ? 'click to load' : `${monthsByYear[year]!.length} months`}
              </span>
            </button>

            {/* Months */}
            {openYears.has(year) && monthsByYear[year] != null && (
              <div style={{ marginLeft: 14 }}>
                {(monthsByYear[year] as number[]).map(month => {
                  const mk = `${year}-${month}`
                  return (
                    <MonthRow
                      key={mk}
                      year={year}
                      month={month}
                      open={openMonths.has(mk)}
                      loaded={entriesByMonth[mk] !== undefined}
                      days={entriesByMonth[mk] ?? []}
                      error={monthErrors[mk] ?? null}
                      onToggle={() => toggleMonth(year, month)}
                      openDays={openDays}
                      onToggleDay={toggleDay}
                    />
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add components/FlowHistory.tsx
git commit -m "feat: rewrite FlowHistory as lazy-loading year/month/day tree"
```

---

## Task 5: Update `dashboard/page.tsx`

**Files:**
- Modify: `app/(manager)/dashboard/page.tsx`

- [ ] **Step 1: Remove flowHistory state and fetch, remove FlowHistory prop**

In `app/(manager)/dashboard/page.tsx`:

1. Remove line: `const [flowHistory, setFlowHistory] = useState<unknown[]>([])`
2. In `fetchData()`, remove `fetch('/api/flow-logs', { cache: 'no-store' })` from the `Promise.all` array and remove `historyRes` from destructuring
3. Remove `if (historyRes.ok) setFlowHistory(await historyRes.json())`
4. Remove the `401` check for `historyRes`
5. Change `<FlowHistory entries={flowHistory as Parameters<typeof FlowHistory>[0]['entries']} />` to `<FlowHistory />`

The updated `fetchData` becomes:

```ts
async function fetchData() {
  const [statsRes, sheetsRes] = await Promise.all([
    fetch('/api/stats', { cache: 'no-store' }),
    fetch('/api/smartsheet-sheets', { cache: 'no-store' }),
  ])
  if (statsRes.status === 401) {
    window.location.href = '/login'
    return
  }
  if (statsRes.ok) setStats(await statsRes.json())
  if (sheetsRes.ok) setSheetStats(await sheetsRes.json())
}
```

The Games History section JSX becomes:

```tsx
{/* Games History */}
<div className="bean-card p-4">
  <FlowHistory />
</div>
```

- [ ] **Step 2: Verify no TypeScript errors**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors

- [ ] **Step 3: Run all tests**

```bash
npm test -- --no-coverage 2>&1 | tail -30
```

Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add app/(manager)/dashboard/page.tsx
git commit -m "refactor: FlowHistory self-contained, remove flowHistory from dashboard"
```

---

## Self-Review Checklist

- [x] `/api/flow-logs/years` — Task 1 ✓
- [x] `/api/flow-logs/months` — Task 2 ✓
- [x] `/api/flow-logs/month` with grouping — Task 3 ✓
- [x] FlowHistory tree with Year/Month/Day — Task 4 ✓
- [x] Refresh button (calls POST refresh, reloads today's month) — Task 4 ✓
- [x] Scroll container 350px — Task 4 ✓
- [x] Auto-open today's year/month/day — Task 4 ✓
- [x] Dashboard cleanup — Task 5 ✓
- [x] Error states (loading/failed/empty) — Task 4 ✓
- [x] Cache (already-loaded months not re-fetched) — Task 4 ✓
- [x] Type names consistent across tasks: `DayGroup`, `EntryRow`, `ENTRY_ORDER` ✓
