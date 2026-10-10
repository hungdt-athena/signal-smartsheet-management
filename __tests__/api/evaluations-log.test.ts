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
jest.mock('@/lib/auth', () => ({ authOptions: {} }))
jest.mock('@/lib/config', () => ({
  getConfigValues: jest.fn(async () => ['Priority IV', 'Insight', 'Bypass', 'List_Idea']),
}))

import { PATCH } from '@/app/api/evaluations/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock

let calls: { text: string; binds: unknown[] }[] = []
function routeSql(row: Record<string, unknown> = { initial_evaluator: 'Alice', initial_conclusion: null }) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    calls.push({ text: (strings as string[]).join('$'), binds })
    return Promise.resolve([{ id: 1, ...row }])
  })
}
const patch = (body: unknown) => PATCH(new NextRequest('http://localhost/api/evaluations', {
  method: 'PATCH', body: JSON.stringify(body),
} as never))
const writeCall = () => calls.find(c => /INSERT INTO evaluation_log/.test(c.text))!

describe('PATCH /api/evaluations — evaluation_log', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => { calls = []; sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Alice' } }) })

  it('writes the log in the same statement as the UPDATE, under a row lock', async () => {
    routeSql()
    const res = await patch({ id: 1, initial_conclusion: 'Bypass', initial_note: 'a real note here', view_s: 42, context: 'evaluate' })
    expect(res.status).toBe(200)
    const w = writeCall()
    expect(w.text).toMatch(/FOR NO KEY UPDATE/)
    expect(w.text).toMatch(/UPDATE game_evaluations ge SET/)
    expect(w.text).toMatch(/FROM old WHERE ge\.id = old\.id/)
    expect(w.binds).toEqual(expect.arrayContaining(['Alice', 'evaluator', 'panel', 'evaluate', 42]))
  })

  it('casts every INSERT parameter (postgres.js sends numbers untyped)', async () => {
    routeSql()
    await patch({ id: 1, initial_note: 'a real note here', view_s: 5, context: 'evaluate' })
    const t = writeCall().text
    expect(t).toMatch(/\$::text, \$::text, old\.initial_evaluator, \$::text, \$::text/)
    expect(t).toMatch(/\$::int, \$::int, \$::int\s+FROM old JOIN upd/)
  })

  it('logs a save without view_s as source "other" with no timing', async () => {
    routeSql()
    await patch({ id: 1, game_alike: [] })
    const b = writeCall().binds
    expect(b).toContain('other')
    expect(b[b.indexOf('other') + 1]).toBeNull()   // context
    expect(b.slice(-3)).toEqual([null, null, null]) // view_s, hidden_s, idle_s
  })

  it('moves evaluate_date only for the owner, an unjudged game, no actor, or a List_Idea batch stamp', async () => {
    routeSql()
    await patch({ id: 1, initial_conclusion: 'Bypass', initial_note: 'a real note here' })
    const t = writeCall().text
    expect(t).toMatch(/lower\(ge\.initial_evaluator\) = lower\(\$::text\)/)
    expect(t).toMatch(/OR ge\.evaluate_date IS NULL/)
    expect(t).toMatch(/= 'List_Idea'/)
    // every right-hand side is ge.-qualified (an unqualified one is ambiguous under FROM old)
    expect(t).not.toMatch(/ELSE (?!ge\.)[a-z_]+\s+END/)
    expect(t).not.toMatch(/COALESCE\(\$, (?!ge\.)[a-z_]+\)/)
  })

  it('returns a readable error when migration 045 is missing', async () => {
    routeSql()
    sqlMock.mockImplementation((strings: unknown) => {
      if (Array.isArray(strings) && /INSERT INTO evaluation_log/.test((strings as string[]).join(' '))) {
        return Promise.reject(Object.assign(new Error('relation "evaluation_log" does not exist'), { code: '42P01' }))
      }
      return Promise.resolve([{ id: 1, initial_evaluator: 'Alice', initial_conclusion: null }])
    })
    const res = await patch({ id: 1, initial_note: 'a real note here', view_s: 5 })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/apply migration 045/)
  })
})
