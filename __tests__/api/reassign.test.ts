/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => {
  const fn = jest.fn() as jest.Mock & { json: jest.Mock }
  fn.json = jest.fn((v: unknown) => v)
  return { sql: fn }
})
jest.mock('next-auth', () => ({ getServerSession: jest.fn(() => Promise.resolve(null)) }))

import { POST } from '@/app/api/operations/reassign/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

function setupSql({ candidates = [] as Record<string, unknown>[], roster = [] as Record<string, unknown>[], drop = [] as number[] }) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!(Array.isArray(strings) && 'raw' in strings)) return { __ids: strings } // sql(ids)
    const q = (strings as string[]).join(' ')
    if (q.includes('UPDATE game_evaluations')) {
      const ids = (binds.find(b => (b as { __ids?: number[] })?.__ids) as { __ids: number[] } | undefined)?.__ids ?? []
      return Promise.resolve(ids.filter(id => !drop.includes(id)).map(id => ({ id })))
    }
    if (q.includes('initial_conclusion IS NULL')) return Promise.resolve(candidates)
    if (q.includes('FROM evaluator_roster')) return Promise.resolve(roster)
    return Promise.resolve([{ id: 1 }]) // INSERT ... RETURNING id (operation_runs) / fragments
  })
}

function post(body: unknown) {
  return POST(new NextRequest('http://localhost/api/operations/reassign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

function joinedSql() {
  return sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? (c[0] as string[]).join(' ') : '')).join('\n')
}

describe('POST /api/operations/reassign', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('rejects an invalid category', async () => {
    setupSql({})
    const res = await post({ evaluator_name: 'Nam', category: 'rpg', count: 5 })
    expect(res.status).toBe(400)
  })

  it('rejects a missing evaluator_name', async () => {
    setupSql({})
    const res = await post({ category: 'puzzle', count: 5 })
    expect(res.status).toBe(400)
  })

  it('rejects when neither date range nor count is given', async () => {
    setupSql({})
    const res = await post({ evaluator_name: 'Nam', category: 'puzzle' })
    expect(res.status).toBe(400)
  })

  it('preview by count with no targets returns the candidate count only', async () => {
    setupSql({ candidates: [{ id: 1, game_id: 'g1', os: 'ios' }, { id: 2, game_id: 'g2', os: 'android' }, { id: 3, game_id: 'g3', os: 'ios' }] })
    const res = await post({ evaluator_name: 'Nam', category: 'puzzle', count: 10, dryRun: true })
    const json = await res.json()
    expect(json.dryRun).toBe(true)
    expect(json.candidate_count).toBe(3)
    expect(json.per_evaluator).toEqual({})
    expect(joinedSql()).not.toContain('UPDATE game_evaluations')
  })

  it('preview by date range with targets returns the distribution without writing', async () => {
    setupSql({
      candidates: [{ id: 1, game_id: 'g1', os: 'ios' }, { id: 2, game_id: 'g2', os: 'android' }],
      roster: [{ name: 'A', game_platform: 'all', weight: 100 }, { name: 'B', game_platform: 'all', weight: 100 }],
    })
    const res = await post({ evaluator_name: 'Nam', category: 'puzzle', start_date: '2026-06-01', end_date: '2026-06-30', selected_evaluators: ['A', 'B'], dryRun: true })
    const json = await res.json()
    expect(json.dryRun).toBe(true)
    expect(json.candidate_count).toBe(2)
    expect(json.per_evaluator).toEqual({ A: 1, B: 1 })
    expect(joinedSql()).not.toContain('UPDATE game_evaluations')
  })

  it('commit requires a non-empty selected_evaluators', async () => {
    setupSql({ candidates: [{ id: 1, game_id: 'g1', os: 'ios' }] })
    const res = await post({ evaluator_name: 'Nam', category: 'puzzle', count: 5 })
    expect(res.status).toBe(400)
  })

  it('commit reassigns, updates rows and writes history', async () => {
    setupSql({
      candidates: [{ id: 1, game_id: 'g1', os: 'ios' }, { id: 2, game_id: 'g2', os: 'android' }],
      roster: [{ name: 'A', game_platform: 'all', weight: 100 }, { name: 'B', game_platform: 'all', weight: 100 }],
    })
    const res = await post({ evaluator_name: 'Nam', category: 'puzzle', count: 5, selected_evaluators: ['A', 'B'] })
    const json = await res.json()
    expect(json.assigned).toBe(2)
    expect(json.per_evaluator).toEqual({ A: 1, B: 1 })
    const q = joinedSql()
    expect(q).toContain('UPDATE game_evaluations')
    expect(q).toContain('INSERT INTO assignment_history')
  })

  it('counts only games the UPDATE moved (one was judged meanwhile)', async () => {
    setupSql({
      candidates: [{ id: 1, game_id: 'g1', os: 'ios' }, { id: 2, game_id: 'g2', os: 'android' }],
      roster: [{ name: 'A', game_platform: 'all', weight: 100 }, { name: 'B', game_platform: 'all', weight: 100 }],
      drop: [2],
    })
    const json = await (await post({ evaluator_name: 'Nam', category: 'puzzle', count: 5, selected_evaluators: ['A', 'B'] })).json()
    expect(json.assigned).toBe(1)
    expect(Object.values(json.per_evaluator as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('excludes the source evaluator from the target set', async () => {
    setupSql({
      candidates: [{ id: 1, game_id: 'g1', os: 'ios' }, { id: 2, game_id: 'g2', os: 'ios' }],
      roster: [{ name: 'Nam', game_platform: 'all', weight: 100 }, { name: 'B', game_platform: 'all', weight: 100 }],
    })
    const res = await post({ evaluator_name: 'Nam', category: 'puzzle', count: 5, selected_evaluators: ['Nam', 'B'], dryRun: true })
    const json = await res.json()
    // Nam is the source → filtered out → everything goes to B.
    expect(json.per_evaluator).toEqual({ B: 2 })
  })
})
