/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn(() => Promise.resolve(null)) }))

import { POST } from '@/app/api/operations/handover/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

function setupSql({ candidates = [] as Record<string, unknown>[], roster = [] as Record<string, unknown>[] }) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('initial_conclusion IS NULL')) return Promise.resolve(candidates)
    if (q.includes('FROM evaluator_roster')) return Promise.resolve(roster)
    return Promise.resolve([])
  })
}

function post(body: unknown) {
  return POST(new NextRequest('http://localhost/api/operations/handover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

function joinedSql() {
  return sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? (c[0] as string[]).join(' ') : '')).join('\n')
}

describe('POST /api/operations/handover', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('requires start_date and end_date', async () => {
    setupSql({})
    const res = await post({ evaluator_name: 'Nam', category: 'puzzle' })
    expect(res.status).toBe(400)
  })

  it('preview redistributes to available roster without writing', async () => {
    setupSql({
      candidates: [{ id: 1, game_id: 'g1', os: 'ios' }, { id: 2, game_id: 'g2', os: 'android' }],
      roster: [{ name: 'A', game_platform: 'all', weight: 100 }, { name: 'B', game_platform: 'all', weight: 100 }],
    })
    const res = await post({ evaluator_name: 'Nam', category: 'puzzle', start_date: '2026-06-01', end_date: '2026-06-30', dryRun: true })
    const json = await res.json()
    expect(json.dryRun).toBe(true)
    expect(json.candidate_count).toBe(2)
    expect(json.per_evaluator).toEqual({ A: 1, B: 1 })
    expect(joinedSql()).not.toContain('UPDATE game_evaluations')
  })

  it('commit reassigns, logs handover_requests and writes history', async () => {
    setupSql({
      candidates: [{ id: 1, game_id: 'g1', os: 'ios' }, { id: 2, game_id: 'g2', os: 'android' }],
      roster: [{ name: 'A', game_platform: 'all', weight: 100 }, { name: 'B', game_platform: 'all', weight: 100 }],
    })
    const res = await post({ evaluator_name: 'Nam', category: 'puzzle', start_date: '2026-06-01', end_date: '2026-06-30' })
    const json = await res.json()
    expect(json.assigned).toBe(2)
    const q = joinedSql()
    expect(q).toContain('UPDATE game_evaluations')
    expect(q).toContain('INSERT INTO handover_requests')
    expect(q).toContain('INSERT INTO assignment_history')
  })

  it('returns candidate_count 0 when the source has no pending games', async () => {
    setupSql({ candidates: [], roster: [{ name: 'A', game_platform: 'all', weight: 100 }] })
    const res = await post({ evaluator_name: 'Nam', category: 'puzzle', start_date: '2026-06-01', end_date: '2026-06-30' })
    const json = await res.json()
    expect(json.candidate_count).toBe(0)
    expect(joinedSql()).not.toContain('UPDATE game_evaluations')
  })
})
