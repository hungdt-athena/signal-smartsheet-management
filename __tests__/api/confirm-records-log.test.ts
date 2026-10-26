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
type Call = { text: string; binds: unknown[] }
let calls: Call[] = []
// Fragments (the per-bucket SET, the own-bucket CASE) come back as marker objects and
// are inlined into the statement that uses them, so assertions read the whole statement.
function render(strings: readonly string[], binds: unknown[]): Call {
  let text = strings[0]
  const flat: unknown[] = []
  binds.forEach((b, i) => {
    if (b && typeof b === 'object' && 'frag' in (b as object)) {
      const f = (b as { frag: Call }).frag
      text += f.text
      flat.push(...f.binds)
    } else {
      text += '$'
      flat.push(b)
    }
    text += strings[i + 1]
  })
  return { text, binds: flat }
}
const isStatement = (text: string) => /^\s*(WITH|UPDATE|SELECT|INSERT)\b/.test(text)
function routeSql(rows: unknown = [{ confirmed: 2 }]) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    // sql(list) helper call: not a tagged template
    if (!Array.isArray(strings) || !('raw' in (strings as object))) return { list: strings }
    const c = render(strings as string[], binds)
    if (!isStatement(c.text)) return { frag: c }
    calls.push(c)
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
    // the Confirm lands in the own bucket's column; record_confirmed_at follows (051 trigger)
    expect(t).toMatch(/record_5min_confirmed_at = CASE WHEN \(CASE[\s\S]*?END\) = '5min' THEN NOW\(\) ELSE ge\.record_5min_confirmed_at END/)
    expect(t).toMatch(/record_20min_confirmed_at = CASE WHEN \(CASE[\s\S]*?END\) = '20min' THEN NOW\(\) ELSE ge\.record_20min_confirmed_at END/)
    expect(t).not.toMatch(/SET record_confirmed_at/)
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
    expect(t).toMatch(/WHERE cur\.recorder IS NOT NULL AND lower\(cur\.recorder\) IS DISTINCT FROM lower\(cur\.prev_recorder\)/)
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
    expect(calls[0].text).toMatch(/record_5min_confirmed_at = CASE WHEN \(CASE[\s\S]*?END\) = '5min' THEN NULL/)
    expect(calls[0].text).toMatch(/record_20min_confirmed_at = CASE WHEN \(CASE[\s\S]*?END\) = '20min' THEN NULL/)
    expect(calls[0].text).toMatch(/ge\.record_confirmed_at IS NOT NULL/)
    expect(calls[0].text).not.toMatch(/evaluation_log/)
  })

  it('400s without ids', async () => {
    const res = await post({ ids: [] })
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('returns a readable error when migration 046 is missing', async () => {
    sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
      if (!Array.isArray(strings) || !('raw' in (strings as object))) return { list: strings }
      const c = render(strings as string[], binds)
      if (!isStatement(c.text)) return { frag: c }
      return Promise.reject(Object.assign(new Error('relation "evaluation_log" does not exist'), { code: '42P01' }))
    })
    const res = await post({ ids: [1] })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/apply migration 046/)
  })
})
