/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
// GET đọc session để scope evaluator; getServerSession cần request scope thật,
// nên mock như các test route khác trong repo.
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { GET, POST, PATCH } from '@/app/api/assign-setup/route'
import { getServerSession } from 'next-auth'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock
function req(url: string, init?: RequestInit) { return new NextRequest(`http://localhost${url}`, init as never) }

describe('/api/assign-setup', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => {
    sqlMock.mockReset()
    sessionMock.mockReset()
    sessionMock.mockResolvedValue({ user: { name: 'Admin', role: 'admin' } })
  })

  it('GET trả cả 3 genre trong một lần, không cần query param', async () => {
    sqlMock.mockResolvedValueOnce([
      { id: 1, name: 'Ann', category_group: 'puzzle', today_available: true, game_platform: 'all', game_category: 'All', weight: 100, list_type: 'initial' },
      { id: 2, name: 'Ann', category_group: 'arcade', today_available: true, game_platform: 'ios', game_category: 'action', weight: 50, list_type: 'initial' },
      { id: 3, name: 'Bob', category_group: 'puzzle', today_available: false, game_platform: 'ios', game_category: 'word', weight: 70, list_type: 'final' },
    ])
    const res = await GET()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.initial).toHaveLength(2)
    expect(json.final).toHaveLength(1)
    expect(json.initial[0].category_group).toBe('puzzle')
  })

  it('GET với evaluator chỉ trả dòng của chính họ, và không trả Final list', async () => {
    sessionMock.mockResolvedValue({ user: { name: 'Ann', role: 'evaluator' } })
    sqlMock.mockResolvedValueOnce([
      { id: 1, name: 'Ann', category_group: 'puzzle', today_available: true, game_platform: 'all', game_category: 'All', weight: 100, list_type: 'initial' },
      { id: 2, name: 'Bob', category_group: 'puzzle', today_available: true, game_platform: 'all', game_category: 'All', weight: 100, list_type: 'initial' },
      { id: 3, name: 'Ann', category_group: 'puzzle', today_available: true, game_platform: 'all', game_category: 'All', weight: 100, list_type: 'final' },
    ])
    const json = await (await GET()).json()
    expect(json.initial.map((r: { name: string }) => r.name)).toEqual(['Ann'])
    expect(json.final).toEqual([])
  })

  it('PATCH today_available ghi theo (list_type, name), không theo id', async () => {
    sqlMock.mockResolvedValue([])
    const res = await PATCH(req('/api/assign-setup', {
      method: 'PATCH',
      body: JSON.stringify({ field: 'today_available', list_type: 'initial', name: 'Ann', value: false }),
    }))
    expect(res.status).toBe(200)
    const stmt = sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? (c[0] as string[]).join(' ') : '')).join('\n')
    expect(stmt).toContain('list_type')
    expect(stmt).toContain('name')
    expect(stmt).not.toContain('WHERE id')
    expect(sqlMock.mock.calls.length).toBe(1) // một câu, không loop từng genre
  })

  it('PATCH today_available đòi name và list_type hợp lệ', async () => {
    const noName = await PATCH(req('/api/assign-setup', {
      method: 'PATCH', body: JSON.stringify({ field: 'today_available', list_type: 'initial', value: false }),
    }))
    expect(noName.status).toBe(400)
    const badList = await PATCH(req('/api/assign-setup', {
      method: 'PATCH', body: JSON.stringify({ field: 'today_available', list_type: 'both', name: 'Ann', value: false }),
    }))
    expect(badList.status).toBe(400)
  })

  it('PATCH các field khác vẫn đòi id', async () => {
    const res = await PATCH(req('/api/assign-setup', {
      method: 'PATCH', body: JSON.stringify({ field: 'weight', value: 50 }),
    }))
    expect(res.status).toBe(400)
  })

  it('POST category_groups tạo một dòng cho mỗi genre', async () => {
    sqlMock.mockResolvedValue([])
    const res = await POST(req('/api/assign-setup', {
      method: 'POST',
      body: JSON.stringify({ list_type: 'initial', name: 'Ann', category_groups: ['puzzle', 'arcade'] }),
    }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, inserted: 2 })
  })

  it('POST rejects khi category_groups rỗng hoặc toàn genre lạ', async () => {
    const empty = await POST(req('/api/assign-setup', {
      method: 'POST', body: JSON.stringify({ list_type: 'initial', name: 'Ann', category_groups: [] }),
    }))
    expect(empty.status).toBe(400)
    const bogus = await POST(req('/api/assign-setup', {
      method: 'POST', body: JSON.stringify({ list_type: 'initial', name: 'Ann', category_groups: ['rpg'] }),
    }))
    expect(bogus.status).toBe(400)
  })

  it('POST with provision upserts dashboard_users then inserts the roster row', async () => {
    sqlMock.mockResolvedValue([])  // every statement resolves []
    const res = await POST(req('/api/assign-setup', {
      method: 'POST',
      body: JSON.stringify({ category_groups: ['puzzle'], list_type: 'initial', name: 'newperson', provision: true, weight: 50 }),
    }))
    expect(await res.json()).toEqual({ ok: true, inserted: 1 })
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
