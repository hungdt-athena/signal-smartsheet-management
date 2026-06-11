/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { GET } from '@/app/api/evaluations/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

interface MockData {
  months?: { year: number; month: number }[]
  rows?: Record<string, unknown>[]
  stats?: { total: number; evaluated: number; dead_links: number }[]
  conclusions?: { c: string }[]
}

// Routes mock results by inspecting the SQL text. All tagged-template calls
// (queries and fragments alike) receive a strings array; calls that match no
// keyword branch — fragments and the sql(array) IN-list helper — resolve [].
function setupSql({ months = [], rows = [], stats = [{ total: 0, evaluated: 0, dead_links: 0 }], conclusions = [] }: MockData = {}) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('EXTRACT(YEAR')) return Promise.resolve(months)
    if (q.includes('count(*)')) return Promise.resolve(stats)
    if (q.includes('initial_conclusion AS c')) return Promise.resolve(conclusions)
    if (q.includes('SELECT ge.id')) return Promise.resolve(rows)
    return Promise.resolve([])
  })
}

// All SQL text seen by the mock, for shape assertions.
function allQueries(): string {
  return sqlMock.mock.calls
    .filter(c => Array.isArray(c[0]))
    .map(c => (c[0] as string[]).join(' '))
    .join('\n')
}

function get(qs: string) {
  return GET(new NextRequest(`http://localhost/api/evaluations?${qs}`))
}

describe('GET /api/evaluations', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  beforeEach(() => {
    // 2026-06-15 in UTC — current month in UTC+7 is June 2026.
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-06-15T10:00:00Z').getTime())
  })
  afterEach(() => { jest.restoreAllMocks() })

  it('month=auto picks the current month when it has data', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }, { year: 2026, month: 5 }] })
    const res = await get('category=puzzle&month=auto&page=1')
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.applied_month).toEqual({ year: 2026, month: 6 })
  })

  it('month=auto falls back to the latest month with data', async () => {
    setupSql({ months: [{ year: 2026, month: 5 }, { year: 2026, month: 4 }] })
    const res = await get('category=puzzle&month=auto&page=1')
    const json = await res.json()
    expect(json.applied_month).toEqual({ year: 2026, month: 5 })
  })

  it('month=auto with no data applies no month and returns applied_month null', async () => {
    setupSql({ months: [] })
    const res = await get('category=puzzle&month=auto&page=1')
    const json = await res.json()
    expect(json.applied_month).toBeNull()
    expect(json.data).toEqual([])
  })

  it('page 1 returns stats computed from the aggregate query', async () => {
    setupSql({
      months: [{ year: 2026, month: 6 }],
      stats: [{ total: 320, evaluated: 200, dead_links: 12 }],
    })
    const res = await get('category=puzzle&month=auto&page=1')
    const json = await res.json()
    expect(json.total).toBe(320)
    expect(json.stats).toEqual({ total: 320, evaluated: 200, pending: 120, dead_links: 12 })
    expect(json.available_months).toEqual([{ year: 2026, month: 6 }])
  })

  it('page > 1 skips meta and stats queries entirely', async () => {
    setupSql({ rows: [{ id: 1 }] })
    const res = await get('category=puzzle&year=2026&month=6&page=2')
    const json = await res.json()
    expect(json.data).toEqual([{ id: 1 }])
    expect(json.stats).toBeUndefined()
    expect(json.available_months).toBeUndefined()
    expect(json.available_conclusions).toBeUndefined()
    const q = allQueries()
    expect(q).not.toContain('count(*)')
    expect(q).not.toContain('EXTRACT(YEAR')
  })

  it('list query no longer selects screenshot_urls or categories', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&month=auto&page=1')
    const q = allQueries()
    expect(q).not.toContain('screenshot_urls')
    expect(q).not.toContain("metadata->'categories'")
  })

  it('explicit month filter uses a make_date range, not EXTRACT', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=3&page=1')
    const q = allQueries()
    expect(q).toContain('make_date')
    // The months meta query legitimately uses EXTRACT(MONTH ...)::int;
    // only the old equality-filter form must be gone.
    expect(q).not.toContain('EXTRACT(MONTH FROM ge.assigned_date) =')
  })
})
