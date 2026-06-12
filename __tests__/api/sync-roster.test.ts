/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { POST } from '@/app/api/admin/sync-roster/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sessionMock = getServerSession as jest.Mock

const sqlMock = sql as unknown as jest.Mock

function post(body: unknown, secret = 's3cret') {
  return POST(new NextRequest('http://localhost/api/admin/sync-roster', {
    method: 'POST',
    headers: { 'x-webhook-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('POST /api/admin/sync-roster', () => {
  const realSecret = process.env.WEBHOOK_SECRET
  beforeAll(() => { process.env.WEBHOOK_SECRET = 's3cret'; process.env.SKIP_AUTH = 'false' })
  afterAll(() => { process.env.WEBHOOK_SECRET = realSecret })
  beforeEach(() => { sqlMock.mockReset(); sqlMock.mockResolvedValue([]); sessionMock.mockResolvedValue(null) })

  it('rejects a wrong secret with 401', async () => {
    const res = await post({ rows: [] }, 'wrong')
    expect(res.status).toBe(401)
  })

  it('rejects missing rows with 400', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
  })

  it('upserts each row and reports the count', async () => {
    const res = await post({ rows: [
      { 'Evaluator Name': 'KietCD', 'Today Available': 'Yes', 'Game Platform': 'all', 'Weight': '100' },
      { 'Evaluator Name': 'HuyDD', 'Today Available': 'No', 'Game Platform': 'ios', 'Weight': '' },
    ] })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.synced).toBe(2)
    const q = sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? c[0].join(' ') : '')).join('\n')
    expect(q).toContain('INSERT INTO evaluator_roster')
    expect(q).toContain('ON CONFLICT')
  })

  it('skips rows without a name', async () => {
    const res = await post({ rows: [{ 'Evaluator Name': '' }] })
    const json = await res.json()
    expect(json.synced).toBe(0)
  })
})
