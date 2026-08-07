/**
 * @jest-environment node
 */
// GET /api/report is readable by evaluators, but must return ONLY their own row.
// These tests pin that contract: an evaluator sees themselves plus team aggregates
// (the "vs team" benchmark), and never another person's name or numbers.
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

// two people so there is something to leak if the scoping is wrong
const PER_EVAL = [
  {
    k: 'mitt', name: 'MitT', evaluated: 200, active_days: 10, ta_sum: '20', ta_count: 10,
    shortlisted: 20, priority_iv: 2, insight: 1, link_dead: 5, noted: 180,
  },
  {
    k: 'huydd', name: 'HuyDD', evaluated: 100, active_days: 10, ta_sum: '30', ta_count: 10,
    shortlisted: 5, priority_iv: 0, insight: 0, link_dead: 1, noted: 50,
  },
]

function setupSql() {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('AS active_days')) return Promise.resolve(PER_EVAL)
    if (q.includes('AS assigned')) {
      return Promise.resolve([{ k: 'mitt', name: 'MitT', assigned: 220 }, { k: 'huydd', name: 'HuyDD', assigned: 110 }])
    }
    // per-person per-day mix (Daily breakdown) - same columns plus the day
    if (q.includes('::date::text AS d,')) {
      return Promise.resolve([
        { k: 'mitt', d: '2026-08-03', c: 'Bypass', n: 10 },
        { k: 'huydd', d: '2026-08-03', c: 'Bypass', n: 7 },
      ])
    }
    if (q.includes('ge.initial_conclusion AS c')) {
      return Promise.resolve([
        { k: 'mitt', c: 'Bypass', n: 180 }, { k: 'mitt', c: 'List_Idea', n: 20 },
        { k: 'huydd', c: 'Bypass', n: 95 }, { k: 'huydd', c: 'List_Idea', n: 5 },
      ])
    }
    return Promise.resolve([])
  })
}

const call = () => GET(new NextRequest('http://localhost/api/report?view=month&key=2026-08'))

beforeEach(setupSql)

describe('GET /api/report scoping', () => {
  it('gives an admin every person', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'Boss' } })
    const body = await (await call()).json()
    expect(body.canSeeTeam).toBe(true)
    expect(body.self).toBeNull()
    expect(body.evaluators.map((e: { key: string }) => e.key).sort()).toEqual(['huydd', 'mitt'])
  })

  it('gives an evaluator only their own row', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'MitT' } })
    const body = await (await call()).json()
    expect(body.canSeeTeam).toBe(false)
    expect(body.self).toBe('mitt')
    expect(body.evaluators).toHaveLength(1)
    expect(body.evaluators[0].key).toBe('mitt')
    expect(Object.keys(body.dailyMix)).toEqual(['mitt'])
    // no other person anywhere in the serialized payload
    expect(JSON.stringify(body).toLowerCase()).not.toContain('huydd')
  })

  it('empties the team-wide charts for an evaluator but keeps the benchmark', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'MitT' } })
    const body = await (await call()).json()
    expect(body.series).toEqual([])
    expect(body.metricSeries).toEqual([])
    expect(body.heatmap.rows).toEqual([])
    expect(body.scoreRank.rows).toEqual([])
    expect(body.initialConclusions).toEqual([])
    expect(body.pipeline).toBeNull()
    expect(body.config.excluded).toEqual([])
    // team benchmark survives: it is aggregate, and it is the point of the comparison
    expect(body.bench.people).toBe(2)
    expect(body.bench.evaluated).toBe(150)          // (200 + 100) / 2 people
    expect(body.bench.survivalRate).toBeCloseTo(25 / 300)  // weighted, not a mean of rates
  })

  it('caches per scope, so an evaluator never gets the admin bundle', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'Boss' } })
    expect((await (await call()).json()).canSeeTeam).toBe(true)
    // same window, same params, different role -> must not be a cache hit
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'MitT' } })
    const scoped = await (await call()).json()
    expect(scoped.canSeeTeam).toBe(false)
    expect(scoped.evaluators).toHaveLength(1)
  })

  it('refuses a scoped request with no resolvable name', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: '' } })
    const res = await call()
    expect(res.status).toBe(403)
  })

  it('ignores the team-wide title lens for an evaluator', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'MitT' } })
    const res = await GET(new NextRequest('http://localhost/api/report?view=month&key=2026-08&title=fulltime'))
    expect((await res.json()).title).toBe('all')
  })
})
