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

import { PATCH } from '@/app/api/playtest-tags/[id]/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

let calls: { text: string; binds: unknown[] }[] = []

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

function patchReq(body: unknown) {
  return new NextRequest('http://localhost/api/playtest-tags/7', {
    method: 'PATCH', body: JSON.stringify(body),
  } as never)
}
const params = { params: { id: '7' } }

// The row being corrected: pending, proposed by an evaluator days ago.
const theRow = {
  match: /SELECT id, game_id, field_value, sub_value_id\s+FROM playtest_tags/,
  rows: [{ id: 7, game_id: 'g1', field_value: 'Balatro', sub_value_id: null }],
}
const activeDef = { match: /FROM custom_field_definitions/, rows: [{ '?column?': 1 }] }
const activeSub = { match: /FROM sub_value_definitions/, rows: [{ '?column?': 1 }] }
const updated = {
  match: /UPDATE playtest_tags/,
  rows: [{ id: 7, game_id: 'g1', field_value: 'Balatro', sub_value_id: 2 }],
}

describe('PATCH /api/playtest-tags/[id]', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => {
    calls = []
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
  })

  it('is admin only', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([])
    const r = await PATCH(patchReq({ sub_value_id: 2 }), params)
    expect(r.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('rejects a body with nothing to change', async () => {
    routeSql([theRow])
    expect((await PATCH(patchReq({}), params)).status).toBe(400)
  })

  it('changes the sub-value without touching provenance', async () => {
    routeSql([theRow, activeSub, updated])
    const r = await PATCH(patchReq({ sub_value_id: 2 }), params)
    expect(r.status).toBe(200)
    expect((await r.json()).tag.sub_value_id).toBe(2)
    const upd = calls.find(c => /UPDATE playtest_tags/.test(c.text))!
    expect(upd.text).not.toMatch(/tagged_by|tagged_at/)
    // Only pending rows are editable; a resolved row is history.
    expect(upd.text).toMatch(/status = 'pending'/)
    expect(upd.binds).toEqual(expect.arrayContaining(['Balatro', 2, 7]))
  })

  it('clears the sub-value when given null', async () => {
    routeSql([
      { match: /SELECT id, game_id, field_value, sub_value_id\s+FROM playtest_tags/,
        rows: [{ id: 7, game_id: 'g1', field_value: 'Balatro', sub_value_id: 2 }] },
      { match: /UPDATE playtest_tags/, rows: [{ id: 7, game_id: 'g1', field_value: 'Balatro', sub_value_id: null }] },
    ])
    const r = await PATCH(patchReq({ sub_value_id: null }), params)
    expect(r.status).toBe(200)
    const upd = calls.find(c => /UPDATE playtest_tags/.test(c.text))!
    expect(upd.binds).toEqual(expect.arrayContaining(['Balatro', null, 7]))
    // No lookup for NULL.
    expect(calls.some(c => /FROM sub_value_definitions/.test(c.text))).toBe(false)
  })

  it('404s on a row that is no longer pending', async () => {
    routeSql([])  // the SELECT is scoped to status = 'pending'
    const r = await PATCH(patchReq({ sub_value_id: 2 }), params)
    expect(r.status).toBe(404)
    expect(calls.some(c => /UPDATE playtest_tags/.test(c.text))).toBe(false)
    expect(calls[0].text).toMatch(/status = 'pending'/)
  })

  it('refuses a value that is not an active Trends definition', async () => {
    routeSql([theRow, { match: /FROM custom_field_definitions/, rows: [] }])
    const r = await PATCH(patchReq({ field_value: 'Not A Trend' }), params)
    expect(r.status).toBe(400)
    expect((await r.json()).error).toMatch(/Unknown Trends value/)
    expect(calls.some(c => /UPDATE playtest_tags/.test(c.text))).toBe(false)
  })

  it('refuses an inactive sub-value', async () => {
    routeSql([theRow, { match: /FROM sub_value_definitions/, rows: [] }])
    const r = await PATCH(patchReq({ sub_value_id: 99 }), params)
    expect(r.status).toBe(400)
    expect(calls.some(c => /UPDATE playtest_tags/.test(c.text))).toBe(false)
  })

  it('409s when the new value is already proposed for the same game', async () => {
    // The partial unique index (game_id, field_value) WHERE status='pending'
    // would otherwise surface as a raw Postgres 500.
    routeSql([
      theRow,
      activeDef,
      { match: /SELECT id FROM playtest_tags/, rows: [{ id: 12 }] },
    ])
    const r = await PATCH(patchReq({ field_value: 'Backpack' }), params)
    expect(r.status).toBe(409)
    expect((await r.json()).error).toMatch(/Backpack.*already proposed/)
    expect(calls.some(c => /UPDATE playtest_tags/.test(c.text))).toBe(false)
  })

  it('turns a lost race on the unique index into a 409, not a 500', async () => {
    sqlMock.mockReset()
    sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
      if (!Array.isArray(strings)) return Promise.resolve([])
      const text = (strings as string[]).join(' ')
      calls.push({ text, binds })
      if (/SELECT id, game_id, field_value, sub_value_id\s+FROM playtest_tags/.test(text)) {
        return Promise.resolve([{ id: 7, game_id: 'g1', field_value: 'Balatro', sub_value_id: null }])
      }
      if (/FROM custom_field_definitions/.test(text)) return Promise.resolve([{ '?column?': 1 }])
      if (/UPDATE playtest_tags/.test(text)) {
        return Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505' }))
      }
      return Promise.resolve([])
    })
    const r = await PATCH(patchReq({ field_value: 'Backpack' }), params)
    expect(r.status).toBe(409)
  })

  it('409s when the row is resolved between the read and the write', async () => {
    routeSql([theRow, activeSub, { match: /UPDATE playtest_tags/, rows: [] }])
    const r = await PATCH(patchReq({ sub_value_id: 2 }), params)
    expect(r.status).toBe(409)
    expect((await r.json()).error).toMatch(/already confirmed or rejected/)
  })

  it('rejects a non-numeric id', async () => {
    routeSql([])
    const r = await PATCH(patchReq({ sub_value_id: 2 }), { params: { id: 'abc' } })
    expect(r.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})
