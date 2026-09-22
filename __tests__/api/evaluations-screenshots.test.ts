/**
 * @jest-environment node
 */
// GET /api/evaluations?with_screenshots=1 adds StoreKit/manual screenshot arrays to
// each row, for the Individual tab's review table. The plain Evaluations page (200
// rows/page) must never pay for this: without the flag the two keys must be ABSENT
// from the row object, not present-and-null, and the query itself must not mention
// them (a consumer doing `'screenshot_urls' in row` has to be able to tell).
import { NextRequest } from 'next/server'
import { clearAvailableMonthsCache } from '@/lib/evaluations-filters'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { GET } from '@/app/api/evaluations/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

function setupSql(rows: Record<string, unknown>[]) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('SELECT ge.id')) return Promise.resolve(rows)
    return Promise.resolve([])
  })
}

function allQueries(): string {
  return sqlMock.mock.calls
    .filter(c => Array.isArray(c[0]))
    .map(c => (c[0] as string[]).join(' '))
    .join('\n')
}

function get(qs: string) {
  return GET(new NextRequest(`http://localhost/api/evaluations?${qs}`))
}

describe('GET /api/evaluations with_screenshots flag', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-06-15T10:00:00Z').getTime())
    clearAvailableMonthsCache()
  })
  afterEach(() => { jest.restoreAllMocks() })

  it('without the flag, the query never mentions the screenshot columns and rows omit the keys entirely', async () => {
    setupSql([{ id: 1, game_id: 'g1' }])
    const res = await get('category=puzzle&year=2026&month=6&page=2')
    const json = await res.json()
    const q = allQueries()
    expect(q).not.toContain('screenshot_urls')
    expect(q).not.toContain('manual_screenshot_urls')
    expect('screenshot_urls' in json.data[0]).toBe(false)
    expect('manual_screenshot_urls' in json.data[0]).toBe(false)
  })

  it('with_screenshots=1 adds both expressions to the select, reusing the detail endpoint\'s exact columns', async () => {
    setupSql([{ id: 1, game_id: 'g1', screenshot_urls: ['a.png'], manual_screenshot_urls: ['b.png'] }])
    const res = await get('category=puzzle&year=2026&month=6&page=2&with_screenshots=1')
    const json = await res.json()
    const q = allQueries()
    expect(q).toContain("gi.metadata->'screenshot_urls' AS screenshot_urls")
    expect(q).toContain("gi.metadata->'manual_screenshot_urls' AS manual_screenshot_urls")
    expect(json.data[0].screenshot_urls).toEqual(['a.png'])
    expect(json.data[0].manual_screenshot_urls).toEqual(['b.png'])
  })

  it('a game with no metadata (or a metadata object missing the key) yields null, not [] or a throw', async () => {
    setupSql([{ id: 2, game_id: 'g2', screenshot_urls: null, manual_screenshot_urls: null }])
    const res = await get('category=puzzle&year=2026&month=6&page=2&with_screenshots=1')
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.data[0].screenshot_urls).toBeNull()
    expect(json.data[0].manual_screenshot_urls).toBeNull()
  })
})
