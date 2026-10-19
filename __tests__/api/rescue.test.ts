/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

// The mock carries a `json` member because insertOperationRun() binds JSONB via
// sql.json() (migration 029). A bare jest.fn() would blow up on commit.
jest.mock('@/lib/db', () => {
  const fn = jest.fn() as jest.Mock & { json: jest.Mock }
  fn.json = jest.fn((v: unknown) => v)
  return { sql: fn }
})
jest.mock('next-auth', () => ({ getServerSession: jest.fn(() => Promise.resolve(null)) }))

import { GET, POST } from '@/app/api/operations/rescue/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

interface ScanRow {
  name: string
  game_platform?: string | null
  weight?: number | null
  today_available?: boolean
  pending?: number
  stale?: number
  movable?: number
  evaluated_recent?: number
}

// Routes the mock by query shape: the roster scan, then each source's stale-game pull
// (keyed by the evaluator name bound into the query), then writes.
function setupSql(opts: { scan: ScanRow[]; stale?: Record<string, Record<string, unknown>[]>; drop?: number[] }) {
  const scan = opts.scan.map(r => ({
    name: r.name,
    game_platform: r.game_platform ?? 'all',
    weight: r.weight ?? 100,
    today_available: r.today_available ?? true,
    pending: r.pending ?? 0,
    stale: r.stale ?? 0,
    movable: r.movable ?? 0,
    evaluated_recent: r.evaluated_recent ?? 0,
  }))
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    if (!(Array.isArray(strings) && 'raw' in strings)) return { __ids: strings } // sql(ids)
    const q = (strings as string[]).join(' ')
    if (q.includes('UPDATE game_evaluations')) {
      const ids = (binds.find(b => (b as { __ids?: number[] })?.__ids) as { __ids: number[] } | undefined)?.__ids ?? []
      return Promise.resolve(ids.filter(id => !(opts.drop ?? []).includes(id)).map(id => ({ id })))
    }
    if (q.includes('FROM evaluator_roster')) return Promise.resolve(scan)
    if (q.includes('JOIN game_info')) {
      // The pull query binds category, then the source name.
      const from = binds.find(b => typeof b === 'string' && b in (opts.stale ?? {})) as string | undefined
      return Promise.resolve(from ? (opts.stale?.[from] ?? []) : [])
    }
    return Promise.resolve([{ id: 1 }]) // UPDATE / INSERT / app_config
  })
}

function post(body: unknown) {
  return POST(new NextRequest('http://localhost/api/operations/rescue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

function get(qs: string) {
  return GET(new NextRequest(`http://localhost/api/operations/rescue?${qs}`))
}

function bindValues() {
  return sqlMock.mock.calls.flatMap(c => c.slice(1))
}

function joinedSql() {
  return sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? (c[0] as string[]).join(' ') : '')).join('\n')
}

// A roster with one clear source (Hung), one clear receiver (Minh), and three people
// who each fail a different gate.
const ROSTER: ScanRow[] = [
  { name: 'Hung', pending: 32, stale: 21, movable: 21, evaluated_recent: 6 },
  { name: 'Minh', pending: 9, evaluated_recent: 14 },
  { name: 'Tu', pending: 4, evaluated_recent: 0 }, // inactive
  { name: 'Khoa', pending: 7, stale: 2, movable: 2, evaluated_recent: 11 }, // own stale
  { name: 'Vy', pending: 3, evaluated_recent: 12, today_available: false }, // away
]
const HUNG_GAMES = [
  { id: 1, game_id: 'g1', os: 'ios', assigned_date: '2026-07-01' },
  { id: 2, game_id: 'g2', os: 'android', assigned_date: '2026-07-02' },
]

describe('POST /api/operations/rescue', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('rejects an unknown action and an invalid category', async () => {
    setupSql({ scan: [] })
    expect((await post({ action: 'nuke', category: 'puzzle' })).status).toBe(400)
    expect((await post({ action: 'scan', category: 'rpg' })).status).toBe(400)
  })

  it('scan classifies the roster and never touches game state', async () => {
    setupSql({ scan: ROSTER })
    const json = await (await post({ action: 'scan', category: 'puzzle' })).json()
    const role = Object.fromEntries(json.rows.map((r: { name: string; role: string }) => [r.name, r.role]))
    expect(role).toEqual({ Hung: 'source', Minh: 'receiver', Tu: 'neutral', Khoa: 'neutral', Vy: 'neutral' })
    expect(joinedSql()).not.toContain('UPDATE game_evaluations')
  })

  it('scan persists the thresholds it ran with', async () => {
    setupSql({ scan: ROSTER })
    await post({ action: 'scan', category: 'puzzle', config: { staleDays: 10 } })
    expect(joinedSql()).toContain('INSERT INTO app_config')
  })

  it('preview distributes the source pool to eligible receivers without writing', async () => {
    setupSql({ scan: ROSTER, stale: { Hung: HUNG_GAMES } })
    const json = await (await post({
      action: 'preview', category: 'puzzle', sources: ['Hung'], receivers: ['Minh'],
    })).json()
    expect(json.dryRun).toBe(true)
    expect(json.candidate_count).toBe(2)
    expect(json.per_evaluator).toEqual({ Minh: 2 })
    expect(json.per_source).toEqual([{ from: 'Hung', pulled: 2, per_evaluator: { Minh: 2 } }])
    expect(joinedSql()).not.toContain('UPDATE game_evaluations')
  })

  it('ignores a stale client pick that is no longer eligible', async () => {
    // The browser still thinks Khoa can receive; the fresh scan says otherwise.
    setupSql({ scan: ROSTER, stale: { Hung: HUNG_GAMES } })
    const json = await (await post({
      action: 'preview', category: 'puzzle', sources: ['Hung'], receivers: ['Khoa'],
    })).json()
    expect(json.reason).toBe('no_receivers')
    expect(json.candidate_count).toBe(0)
  })

  it('refuses to move anything when nobody passes the receiver gate', async () => {
    setupSql({ scan: ROSTER.filter(r => r.name !== 'Minh'), stale: { Hung: HUNG_GAMES } })
    const json = await (await post({ action: 'commit', category: 'puzzle' })).json()
    expect(json.reason).toBe('no_receivers')
    expect(joinedSql()).not.toContain('UPDATE game_evaluations')
  })

  it('reports no_sources when no backlog is deep enough', async () => {
    setupSql({ scan: ROSTER.filter(r => r.name !== 'Hung') })
    const json = await (await post({ action: 'commit', category: 'puzzle' })).json()
    expect(json.reason).toBe('no_sources')
    expect(joinedSql()).not.toContain('UPDATE game_evaluations')
  })

  it('pools several sources and splits them across receivers by remaining backlog', async () => {
    setupSql({
      scan: [
        { name: 'Hung', pending: 20, stale: 2, movable: 2, evaluated_recent: 5 },
        { name: 'Lan', pending: 18, stale: 2, movable: 2, evaluated_recent: 9 },
        { name: 'Minh', pending: 0, evaluated_recent: 14 }, // empty shelf → takes more
        { name: 'An', pending: 3, evaluated_recent: 8 },
      ],
      stale: {
        Hung: HUNG_GAMES,
        Lan: [
          { id: 3, game_id: 'g3', os: 'ios', assigned_date: '2026-07-03' },
          { id: 4, game_id: 'g4', os: 'android', assigned_date: '2026-07-04' },
        ],
      },
    })
    const json = await (await post({ action: 'preview', category: 'puzzle' })).json()
    expect(json.candidate_count).toBe(4)
    // Minh starts 3 games lighter, so water-filling sends more games their way.
    expect(json.quotas.Minh).toBeGreaterThan(json.quotas.An ?? 0)
    expect(Object.values(json.quotas as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(4)
    expect(json.per_source.map((s: { from: string }) => s.from).sort()).toEqual(['Hung', 'Lan'])
  })

  it('commit moves the games and logs to both audit trails', async () => {
    setupSql({ scan: ROSTER, stale: { Hung: HUNG_GAMES } })
    const json = await (await post({
      action: 'commit', category: 'puzzle', sources: ['Hung'], receivers: ['Minh'],
    })).json()
    expect(json.dryRun).toBe(false)
    expect(json.assigned).toBe(2)
    const q = joinedSql()
    expect(q).toContain('UPDATE game_evaluations')
    // The movement is recorded as a plain reassign so it shows in the Assign tab...
    expect(q).toContain('INSERT INTO assignment_history')
    // ...while the run itself is a rescue, for the Rescue tab's own history.
    expect(q).toContain('INSERT INTO operation_runs')
    const kinds = sqlMock.mock.calls.flatMap(c => c.slice(1)).filter(v => v === 'rescue')
    expect(kinds.length).toBeGreaterThan(0)
    const actions = sqlMock.mock.calls.flatMap(c => c.slice(1)).filter(v => v === 'reassign')
    expect(actions.length).toBeGreaterThan(0)
  })

  it('commit counts only games the UPDATE moved', async () => {
    setupSql({ scan: ROSTER, stale: { Hung: HUNG_GAMES }, drop: [2] })
    const json = await (await post({ action: 'commit', category: 'puzzle', sources: ['Hung'], receivers: ['Minh'] })).json()
    expect(json.assigned).toBe(1)
    const histBinds = sqlMock.mock.calls
      .filter(c => Array.isArray(c[0]) && (c[0] as string[]).join(' ').includes('INSERT INTO assignment_history'))
      .flatMap(c => c.slice(1))
    expect(JSON.stringify(histBinds)).toContain('g1')
    expect(JSON.stringify(histBinds)).not.toContain('g2')
  })
})

// The assigned-date range is a view selector: it scopes the scan and the pull, travels in
// the request, is echoed on EVERY JSON response and is never persisted as a threshold.
describe('/api/operations/rescue assigned-date range', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  const RANGE = { from: '2026-10-06', to: '2026-10-13' }

  it('GET without a range echoes null', async () => {
    setupSql({ scan: ROSTER })
    const res = await get('category=puzzle')
    expect(res.status).toBe(200)
    expect((await res.json()).range).toBeNull()
  })

  it('GET with a range scans inside it and echoes it', async () => {
    setupSql({ scan: ROSTER })
    const res = await get('category=puzzle&assignedFrom=2026-10-06&assignedTo=2026-10-13')
    expect(res.status).toBe(200)
    expect((await res.json()).range).toEqual(RANGE)
    expect(bindValues()).toEqual(expect.arrayContaining(['2026-10-06', '2026-10-13']))
  })

  it('GET with a malformed range is 400, not the whole backlog', async () => {
    setupSql({ scan: ROSTER })
    const res = await get('category=puzzle&assignedFrom=yesterday')
    expect(res.status).toBe(400)
    expect(sqlMock).not.toHaveBeenCalled()
  })

  it('POST scan with an inverted range is 400 and never saves the config', async () => {
    setupSql({ scan: ROSTER })
    const res = await post({ action: 'scan', category: 'puzzle', range: { from: '2026-10-13', to: '2026-10-06' } })
    expect(res.status).toBe(400)
    expect(sqlMock).not.toHaveBeenCalled()
  })

  it('POST with a range that is not an object of day strings is 400, not "no range"', async () => {
    for (const range of ['2026-10-06', 5, true, [1], { from: 20261006 }, { to: ['2026-10-13'] }]) {
      setupSql({ scan: ROSTER })
      const res = await post({ action: 'scan', category: 'puzzle', range })
      expect(res.status).toBe(400)
      expect(sqlMock).not.toHaveBeenCalled()
    }
  })

  it('POST scan echoes the range, or null when there is none', async () => {
    setupSql({ scan: ROSTER })
    const withRange = await post({ action: 'scan', category: 'puzzle', range: RANGE })
    expect(withRange.status).toBe(200)
    expect((await withRange.json()).range).toEqual(RANGE)
    setupSql({ scan: ROSTER })
    expect((await (await post({ action: 'scan', category: 'puzzle' })).json()).range).toBeNull()
  })

  it('POST accepts a half-open range', async () => {
    setupSql({ scan: ROSTER })
    const json = await (await post({ action: 'scan', category: 'puzzle', range: { from: '2026-10-06' } })).json()
    expect(json.range).toEqual({ from: '2026-10-06', to: null })
  })

  it('the early-return reasons carry the range', async () => {
    setupSql({ scan: ROSTER.filter(r => r.name !== 'Hung') })
    const noSources = await (await post({ action: 'preview', category: 'puzzle', range: RANGE })).json()
    expect(noSources.reason).toBe('no_sources')
    expect(noSources.range).toEqual(RANGE)

    setupSql({ scan: ROSTER.filter(r => r.name !== 'Minh') })
    const noReceivers = await (await post({ action: 'preview', category: 'puzzle', range: RANGE })).json()
    expect(noReceivers.reason).toBe('no_receivers')
    expect(noReceivers.range).toEqual(RANGE)

    setupSql({ scan: ROSTER, stale: { Hung: [] } })
    const noGames = await (await post({
      action: 'preview', category: 'puzzle', sources: ['Hung'], receivers: ['Minh'], range: RANGE,
    })).json()
    expect(noGames.reason).toBe('no_stale_games')
    expect(noGames.range).toEqual(RANGE)
  })

  it('preview pulls inside the range and echoes it', async () => {
    setupSql({ scan: ROSTER, stale: { Hung: HUNG_GAMES } })
    const json = await (await post({
      action: 'preview', category: 'puzzle', sources: ['Hung'], receivers: ['Minh'], range: RANGE,
    })).json()
    expect(json.range).toEqual(RANGE)
    // The range reaches SQL as a fragment (a nested sql`` call) once per query: the two
    // roster-scan queries and the stale-game pull, so at least three of each bound.
    const frag = (op: string, day: string) => sqlMock.mock.calls.filter(c =>
      Array.isArray(c[0]) && (c[0] as string[]).join(' ').includes(`ge.assigned_date ${op}`) && c[1] === day)
    expect(frag('>=', '2026-10-06').length).toBeGreaterThanOrEqual(3)
    expect(frag('<', '2026-10-13').length).toBeGreaterThanOrEqual(3)
  })

  it('commit echoes the range and records it on the operation run', async () => {
    setupSql({ scan: ROSTER, stale: { Hung: HUNG_GAMES } })
    const json = await (await post({
      action: 'commit', category: 'puzzle', sources: ['Hung'], receivers: ['Minh'], range: RANGE,
    })).json()
    expect(json.dryRun).toBe(false)
    expect(json.range).toEqual(RANGE)
    expect(bindValues()).toEqual(expect.arrayContaining([
      expect.objectContaining({ assigned_from: '2026-10-06', assigned_to: '2026-10-13' }),
    ]))
  })

  it('commit without a range records null bounds', async () => {
    setupSql({ scan: ROSTER, stale: { Hung: HUNG_GAMES } })
    const json = await (await post({
      action: 'commit', category: 'puzzle', sources: ['Hung'], receivers: ['Minh'],
    })).json()
    expect(json.range).toBeNull()
    expect(bindValues()).toEqual(expect.arrayContaining([
      expect.objectContaining({ assigned_from: null, assigned_to: null }),
    ]))
  })
})
