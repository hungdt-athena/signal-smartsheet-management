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

import { POST as RECONCILE } from '@/app/api/playtest-tags/reconcile/route'
import { POST as REMOVE } from '@/app/api/playtest-tags/remove/route'
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

function req(url: string, body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  } as never)
}

const ADMIN = { user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } }
const EVALUATOR = { user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } }

describe('POST /api/playtest-tags/reconcile', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { calls = []; sessionMock.mockResolvedValue(ADMIN) })

  it('is admin only', async () => {
    sessionMock.mockResolvedValue(EVALUATOR)
    routeSql([])
    expect((await RECONCILE(req('/api/playtest-tags/reconcile'))).status).toBe(403)
  })

  it('stamps only synced rows that are gone from Signal Sense and not already stamped', async () => {
    routeSql([{ match: /UPDATE playtest_tags/, rows: [{ id: 4, game_id: 'g1', field_value: 'Artwork-Canvas' }] }])
    const body = await (await RECONCILE(req('/api/playtest-tags/reconcile'))).json()
    expect(body).toEqual({ ok: true, removed: 1, rows: [{ id: 4, game_id: 'g1', field_value: 'Artwork-Canvas' }] })
    const upd = calls.find(c => /UPDATE playtest_tags/.test(c.text))!
    // Guards that keep the sweep once-only and scoped to confirmed tags.
    expect(upd.text).toMatch(/status = 'synced'/)
    expect(upd.text).toMatch(/removed_at IS NULL/)
    expect(upd.text).toMatch(/NOT EXISTS/)
    expect(upd.text).toMatch(/removed_by = 'signal_sense'/)
  })

  it('never writes to custom_field_values', async () => {
    routeSql([{ match: /UPDATE playtest_tags/, rows: [] }])
    await RECONCILE(req('/api/playtest-tags/reconcile'))
    expect(calls.some(c => /(DELETE FROM|INSERT INTO|UPDATE) custom_field_values/.test(c.text))).toBe(false)
  })

  it('reports zero when nothing has gone missing', async () => {
    routeSql([{ match: /UPDATE playtest_tags/, rows: [] }])
    expect(await (await RECONCILE(req('/api/playtest-tags/reconcile'))).json())
      .toEqual({ ok: true, removed: 0, rows: [] })
  })
})

describe('POST /api/playtest-tags/remove', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { calls = []; sessionMock.mockResolvedValue(ADMIN) })

  const SYNCED = { match: /FROM playtest_tags/, rows: [{ id: 7, game_id: 'g1', field_value: 'Animal Driver' }] }

  it('is admin only', async () => {
    sessionMock.mockResolvedValue(EVALUATOR)
    routeSql([])
    expect((await REMOVE(req('/api/playtest-tags/remove', { id: 7 }))).status).toBe(403)
  })

  it('rejects a missing id', async () => {
    routeSql([])
    expect((await REMOVE(req('/api/playtest-tags/remove', {}))).status).toBe(400)
  })

  it('404s when no synced tag has that id', async () => {
    routeSql([{ match: /FROM playtest_tags/, rows: [] }])
    const r = await REMOVE(req('/api/playtest-tags/remove', { id: 99 }))
    expect(r.status).toBe(404)
    expect(calls.some(c => /DELETE FROM custom_field_values/.test(c.text))).toBe(false)
  })

  it('deletes the Signal Sense row when playtest_sync created it, and stamps the removal', async () => {
    routeSql([
      SYNCED,
      { match: /FROM custom_field_values/, rows: [{ created_by: 'playtest_sync', first_name: 'Signal Playtest', last_name: 'Sync', email: null }] },
    ])
    const body = await (await REMOVE(req('/api/playtest-tags/remove', { id: 7 }))).json()
    expect(body).toEqual({ ok: true, outcome: 'deleted' })
    const del = calls.find(c => /DELETE FROM custom_field_values/.test(c.text))!
    // Scoped to our own row, so a concurrent hand-off cannot widen the delete.
    expect(del.text).toMatch(/created_by =/)
    expect(del.binds).toEqual(expect.arrayContaining(['g1', 'Trends', 'Animal Driver', 'playtest_sync']))
    const stamp = calls.find(c => /UPDATE playtest_tags/.test(c.text))!
    expect(stamp.text).toMatch(/status = 'removed'/)
    expect(stamp.binds).toEqual(expect.arrayContaining(['vinhtd@athena.studio', 7]))
  })

  it('refuses to delete a row a Signal Sense user created, naming them', async () => {
    routeSql([
      SYNCED,
      { match: /FROM custom_field_values/, rows: [{ created_by: 'LCU6y3GtrRRoqHYyOn_tE', first_name: 'Tran', last_name: 'Vinh', email: 'vinhtd@athena.studio' }] },
    ])
    const r = await REMOVE(req('/api/playtest-tags/remove', { id: 7 }))
    expect(r.status).toBe(409)
    expect((await r.json()).error).toContain('Tran Vinh')
    expect(calls.some(c => /DELETE FROM custom_field_values/.test(c.text))).toBe(false)
    // Nothing is stamped either: the tag is still there, so history must not
    // claim it was removed.
    expect(calls.some(c => /UPDATE playtest_tags/.test(c.text))).toBe(false)
  })

  it('stamps the removal without a delete when the row is already gone', async () => {
    routeSql([SYNCED, { match: /FROM custom_field_values/, rows: [] }])
    const body = await (await REMOVE(req('/api/playtest-tags/remove', { id: 7 }))).json()
    expect(body).toEqual({ ok: true, outcome: 'already_gone' })
    expect(calls.some(c => /DELETE FROM custom_field_values/.test(c.text))).toBe(false)
    expect(calls.some(c => /UPDATE playtest_tags/.test(c.text))).toBe(true)
  })
})
