/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))
jest.mock('@/lib/config', () => ({ getConfigValues: jest.fn(async () => []) }))
jest.mock('@/lib/people-config-db', () => ({ loadHiddenEvaluatorKeys: jest.fn(async () => []) }))

import { GET as getList } from '@/app/api/evaluations/route'
import { GET as getFacets } from '@/app/api/evaluations/facets/route'
import { GET as getOne } from '@/app/api/evaluations/[gameId]/route'
import { clearAvailableMonthsCache } from '@/lib/evaluations-filters'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

// Legacy row first, global row second: a reader that takes "the first row" or builds a
// per-category key gets W1; the right answer is the global W2.
const CONFIG = [
  { key: 'current_batch:arcade', value: 'W1 Oct, 2026' },
  { key: 'current_batch', value: 'W2 Oct, 2026' },
]

function db({ present = [] as { batch: string }[], game = null as Record<string, unknown> | null } = {}) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('app_config')) return Promise.resolve(CONFIG)
    if (q.includes('FROM game_evaluations ge') && q.includes('LEFT JOIN developer')) {
      return Promise.resolve(game ? [game] : [])
    }
    if (q.includes('SELECT DISTINCT ge.batch') && q.includes('JOIN game_info')) return Promise.resolve(present)
    if (q.includes('SELECT DISTINCT ge.batch')) return Promise.resolve(present)
    if (q.includes('count(*)')) return Promise.resolve([{ total: 0, evaluated: 0 }])
    return Promise.resolve([])
  })
}

describe('readers of the current batch use the one global value', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => clearAvailableMonthsCache())

  it('GET /api/evaluations/facets', async () => {
    db({ present: [{ batch: 'W2 Oct, 2026' }] })
    const res = await getFacets(new NextRequest('http://localhost/api/evaluations/facets?category=arcade'))
    const json = await res.json()
    expect(json.current_batch).toBe('W2 Oct, 2026')
    expect(json.default_batch).toBe('W2 Oct, 2026')
  })

  it('GET /api/evaluations (page 1 with meta)', async () => {
    db({ present: [{ batch: 'W2 Oct, 2026' }] })
    const res = await getList(new NextRequest('http://localhost/api/evaluations?category=arcade&page=1'))
    const json = await res.json()
    expect(json.current_batch).toBe('W2 Oct, 2026')
    expect(json.default_batch).toBe('W2 Oct, 2026')
  })

  it('GET /api/evaluations/[gameId] returns it as data.current_batch for any category', async () => {
    db({ game: { id: 1, game_id: 'g1', category_group: 'arcade', initial_evaluator: 'X', screenshot_urls: null, manual_screenshot_urls: null } })
    const res = await getOne(
      new NextRequest('http://localhost/api/evaluations/g1?category=arcade'),
      { params: { gameId: 'g1' } },
    )
    const json = await res.json()
    expect(json.data.current_batch).toBe('W2 Oct, 2026')
  })
})
