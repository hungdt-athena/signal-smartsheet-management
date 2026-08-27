/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => {
  const fn = jest.fn() as jest.Mock & { json: jest.Mock; begin: jest.Mock; savepoint: jest.Mock }
  fn.json = jest.fn((v: unknown) => v)
  fn.begin = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(fn)))
  // logCfvChanges isolates each log row in a savepoint.
  fn.savepoint = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(fn)))
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

  // Pass 1 reads Signal Sense's change log; pass 2 is the absence sweep. Both
  // are UPDATE playtest_tags, so route on the log table to tell them apart.
  const LOGGED = /custom_field_value_changes/
  const ABSENCE = /NOT EXISTS/

  it('takes attribution from the change log, only for removals after our confirm', async () => {
    routeSql([
      { match: LOGGED, rows: [{ id: 7, game_id: 'g1', field_value: 'Animal Driver', removed_by: 'minhlq@athena.studio', removed_at: '2026-08-13T04:00:00Z' }] },
      { match: ABSENCE, rows: [] },
    ])
    const body = await (await RECONCILE(req('/api/playtest-tags/reconcile'))).json()
    expect(body.attributed).toBe(1)
    expect(body.unattributed).toBe(0)
    expect(body.removed).toBe(1)
    expect(body.rows[0].removed_by).toBe('minhlq@athena.studio')

    const pass1 = calls.find(c => LOGGED.test(c.text))!
    expect(pass1.text).toMatch(/action = 'remove'/)
    // A removal predating our confirm belongs to an earlier tag of the same trend.
    expect(pass1.text).toMatch(/ev\.changed_at > pt\.confirmed_at/)
    // Latest event per (game, value) — the pair can be removed and re-tagged.
    expect(pass1.text).toMatch(/DISTINCT ON \(c\.game_id, c\.field_value\)/)
    // Real email, falling back to the sentinel only when the actor is unknown.
    expect(pass1.text).toMatch(/COALESCE\(ev\.email, 'signal_sense'\)/)
    expect(pass1.text).toMatch(/status = 'synced'/)
    expect(pass1.text).toMatch(/removed_at IS NULL/)
  })

  it('keeps the absence sweep as a net for deletions the log never records', async () => {
    routeSql([
      { match: LOGGED, rows: [] },
      { match: ABSENCE, rows: [{ id: 4, game_id: 'g1', field_value: 'Artwork-Canvas' }] },
    ])
    const body = await (await RECONCILE(req('/api/playtest-tags/reconcile'))).json()
    expect(body).toMatchObject({ ok: true, removed: 1, attributed: 0, unattributed: 1 })
    const pass2 = calls.find(c => ABSENCE.test(c.text))!
    expect(pass2.text).toMatch(/removed_by = 'signal_sense'/)
    expect(pass2.text).toMatch(/removed_at IS NULL/)
  })

  it('runs the log pass before the absence sweep, so attribution wins', async () => {
    routeSql([{ match: LOGGED, rows: [] }, { match: ABSENCE, rows: [] }])
    await RECONCILE(req('/api/playtest-tags/reconcile'))
    const iLog = calls.findIndex(c => LOGGED.test(c.text))
    const iAbs = calls.findIndex(c => ABSENCE.test(c.text))
    expect(iLog).toBeGreaterThanOrEqual(0)
    expect(iAbs).toBeGreaterThan(iLog)
  })

  it('never writes to custom_field_values or to the change log', async () => {
    routeSql([{ match: LOGGED, rows: [] }, { match: ABSENCE, rows: [] }])
    await RECONCILE(req('/api/playtest-tags/reconcile'))
    expect(calls.some(c => /(DELETE FROM|INSERT INTO|UPDATE) custom_field_values/.test(c.text))).toBe(false)
    expect(calls.some(c => /INSERT INTO custom_field_value_changes/.test(c.text))).toBe(false)
  })

  it('reports zero when nothing has gone missing', async () => {
    routeSql([{ match: LOGGED, rows: [] }, { match: ABSENCE, rows: [] }])
    expect(await (await RECONCILE(req('/api/playtest-tags/reconcile'))).json())
      .toMatchObject({ ok: true, removed: 0, attributed: 0, unattributed: 0, rows: [] })
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

  it('writes a Remove into Signal Sense\'s change log before deleting the row', async () => {
    routeSql([
      SYNCED,
      { match: /FROM custom_field_values/, rows: [{ created_by: 'playtest_sync', sub_value_id: 2, first_name: 'Signal Playtest', last_name: 'Sync', email: null }] },
    ])
    await REMOVE(req('/api/playtest-tags/remove', { id: 7 }))
    // The plain INSERT ... VALUES, not the backfill's INSERT ... SELECT cfv.
    const iLog = calls.findIndex(c => /INSERT INTO custom_field_value_changes/.test(c.text) && !/SELECT cfv\./.test(c.text))
    const iDel = calls.findIndex(c => /DELETE FROM custom_field_values/.test(c.text))
    expect(iLog).toBeGreaterThanOrEqual(0)
    // Logged first: after the delete we could no longer read the sub-value, and
    // Signal Sense's history would show a tag that vanished with no Remove.
    expect(iDel).toBeGreaterThan(iLog)
    const log = calls[iLog]
    // action is a bind, not inline SQL. changed_by is a users(id) FK; the admin
    // has no row there, so the app is the actor. old_sub_value_id carries what
    // the tag had at removal time.
    expect(log.binds).toEqual(expect.arrayContaining(['g1', 'Trends', 'Animal Driver', 'remove', 2, 'playtest_sync']))
    expect(log.binds).not.toContain('vinhtd@athena.studio')
  })

  it('rescues the missing add line from the row itself, before deleting it', async () => {
    routeSql([
      SYNCED,
      { match: /FROM custom_field_values/, rows: [{ created_by: 'playtest_sync', sub_value_id: 2, first_name: 'Signal Playtest', last_name: 'Sync', email: null }] },
    ])
    await REMOVE(req('/api/playtest-tags/remove', { id: 7 }))
    const backfill = calls.find(c => /INSERT INTO custom_field_value_changes[\s\S]*SELECT cfv\./.test(c.text))
    expect(backfill).toBeDefined()
    // Attribution comes from the row, not from this app.
    expect(backfill!.text).toMatch(/cfv\.created_by/)
    // One add per tag, so a tag already logged is left alone.
    expect(backfill!.text).toMatch(/NOT EXISTS/)
    expect(backfill!.text).toMatch(/a\.action = 'add'/)
    // A plain ::timestamptz cast would read the naive created_at in the
    // session's TimeZone — seven hours out under Asia/Ho_Chi_Minh.
    expect(backfill!.text).toMatch(/AT TIME ZONE 'UTC'/)
    // changed_at is NOT NULL, and created_at is nullable.
    expect(backfill!.text).toMatch(/COALESCE/)

    // Ordering: rescue the add, then log the remove, then delete.
    const iAdd = calls.findIndex(c => /SELECT cfv\./.test(c.text))
    const iRemoveLog = calls.findIndex(c => /INSERT INTO custom_field_value_changes/.test(c.text) && !/SELECT cfv\./.test(c.text))
    const iDel = calls.findIndex(c => /DELETE FROM custom_field_values/.test(c.text))
    expect(iAdd).toBeLessThan(iRemoveLog)
    expect(iRemoveLog).toBeLessThan(iDel)
  })

  it('does not attempt a backfill when the row is already gone', async () => {
    routeSql([SYNCED, { match: /FROM custom_field_values/, rows: [] }])
    await REMOVE(req('/api/playtest-tags/remove', { id: 7 }))
    // Nothing to read provenance from, and nothing to remove — so no log at all.
    expect(calls.some(c => /INSERT INTO custom_field_value_changes/.test(c.text))).toBe(false)
  })

  it('deletes the Signal Sense row when playtest_sync created it, and stamps the removal', async () => {
    routeSql([
      SYNCED,
      { match: /FROM custom_field_values/, rows: [{ created_by: 'playtest_sync', sub_value_id: 1, first_name: 'Signal Playtest', last_name: 'Sync', email: null }] },
    ])
    const body = await (await REMOVE(req('/api/playtest-tags/remove', { id: 7 }))).json()
    expect(body).toEqual({ ok: true, outcome: 'deleted' })
    const del = calls.find(c => /DELETE FROM custom_field_values/.test(c.text))!
    // Not scoped by creator any more: the tag's identity over there is
    // (game, field, value), and that is what the admin acted on.
    expect(del.text).not.toMatch(/created_by/)
    expect(del.binds).toEqual(expect.arrayContaining(['g1', 'Trends', 'Animal Driver']))
    const stamp = calls.find(c => /UPDATE playtest_tags/.test(c.text))!
    expect(stamp.text).toMatch(/status = 'removed'/)
    // Stamped by (game, value) rather than by the id this route was given: the
    // shared helper is also reached from surfaces that have no id to pass.
    expect(stamp.binds).toEqual(expect.arrayContaining(['vinhtd@athena.studio', 'g1', 'Animal Driver']))
  })

  // This route used to refuse here with a 409 naming the Signal Sense user, on
  // the rule "this app only removes what it added". An admin here now owns
  // every Trends tag on the game, so the rule is gone -- what stays is the
  // bookkeeping: their change log gets the removal, and so does ours.
  it('deletes a row a Signal Sense user created, same as its own', async () => {
    routeSql([
      SYNCED,
      { match: /FROM custom_field_values/, rows: [{ created_by: 'LCU6y3GtrRRoqHYyOn_tE', sub_value_id: 1, first_name: 'Tran', last_name: 'Vinh', email: 'vinhtd@athena.studio' }] },
    ])
    const r = await REMOVE(req('/api/playtest-tags/remove', { id: 7 }))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, outcome: 'deleted' })
    expect(calls.some(c => /DELETE FROM custom_field_values/.test(c.text))).toBe(true)
    expect(calls.some(c => /INSERT INTO custom_field_value_changes/.test(c.text))).toBe(true)
    expect(calls.some(c => /UPDATE playtest_tags/.test(c.text))).toBe(true)
  })

  it('stamps the removal without a delete when the row is already gone', async () => {
    routeSql([SYNCED, { match: /FROM custom_field_values/, rows: [] }])
    const body = await (await REMOVE(req('/api/playtest-tags/remove', { id: 7 }))).json()
    expect(body).toEqual({ ok: true, outcome: 'already_gone' })
    expect(calls.some(c => /DELETE FROM custom_field_values/.test(c.text))).toBe(false)
    expect(calls.some(c => /UPDATE playtest_tags/.test(c.text))).toBe(true)
  })
})
