/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { POST } from '@/app/api/cron/assign-evaluators/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sessionMock = getServerSession as jest.Mock

const sqlMock = sql as unknown as jest.Mock

function setupSql({
  roster = [] as Record<string, unknown>[],
  games = [] as Record<string, unknown>[],
  // Every genre on and staffed unless a test says otherwise, so the assignment
  // assertions read the same as before the gate was added.
  config = '{"puzzle":true,"arcade":true,"simulation":true}' as string | null,
  available = null as number | null,
}) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('FROM app_config')) return Promise.resolve(config === null ? [] : [{ value: config }])
    // The gate counts the roster; the assignment reads the rows themselves.
    if (q.includes('count(*) FILTER')) {
      const n = available === null ? roster.length : available
      return Promise.resolve([
        { category_group: 'puzzle', available: String(n) },
        { category_group: 'arcade', available: String(n) },
        { category_group: 'simulation', available: String(n) },
      ])
    }
    if (q.includes('FROM evaluator_roster')) return Promise.resolve(roster)
    if (q.includes('initial_evaluator IS NULL')) return Promise.resolve(games)
    return Promise.resolve([]) // UPDATEs
  })
}

function post(body: unknown, secret = 's3cret') {
  return POST(new NextRequest('http://localhost/api/cron/assign-evaluators', {
    method: 'POST',
    headers: { 'x-webhook-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('POST /api/cron/assign-evaluators', () => {
  const realSecret = process.env.WEBHOOK_SECRET
  beforeAll(() => { process.env.WEBHOOK_SECRET = 's3cret'; process.env.SKIP_AUTH = 'false' })
  afterAll(() => { process.env.WEBHOOK_SECRET = realSecret })
  beforeEach(() => { sessionMock.mockResolvedValue(null) })

  it('rejects a wrong secret with 401', async () => {
    setupSql({})
    const res = await post({ category: 'puzzle' }, 'wrong')
    expect(res.status).toBe(401)
  })

  it('returns ok with zero assignments when no unassigned games', async () => {
    setupSql({ roster: [{ name: 'A', game_platform: 'all', weight: 100 }], games: [] })
    const res = await post({ category: 'puzzle' })
    const json = await res.json()
    expect(json.assigned).toBe(0)
  })

  it('skips instead of failing when nobody is available for the genre', async () => {
    setupSql({ roster: [], games: [{ id: 1, os: 'ios' }] })
    const res = await post({ category: 'puzzle' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, assigned: 0, skipped: 'no-evaluator' })
    const q = sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? c[0].join(' ') : '')).join('\n')
    expect(q).not.toContain('UPDATE game_evaluations')
  })

  it('skips a genre whose toggle is off, even with games and people waiting', async () => {
    setupSql({
      config: '{"puzzle":true,"arcade":false,"simulation":false}',
      roster: [{ name: 'A', game_platform: 'all', weight: 100 }],
      games: [{ id: 1, game_id: 'g1', os: 'ios' }],
    })
    const res = await post({ category: 'arcade' })
    expect(res.status).toBe(200)
    expect((await res.json()).skipped).toBe('disabled')
    const q = sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? c[0].join(' ') : '')).join('\n')
    expect(q).not.toContain('UPDATE game_evaluations')
    expect(q).not.toContain('INSERT INTO assignment_history')
  })

  it('assigns a non-puzzle genre once it is toggled on and staffed', async () => {
    setupSql({
      config: '{"puzzle":false,"arcade":true,"simulation":false}',
      roster: [{ name: 'A', game_platform: 'all', weight: 100 }],
      games: [{ id: 1, game_id: 'g1', os: 'ios' }],
    })
    const json = await (await post({ category: 'arcade' })).json()
    expect(json.skipped).toBeUndefined()
    expect(json.assigned).toBe(1)
  })

  it('assigns games and reports per-evaluator counts', async () => {
    setupSql({
      roster: [
        { name: 'A', game_platform: 'all', weight: 100 },
        { name: 'B', game_platform: 'all', weight: 100 },
      ],
      games: [{ id: 1, game_id: 'g1', os: 'ios' }, { id: 2, game_id: 'g2', os: 'android' }, { id: 3, game_id: 'g3', os: 'ios' }, { id: 4, game_id: 'g4', os: 'ios' }],
    })
    const res = await post({ category: 'puzzle' })
    const json = await res.json()
    expect(json.assigned).toBe(4)
    expect(json.per_evaluator).toEqual({ A: 2, B: 2 })
    const q = sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? c[0].join(' ') : '')).join('\n')
    expect(q).toContain('UPDATE game_evaluations')
    expect(q).toContain('assigned_date')
    expect(q).toContain('INSERT INTO assignment_history')
  })

  it('rejects a null body with 400', async () => {
    setupSql({})
    const res = await POST(new NextRequest('http://localhost/api/cron/assign-evaluators', {
      method: 'POST',
      headers: { 'x-webhook-secret': 's3cret', 'content-type': 'application/json' },
      body: 'null',
    }))
    expect(res.status).toBe(400)
  })

  it('dryRun computes the split without updating', async () => {
    setupSql({
      roster: [{ name: 'A', game_platform: 'all', weight: 100 }],
      games: [{ id: 1, os: 'ios' }],
    })
    const res = await post({ category: 'puzzle', dryRun: true })
    const json = await res.json()
    expect(json.dryRun).toBe(true)
    expect(json.assigned).toBe(1)
    const q = sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? c[0].join(' ') : '')).join('\n')
    expect(q).not.toContain('UPDATE game_evaluations')
  })
})
