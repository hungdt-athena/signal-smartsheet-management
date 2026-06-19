/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { GET, POST, PATCH } from '@/app/api/assign-setup/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock
function req(url: string, init?: RequestInit) { return new NextRequest(`http://localhost${url}`, init as never) }

describe('/api/assign-setup', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => sqlMock.mockReset())

  it('GET requires a valid group', async () => {
    const res = await GET(req('/api/assign-setup?group=rpg'))
    expect(res.status).toBe(400)
  })

  it('GET returns initial + final split by list_type', async () => {
    sqlMock.mockResolvedValueOnce([
      { id: 1, name: 'Ann', today_available: true, game_platform: 'all', game_category: 'All', weight: 100, list_type: 'initial' },
      { id: 2, name: 'Bob', today_available: false, game_platform: 'ios', game_category: 'word', weight: 70, list_type: 'final' },
    ])
    const res = await GET(req('/api/assign-setup?group=puzzle'))
    const json = await res.json()
    expect(json.initial).toHaveLength(1)
    expect(json.final).toHaveLength(1)
    expect(json.initial[0].name).toBe('Ann')
  })

  it('POST rejects an invalid bucket', async () => {
    const res = await POST(req('/api/assign-setup', {
      method: 'POST', body: JSON.stringify({ category_group: 'rpg', list_type: 'initial', name: 'X' }),
    }))
    expect(res.status).toBe(400)
  })

  it('POST with provision upserts dashboard_users then inserts the roster row', async () => {
    sqlMock.mockResolvedValue([])  // every statement resolves []
    const res = await POST(req('/api/assign-setup', {
      method: 'POST',
      body: JSON.stringify({ category_group: 'puzzle', list_type: 'initial', name: 'newperson', provision: true, weight: 50 }),
    }))
    expect(await res.json()).toEqual({ ok: true })
    const allSql = sqlMock.mock.calls.filter(c => Array.isArray(c[0])).map(c => (c[0] as string[]).join(' ')).join('\n')
    expect(allSql).toContain('dashboard_users')
    expect(allSql).toContain('evaluator_roster')
  })

  it('PATCH rejects an unknown field', async () => {
    const res = await PATCH(req('/api/assign-setup', {
      method: 'PATCH', body: JSON.stringify({ id: 1, field: 'role', value: 'admin' }),
    }))
    expect(res.status).toBe(400)
  })

  it('PATCH rejects an invalid weight', async () => {
    const res = await PATCH(req('/api/assign-setup', {
      method: 'PATCH', body: JSON.stringify({ id: 1, field: 'weight', value: 60 }),
    }))
    expect(res.status).toBe(400)
  })
})
