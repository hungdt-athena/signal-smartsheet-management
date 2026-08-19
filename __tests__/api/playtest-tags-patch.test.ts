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

/** The SET clause the route builds for the original_* snapshot, or '' when it
 *  decided not to snapshot. It reaches sql() as a nested fragment, which the
 *  mock records as its own call. */
function snapshotSql() {
  return calls.map(c => c.text).find(t => /original_field_value =/.test(t)) ?? ''
}

function patchReq(body: unknown) {
  return new NextRequest('http://localhost/api/playtest-tags/7', {
    method: 'PATCH', body: JSON.stringify(body),
  } as never)
}
const params = { params: { id: '7' } }

// The row being corrected: pending, proposed by an evaluator days ago, and never
// edited before — original_captured_at is what the route reads to decide whether
// this correction is the one that snapshots the evaluator's version.
const theRow = {
  match: /SELECT id, game_id, field_value, sub_value_id, original_captured_at\s+FROM playtest_tags/,
  rows: [{ id: 7, game_id: 'g1', field_value: 'Balatro', sub_value_id: null, original_captured_at: null }],
}
/** The same row after an earlier correction already captured the original. */
const editedRow = {
  match: theRow.match,
  rows: [{ ...theRow.rows[0], original_captured_at: '2026-08-14T03:00:00Z' }],
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

  // The review table redraws the edited row from this response instead of
  // refetching the queue, so it has to carry the recomputed conflict flag rather
  // than just the three columns the UPDATE returned.
  it('answers with the row as the queue reads it, conflict included', async () => {
    routeSql([theRow, activeSub, updated, {
      match: /FROM playtest_tags pt/,
      rows: [{
        id: 7, game_id: 'g1', title: 'Balatro Clone', publisher_name: 'Pub',
        icon_url: null, initial_evaluator: 'Mitt', field_value: 'Balatro',
        sub_value_id: 2, sub_value_name: 'Deckbuilder', tagged_by_name: 'Mitt',
        tagged_at: '2026-08-13', their_exists: true, their_sub_value_id: 5,
        their_sub_value_name: 'Roguelike',
      }],
    }])
    const d = await (await PATCH(patchReq({ sub_value_id: 2 }), params)).json()
    expect(d.tag.conflict).toBe(true)
    expect(d.tag.their_sub_value_name).toBe('Roguelike')
    expect(d.tag.title).toBe('Balatro Clone')
    // The flag is derived, never a column.
    expect(d.tag.their_exists).toBeUndefined()
  })

  it('clears the sub-value when given null', async () => {
    routeSql([
      { match: theRow.match,
        rows: [{ id: 7, game_id: 'g1', field_value: 'Balatro', sub_value_id: 2, original_captured_at: null }] },
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
      if (theRow.match.test(text)) return Promise.resolve(theRow.rows)
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

  // What the evaluator proposed has to survive the correction, or History can
  // only ever show them the corrected tag and never that it was corrected.
  it('snapshots the evaluator version on the first correction', async () => {
    routeSql([theRow, activeSub, updated])
    const r = await PATCH(patchReq({ sub_value_id: 2 }), params)
    expect(r.status).toBe(200)
    // The snapshot rides in as a nested sql fragment, so it is a call of its
    // own here rather than part of the UPDATE's own template text. Its SET
    // expressions read the pre-UPDATE row, storing the version being replaced
    // rather than the replacement.
    expect(snapshotSql()).toMatch(/original_field_value = field_value/)
    expect(snapshotSql()).toMatch(/original_sub_value_id = sub_value_id/)
    expect(snapshotSql()).toMatch(/original_captured_at = now\(\)/)
  })

  // A third correction must still compare against the evaluator, not against
  // the second correction.
  it('does not re-snapshot a row that was already corrected once', async () => {
    routeSql([editedRow, activeSub, updated])
    expect((await PATCH(patchReq({ sub_value_id: 2 }), params)).status).toBe(200)
    expect(snapshotSql()).toBe('')
  })

  // Picking the value that is already there is not a correction. Stamping it
  // would tell the evaluator they were overruled when nothing about their tag
  // changed.
  it('does not snapshot when the edit changes nothing', async () => {
    routeSql([theRow, activeDef, updated])
    expect((await PATCH(patchReq({ field_value: 'Balatro' }), params)).status).toBe(200)
    expect(snapshotSql()).toBe('')
  })

  it('rejects a non-numeric id', async () => {
    routeSql([])
    const r = await PATCH(patchReq({ sub_value_id: 2 }), { params: { id: 'abc' } })
    expect(r.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})
