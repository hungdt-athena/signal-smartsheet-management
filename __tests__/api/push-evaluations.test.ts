/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))

import { POST } from '@/app/api/cron/push-evaluations/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'

const sessionMock = getServerSession as jest.Mock

const sqlMock = sql as unknown as jest.Mock

// Every genre is on and staffed unless a test says otherwise, so the existing
// push assertions read the same as before the gate was added.
function setupSql({
  config = '{"puzzle":true,"arcade":true,"simulation":true}' as string | null,
  roster = [
    { category_group: 'puzzle', available: '5' },
    { category_group: 'arcade', available: '5' },
    { category_group: 'simulation', available: '5' },
  ] as Record<string, unknown>[],
  pushed = [] as Record<string, unknown>[],
  // The per-genre push window, read from the same app_config table as the genre
  // toggles — so the mock has to branch on the KEY, not on the SQL text.
  pushWindow = null as string | null,
} = {}) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...values: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('FROM app_config')) {
      const blob = values[0] === 'push_window_config' ? pushWindow : config
      return Promise.resolve(blob === null ? [] : [{ value: blob }])
    }
    if (q.includes('FROM evaluator_roster')) return Promise.resolve(roster)
    if (q.includes('FROM category_mappings')) return Promise.resolve([{ genre: 'puzzle' }])
    return Promise.resolve(pushed)
  })
}

const queries = () => sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? c[0].join(' ') : '')).join('\n')

function post(body: unknown, secret = 's3cret') {
  return POST(new NextRequest('http://localhost/api/cron/push-evaluations', {
    method: 'POST',
    headers: { 'x-webhook-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('POST /api/cron/push-evaluations', () => {
  const realSecret = process.env.WEBHOOK_SECRET
  beforeAll(() => { process.env.WEBHOOK_SECRET = 's3cret'; process.env.SKIP_AUTH = 'false' })
  afterAll(() => { process.env.WEBHOOK_SECRET = realSecret })
  beforeEach(() => { setupSql(); sessionMock.mockResolvedValue(null) })

  it('rejects a wrong secret with 401', async () => {
    const res = await post({ category: 'puzzle', categories: ['puzzle'] }, 'wrong')
    expect(res.status).toBe(401)
  })

  it('rejects an unknown category with 400', async () => {
    const res = await post({ category: 'rpg', categories: ['rpg'] })
    expect(res.status).toBe(400)
  })

  it('rejects an empty categories list with 400', async () => {
    setupSql({ config: '{"puzzle":true}' })
    sqlMock.mockImplementation((strings: unknown) => {
      const q = Array.isArray(strings) ? (strings as string[]).join(' ') : ''
      if (q.includes('FROM app_config')) return Promise.resolve([{ value: '{"puzzle":true}' }])
      if (q.includes('FROM evaluator_roster')) return Promise.resolve([{ category_group: 'puzzle', available: '5' }])
      return Promise.resolve([])
    })
    const res = await post({ category: 'puzzle', categories: [] })
    expect(res.status).toBe(400)
  })

  it('inserts and returns the pushed game ids', async () => {
    setupSql({ pushed: [{ game_id: 'g1' }, { game_id: 'g2' }] })
    const res = await post({ category: 'puzzle', categories: ['puzzle', 'word'] })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.pushed).toBe(2)
    expect(json.game_ids).toEqual(['g1', 'g2'])
    const q = queries()
    expect(q).toContain('INSERT INTO game_evaluations')
    expect(q).toContain('ON CONFLICT (game_id, category_group) DO NOTHING')
    expect(q).toContain("|| ' days')::interval")
  })

  it('copies the genres from game_info metadata into the new row', async () => {
    setupSql({ pushed: [{ game_id: 'g1' }] })
    await post({ category: 'puzzle', categories: ['puzzle'] })
    const q = queries()
    expect(q).toContain('INSERT INTO game_evaluations (game_id, category_group, genre_1, genre_2)')
    expect(q).toContain("gi.metadata -> 'categories' ->> 0")
    expect(q).toContain("gi.metadata -> 'categories' ->> 1")
  })

  it('dryRun selects without inserting', async () => {
    setupSql({ pushed: [{ game_id: 'g1' }] })
    const res = await post({ category: 'puzzle', categories: ['puzzle'], dryRun: true })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.dryRun).toBe(true)
    expect(json.pushed).toBe(1)
    expect(queries()).not.toContain('INSERT INTO game_evaluations')
  })

  // The release window is the whole filter now. A game that was released long ago
  // and merely got crawled today is back catalogue, not a new release: letting it
  // in through created_date is what flooded the queue with 2,876 games on
  // 2026-08-19. Games with no release date at all still get in on created_date,
  // because a brand-new store listing often has no date yet.
  describe('eligibility window', () => {
    it('admits games released inside the window, which defaults to 30 days', async () => {
      const res = await post({ category: 'puzzle', categories: ['puzzle'] })
      // The length is a bind parameter now, so the SQL text carries the shape
      // and the response carries the value.
      expect(queries()).toContain("|| ' days')::interval")
      expect((await res.json()).windowDays).toBe(30)
    })

    it('uses the window Config set for THAT genre', async () => {
      setupSql({ pushWindow: '{"puzzle":7,"arcade":14,"simulation":3}' })
      expect((await (await post({ category: 'puzzle', categories: ['puzzle'] })).json()).windowDays).toBe(7)
      setupSql({ pushWindow: '{"puzzle":7,"arcade":14,"simulation":3}' })
      expect((await (await post({ category: 'arcade', categories: ['arcade'] })).json()).windowDays).toBe(14)
    })

    it('falls back to 30 days when the stored window is junk', async () => {
      // This row must never be able to stop the daily push.
      setupSql({ pushWindow: '{"puzzle":45}' })
      expect((await (await post({ category: 'puzzle', categories: ['puzzle'] })).json()).windowDays).toBe(30)
    })

    it('only consults created_date for games with no release date', async () => {
      await post({ category: 'puzzle', categories: ['puzzle'] })
      const q = queries().replace(/\s+/g, ' ')
      expect(q).toContain('rel IS NULL AND gi.created_date BETWEEN')
    })

    it('no longer carries the 180-day back-catalogue cap it replaced', async () => {
      await post({ category: 'puzzle', categories: ['puzzle'] })
      expect(queries()).not.toContain("INTERVAL '180 days'")
    })

    it('applies the same window on the dryRun path', async () => {
      await post({ category: 'puzzle', categories: ['puzzle'], dryRun: true })
      const q = queries().replace(/\s+/g, ' ')
      expect(q).toContain('rel IS NULL AND gi.created_date BETWEEN')
      expect(q).not.toContain("INTERVAL '180 days'")
    })
  })

  describe('genre gate', () => {
    it('skips a genre whose toggle is off, without touching game_evaluations', async () => {
      setupSql({ config: '{"puzzle":true,"arcade":false,"simulation":false}' })
      const res = await post({ category: 'arcade', categories: ['arcade'] })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toMatchObject({ ok: true, category: 'arcade', pushed: 0, skipped: 'disabled' })
      expect(queries()).not.toContain('INSERT INTO game_evaluations')
    })

    it('skips a genre that is on but has nobody available today', async () => {
      setupSql({ roster: [{ category_group: 'arcade', available: '0' }] })
      const res = await post({ category: 'arcade', categories: ['arcade'] })
      expect(res.status).toBe(200)
      expect((await res.json()).skipped).toBe('no-evaluator')
      expect(queries()).not.toContain('INSERT INTO game_evaluations')
    })

    it('pushes a genre that is on and staffed', async () => {
      setupSql({ pushed: [{ game_id: 'g1' }] })
      const res = await post({ category: 'arcade', categories: ['arcade'] })
      const json = await res.json()
      expect(json.skipped).toBeUndefined()
      expect(json.pushed).toBe(1)
    })

    it('honours the gate on the dryRun path too', async () => {
      setupSql({ config: '{"arcade":false}' })
      const json = await (await post({ category: 'arcade', categories: ['arcade'], dryRun: true })).json()
      expect(json.skipped).toBe('disabled')
    })
  })

  // One game, one genre. category_mappings overlap (casual -> puzzle, action ->
  // arcade), so a Casual+Action game matches both. Deduping per genre gave it a row
  // in each, assigned to two people: arcade's first run on 2026-09-21 did that to
  // 436 games already in puzzle, and the Evaluate panel then opened the other
  // person's row. A row in ANY genre means the game is taken.
  describe('one game, one genre', () => {
    const dedupe = () => {
      const q = queries().replace(/\s+/g, ' ')
      const m = q.match(/NOT EXISTS \( SELECT 1 FROM game_evaluations ge WHERE ([^)]*)\)/g) || []
      return m
    }

    it('skips a game that already has a row in another genre (insert)', async () => {
      setupSql({ pushed: [] })
      await post({ category: 'arcade', categories: ['action'] })
      const clauses = dedupe()
      expect(clauses).toHaveLength(1)
      expect(clauses[0]).toContain('ge.game_id = gi.game_id')
      expect(clauses[0]).not.toContain('category_group')
    })

    it('skips it on the dryRun path too, so the count matches the push', async () => {
      setupSql({ pushed: [] })
      await post({ category: 'arcade', categories: ['action'], dryRun: true })
      const clauses = dedupe()
      expect(clauses).toHaveLength(1)
      expect(clauses[0]).not.toContain('category_group')
    })
  })
})
