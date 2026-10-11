/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => {
  return { sql: jest.fn() }
})
jest.mock('@/lib/auth-guard', () => ({ requireManager: jest.fn(async () => null) }))
jest.mock('@/lib/session', () => ({ getSession: jest.fn(async () => ({ user: { name: 'VinhTD', role: 'moderator' } })) }))

import { POST } from '@/app/api/evaluations/confirm-records/route'
import { sql } from '@/lib/db'
import { getSession } from '@/lib/session'

const sqlMock = sql as unknown as jest.Mock
let calls: { text: string; binds: unknown[] }[] = []
function routeSql(rows: unknown = [{ confirmed: 2 }]) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    // sql(list) helper call: not a tagged template
    if (!Array.isArray(strings) || !('raw' in (strings as object))) return { list: strings }
    calls.push({ text: (strings as string[]).join('$'), binds })
    const r = Object.assign(Array.isArray(rows) ? [...rows] : [], { count: 2 })
    return Promise.resolve(r)
  })
}
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/evaluations/confirm-records', {
  method: 'POST', body: JSON.stringify(body),
} as never))

describe('POST /api/evaluations/confirm-records — evaluation_log', () => {
  beforeEach(() => { calls = []; routeSql() })

  it('confirms and logs in one statement, under a row lock', async () => {
    const res = await post({ ids: [1, 2] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ confirmed: 2 })
    expect(calls).toHaveLength(1)
    const t = calls[0].text
    expect(t).toMatch(/FOR NO KEY UPDATE/)
    expect(t).toMatch(/record_confirmed_at IS NULL/)
    expect(t).toMatch(/SET record_confirmed_at = NOW\(\)/)
    expect(t).toMatch(/FROM old WHERE ge\.id = old\.id/)
    expect(t).toMatch(/FROM old JOIN upd ON upd\.id = old\.id/)
    expect(t).toMatch(/INSERT INTO evaluation_log/)
    expect(t).toMatch(/'record_tab',\s+'record_assign'/)
    expect(t).toMatch(/SELECT count\(\*\)::int AS confirmed FROM upd/)
  })

  it('reads the effective bucket and the recorder in it', async () => {
    await post({ ids: [1] })
    const t = calls[0].text
    expect(t).toMatch(/WHEN old\.record_bucket IN \('5min', '20min'\) THEN old\.record_bucket/)
    expect(t).toMatch(/WHEN old\.final_conclusion = 'Priority IV' THEN '20min'/)
    expect(t).toMatch(/WHEN old\.final_conclusion = 'Insight' THEN '5min'/)
    expect(t).toMatch(/WHEN '5min' THEN old\.record_5min_assignee/)
    expect(t).toMatch(/WHEN '20min' THEN old\.record_20min_assignee/)
  })

  it('looks up the previous recorder and skips NULL or unchanged recorders', async () => {
    await post({ ids: [1] })
    const t = calls[0].text
    expect(t).toMatch(/SELECT l\.recorder_after FROM evaluation_log l/)
    expect(t).toMatch(/l\.kind IN \('record_assign', 'record_move', 'record_remove'\)/)
    expect(t).toMatch(/ORDER BY l\.id DESC LIMIT 1\) AS prev_recorder/)
    expect(t).toMatch(/cur\.prev_recorder, cur\.recorder/)
    expect(t).toMatch(/WHERE cur\.recorder IS NOT NULL AND cur\.recorder IS DISTINCT FROM cur\.prev_recorder/)
  })

  it('binds the session actor and role with explicit casts', async () => {
    await post({ ids: [1] })
    const c = calls[0]
    expect(c.binds[0]).toEqual({ list: [1] })
    expect(c.binds.slice(1)).toEqual(['VinhTD', 'moderator'])
    expect(c.text).toMatch(/\$::text, \$::text, cur\.initial_evaluator/)
  })

  it('logs a NULL actor without a session', async () => {
    ;(getSession as jest.Mock).mockResolvedValueOnce(null)
    await post({ ids: [1] })
    // binds: the id list, then actor and role
    expect(calls[0].binds.slice(1)).toEqual([null, null])
  })

  it('unset (reset to draft) is a plain UPDATE with no log row', async () => {
    const res = await post({ ids: [1, 2], unset: true })
    expect(await res.json()).toEqual({ reset: 2 })
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toMatch(/SET record_confirmed_at = NULL/)
    expect(calls[0].text).not.toMatch(/evaluation_log/)
  })

  it('400s without ids', async () => {
    const res = await post({ ids: [] })
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('returns a readable error when migration 045 is missing', async () => {
    sqlMock.mockImplementation((strings: unknown) => {
      if (!Array.isArray(strings) || !('raw' in (strings as object))) return { list: strings }
      return Promise.reject(Object.assign(new Error('relation "evaluation_log" does not exist'), { code: '42P01' }))
    })
    const res = await post({ ids: [1] })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/apply migration 045/)
  })
})
