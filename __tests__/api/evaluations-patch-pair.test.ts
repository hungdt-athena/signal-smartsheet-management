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
jest.mock('@/lib/config', () => ({ getConfigValues: jest.fn(async () => ['Bypass', 'List_Idea']) }))

import { PATCH } from '@/app/api/evaluations/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sqlMock = sql as unknown as jest.Mock
let calls: string[] = []

describe('PATCH /api/evaluations: linked pairs', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = undefined })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })
  beforeEach(() => {
    calls = []
    ;(getServerSession as unknown as jest.Mock).mockResolvedValue({ user: { role: 'admin', name: 'Boss' } })
    sqlMock.mockReset(); (sql as unknown as { begin: jest.Mock }).begin.mockClear()
    sqlMock.mockImplementation((strings: unknown) => {
      if (Array.isArray(strings)) calls.push((strings as string[]).join('$'))
      return Promise.resolve([{ id: 1, game_id: 'g1' }])
    })
  })
  const patch = (body: unknown) => PATCH(new NextRequest('http://localhost/api/evaluations', {
    method: 'PATCH', body: JSON.stringify(body),
  } as never))

  it('logs pair_scope: pair for a linked twin, store when either row is store-only', async () => {
    await patch({ id: 1, game_alike: [] })
    const t = calls.find((c) => /INSERT INTO evaluation_log/.test(c))!
    expect(t).toMatch(/view_s, hidden_s, idle_s, batch_before, batch_after, demo_added, pair_scope\)/)
    expect(t).toMatch(/upd\.pair_eval_id IS NOT NULL/)
    expect(t).toMatch(/upd\.initial_conclusion IS DISTINCT FROM 'Link_dead'/)
    expect(t).toMatch(/pr\.id = upd\.pair_eval_id[\s\S]*IN \('Link_dead', 'Stale_release'\)/)
    expect(t).toMatch(/THEN 'pair' ELSE 'store' END/)
  })

  it('locks both rows of the pair in id order before the UPDATE, in one transaction', async () => {
    await patch({ id: 1, game_alike: [] })
    expect(sqlMock.mock.calls.length).toBeGreaterThan(0)
    const lockAt = calls.findIndex((c) => /FROM game_evaluations\s+WHERE id IN \(\$, \(SELECT pair_eval_id FROM game_evaluations WHERE id = \$\)\)\s+ORDER BY id FOR UPDATE/.test(c))
    const updAt = calls.findIndex((c) => /UPDATE game_evaluations ge SET/.test(c))
    expect(lockAt).toBeGreaterThanOrEqual(0)
    expect(updAt).toBeGreaterThan(lockAt)
    expect((sql as unknown as { begin: jest.Mock }).begin).toHaveBeenCalledTimes(1)
  })
})
