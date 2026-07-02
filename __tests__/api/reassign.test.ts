/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn(() => Promise.resolve(null)) }))

import { POST } from '@/app/api/operations/reassign/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

function setupSql({ candidates = [] as Record<string, unknown>[], roster = [] as Record<string, unknown>[] }) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([]) // sql(ids) IN-clause
    const q = (strings as string[]).join(' ')
    if (q.includes('initial_conclusion IS NULL')) return Promise.resolve(candidates)
    if (q.includes('FROM evaluator_roster')) return Promise.resolve(roster)
    return Promise.resolve([]) // UPDATE / INSERT / fragments
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
