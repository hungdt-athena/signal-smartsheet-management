/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => {
  const fn = jest.fn() as jest.Mock & { begin: jest.Mock }
  fn.begin = jest.fn((cb: (t: unknown) => unknown) => Promise.resolve(cb(fn)))
  return { sql: fn }
})
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))

import { POST } from '@/app/api/evaluations/store-dead/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as unknown as jest.Mock
let calls: { text: string; binds: unknown[] }[] = []
let locked: Record<string, unknown>[]

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/evaluations/store-dead', {
  method: 'POST', body: JSON.stringify(body),
} as never))

describe('POST /api/evaluations/store-dead', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => {
    calls = []
    locked = [
      { id: 1, initial_evaluator: 'Alice', initial_conclusion: null, pair_eval_id: 2 },
      { id: 2, initial_evaluator: 'Bob', initial_conclusion: null, pair_eval_id: 1 },
    ]
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Alice' } })
    sqlMock.mockReset()
    sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
      if (!Array.isArray(strings)) return { frag: true }
      const text = (strings as string[]).join('$')
      calls.push({ text, binds })
      if (/FOR UPDATE/.test(text)) return Promise.resolve(locked)
      return Promise.resolve([{ id: 1, initial_conclusion: 'Link_dead' }])
    })
  })

  it('401 without a session', async () => {
    sessionMock.mockResolvedValue(null)
    expect((await post({ id: 1, dead: true })).status).toBe(401)
  })

  it('403 for an evaluator who holds neither row', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Carol' } })
    expect((await post({ id: 1, dead: true })).status).toBe(403)
    expect(calls.some((c) => /UPDATE game_evaluations/.test(c.text))).toBe(false)
  })

  it('the holder of the OTHER row may toggle this store', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'bob' } })
    expect((await post({ id: 1, dead: true })).status).toBe(200)
  })

  it('a manager may toggle any store', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'moderator', name: 'Mod' } })
    expect((await post({ id: 1, dead: true })).status).toBe(200)
  })

  it('dead=true writes Link_dead, a store-scoped log, after the pair lock', async () => {
    const res = await post({ id: 1, dead: true, view_s: 3, context: 'evaluate' })
    expect(res.status).toBe(200)
    const lockAt = calls.findIndex((c) => /ORDER BY id FOR UPDATE/.test(c.text))
    const updAt = calls.findIndex((c) => /UPDATE game_evaluations ge SET/.test(c.text))
    expect(lockAt).toBeGreaterThanOrEqual(0)
    expect(updAt).toBeGreaterThan(lockAt)
    expect(calls[updAt].binds).toContain('Link_dead')
    // the log is written AFTER the update, from a re-read of the row (post-trigger state)
    const logAt = calls.findIndex((c) => /INSERT INTO evaluation_log/.test(c.text))
    expect(logAt).toBeGreaterThan(updAt)
    const u = calls[logAt]
    expect(u.text).toMatch(/upd AS \(\s*SELECT \* FROM game_evaluations WHERE id = \$/)
    expect(u.text).not.toMatch(/UPDATE game_evaluations/)
    expect(u.text).toMatch(/old\.batch, upd\.batch, 'store'/)
    expect((await res.json()).data.id).toBe(1)
  })

  it('dead=false on a store that is not Link_dead is a 400', async () => {
    expect((await post({ id: 1, dead: false })).status).toBe(400)
    expect(calls.some((c) => /UPDATE game_evaluations/.test(c.text))).toBe(false)
  })

  it('dead=false on a Link_dead store clears the conclusion', async () => {
    locked[0].initial_conclusion = 'Link_dead'
    expect((await post({ id: 1, dead: false })).status).toBe(200)
    const u = calls.find((c) => /UPDATE game_evaluations ge SET/.test(c.text))!
    expect(u.binds).toContain(null)
    expect(u.binds).not.toContain('Link_dead')
    expect(u.text).toMatch(/evaluate_date = \$/)
  })

  it('400 on a missing id or a non-boolean dead; 404 when the row is gone', async () => {
    expect((await post({ dead: true })).status).toBe(400)
    expect((await post({ id: 1, dead: 'yes' })).status).toBe(400)
    locked = []
    expect((await post({ id: 1, dead: true })).status).toBe(404)
  })
})
