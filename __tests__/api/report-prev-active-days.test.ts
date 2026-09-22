/**
 * @jest-environment node
 */
// `rhythm` (Individual tab, contractor's own view) reads `d.prev.activeDays` - that
// person's own active-day count in the window before this one. The route's `prev`
// query used to carry no evaluator filter at all, so the field was always absent and
// `rhythm` could never fire. These tests pin the fix: `prev.activeDays` is populated
// for a scoped (evaluator) request, stays off an unscoped (manager) one, and `prev`
// itself stays null when there is no previous period to report.
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: Object.assign(jest.fn(), { unsafe: jest.fn(() => '') }) }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn(() => Promise.resolve(null)) }))
jest.mock('@/lib/auth-guard', () => ({ requireRole: jest.fn(() => Promise.resolve(null)) }))
jest.mock('@/lib/report-config-db', () => ({
  loadReportConfig: jest.fn(() => Promise.resolve({
    config: { excluded: [], weights: { Volume: 40, Consistency: 15, Signal: 15, Survival: 15, Recording: 15 }, credibility: false },
    updatedAt: '2026-08-07T00:00:00Z',
  })),
}))

import { getServerSession } from 'next-auth'
import { GET } from '@/app/api/report/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

// One row of the `refQuery` shape (baseline AND prev both call it). `self_active_days`
// is what this task adds - MitT worked 4 of the days the whole team worked 10.
const REF_ROW = {
  evaluated: 50, shortlisted: 10, final_priority: 2, noted: 30,
  person_days: 10, self_active_days: 4,
}

function setupSql(refRows: Array<Record<string, unknown>> | null = [REF_ROW]) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    // the baseline AND prev queries share this exact shape - see refQuery
    if (q.includes('AS person_days')) return Promise.resolve(refRows ?? [])
    if (q.includes('AS active_days')) {
      return Promise.resolve([
        { k: 'mitt', name: 'MitT', evaluated: 20, active_days: 4, ta_sum: '5', ta_count: 5, shortlisted: 5, priority_iv: 1, insight: 0, link_dead: 0, noted: 10 },
      ])
    }
    return Promise.resolve([])
  })
}

// A Monday with both a resolvable current AND previous week.
const call = (opts: { view?: string; key?: string; category?: string } = {}) =>
  GET(new NextRequest(`http://localhost/api/report?view=${opts.view ?? 'week'}&key=${opts.key ?? '2026-09-14'}&category=${opts.category ?? 'all'}`))

describe('GET /api/report prev.activeDays', () => {
  it('carries the scoped person\'s own active-day count from the previous window', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'MitT' } })
    setupSql()
    const body = await (await call({ category: 'puzzle' })).json()
    expect(body.prev).not.toBeNull()
    expect(body.prev.activeDays).toBe(4)
  })

  it('never carries a per-person figure for an unscoped (manager) request', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'Boss' } })
    setupSql()
    const body = await (await call({ category: 'arcade' })).json()
    expect(body.prev).not.toBeNull()
    expect(body.prev).not.toHaveProperty('activeDays')
  })

  it('stays null when the window has no previous period to report', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'MitT' } })
    // the mocked DB returns nothing for the ref query at all (no prior evaluations)
    setupSql([])
    const body = await (await call({ category: 'simulation' })).json()
    expect(body.prev).toBeNull()
  })
})
