/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { POST } from '@/app/api/cron/push-evaluations/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sessionMock = getServerSession as jest.Mock

const sqlMock = sql as unknown as jest.Mock

function post(body: unknown, secret = 's3cret') {
  return POST(new NextRequest('http://localhost/api/cron/push-evaluations', {
    method: 'POST',
    headers: { 'x-webhook-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('POST /api/cron/push-evaluations', () => {
  const realSecret = process.env.WEBHOOK_SECRET
  beforeAll(() => { process.env.WEBHOOK_SECRET = 's3cret'; process.env.SKIP_AUTH = 'false' })
  afterAll(() => { process.env.WEBHOOK_SECRET = realSecret })
  beforeEach(() => { sqlMock.mockReset(); sqlMock.mockResolvedValue([]); sessionMock.mockResolvedValue(null) })

  it('rejects a wrong secret with 401', async () => {
    const res = await post({ category: 'puzzle', categories: ['puzzle'] }, 'wrong')
    expect(res.status).toBe(401)
  })

  it('rejects an unknown category with 400', async () => {
    const res = await post({ category: 'rpg', categories: ['rpg'] })
    expect(res.status).toBe(400)
  })

  it('rejects an empty categories list with 400', async () => {
    const res = await post({ category: 'puzzle', categories: [] })
    expect(res.status).toBe(400)
  })

  it('inserts and returns the pushed game ids', async () => {
    sqlMock.mockResolvedValue([{ game_id: 'g1' }, { game_id: 'g2' }])
    const res = await post({ category: 'puzzle', categories: ['puzzle', 'word'] })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.pushed).toBe(2)
    expect(json.game_ids).toEqual(['g1', 'g2'])
    const q = sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? c[0].join(' ') : '')).join('\n')
    expect(q).toContain('INSERT INTO game_evaluations')
    expect(q).toContain('ON CONFLICT (game_id, category_group) DO NOTHING')
    expect(q).toContain("INTERVAL '30 days'")
  })

  it('dryRun selects without inserting', async () => {
    sqlMock.mockResolvedValue([{ game_id: 'g1' }])
    const res = await post({ category: 'puzzle', categories: ['puzzle'], dryRun: true })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.dryRun).toBe(true)
    expect(json.pushed).toBe(1)
    const q = sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? c[0].join(' ') : '')).join('\n')
    expect(q).not.toContain('INSERT INTO game_evaluations')
  })
})
