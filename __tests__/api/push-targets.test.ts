/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { GET } from '@/app/api/cron/push-targets/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sessionMock = getServerSession as jest.Mock
const sqlMock = sql as unknown as jest.Mock

function setupSql({ config = null as string | null, roster = [] as Record<string, unknown>[] }) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('FROM app_config')) return Promise.resolve(config === null ? [] : [{ value: config }])
    if (q.includes('FROM evaluator_roster')) return Promise.resolve(roster)
    return Promise.resolve([])
  })
}

function get(secret = 's3cret') {
  return GET(new NextRequest('http://localhost/api/cron/push-targets', {
    headers: { 'x-webhook-secret': secret },
  }))
}

describe('GET /api/cron/push-targets', () => {
  const realSecret = process.env.WEBHOOK_SECRET
  beforeAll(() => { process.env.WEBHOOK_SECRET = 's3cret'; process.env.SKIP_AUTH = 'false' })
  afterAll(() => { process.env.WEBHOOK_SECRET = realSecret })
  beforeEach(() => { sessionMock.mockResolvedValue(null) })

  it('rejects a wrong secret with 401', async () => {
    setupSql({})
    expect((await get('wrong')).status).toBe(401)
  })

  it('returns only genres that are on AND have someone available', async () => {
    setupSql({
      config: '{"puzzle":true,"arcade":true,"simulation":true}',
      roster: [
        { category_group: 'puzzle', available: '7' },
        { category_group: 'arcade', available: '0' },
        { category_group: 'simulation', available: '2' },
      ],
    })
    const json = await (await get()).json()
    expect(json.targets).toEqual(['puzzle', 'simulation'])
  })

  it('omits a genre that is toggled off even when people are available', async () => {
    setupSql({
      config: '{"puzzle":true,"arcade":false}',
      roster: [
        { category_group: 'puzzle', available: '3' },
        { category_group: 'arcade', available: '5' },
      ],
    })
    const json = await (await get()).json()
    expect(json.targets).toEqual(['puzzle'])
  })

  it('reports every genre with its reason, so a skipped run is explainable', async () => {
    setupSql({
      config: '{"puzzle":true,"arcade":true,"simulation":false}',
      roster: [{ category_group: 'puzzle', available: '7' }],
    })
    const json = await (await get()).json()
    expect(json.genres).toEqual([
      { bucket: 'puzzle', enabled: true, available: 7, active: true },
      { bucket: 'arcade', enabled: true, available: 0, active: false },
      { bucket: 'simulation', enabled: false, available: 0, active: false },
    ])
  })

  it('falls back to puzzle-only when no config row exists yet', async () => {
    setupSql({ config: null, roster: [{ category_group: 'puzzle', available: '1' }] })
    const json = await (await get()).json()
    expect(json.targets).toEqual(['puzzle'])
  })
})
