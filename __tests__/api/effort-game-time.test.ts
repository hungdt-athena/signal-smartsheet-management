/**
 * @jest-environment node
 */
// GET /api/external/effort-game-time — panel time per game, for the Effort Tracker.
// Same key, date contract and Freelancer scope as effort-sessions (which stays as it is);
// what is pinned here is where the seconds come from and what is left out.
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { GET } from '@/app/api/external/effort-game-time/route'
import { sql } from '@/lib/db'
import { PANEL_CAP_S } from '@/lib/evaluation-hours'

const sqlMock = sql as unknown as jest.Mock
const KEY = 'test-key-123'

let queries: { text: string; binds: unknown[] }[] = []
function setupSql(people: unknown[], rows: unknown[] = [], records: unknown[] = []) {
  queries = []
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    const text = (strings as string[]).join(' ')
    if (!/SELECT/.test(text)) return { fragment: text, binds }
    queries.push({ text, binds })
    if (text.includes('FROM dashboard_users')) return Promise.resolve(people)
    if (text.includes('record_5min_confirmed_at')) return Promise.resolve(records)
    if (text.includes('FROM evaluation_log')) return Promise.resolve(rows)
    return Promise.resolve([])
  })
}

function get(qs: string, key: string | null = KEY) {
  const headers: Record<string, string> = key ? { 'x-api-key': key } : {}
  return GET(new NextRequest(`http://localhost/api/external/effort-game-time?${qs}`, { headers }))
}

describe('GET /api/external/effort-game-time', () => {
  const realKey = process.env.EFFORT_TRACKER_API_KEY
  beforeAll(() => { process.env.EFFORT_TRACKER_API_KEY = KEY })
  afterAll(() => { process.env.EFFORT_TRACKER_API_KEY = realKey })

  it('refuses a missing or wrong key, and stays closed when the env key is unset', async () => {
    setupSql([])
    expect((await get('from=2026-10-01&to=2026-10-02', null)).status).toBe(401)
    expect((await get('from=2026-10-01&to=2026-10-02', 'nope')).status).toBe(401)
    process.env.EFFORT_TRACKER_API_KEY = ''
    expect((await get('from=2026-10-01&to=2026-10-02', '')).status).toBe(401)
    process.env.EFFORT_TRACKER_API_KEY = KEY
    expect(queries).toHaveLength(0)
  })

  it.each([
    ['', 'missing dates'],
    ['from=2026-02-30&to=2026-03-01', 'impossible date'],
    ['from=2026-10-05&to=2026-10-01', 'from after to'],
    ['from=2026-01-01&to=2026-03-05', 'over 62 days'],
    ['from=2026-10-01&to=2026-10-02&employee_id=a%27b', 'bad employee_id'],
  ])('400 on %s (%s)', async (qs) => {
    setupSql([])
    expect((await get(qs)).status).toBe(400)
  })

  it('without employee_id, filters to freelancers and leaves out system accounts', async () => {
    setupSql([])
    await get('from=2026-10-01&to=2026-10-02')
    const frag = queries[0].binds.find(b => (b as { fragment?: string })?.fragment) as { fragment: string }
    expect(frag.fragment).toContain("lower(title) = 'freelancer'")
    expect(queries[0].binds).toContainEqual(['shortcut', 'pj202-backfill'])
  })

  it('with employee_id, looks up that person regardless of title; 404 when nobody matches', async () => {
    setupSql([{ employee_id: 'abc', name: 'AbcXY' }])
    await get('from=2026-10-01&to=2026-10-02&employee_id=ABC')
    const frag = queries[0].binds.find(b => (b as { fragment?: string })?.fragment) as { fragment: string; binds: unknown[] }
    expect(frag.fragment).not.toContain('freelancer')
    expect(frag.binds).toEqual(['abc'])
    setupSql([])
    expect((await get('from=2026-10-01&to=2026-10-02&employee_id=ghost')).status).toBe(404)
  })

  it('skips the log and record queries when there is nobody to report', async () => {
    setupSql([])
    const body = await (await get('from=2026-10-01&to=2026-10-02')).json()
    expect(body.people).toEqual([])
    expect(queries).toHaveLength(1)
  })

  it('returns games with only a duration, and records with the 5/20 counts', async () => {
    setupSql(
      [{ employee_id: 'huydd', name: 'HuyDD' }],
      [
        { person_key: 'huydd', date: '2026-10-26', game_id: 'g1', game: 'Color Sand Block', genre: 'puzzle', duration_s: 700 },
        { person_key: 'huydd', date: '2026-10-26', game_id: 'g2', game: 'Old game', genre: 'puzzle', duration_s: null },
      ],
      [{ assignee_key: 'huydd', date: '2026-10-26', time: '09:12:00', game_id: 'r1', game: 'R1', genre: 'puzzle', duration_min: 5 }],
    )
    const res = await get('from=2026-10-26&to=2026-10-26')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.timezone).toBe('Asia/Ho_Chi_Minh')
    expect(body.people[0].days[0]).toEqual({
      date: '2026-10-26',
      games: [
        { game_id: 'g1', game: 'Color Sand Block', genre: 'puzzle', duration_s: 700 },
        { game_id: 'g2', game: 'Old game', genre: 'puzzle', duration_s: null },
      ],
      records: [{ time: '09:12:00', game_id: 'r1', game: 'R1', genre: 'puzzle', duration_min: 5 }],
      records_5min: 1, records_20min: 0,
    })
  })

  describe('where the seconds come from', () => {
    const logQuery = async () => {
      setupSql([{ employee_id: 'abc', name: 'AbcXY' }])
      await get('from=2026-10-01&to=2026-10-02')
      return queries.find(q => q.text.includes('FROM evaluation_log'))!
    }

    it('sums measured panel saves only, each capped like the Hours tab', async () => {
      const q = await logQuery()
      expect(q.text).toMatch(/l\.source = 'panel'/)
      expect(q.text).toMatch(/l\.view_s IS NOT NULL/)
      expect(q.text).toMatch(/LEAST\(l\.view_s,/)
      expect(q.binds).toContain(PANEL_CAP_S)
    })

    it('adds a null-duration line for a game judged before the log existed (seed row)', async () => {
      const q = await logQuery()
      expect(q.text).toMatch(/l\.source = 'seed'/)
      expect(q.text).toMatch(/l\.kind = 'first'/)
      expect(q.text).toMatch(/lower\(l\.owner\)/)
      expect(q.text).toMatch(/count\(ev\.s\) = 0 THEN NULL/)
    })

    it('does not count saves outside the panel (add-to-record, Record tab, other) or the demo credit', async () => {
      const q = await logQuery()
      expect(q.text).not.toMatch(/add_to_record|record_tab|demo_added/)
    })

    it('joins the game row by evaluation id, not by game_id, so a game with two rows is not doubled', async () => {
      const q = await logQuery()
      expect(q.text).toMatch(/ge\.id = ev\.ge_id/)
      expect(q.text).not.toMatch(/ge\.game_id = /)
    })

    it('filters on the save time, as VN days, both ends included', async () => {
      const q = await logQuery()
      expect(q.text).toMatch(/l\.created_at >= \(/)
      expect(q.text).toMatch(/l\.created_at <\s+\(/)
      expect(q.binds).toContain('2026-10-01')
      expect(q.binds).toContain('2026-10-02')
    })
  })

  it('500 when the database fails', async () => {
    setupSql([{ employee_id: 'abc', name: 'AbcXY' }])
    sqlMock.mockImplementationOnce(() => Promise.resolve([{ employee_id: 'abc', name: 'AbcXY' }]))
    sqlMock.mockImplementation(() => Promise.reject(new Error('boom')))
    jest.spyOn(console, 'error').mockImplementation(() => {})
    expect((await get('from=2026-10-01&to=2026-10-02')).status).toBe(500)
  })
})
