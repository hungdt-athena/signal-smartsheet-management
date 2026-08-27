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

  // The authorisation query answers two EXISTS in one row: whether the game has
  // any game_evaluations rows at all, and whether the caller is the evaluator on
  // any of them (a game can hold one row per category_group).
  const authz = (found: boolean, owned: boolean) =>
    ({ match: /FROM game_evaluations/, rows: [{ found, owned }] })

  it('refuses an evaluator writing tags on someone else\'s game', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([authz(true, false)])
    const r = await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: null }] }))
    expect(r.status).toBe(403)
    expect(calls.some(c => /INSERT INTO playtest_tags/.test(c.text))).toBe(false)
  })

  it('404s when the game has no game_evaluations rows at all', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    routeSql([authz(false, false)])
    const r = await PUT(putReq({ game_id: 'nope', tags: [] }))
    expect(r.status).toBe(404)
    expect(calls.some(c => /DELETE FROM playtest_tags/.test(c.text))).toBe(false)
  })

  it('authorises an evaluator listed on ANY of the game\'s category groups', async () => {
    // Two rows exist for the game (e.g. puzzle + arcade) and Mitt is the
    // evaluator on only one of them: EXISTS must allow it, and the query must
    // not pick a single arbitrary row.
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([
      authz(true, true),
      { match: /field_value = ANY/, rows: [{ field_value: 'Balatro' }] },
    ])
    const r = await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: null }] }))
    expect(r.status).toBe(200)
    const authQuery = calls.find(c => /FROM game_evaluations/.test(c.text))!
    expect(authQuery.text).toMatch(/EXISTS/)
    expect(authQuery.text).not.toMatch(/LIMIT 1/)
  })

  it('lets an evaluator replace the pending set on their own game', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([
      authz(true, true),
      { match: /field_value = ANY/, rows: [{ field_value: 'Balatro' }] },
    ])
    const r = await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: 2 }] }))
    expect(await r.json()).toEqual({ ok: true, count: 1 })
    // Tags dropped from the list are rejected -- History has to keep the
    // episode -- unless they are the caller's own untouched proposal, which is
    // deleted instead (see the self-drop tests below).
    expect(calls.some(c => /UPDATE playtest_tags\s*SET status = /.test(c.text))).toBe(true)
    const insert = calls.find(c => /INSERT INTO playtest_tags/.test(c.text))
    expect(insert?.binds).toEqual(expect.arrayContaining(['g1', 'Balatro', 2, 'mitt@athena.studio']))
  })

  it('keeps tagged_by/tagged_at on a surviving tag and only drops the ones removed', async () => {
    // Every eval save fires this PUT, including saves that never touched a tag.
    // A delete-all + re-insert would restamp the evaluator's provenance with the
    // saver's email and a fresh tagged_at, and churn the ids the admin queue
    // holds. So: a scoped DELETE plus an upsert that writes only the sub-value.
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    routeSql([
      authz(true, false),
      { match: /field_value = ANY/, rows: [{ field_value: 'Balatro' }] },
    ])
    const r = await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: 1 }] }))
    expect(r.status).toBe(200)

    const drop = calls.find(c => /UPDATE playtest_tags\s*SET status = /.test(c.text))!
    // Scoped to the values that are gone, not the whole pending set.
    expect(drop.text).toMatch(/NOT \(field_value = ANY/)
    expect(drop.binds).toEqual(expect.arrayContaining([['Balatro']]))

    const insert = calls.find(c => /INSERT INTO playtest_tags/.test(c.text))!
    // Upsert on the partial unique index, predicate repeated in the target.
    expect(insert.text).toMatch(/ON CONFLICT \(game_id, field_value\)\s*WHERE status = 'pending'/)
    expect(insert.text).toMatch(/DO UPDATE SET\s*sub_value_id = EXCLUDED\.sub_value_id/)
    // Editing a pending tag here leaves the review rows' trail: the tagger keeps
    // the credit, the replaced version is snapshotted, edited_by names whoever
    // moved it. All guarded on the sub-value actually changing, because this PUT
    // also fires on saves that never touched a tag -- see the route.
    const update = insert.text.split('DO UPDATE')[1]
    expect(update).not.toMatch(/tagged_by =/)
    expect(update).toMatch(/edited_by = CASE/)
    expect(update).toMatch(/original_captured_at = CASE/)
    expect(update).toMatch(/sub_value_id IS DISTINCT FROM EXCLUDED\.sub_value_id/)
  })

  it('deletes your own untouched proposal instead of logging a self-rejection', async () => {
    // Proposed by Mitt, dropped by Mitt, before any admin saw it: History would
    // otherwise show a `rejected` line whose Proposed and Reviewed are both Mitt.
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([
      authz(true, true),
      { match: /field_value = ANY/, rows: [{ field_value: 'Balatro' }] },
    ])
    const r = await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: 1 }] }))
    expect(r.status).toBe(200)

    const del = calls.find(c => /DELETE FROM playtest_tags/.test(c.text))!
    // Scoped three ways: this game's dropped values, tagged by the caller, and
    // not corrected by anyone else -- an edited row belongs to two people.
    expect(del.text).toMatch(/NOT \(field_value = ANY/)
    expect(del.text).toMatch(/tagged_by = /)
    expect(del.text).toMatch(/edited_by IS NULL OR edited_by = /)
    expect(del.binds).toEqual(expect.arrayContaining([['Balatro'], 'mitt@athena.studio']))

    // Everyone else's dropped tags still become history, and the delete runs
    // first so it wins the rows it owns.
    const reject = calls.find(c => /UPDATE playtest_tags\s*SET status = /.test(c.text))!
    expect(calls.indexOf(del)).toBeLessThan(calls.indexOf(reject))
    expect(reject.text).not.toMatch(/tagged_by = /)
  })

  it('deletes only your own tags when clearing the whole pending set', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([authz(true, true)])
    const r = await PUT(putReq({ game_id: 'g1', tags: [] }))
    expect(r.status).toBe(200)
    const del = calls.find(c => /DELETE FROM playtest_tags/.test(c.text))!
    expect(del.text).not.toMatch(/NOT \(field_value = ANY/)
    expect(del.text).toMatch(/tagged_by = /)
    expect(del.binds).toEqual(expect.arrayContaining(['mitt@athena.studio']))
  })

  it('rejects a value that is not an active Trends definition', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    routeSql([
      authz(true, false),
      { match: /field_value = ANY/, rows: [] },
    ])
    const r = await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Not A Trend', sub_value_id: null }] }))
    expect(r.status).toBe(400)
    expect(calls.some(c => /INSERT INTO playtest_tags/.test(c.text))).toBe(false)
  })

  it('clears the pending set when tags is empty', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    routeSql([authz(true, false)])
    const r = await PUT(putReq({ game_id: 'g1', tags: [] }))
    expect(await r.json()).toEqual({ ok: true, count: 0 })
    const drop = calls.find(c => /UPDATE playtest_tags\s*SET status = /.test(c.text))!
    // Rejecting the whole pending set is only correct when the payload is empty.
    expect(drop.text).not.toMatch(/NOT \(field_value = ANY/)
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
      if (/FROM game_evaluations/.test(text)) return Promise.resolve([{ found: true, owned: true }])
      if (/field_value = ANY/.test(text)) return Promise.resolve([{ field_value: 'Balatro' }])
      if (/INSERT INTO playtest_tags/.test(text)) return Promise.reject(new Error('constraint violation'))
      return Promise.resolve([])
    })
    sqlMock.begin = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(sqlMock)))

    await expect(PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: null }] })))
      .rejects.toThrow('constraint violation')
    expect(calls.some(c => /UPDATE playtest_tags\s*SET status = /.test(c.text))).toBe(true)
  })

  it('syncs an admin tag straight into Signal Sense', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    routeSql([
      { match: /EXISTS/, rows: [{ found: true, owned: true }] },
      { match: /custom_field_definitions/, rows: [{ field_value: 'Balatro' }] },
      { match: /INSERT INTO playtest_tags/, rows: [{ id: 42 }] },
      { match: /SELECT id, field_value, sub_value_id/, rows: [{ id: 42, field_value: 'Balatro', sub_value_id: 3 }] },
      { match: /FROM custom_field_values/, rows: [] },
      { match: /INSERT INTO custom_field_values/, rows: [{ id: 9 }] },
    ])
    const res = await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: 3 }] }))
    expect(res.status).toBe(200)
    expect(calls.some(c => /INSERT INTO custom_field_values/.test(c.text))).toBe(true)
    expect(calls.some(c => /UPDATE playtest_tags/.test(c.text) && c.binds.includes('synced'))).toBe(true)
  })

  it('never auto-syncs a tag proposed by someone else', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'VinhTD', email: 'vinhtd@athena.studio' } })
    routeSql([
      { match: /EXISTS/, rows: [{ found: true, owned: true }] },
      { match: /custom_field_definitions/, rows: [{ field_value: 'Balatro' }] },
      { match: /INSERT INTO playtest_tags/, rows: [{ id: 42 }] },
      // The read-back is scoped to tagged_by = the admin, so a proposal made by
      // an evaluator comes back empty and nothing is synced.
      { match: /SELECT id, field_value, sub_value_id/, rows: [] },
    ])
    const res = await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: 3 }] }))
    expect(res.status).toBe(200)
    const readBack = calls.find(c => /SELECT id, field_value, sub_value_id/.test(c.text))
    expect(readBack?.binds).toContain('vinhtd@athena.studio')
    expect(calls.some(c => /INSERT INTO custom_field_values/.test(c.text))).toBe(false)
  })

  it('leaves a moderator tag pending', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'moderator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([
      { match: /EXISTS/, rows: [{ found: true, owned: true }] },
      { match: /custom_field_definitions/, rows: [{ field_value: 'Balatro' }] },
      { match: /INSERT INTO playtest_tags/, rows: [{ id: 42 }] },
    ])
    expect((await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: 3 }] }))).status).toBe(200)
    expect(calls.some(c => /INSERT INTO custom_field_values/.test(c.text))).toBe(false)
  })

  it('leaves an evaluator tag pending', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Mitt', email: 'mitt@athena.studio' } })
    routeSql([
      { match: /EXISTS/, rows: [{ found: true, owned: true }] },
      { match: /custom_field_definitions/, rows: [{ field_value: 'Balatro' }] },
      { match: /INSERT INTO playtest_tags/, rows: [{ id: 42 }] },
    ])
    expect((await PUT(putReq({ game_id: 'g1', tags: [{ field_value: 'Balatro', sub_value_id: 3 }] }))).status).toBe(200)
    expect(calls.some(c => /INSERT INTO custom_field_values/.test(c.text))).toBe(false)
  })
})
