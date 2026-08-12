/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => {
  const fn = jest.fn() as jest.Mock & { json: jest.Mock; begin: jest.Mock }
  fn.json = jest.fn((v: unknown) => v)
  // begin(cb) runs the callback with the same mock, so a transaction behaves
  // like the plain client in tests.
  fn.begin = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(fn)))
  return { sql: fn }
})
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { POST as CONFIRM } from '@/app/api/playtest-tags/confirm/route'
import { POST as REJECT } from '@/app/api/playtest-tags/reject/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

let calls: { text: string; binds: unknown[] }[] = []

function routeSql(handlers: { match: RegExp; rows: unknown[] }[]) {
  sqlMock.mockReset()
  ;(sqlMock as unknown as { begin: jest.Mock }).begin =
    jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(sqlMock)))
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const text = (strings as string[]).join(' ')
    calls.push({ text, binds })
    const h = handlers.find(x => x.match.test(text))
    return Promise.resolve(h ? h.rows : [])
  })
}

function req(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) } as never)
}

describe('POST /api/playtest-tags/confirm', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { calls = []; sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } }) })

  it('is admin only', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([])
    expect((await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))).status).toBe(403)
  })

  it('handles a mixed batch: insert, duplicate, enrich, conflict', async () => {
    routeSql([
      { match: /FROM playtest_tags/, rows: [
        { id: 1, field_value: 'New Trend', sub_value_id: 1 },   // not in Signal Sense → insert
        { id: 2, field_value: 'Same', sub_value_id: 1 },        // identical → duplicate
        { id: 3, field_value: 'Empty Sub', sub_value_id: 2 },   // theirs NULL → enrich
        { id: 4, field_value: 'Clash', sub_value_id: 1 },       // theirs 2 → conflict, kept
      ] },
      { match: /FROM custom_field_values/, rows: [
        { field_value: 'Same', sub_value_id: 1 },
        { field_value: 'Empty Sub', sub_value_id: null },
        { field_value: 'Clash', sub_value_id: 2 },
      ] },
    ])
    const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))).json()
    expect(body.results).toEqual([
      { id: 1, result: 'inserted' },
      { id: 2, result: 'duplicate' },
      { id: 3, result: 'enriched' },
      { id: 4, result: 'kept' },
    ])
    const inserts = calls.filter(c => /INSERT INTO custom_field_values/.test(c.text))
    expect(inserts).toHaveLength(1)
    expect(inserts[0].binds).toEqual(expect.arrayContaining(['g1', 'Trends', 'New Trend', 1, 'playtest_sync']))
    const updates = calls.filter(c => /UPDATE custom_field_values/.test(c.text))
    expect(updates).toHaveLength(1)
    expect(updates[0].binds).toEqual(expect.arrayContaining([2, 'Empty Sub']))
  })

  it('overwrites only the conflict ids the admin listed', async () => {
    routeSql([
      { match: /FROM playtest_tags/, rows: [
        { id: 4, field_value: 'Clash', sub_value_id: 1 },
        { id: 5, field_value: 'Clash Two', sub_value_id: 1 },
      ] },
      { match: /FROM custom_field_values/, rows: [
        { field_value: 'Clash', sub_value_id: 2 },
        { field_value: 'Clash Two', sub_value_id: 2 },
      ] },
    ])
    const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1', overwrite: [4] }))).json()
    expect(body.results).toEqual([
      { id: 4, result: 'overwritten' },
      { id: 5, result: 'kept' },
    ])
    expect(calls.filter(c => /UPDATE custom_field_values/.test(c.text))).toHaveLength(1)
  })

  it('stamps confirmed_by and the per-row status', async () => {
    routeSql([
      { match: /FROM playtest_tags/, rows: [{ id: 1, field_value: 'New Trend', sub_value_id: null }] },
      { match: /FROM custom_field_values/, rows: [] },
    ])
    await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))
    const stamp = calls.find(c => /UPDATE playtest_tags/.test(c.text))
    expect(stamp?.binds).toEqual(expect.arrayContaining(['synced', 'inserted', 'vinhtd@athena.studio', 1]))
  })

  it('returns an empty result set when the game has no pending tags', async () => {
    routeSql([{ match: /FROM playtest_tags/, rows: [] }])
    const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))).json()
    expect(body).toEqual({ ok: true, results: [] })
  })
})

describe('POST /api/playtest-tags/reject', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { calls = [] })

  it('is admin only', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([])
    expect((await REJECT(req('/api/playtest-tags/reject', { ids: [1] }))).status).toBe(403)
  })

  it('marks the ids rejected with the admin email', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    routeSql([{ match: /UPDATE playtest_tags/, rows: [{ id: 1 }, { id: 2 }] }])
    const body = await (await REJECT(req('/api/playtest-tags/reject', { ids: [1, 2] }))).json()
    expect(body).toEqual({ ok: true, count: 2 })
    const upd = calls.find(c => /UPDATE playtest_tags/.test(c.text))
    expect(upd?.binds).toEqual(expect.arrayContaining(['vinhtd@athena.studio', [1, 2]]))
  })

  it('rejects a body with no ids', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    routeSql([])
    expect((await REJECT(req('/api/playtest-tags/reject', { ids: [] }))).status).toBe(400)
  })
})
