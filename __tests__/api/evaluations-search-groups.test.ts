/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))
jest.mock('@/lib/config', () => ({ getConfigValues: jest.fn(async () => []) }))
jest.mock('@/lib/people-config-db', () => ({ loadHiddenEvaluatorKeys: jest.fn(async () => []) }))
jest.mock('@/lib/session', () => ({ getSession: jest.fn(async () => ({ user: { name: 'KietCD', role: 'evaluator' } })) }))
jest.mock('@/lib/current-batch', () => ({ getCurrentBatch: jest.fn(async () => 'W3 Nov, 2026') }))

import { GET as getList } from '@/app/api/evaluations/route'
import { clearAvailableMonthsCache } from '@/lib/evaluations-filters'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock
const calls = () => sqlMock.mock.calls.filter(c => Array.isArray(c[0]))
const texts = () => calls().map(c => (c[0] as string[]).join('?'))
// The list's group filter is its own fragment; the month dropdown's cached query has a different shape.
const groupFilter = () => texts().some(t => t === 'ge.category_group = ?')
const get = (qs: string) => getList(new NextRequest(`http://localhost/api/evaluations?${qs}`))

beforeEach(() => {
  clearAvailableMonthsCache()
  sqlMock.mockReset()
  sqlMock.mockImplementation(() => Promise.resolve([]))
})

describe('GET /api/evaluations: a search spans every category group', () => {
  it('without a search, the tab narrows to its group', async () => {
    await get('category=puzzle&limit=10')
    expect(groupFilter()).toBe(true)
  })

  it('with a search, no group filter: a game in Arcade is found from the Puzzle tab', async () => {
    await get('category=puzzle&q=Sloppy&limit=10')
    expect(groupFilter()).toBe(false)
  })

  it('a search too short to act on keeps the group filter', async () => {
    await get('category=puzzle&q=Sl&limit=10')
    expect(groupFilter()).toBe(true)
  })

  it('a search never widens who you may see: an evaluator stays on their own rows', async () => {
    process.env.SKIP_AUTH = 'false'
    try {
      await get('category=puzzle&q=Sloppy&limit=10')
      const scoped = calls().some(c => (c[0] as string[]).join('?').includes('initial_evaluator') && c.slice(1).includes('KietCD'))
      expect(scoped).toBe(true)
    } finally {
      process.env.SKIP_AUTH = 'true'
    }
  })
})
