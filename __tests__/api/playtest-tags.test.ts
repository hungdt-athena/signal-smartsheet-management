/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => {
  const fn = jest.fn() as jest.Mock & { json: jest.Mock; begin: jest.Mock }
  fn.json = jest.fn((v: unknown) => v)
  fn.begin = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(fn)))
  return { sql: fn }
})
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { GET, PUT } from '@/app/api/playtest-tags/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock & { begin: jest.Mock }
const sessionMock = getServerSession as unknown as jest.Mock

function putReq(body: unknown) {
  return new NextRequest('http://localhost/api/playtest-tags', {
    method: 'PUT', body: JSON.stringify(body),
  } as never)
}
function getReq(gameId: string) {
  return new NextRequest(`http://localhost/api/playtest-tags?gameId=${gameId}`)
}

// Answers queries by the text of the template so tests do not depend on call order.
function routeSql(handlers: { match: RegExp; rows: unknown[] }[]) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const text = (strings as string[]).join(' ')
    const h = handlers.find(x => x.match.test(text))
    calls.push({ text, binds })
    return Promise.resolve(h ? h.rows : [])
  })
  // mockReset() above wipes the .begin implementation too — re-establish it so
  // the transaction wrapper in the route still runs its callback against the
  // same routed mock.
  sqlMock.begin = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(sqlMock)))
}
let calls: { text: string; binds: unknown[] }[] = []

describe('/api/playtest-tags', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { calls = [] })

  it('returns 401 without a session', async () => {
    sessionMock.mockResolvedValue(null)
    routeSql([])
    expect((await GET(getReq('g1'))).status).toBe(401)
  })

  it('returns pending tags and the live Signal Sense tags', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    routeSql([
      { match: /FROM playtest_tags/, rows: [{ id: 7, field_value: 'Balatro', sub_value_id: 1, tagged_by: 'mitt@athena.studio', tagged_by_name: 'Mitt' }] },
      { match: /FROM custom_field_values/, rows: [{ field_value: 'Backpack', sub_value_id: null, sub_value_name: null }] },
    ])
    const body = await (await GET(getReq('g1'))).json()
    expect(body.pending).toHaveLength(1)
    expect(body.pending[0].field_value).toBe('Balatro')
    expect(body.existing[0].field_value).toBe('Backpack')
  })

  it('refuses an evaluator writing tags on someone else\'s game', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([
      { match: /FROM game_evaluations/, rows: [{ initial_evaluator: 'MyTL' }] },
    ])
    const r = await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: null }] }))
    expect(r.status).toBe(403)
    expect(calls.some(c => /INSERT INTO playtest_tags/.test(c.text))).toBe(false)
  })

  it('lets an evaluator replace the pending set on their own game', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([
      { match: /FROM game_evaluations/, rows: [{ initial_evaluator: 'Mitt' }] },
      { match: /field_value = ANY/, rows: [{ field_value: 'Balatro' }] },
    ])
    const r = await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: 2 }] }))
    expect(await r.json()).toEqual({ ok: true, count: 1 })
    expect(calls.some(c => /DELETE FROM playtest_tags/.test(c.text))).toBe(true)
    const insert = calls.find(c => /INSERT INTO playtest_tags/.test(c.text))
    expect(insert?.binds).toEqual(expect.arrayContaining(['g1', 'Balatro', 2, 'mitt@athena.studio']))
  })

  it('rejects a value that is not an active Trends definition', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    routeSql([
      { match: /FROM game_evaluations/, rows: [{ initial_evaluator: 'Mitt' }] },
      { match: /field_value = ANY/, rows: [] },
    ])
    const r = await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Not A Trend', sub_value_id: null }] }))
    expect(r.status).toBe(400)
    expect(calls.some(c => /INSERT INTO playtest_tags/.test(c.text))).toBe(false)
  })

  it('clears the pending set when tags is empty', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    routeSql([{ match: /FROM game_evaluations/, rows: [{ initial_evaluator: 'Mitt' }] }])
    const r = await PUT(putReq({ game_id: 'g1', tags: [] }))
    expect(await r.json()).toEqual({ ok: true, count: 0 })
    expect(calls.some(c => /DELETE FROM playtest_tags/.test(c.text))).toBe(true)
    expect(calls.some(c => /INSERT INTO playtest_tags/.test(c.text))).toBe(false)
  })

  it('surfaces a failed insert instead of reporting success (transaction propagation)', async () => {
    // This proves the route's `sql.begin(...)` callback propagates a mid-loop
    // failure up to the HTTP response rather than swallowing it. With a mocked
    // `sql`, `.begin` just invokes its callback inline (see the mock above) --
    // it does not exercise real Postgres rollback semantics. It only shows the
    // route does not report `{ ok: true }` when a write inside the transaction
    // rejects; it is not proof that the DELETE is actually rolled back on a
    // real database.
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    sqlMock.mockReset()
    sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
      if (!Array.isArray(strings)) return Promise.resolve([])
      const text = (strings as string[]).join(' ')
      calls.push({ text, binds })
      if (/FROM game_evaluations/.test(text)) return Promise.resolve([{ initial_evaluator: 'Mitt' }])
      if (/field_value = ANY/.test(text)) return Promise.resolve([{ field_value: 'Balatro' }])
      if (/INSERT INTO playtest_tags/.test(text)) return Promise.reject(new Error('constraint violation'))
      return Promise.resolve([])
    })
    sqlMock.begin = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(sqlMock)))

    await expect(PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: null }] })))
      .rejects.toThrow('constraint violation')
    expect(calls.some(c => /DELETE FROM playtest_tags/.test(c.text))).toBe(true)
  })
})
