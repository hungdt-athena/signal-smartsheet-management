/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => {
  const fn = jest.fn() as jest.Mock & { json: jest.Mock; begin: jest.Mock; savepoint: jest.Mock }
  fn.json = jest.fn((v: unknown) => v)
  fn.begin = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(fn)))
  fn.savepoint = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(fn)))
  return { sql: fn }
})
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { PATCH, DELETE } from '@/app/api/playtest-tags/existing/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

let calls: { text: string; binds: unknown[] }[] = []

function routeSql(handlers: { match: RegExp; rows: unknown[] }[]) {
  sqlMock.mockReset()
  ;(sqlMock as unknown as { begin: jest.Mock }).begin =
    jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(sqlMock)))
  ;(sqlMock as unknown as { savepoint: jest.Mock }).savepoint =
    jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(sqlMock)))
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const text = (strings as string[]).join(' ')
    calls.push({ text, binds })
    const h = handlers.find(x => x.match.test(text))
    return Promise.resolve(h ? h.rows : [])
  })
}

function req(method: string, body?: unknown) {
  return new NextRequest('http://localhost/api/playtest-tags/existing', {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  } as never)
}

const ADMIN = { user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } }
const MODERATOR = { user: { role: 'moderator', name: 'Minh', email: 'minhlq@athena.studio' } }
const EVALUATOR = { user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } }

// Query shapes the helper issues, in the order handlers must be matched: the
// backfill is an INSERT ... SELECT over custom_field_values, so it would answer
// the plain read's matcher if it came second.
const BACKFILL = /INSERT INTO custom_field_value_changes[\s\S]*SELECT cfv\./
const LOG = /INSERT INTO custom_field_value_changes(?![\s\S]*SELECT cfv\.)/
const READ = /SELECT[\s\S]*FROM custom_field_values/
const UPDATE_CFV = /UPDATE custom_field_values/
const DELETE_CFV = /DELETE FROM custom_field_values/
const AUDIT_UPDATE = /UPDATE playtest_tags/
const AUDIT_INSERT = /INSERT INTO playtest_tags/

/** The backfill answers the plain read's matcher too, so it is routed first. */
const NO_BACKFILL_ROWS = { match: BACKFILL, rows: [] }

/** A Trends row a Signal Sense user created — the case this app used to refuse. */
const THEIRS = {
  match: READ,
  rows: [{
    created_by: 'LCU6y3GtrRRoqHYyOn_tE', sub_value_id: 1,
    first_name: 'Tran', last_name: 'Vinh', email: 'vinhtd@athena.studio',
    created_at_utc: new Date('2026-05-01T02:00:00Z'),
  }],
}
/** The synced playtest_tags row for the same pair, when this app made the tag. */
const OURS_AUDIT = { match: AUDIT_UPDATE, rows: [{ id: 7 }] }
/** No playtest_tags row for the pair: the tag is Signal Sense's own. */
const NO_AUDIT = { match: AUDIT_UPDATE, rows: [] }

const PAIR = { gameId: 'g1', fieldValue: 'Animal Driver' }

describe('PATCH /api/playtest-tags/existing — change a synced tag\'s sub-value', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { calls = []; sessionMock.mockResolvedValue(ADMIN) })

  it('is closed to evaluators', async () => {
    sessionMock.mockResolvedValue(EVALUATOR)
    routeSql([])
    expect((await PATCH(req('PATCH', { ...PAIR, subValueId: 2 }))).status).toBe(403)
  })

  it('is open to moderators, who review tags alongside admins', async () => {
    sessionMock.mockResolvedValue(MODERATOR)
    routeSql([NO_BACKFILL_ROWS, THEIRS, OURS_AUDIT])
    expect((await PATCH(req('PATCH', { ...PAIR, subValueId: 2 }))).status).toBe(200)
  })

  it('rejects a request with no game or no value', async () => {
    routeSql([])
    expect((await PATCH(req('PATCH', { gameId: 'g1', subValueId: 2 }))).status).toBe(400)
    expect((await PATCH(req('PATCH', { fieldValue: 'x', subValueId: 2 }))).status).toBe(400)
  })

  it('404s when the trend is no longer in Signal Sense', async () => {
    routeSql([{ match: READ, rows: [] }])
    const r = await PATCH(req('PATCH', { ...PAIR, subValueId: 2 }))
    expect(r.status).toBe(404)
    expect(calls.some(c => UPDATE_CFV.test(c.text))).toBe(false)
  })

  it('writes nothing when the sub-value is already the one asked for', async () => {
    routeSql([NO_BACKFILL_ROWS, THEIRS, OURS_AUDIT])
    const body = await (await PATCH(req('PATCH', { ...PAIR, subValueId: 1 }))).json()
    expect(body).toEqual({ ok: true, outcome: 'unchanged' })
    expect(calls.some(c => UPDATE_CFV.test(c.text))).toBe(false)
    // No log line either: nothing changed, so the history must not claim one.
    expect(calls.some(c => /custom_field_value_changes/.test(c.text))).toBe(false)
  })

  it('rescues the add line and logs the change before touching the row', async () => {
    routeSql([NO_BACKFILL_ROWS, THEIRS, OURS_AUDIT])
    await PATCH(req('PATCH', { ...PAIR, subValueId: 2 }))
    const iAdd = calls.findIndex(c => BACKFILL.test(c.text))
    const iLog = calls.findIndex(c => LOG.test(c.text))
    const iUpd = calls.findIndex(c => UPDATE_CFV.test(c.text))
    expect(iAdd).toBeGreaterThanOrEqual(0)
    expect(iLog).toBeGreaterThan(iAdd)
    expect(iUpd).toBeGreaterThan(iLog)
    // Both ends of the move, and the app as the actor: changed_by is a
    // users(id) FK the admin has no row in.
    expect(calls[iLog].binds).toEqual(
      expect.arrayContaining(['g1', 'Trends', 'Animal Driver', 'sub_value_change', 1, 2, 'playtest_sync']))
    expect(calls[iLog].binds).not.toContain('vinhtd@athena.studio')
  })

  it('changes the row a Signal Sense user created, not only its own', async () => {
    routeSql([NO_BACKFILL_ROWS, THEIRS, OURS_AUDIT])
    const body = await (await PATCH(req('PATCH', { ...PAIR, subValueId: 2 }))).json()
    expect(body).toEqual({ ok: true, outcome: 'updated' })
    const upd = calls.find(c => UPDATE_CFV.test(c.text))!
    // Scoped to the one tag, and NOT scoped by creator: an admin here now owns
    // every Trends tag on the game.
    expect(upd.text).not.toMatch(/created_by/)
    expect(upd.binds).toEqual(expect.arrayContaining([2, 'g1', 'Trends', 'Animal Driver']))
  })

  it('clears the sub-value when asked for none', async () => {
    routeSql([NO_BACKFILL_ROWS, THEIRS, OURS_AUDIT])
    const body = await (await PATCH(req('PATCH', { ...PAIR, subValueId: null }))).json()
    expect(body).toEqual({ ok: true, outcome: 'updated' })
    expect(calls.find(c => UPDATE_CFV.test(c.text))!.binds).toContain(null)
    expect(calls.find(c => LOG.test(c.text))!.binds).toEqual(
      expect.arrayContaining(['sub_value_change', 1, null]))
  })

  it('names the editor on the tag\'s own history row', async () => {
    routeSql([NO_BACKFILL_ROWS, THEIRS, OURS_AUDIT])
    await PATCH(req('PATCH', { ...PAIR, subValueId: 2 }))
    const stamp = calls.find(c => AUDIT_UPDATE.test(c.text))!
    expect(stamp.text).toMatch(/edited_by/)
    expect(stamp.text).toMatch(/sub_value_id/)
    expect(stamp.binds).toEqual(expect.arrayContaining([2, 'vinhtd@athena.studio', 'g1', 'Animal Driver']))
    expect(calls.some(c => AUDIT_INSERT.test(c.text))).toBe(false)
  })

  it('opens a history row for a tag this app never proposed, credited to its author', async () => {
    routeSql([NO_BACKFILL_ROWS, THEIRS, NO_AUDIT])
    await PATCH(req('PATCH', { ...PAIR, subValueId: 2 }))
    const ins = calls.find(c => AUDIT_INSERT.test(c.text))!
    // Proposed by whoever tagged it in Signal Sense, at the time they did —
    // this app only edited it.
    expect(ins.text).toMatch(/'synced'/)
    expect(ins.binds).toEqual(expect.arrayContaining([
      'g1', 'Animal Driver', 2, 'vinhtd@athena.studio', 'vinhtd@athena.studio',
    ]))
    expect(ins.binds).toContainEqual(new Date('2026-05-01T02:00:00Z'))
  })

  it('credits an unknown author as signal_sense rather than to nobody', async () => {
    routeSql([
      NO_BACKFILL_ROWS,
      { match: READ, rows: [{ created_by: 'ghost', sub_value_id: null, first_name: null, last_name: null, email: null, created_at_utc: null }] },
      NO_AUDIT,
    ])
    await PATCH(req('PATCH', { ...PAIR, subValueId: 2 }))
    expect(calls.find(c => AUDIT_INSERT.test(c.text))!.binds).toContain('signal_sense')
  })
})

describe('DELETE /api/playtest-tags/existing — take a synced tag out', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { calls = []; sessionMock.mockResolvedValue(ADMIN) })

  it('is closed to evaluators', async () => {
    sessionMock.mockResolvedValue(EVALUATOR)
    routeSql([])
    expect((await DELETE(req('DELETE', PAIR))).status).toBe(403)
  })

  it('deletes a row a Signal Sense user created, logging the removal first', async () => {
    routeSql([NO_BACKFILL_ROWS, THEIRS, OURS_AUDIT])
    const body = await (await DELETE(req('DELETE', PAIR))).json()
    expect(body).toEqual({ ok: true, outcome: 'deleted' })
    const iLog = calls.findIndex(c => LOG.test(c.text))
    const iDel = calls.findIndex(c => DELETE_CFV.test(c.text))
    expect(iDel).toBeGreaterThan(iLog)
    expect(calls[iLog].binds).toEqual(
      expect.arrayContaining(['g1', 'Trends', 'Animal Driver', 'remove', 1, 'playtest_sync']))
    // The old refusal scoped the delete to playtest_sync's own rows.
    expect(calls[iDel].text).not.toMatch(/created_by/)
  })

  it('stamps the removal on the tag\'s history row', async () => {
    routeSql([NO_BACKFILL_ROWS, THEIRS, OURS_AUDIT])
    await DELETE(req('DELETE', PAIR))
    const stamp = calls.find(c => AUDIT_UPDATE.test(c.text))!
    expect(stamp.text).toMatch(/status = 'removed'/)
    expect(stamp.binds).toEqual(expect.arrayContaining(['vinhtd@athena.studio', 'g1', 'Animal Driver']))
  })

  it('records the removal of a tag this app never proposed', async () => {
    routeSql([NO_BACKFILL_ROWS, THEIRS, NO_AUDIT])
    await DELETE(req('DELETE', PAIR))
    const ins = calls.find(c => AUDIT_INSERT.test(c.text))!
    expect(ins.text).toMatch(/'removed'/)
    // The sub-value it carried when it went, so history can still say what was lost.
    expect(ins.binds).toEqual(expect.arrayContaining(['g1', 'Animal Driver', 1, 'vinhtd@athena.studio']))
  })

  // Signal Sense deleted it first. The tag still stopped existing, so history
  // says so rather than staying silent -- but nothing is logged as a removal
  // this app performed, because it performed none.
  it('records the removal when Signal Sense already deleted the tag', async () => {
    routeSql([{ match: READ, rows: [] }, OURS_AUDIT])
    const body = await (await DELETE(req('DELETE', PAIR))).json()
    expect(body).toEqual({ ok: true, outcome: 'already_gone' })
    expect(calls.some(c => DELETE_CFV.test(c.text))).toBe(false)
    expect(calls.some(c => /custom_field_value_changes/.test(c.text))).toBe(false)
    expect(calls.some(c => AUDIT_UPDATE.test(c.text))).toBe(true)
  })

  it('opens no history row for a tag that is gone and was never ours', async () => {
    routeSql([{ match: READ, rows: [] }, NO_AUDIT])
    await DELETE(req('DELETE', PAIR))
    // Nothing to say: this app never had the tag, and it is not there now.
    expect(calls.some(c => AUDIT_INSERT.test(c.text))).toBe(false)
  })
})
