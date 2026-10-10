/**
 * @jest-environment node
 */
// GET /api/external/effort-sessions — the Effort Tracker's read-only feed.
// Pinned: the API key gate, the date contract, the hybrid person filter
// (all freelancers by default, any one person by employee_id), the grouping, and
// which record assignments count (confirmed only, dated by assignment).
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { GET } from '@/app/api/external/effort-sessions/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock
const KEY = 'test-key-123'

let queries: { text: string; binds: unknown[] }[] = []
function setupSql(people: unknown[], rows: unknown[] = [], records: unknown[] = []) {
  queries = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    const text = (strings as string[]).join(' ')
    // A fragment nested inside the people query: hand back a marker, not a promise.
    if (!/SELECT/.test(text)) return { fragment: text, binds }
    queries.push({ text, binds })
    if (text.includes('FROM dashboard_users')) return Promise.resolve(people)
    if (text.includes('record_confirmed_at')) return Promise.resolve(records)
    return Promise.resolve(rows)
  })
}

function get(qs: string, key: string | null = KEY) {
  const headers: Record<string, string> = key ? { 'x-api-key': key } : {}
  return GET(new NextRequest(`http://localhost/api/external/effort-sessions?${qs}`, { headers }))
}

describe('GET /api/external/effort-sessions', () => {
  const realKey = process.env.EFFORT_TRACKER_API_KEY
  beforeAll(() => { process.env.EFFORT_TRACKER_API_KEY = KEY })
  afterAll(() => { process.env.EFFORT_TRACKER_API_KEY = realKey })

  it('refuses a missing or wrong key', async () => {
    setupSql([])
    expect((await get('from=2026-09-01&to=2026-09-02', null)).status).toBe(401)
    expect((await get('from=2026-09-01&to=2026-09-02', 'nope')).status).toBe(401)
    expect(queries).toHaveLength(0)
  })

  it('stays closed when the env key is unset', async () => {
    process.env.EFFORT_TRACKER_API_KEY = ''
    setupSql([])
    expect((await get('from=2026-09-01&to=2026-09-02', '')).status).toBe(401)
    process.env.EFFORT_TRACKER_API_KEY = KEY
  })

  it.each([
    ['', 'missing dates'],
    ['from=2026-09-01', 'missing to'],
    ['from=2026-02-30&to=2026-03-01', 'impossible date'],
    ['from=2026-09-05&to=2026-09-01', 'from after to'],
    ['from=2026-01-01&to=2026-03-05', 'over 62 days'],
    ['from=2026-09-01&to=2026-09-02&employee_id=a%27b', 'bad employee_id'],
  ])('400 on %s (%s)', async (qs) => {
    setupSql([])
    expect((await get(qs)).status).toBe(400)
  })

  it('accepts exactly 62 days', async () => {
    setupSql([])
    expect((await get('from=2026-09-01&to=2026-11-01')).status).toBe(200)
  })

  it('without employee_id, filters to freelancers', async () => {
    setupSql([])
    await get('from=2026-09-01&to=2026-09-02')
    const peopleQ = queries[0]
    const frag = peopleQ.binds.find(b => (b as { fragment?: string })?.fragment) as { fragment: string }
    expect(frag.fragment).toContain("lower(title) = 'freelancer'")
  })

  it('with employee_id, looks up that person regardless of title', async () => {
    setupSql([{ employee_id: 'abc', name: 'AbcXY' }])
    await get('from=2026-09-01&to=2026-09-02&employee_id=ABC')
    const frag = queries[0].binds.find(b => (b as { fragment?: string })?.fragment) as { fragment: string; binds: unknown[] }
    expect(frag.fragment).toContain("split_part(email, '@', 1)")
    expect(frag.fragment).not.toContain('freelancer')
    expect(frag.binds).toEqual(['abc'])
  })

  it('404 when employee_id matches nobody', async () => {
    setupSql([])
    expect((await get('from=2026-09-01&to=2026-09-02&employee_id=ghost')).status).toBe(404)
  })

  it('excludes Shortcut from the people lookup', async () => {
    setupSql([])
    await get('from=2026-09-01&to=2026-09-02')
    expect(queries[0].binds).toContainEqual(['shortcut'])
  })

  it('groups events per person and per day, keeping people with no work', async () => {
    setupSql(
      [{ employee_id: 'abc', name: 'AbcXY' }, { employee_id: 'idle', name: 'Idle' }],
      [
        { evaluator_key: 'abcxy', date: '2026-09-01', time: '09:00:00', game_id: 'g1', game: 'G1', genre: 'puzzle', status: 'Bypass', comment: 'meh game here' },
        { evaluator_key: 'abcxy', date: '2026-09-01', time: '09:05:00', game_id: 'g2', game: 'G2', genre: 'puzzle', status: 'List_Idea', comment: 'good core loop' },
        { evaluator_key: 'abcxy', date: '2026-09-02', time: '10:00:00', game_id: 'g3', game: 'G3', genre: 'arcade', status: 'Bypass', comment: 'clone of X' },
      ],
    )
    const res = await get('from=2026-09-01&to=2026-09-02')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.timezone).toBe('Asia/Ho_Chi_Minh')
    expect(body.people).toHaveLength(2)
    const abc = body.people[0]
    expect(abc.employee_id).toBe('abc')
    expect(abc.days.map((d: { date: string }) => d.date)).toEqual(['2026-09-01', '2026-09-02'])
    expect(abc.days[0].sessions).toHaveLength(2)
    expect(abc.days[0].sessions[0]).toEqual({
      time: '09:00:00', game_id: 'g1', game: 'G1', genre: 'puzzle', status: 'Bypass', comment: 'meh game here',
    })
    expect(abc.days[0].records).toEqual([])
    expect(body.people[1]).toEqual({ employee_id: 'idle', name: 'Idle', days: [] })
  })

  it('skips the events query when there is nobody to report', async () => {
    setupSql([])
    const body = await (await get('from=2026-09-01&to=2026-09-02')).json()
    expect(body.people).toEqual([])
    expect(queries).toHaveLength(1) // no events or records query
  })

  it('puts record assignments on their own day, sorted with evaluation days', async () => {
    setupSql(
      [{ employee_id: 'abc', name: 'AbcXY' }],
      [{ evaluator_key: 'abcxy', date: '2026-09-03', time: '09:00:00', game_id: 'g1', game: 'G1', genre: 'puzzle', status: 'Bypass', comment: 'meh game here' }],
      [
        { assignee_key: 'abcxy', date: '2026-09-01', time: '14:00:00', game_id: 'g9', game: 'G9', genre: 'puzzle', duration_min: 20 },
        { assignee_key: 'abcxy', date: '2026-09-03', time: '10:00:00', game_id: 'g8', game: 'G8', genre: 'arcade', duration_min: 5 },
        { assignee_key: 'abcxy', date: '2026-09-03', time: '10:00:00', game_id: 'g8', game: 'G8', genre: 'arcade', duration_min: 20 },
      ],
    )
    const body = await (await get('from=2026-09-01&to=2026-09-03')).json()
    const days = body.people[0].days
    expect(days.map((d: { date: string }) => d.date)).toEqual(['2026-09-01', '2026-09-03'])
    expect(days[0]).toEqual({
      date: '2026-09-01', sessions: [],
      records: [{ time: '14:00:00', game_id: 'g9', game: 'G9', genre: 'puzzle', duration_min: 20 }],
    })
    expect(days[1].sessions).toHaveLength(1)
    expect(days[1].records.map((r: { duration_min: number }) => r.duration_min)).toEqual([5, 20])
  })

  it('counts only confirmed record assignments, filtered on the assignment date', async () => {
    setupSql([{ employee_id: 'abc', name: 'AbcXY' }])
    await get('from=2026-09-01&to=2026-09-03')
    const recQ = queries.find(q => q.text.includes('record_confirmed_at'))!
    expect(recQ.text).toMatch(/record_confirmed_at IS NOT NULL/)
    expect(recQ.text).toMatch(/slot\.assigned_at >=/)
    expect(recQ.text).not.toMatch(/youtube/)
  })
})
