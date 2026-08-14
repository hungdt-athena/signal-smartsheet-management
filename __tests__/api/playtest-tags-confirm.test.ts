/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => {
  const fn = jest.fn() as jest.Mock & { json: jest.Mock; begin: jest.Mock; savepoint: jest.Mock }
  fn.json = jest.fn((v: unknown) => v)
  // begin(cb) runs the callback with the same mock, so a transaction behaves
  // like the plain client in tests.
  fn.begin = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(fn)))
  // logCfvChanges isolates each log row in a savepoint.
  fn.savepoint = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(fn)))
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

function req(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) } as never)
}

// Confirm re-checks the definitions, so every test must say which values are
// still active. Anything omitted here is treated as retired -- which is the
// point of the check, not an artefact of the mock.
const activeDefs = (...values: string[]) =>
  ({ match: /FROM custom_field_definitions/, rows: values.map(v => ({ field_value: v })) })
// The writes now carry RETURNING, so their mocked rows decide whether the route
// believes anything was written.
const insertWrote = (ok = true) =>
  ({ match: /INSERT INTO custom_field_values/, rows: ok ? [{ id: 99 }] : [] })
const updateWrote = (ok = true) =>
  ({ match: /UPDATE custom_field_values/, rows: ok ? [{ id: 99 }] : [] })
// Their sub-value read back after a guarded write matched no row. Must precede
// the bulk `SELECT field_value, sub_value_id FROM custom_field_values` handler.
const readBack = (rows: unknown[]) =>
  ({ match: /SELECT sub_value_id\s+FROM custom_field_values/, rows })

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
      activeDefs('New Trend', 'Same', 'Empty Sub', 'Clash'),
      insertWrote(), updateWrote(),
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
      activeDefs('Clash', 'Clash Two'),
      updateWrote(),
    ])
    const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1', overwrite: [4] }))).json()
    expect(body.results).toEqual([
      { id: 4, result: 'overwritten' },
      { id: 5, result: 'kept' },
    ])
    expect(calls.filter(c => /UPDATE custom_field_values/.test(c.text))).toHaveLength(1)
  })

  // The queue confirms ticked tags, not whole games, so the pending read must be
  // narrowed to those ids -- a run that ignored `ids` would confirm a game's
  // other proposals behind the admin's back.
  it('narrows the pending read to the ids the admin ticked', async () => {
    routeSql([
      { match: /SELECT id, field_value, sub_value_id\s+FROM playtest_tags/,
        rows: [{ id: 1, field_value: 'New Trend', sub_value_id: null }] },
      { match: /FROM custom_field_values/, rows: [] },
      activeDefs('New Trend'),
      insertWrote(),
    ])
    const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1', ids: [1] }))).json()
    expect(body.results).toEqual([{ id: 1, result: 'inserted' }])
    // The filter is a nested fragment, so it reaches the client as its own
    // tagged template rather than as text inside the SELECT.
    const filter = calls.find(c => /AND id = ANY\(/.test(c.text))
    expect(filter?.binds).toEqual([[1]])
  })

  it('reads the whole pending set when no ids are given', async () => {
    routeSql([
      { match: /SELECT id, field_value, sub_value_id\s+FROM playtest_tags/, rows: [] },
    ])
    await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))
    expect(calls.some(c => /AND id = ANY\(/.test(c.text))).toBe(false)
  })

  // An empty selection means "nothing", which must not fall through to "all".
  it('refuses an empty ids array instead of confirming everything', async () => {
    routeSql([])
    const r = await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1', ids: [] }))
    expect(r.status).toBe(400)
    expect(calls.some(c => /FROM playtest_tags/.test(c.text))).toBe(false)
  })

  it('stamps confirmed_by and the per-row status', async () => {
    routeSql([
      { match: /FROM playtest_tags/, rows: [{ id: 1, field_value: 'New Trend', sub_value_id: null }] },
      { match: /FROM custom_field_values/, rows: [] },
      activeDefs('New Trend'),
      insertWrote(),
    ])
    await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))
    const stamp = calls.find(c => /UPDATE playtest_tags/.test(c.text))
    expect(stamp?.binds).toEqual(expect.arrayContaining(['synced', 'inserted', 'vinhtd@athena.studio', 1]))
  })

  it('returns an empty result set when the game has no pending tags', async () => {
    routeSql([{ match: /FROM playtest_tags/, rows: [] }])
    const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))).json()
    expect(body).toEqual({ ok: true, results: [], skipped: [] })
  })

  it('rejects a value that stopped being an active Trends definition', async () => {
    // Proposal and confirm are days apart; a Signal Sense admin may retire a
    // value in between. Confirming must not resurrect it.
    routeSql([
      { match: /FROM playtest_tags/, rows: [
        { id: 1, field_value: 'Retired', sub_value_id: 1 },
        { id: 2, field_value: 'Still Active', sub_value_id: null },
      ] },
      { match: /FROM custom_field_values/, rows: [] },
      activeDefs('Still Active'),
      insertWrote(),
    ])
    const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))).json()
    expect(body.results).toEqual([
      { id: 1, result: 'inactive' },
      { id: 2, result: 'inserted' },
    ])
    // Exactly one write, and it is the surviving value.
    const inserts = calls.filter(c => /INSERT INTO custom_field_values/.test(c.text))
    expect(inserts).toHaveLength(1)
    expect(inserts[0].binds).toEqual(expect.arrayContaining(['Still Active']))
    // The retired row is terminal and says why.
    const stamp = calls.find(c => /UPDATE playtest_tags/.test(c.text) && /'inactive'/.test(c.text))
    expect(stamp?.text).toMatch(/status = 'rejected'/)
    expect(body.skipped).toEqual([
      { id: 1, field_value: 'Retired', reason: 'no longer an active Trends value in Signal Sense' },
    ])
  })

  it('reports duplicate, not inserted, when the INSERT hits an existing row', async () => {
    // ON CONFLICT DO NOTHING + RETURNING: no row back means Signal Sense wrote
    // that value between our SELECT and our INSERT.
    routeSql([
      { match: /FROM playtest_tags/, rows: [{ id: 1, field_value: 'Racy', sub_value_id: 1 }] },
      { match: /FROM custom_field_values/, rows: [] },
      activeDefs('Racy'),
      insertWrote(false),
    ])
    const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))).json()
    expect(body.results).toEqual([{ id: 1, result: 'duplicate' }])
    expect(calls.find(c => /INSERT INTO custom_field_values/.test(c.text))?.text).toMatch(/RETURNING id/)
    const stamp = calls.find(c => /UPDATE playtest_tags/.test(c.text))
    expect(stamp?.binds).toEqual(expect.arrayContaining(['synced', 'duplicate']))
  })

  it('guards the enrich UPDATE on a still-NULL sub-value and reports the truth when it matches nothing', async () => {
    // Signal Sense filled the sub-value between our read and our write, with the
    // same value we proposed: nothing to do, and it is not an "enriched" write.
    routeSql([
      { match: /FROM playtest_tags/, rows: [{ id: 1, field_value: 'Empty Sub', sub_value_id: 2 }] },
      readBack([{ sub_value_id: 2 }]),
      { match: /FROM custom_field_values/, rows: [{ field_value: 'Empty Sub', sub_value_id: null }] },
      activeDefs('Empty Sub'),
      updateWrote(false),
    ])
    const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))).json()
    expect(body.results).toEqual([{ id: 1, result: 'duplicate' }])
    const upd = calls.find(c => /UPDATE custom_field_values/.test(c.text))!
    expect(upd.text).toMatch(/sub_value_id IS NULL/)
    expect(upd.text).toMatch(/RETURNING id/)
    expect(body.skipped[0].reason).toMatch(/changed this tag/)
  })

  it('keeps Signal Sense\'s value when a guarded enrich finds a different sub-value', async () => {
    routeSql([
      { match: /FROM playtest_tags/, rows: [{ id: 1, field_value: 'Empty Sub', sub_value_id: 2 }] },
      readBack([{ sub_value_id: 1 }]),
      { match: /FROM custom_field_values/, rows: [{ field_value: 'Empty Sub', sub_value_id: null }] },
      activeDefs('Empty Sub'),
      updateWrote(false),
    ])
    const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))).json()
    expect(body.results).toEqual([{ id: 1, result: 'kept' }])
    const stamp = calls.find(c => /UPDATE playtest_tags/.test(c.text))
    expect(stamp?.binds).toEqual(expect.arrayContaining(['rejected', 'kept']))
  })

  it('guards the overwrite UPDATE on the sub-value the admin decided against', async () => {
    routeSql([
      { match: /FROM playtest_tags/, rows: [{ id: 4, field_value: 'Clash', sub_value_id: 1 }] },
      { match: /FROM custom_field_values/, rows: [{ field_value: 'Clash', sub_value_id: 2 }] },
      activeDefs('Clash'),
      updateWrote(),
    ])
    const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1', overwrite: [4] }))).json()
    expect(body.results).toEqual([{ id: 4, result: 'overwritten' }])
    const upd = calls.find(c => /UPDATE custom_field_values/.test(c.text))!
    // Bound to THEIR sub-value (2), so a row they changed since is left alone.
    expect(upd.text).toMatch(/AND sub_value_id = /)
    expect(upd.binds).toEqual(expect.arrayContaining([1, 'Clash', 2]))
  })

  it('does not claim an overwrite when the row moved underneath it', async () => {
    routeSql([
      { match: /FROM playtest_tags/, rows: [{ id: 4, field_value: 'Clash', sub_value_id: 1 }] },
      readBack([]),  // the row is gone entirely
      { match: /FROM custom_field_values/, rows: [{ field_value: 'Clash', sub_value_id: 2 }] },
      activeDefs('Clash'),
      updateWrote(false),
    ])
    const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1', overwrite: [4] }))).json()
    expect(body.results).toEqual([{ id: 4, result: 'kept' }])
    expect(body.skipped[0].reason).toMatch(/disappeared/)
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

  // Signal Sense derives tag history from the value rows themselves, so a write
  // we make without a log entry is invisible in its history (their migration 020
  // moved every tag event into that one table).
  describe('Signal Sense change log', () => {
    const LOG = /INSERT INTO custom_field_value_changes/

    it("logs an 'add' for a tag it inserted, carrying the sub-value", async () => {
      routeSql([
        { match: /FROM playtest_tags/, rows: [{ id: 1, field_value: 'New Trend', sub_value_id: 2 }] },
        { match: /FROM custom_field_values/, rows: [] },
        activeDefs('New Trend'),
        insertWrote(true),
      ])
      await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))
      const log = calls.find(c => LOG.test(c.text))!
      expect(log).toBeDefined()
      // action, the tag, the sub-value it was given, and the app as the actor.
      expect(log.binds).toEqual(expect.arrayContaining(['g1', 'Trends', 'New Trend', 'add', 2, 'playtest_sync']))
    })

    it("logs a 'sub_value_change' for an enrich, from NULL to ours", async () => {
      routeSql([
        { match: /FROM playtest_tags/, rows: [{ id: 3, field_value: 'Empty Sub', sub_value_id: 2 }] },
        { match: /FROM custom_field_values/, rows: [{ field_value: 'Empty Sub', sub_value_id: null }] },
        activeDefs('Empty Sub'),
        updateWrote(true),
      ])
      await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))
      const log = calls.find(c => LOG.test(c.text))!
      expect(log.binds).toEqual(expect.arrayContaining(['Empty Sub', 'sub_value_change', 2, 'playtest_sync']))
      // old_sub_value_id is NULL for an enrich: there was nothing there before.
      expect(log.binds).toContain(null)
    })

    it("logs a 'sub_value_change' for an overwrite, naming what it replaced", async () => {
      routeSql([
        { match: /FROM playtest_tags/, rows: [{ id: 4, field_value: 'Clash', sub_value_id: 1 }] },
        { match: /FROM custom_field_values/, rows: [{ field_value: 'Clash', sub_value_id: 2 }] },
        activeDefs('Clash'),
        updateWrote(true),
      ])
      await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1', overwrite: [4] }))
      const log = calls.find(c => LOG.test(c.text))!
      expect(log.binds).toEqual(expect.arrayContaining(['Clash', 'sub_value_change', 2, 1, 'playtest_sync']))
    })

    it('logs nothing when no write landed', async () => {
      // duplicate: the value is already there, we wrote nothing to log.
      routeSql([
        { match: /FROM playtest_tags/, rows: [{ id: 2, field_value: 'Same', sub_value_id: 1 }] },
        { match: /FROM custom_field_values/, rows: [{ field_value: 'Same', sub_value_id: 1 }] },
        activeDefs('Same'),
      ])
      const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))).json()
      expect(body.results).toEqual([{ id: 2, result: 'duplicate' }])
      expect(calls.some(c => LOG.test(c.text))).toBe(false)
    })

    it('never logs an inactive value, which is refused before any write', async () => {
      routeSql([
        { match: /FROM playtest_tags/, rows: [{ id: 9, field_value: 'Retired', sub_value_id: 1 }] },
        { match: /FROM custom_field_values/, rows: [] },
        activeDefs(),  // no longer an active definition
      ])
      const body = await (await CONFIRM(req('/api/playtest-tags/confirm', { game_id: 'g1' }))).json()
      expect(body.results).toEqual([{ id: 9, result: 'inactive' }])
      expect(calls.some(c => LOG.test(c.text))).toBe(false)
    })
  })

})
