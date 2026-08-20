/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { GET as catalogGET } from '@/app/api/trends/catalog/route'
import { GET as detailGET } from '@/app/api/trends/detail/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

let calls: { text: string; binds: unknown[] }[] = []

// Answers queries by the text of the template so tests do not depend on call order.
function routeSql(handlers: { match: RegExp; rows: unknown[] }[]) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const text = (strings as string[]).join(' ')
    calls.push({ text, binds })
    const h = handlers.find(x => x.match.test(text))
    return Promise.resolve(h ? h.rows : [])
  })
}

const CATALOG_ROWS = [
  { field_value: 'Block Puzzle', total: 730, last30: 12, last_tagged_at: '2026-08-19T20:15:08.564Z', has_instruction: true },
  { field_value: 'Backpack', total: 0, last30: 0, last_tagged_at: null, has_instruction: false },
]

describe('/api/trends/catalog', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { calls = [] })

  it('returns 401 without a session', async () => {
    sessionMock.mockResolvedValue(null)
    routeSql([])
    const res = await catalogGET(new NextRequest('http://localhost/api/trends/catalog'))
    expect(res.status).toBe(401)
  })

  it('returns every active trend, counted from tags still live in Signal Sense', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([{ match: /custom_field_definitions/, rows: CATALOG_ROWS }])
    const res = await catalogGET(new NextRequest('http://localhost/api/trends/catalog'))
    expect(res.status).toBe(200)
    const body = await res.json()
    // A trend nobody has tagged yet still belongs in the list — an evaluator
    // has to be able to find it before it can ever be used.
    expect(body.trends).toEqual([
      { value: 'Block Puzzle', total: 730, last30: 12, lastTaggedAt: '2026-08-19T20:15:08.564Z', hasInstruction: true },
      { value: 'Backpack', total: 0, last30: 0, lastTaggedAt: null, hasInstruction: false },
    ])
    const text = calls.map(c => c.text).join(' ')
    expect(text).toMatch(/custom_field_values/)
    expect(text).toMatch(/is_active/)
  })

  it('serves the next reader from cache instead of re-counting', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([{ match: /custom_field_definitions/, rows: CATALOG_ROWS }])
    const res = await catalogGET(new NextRequest('http://localhost/api/trends/catalog'))
    expect((await res.json()).trends).toHaveLength(2)
    expect(calls).toHaveLength(0)
  })
})

describe('/api/trends/detail', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { calls = [] })

  const session = () => sessionMock.mockResolvedValue({
    user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' },
  })

  it('returns 401 without a session', async () => {
    sessionMock.mockResolvedValue(null)
    routeSql([])
    const res = await detailGET(new NextRequest('http://localhost/api/trends/detail?value=Merge'))
    expect(res.status).toBe(401)
  })

  it('rejects a request with no trend named', async () => {
    session()
    routeSql([])
    const res = await detailGET(new NextRequest('http://localhost/api/trends/detail'))
    expect(res.status).toBe(400)
  })

  it('returns the instruction and the most recent games carrying the trend', async () => {
    session()
    routeSql([
      { match: /custom_field_definitions/, rows: [{ instruction: '# Merge\n\nplace pieces' }] },
      { match: /game_info/, rows: [{
        game_id: 'g1', title: 'Balatro Clone', icon_url: null,
        sub_value_name: 'Merge Two', created_at: '2026-08-19T20:15:08.564Z',
      }] },
    ])
    const res = await detailGET(new NextRequest('http://localhost/api/trends/detail?value=Merge'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.instruction).toBe('# Merge\n\nplace pieces')
    expect(body.games).toEqual([{
      game_id: 'g1', title: 'Balatro Clone', icon_url: null,
      sub_value_name: 'Merge Two', created_at: '2026-08-19T20:15:08.564Z',
    }])
    expect(calls.some(c => c.binds.includes('Merge'))).toBe(true)
  })

  it('asks for at most 20 games', async () => {
    session()
    routeSql([{ match: /game_info/, rows: [] }])
    await detailGET(new NextRequest('http://localhost/api/trends/detail?value=Merge'))
    const games = calls.find(c => /game_info/.test(c.text))
    expect(games?.binds).toContain(20)
  })
})
