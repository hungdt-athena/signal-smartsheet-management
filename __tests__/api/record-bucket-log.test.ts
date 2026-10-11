/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/auth-guard', () => ({ requireManager: jest.fn(async () => null) }))
jest.mock('@/lib/session', () => ({ getSession: jest.fn(async () => ({ user: { name: 'VinhTD', role: 'moderator' } })) }))

import { POST } from '@/app/api/evaluations/record-bucket/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock
type Call = { text: string; binds: unknown[] }
let calls: Call[] = []
let found: Record<string, unknown>[] = []

// Fragments (the SET list) come back as marker objects; the outer statement's text is
// rebuilt with them inlined, so assertions read the whole statement.
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
beforeEach(() => {
  calls = []
  found = [{ record_bucket: null, record_5min_assignee: null, record_20min_assignee: 'MyTL', final_conclusion: 'Priority IV' }]
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: readonly string[], ...binds: unknown[]) => {
    const c = render(strings, binds)
    if (/^\s*record_bucket = /.test(c.text)) {
      // a SET fragment: postgres.js inlines it into the statement that uses it
      return { frag: c }
    }
    calls.push(c)
    if (/^\s*SELECT record_bucket/.test(c.text)) return Promise.resolve(found)
    return Promise.resolve([{ id: 7 }])
  })
})
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/evaluations/record-bucket', {
  method: 'POST', body: JSON.stringify(body),
} as never))
const writeCall = () => calls[calls.length - 1]

describe('POST /api/evaluations/record-bucket — evaluation_log', () => {
  it('a move logs record_move with the recorder carried, in the same statement', async () => {
    const res = await post({ id: 7, bucket: '5min' })
    expect(res.status).toBe(200)
    const w = writeCall()
    expect(w.text).toMatch(/WITH upd AS \(\s+UPDATE game_evaluations SET\s+record_bucket = \$/)
    expect(w.text).toMatch(/RETURNING \*/)
    expect(w.text).toMatch(/INSERT INTO evaluation_log/)
    expect(w.text).toMatch(/FROM upd\s+\)\s+SELECT \* FROM upd/)
    expect(w.text).toMatch(/'record_tab',\s+\$::text, \$::text, \$::text, \$::text, \$::text/)
    // actor, role, kind, bucket_before, bucket_after, recorder_before, recorder_after
    const tail = w.binds.slice(-7)
    expect(tail).toEqual(['VinhTD', 'moderator', 'record_move', '20min', '5min', 'MyTL', 'MyTL'])
    // the SET carries MyTL into the 5min column and clears 20min
    expect(w.binds.slice(0, 3)).toEqual(['5min', 'MyTL', null])
  })

  it('a remove logs record_remove: old bucket and recorder, nothing after', async () => {
    await post({ id: 7, bucket: 'none' })
    const w = writeCall()
    expect(w.text).toMatch(/record_bucket = 'none'/)
    expect(w.text).toMatch(/record_confirmed_at = NULL/)
    expect(w.binds.slice(-7)).toEqual(['VinhTD', 'moderator', 'record_remove', '20min', null, 'MyTL', null])
  })

  it('picking the same bucket again is a plain UPDATE with no log row', async () => {
    await post({ id: 7, bucket: '20min' })
    const w = writeCall()
    expect(w.text).toMatch(/^\s*UPDATE game_evaluations SET/)
    expect(w.text).not.toMatch(/evaluation_log/)
  })

  it('removing a game that is not in Record logs nothing', async () => {
    found = [{ record_bucket: null, record_5min_assignee: null, record_20min_assignee: null, final_conclusion: null }]
    await post({ id: 7, bucket: 'none' })
    const w = writeCall()
    expect(w.text).toMatch(/^\s*UPDATE game_evaluations SET/)
    expect(w.text).not.toMatch(/evaluation_log/)
  })

  it('a manual bucket is the current bucket, whatever the final conclusion says', async () => {
    found = [{ record_bucket: '5min', record_5min_assignee: 'Bob', record_20min_assignee: null, final_conclusion: 'Priority IV' }]
    await post({ id: 7, bucket: '20min' })
    expect(writeCall().binds.slice(-7)).toEqual(['VinhTD', 'moderator', 'record_move', '5min', '20min', 'Bob', 'Bob'])
  })

  it('returns a readable error when migration 046 is missing', async () => {
    sqlMock.mockImplementation((strings: readonly string[], ...binds: unknown[]) => {
      const c = render(strings, binds)
      if (/^\s*record_bucket = /.test(c.text)) return { frag: c }
      if (/^\s*SELECT record_bucket/.test(c.text)) return Promise.resolve(found)
      return Promise.reject(Object.assign(new Error('relation "evaluation_log" does not exist'), { code: '42P01' }))
    })
    const res = await post({ id: 7, bucket: '5min' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/apply migration 046/)
  })
})
