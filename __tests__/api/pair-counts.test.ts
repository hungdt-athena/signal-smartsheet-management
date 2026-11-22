/**
 * @jest-environment node
 */
// Task 6 (unified playtest): work counts count a linked pair once. Every query that reads
// `game_evaluations ge` to COUNT work carries notPairCopy (a back row that is only a copy is
// dropped; a back row holding Link_dead / Stale_release is real work and stays).
// The mock composes nested fragments into one text, so "this query has pair_back" is checked on
// the whole statement, not on a fragment next to it.
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => {
  type Frag = { __text: string; then: (a: (v: unknown) => unknown, b?: (e: unknown) => unknown) => Promise<unknown> }
  const mk = (text: string): Frag => ({
    __text: text,
    then: (a, b) => Promise.resolve(text.includes('FROM dashboard_users') && text.includes('employee_id')
      ? [{ employee_id: 'x', name: 'NhiLV' }] : []).then(a, b),
  })
  const render = (strings: readonly string[], binds: unknown[]) =>
    strings.reduce((acc, s, i) => {
      const b = i < binds.length ? binds[i] : undefined
      const t = b && typeof b === 'object' && '__text' in (b as object) ? (b as Frag).__text : (i < binds.length ? '?' : '')
      return acc + s + t
    }, '')
  const tag: any = jest.fn((strings: unknown, ...binds: unknown[]) => {
    if (typeof strings === 'string') return mk(strings)            // identifier: sql('ge')
    if (!Array.isArray(strings)) return mk('')
    return mk(render(strings as string[], binds))
  })
  tag.unsafe = jest.fn(() => mk(''))
  tag.json = jest.fn((x: unknown) => x)
  tag.begin = jest.fn(async (cb: (tx: unknown) => unknown) => cb(tag))
  return { sql: tag }
})
jest.mock('next-auth', () => ({ getServerSession: jest.fn(() => Promise.resolve(null)) }))
jest.mock('@/lib/auth-guard', () => ({
  requireAuth: jest.fn(() => Promise.resolve(null)),
  requireRole: jest.fn(() => Promise.resolve(null)),
  requireAdmin: jest.fn(() => Promise.resolve(null)),
  requireManager: jest.fn(() => Promise.resolve(null)),
}))
jest.mock('@/lib/session', () => ({ getSession: jest.fn(async () => ({ user: { name: 'KietCD', role: 'admin' } })) }))
jest.mock('@/lib/report-config-db', () => ({
  loadReportConfig: jest.fn(() => Promise.resolve({
    config: { excluded: [], weights: { Volume: 40, Consistency: 20, Signal: 20, Survival: 20 }, credibility: false },
    updatedAt: '2026-08-07T00:00:00Z',
  })),
}))
jest.mock('@/lib/rescue-config-db', () => ({
  loadRescueConfig: jest.fn(async () => ({ staleDays: 14, cooldownDays: 3, activeDays: 7 })),
}))
jest.mock('@/lib/push-window-db', () => ({ loadPushWindowConfig: jest.fn(async () => ({})) }))
jest.mock('@/lib/genre-config-db', () => ({ loadGenreTargets: jest.fn(async () => []) }))

import { sql } from '@/lib/db'
import { getSession } from '@/lib/session'
import { GET as quickStats } from '@/app/api/evaluations/quick-stats/route'
import { GET as report } from '@/app/api/report/route'
import { GET as reportDaily } from '@/app/api/report/daily/route'
import { POST as rollup } from '@/app/api/cron/report-rollup/route'
import { GET as pendingHolders } from '@/app/api/operations/pending-holders/route'
import { GET as assignPreview } from '@/app/api/assign-setup/preview/route'
import { GET as effortSessions } from '@/app/api/external/effort-sessions/route'
import { GET as effortGameTime } from '@/app/api/external/effort-game-time/route'
import { GET as configPeople } from '@/app/api/config/people/route'
import { GET as auditEvaluators } from '@/app/api/admin/users/audit-evaluators/route'
import { scanRoster } from '@/lib/rescue-core'

const sqlMock = sql as unknown as jest.Mock
const KEY = 'k'
const texts = () => sqlMock.mock.results
  .map(r => r.value as { __text?: string })
  .filter(v => v && typeof v.__text === 'string')
  .map(v => v.__text as string)
// statements (not fragments) that read game_evaluations as ge
const geQueries = () => texts().filter(t => /(FROM|JOIN) game_evaluations (ge|g2)\b/.test(t) && /SELECT/.test(t))
// every `FROM game_evaluations ge` read, minus the ones that deliberately do not count work
const mustCarry = (t: string) => !/NOT EXISTS \(\s*SELECT 1 FROM game_evaluations ge/.test(t)

// Recording counts (record slots) drop EVERY back row: media columns are copied onto a dead
// back row too, so the evaluation rule (notPairCopy) would count one recording twice.
const MEDIA = 'AND NOT ge.pair_back'
const EVAL = 'NOT (ge.pair_back'
function expectMedia(q: string) {
  expect(q).toContain(MEDIA)
  expect(q).not.toContain(EVAL)
}

function expectAllCarry(qs: string[]) {
  expect(qs.length).toBeGreaterThan(0)
  for (const q of qs) expect(q).toContain('pair_back')
}

beforeAll(() => {
  process.env.SKIP_AUTH = 'true'
  process.env.EFFORT_TRACKER_API_KEY = KEY
  process.env.WEBHOOK_SECRET = 's'
})
beforeEach(() => sqlMock.mockClear())

const req = (u: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://localhost${u}`, init)

describe('work counts drop the copy row of a linked pair', () => {
  it('quick stats: totals, conclusions and platforms', async () => {
    await quickStats(req('/api/evaluations/quick-stats?category=puzzle'))
    const qs = geQueries()
    expect(qs).toHaveLength(3)
    expectAllCarry(qs)
  })

  it('quick stats keeps the evaluator condition next to the pair condition (Review Focus 5)', async () => {
    ;(getSession as jest.Mock).mockResolvedValueOnce({ user: { name: 'NhiLV', role: 'evaluator' } })
    const prev = process.env.SKIP_AUTH
    process.env.SKIP_AUTH = 'false'
    try { await quickStats(req('/api/evaluations/quick-stats?category=puzzle')) } finally { process.env.SKIP_AUTH = prev }
    const qs = geQueries()
    expect(qs).toHaveLength(3)
    for (const q of qs) {
      expect(q).toContain('lower(ge.initial_evaluator) = lower(')
      expect(q).toContain('NOT (ge.pair_back')
    }
  })

  it('keeps a Link_dead / Stale_release back row (it is real work)', async () => {
    await quickStats(req('/api/evaluations/quick-stats?category=puzzle'))
    const q = geQueries()[0]
    expect(q).toContain("IS DISTINCT FROM 'Link_dead'")
    expect(q).toContain("IS DISTINCT FROM 'Stale_release'")
  })

  it('report: every ge read that counts work', async () => {
    await report(req('/api/report?category=puzzle&range=month'))
    const qs = geQueries().filter(mustCarry)
    expect(qs.length).toBeGreaterThanOrEqual(15)
    expectAllCarry(qs)
  })

  it('report: recordings per recorder and the recording queue use the media filter', async () => {
    // another category than the test above: the route caches a response per query string
    await report(req('/api/report?category=arcade&range=month'))
    const isRec = (t: string) => /WITH rec AS|AS slot|AS record_confirmed_at/.test(t)
    const rec = geQueries().filter(t => /WITH rec AS/.test(t))
    expect(rec).toHaveLength(2)
    for (const q of rec) {
      expectMedia(q)
      expect(q.split(MEDIA).length - 1).toBe(2)
    }
    // the evaluation reads still use the evaluation rule
    const evals = geQueries().filter(mustCarry).filter(t => !isRec(t))
    expect(evals.length).toBeGreaterThanOrEqual(13)
    for (const q of evals) expect(q).toContain(EVAL)
  })

  // Trends tags (playtest_tags) are one row per tag, never a copy, so their join to the
  // evaluation row (for its category) carries no pair condition.
  const tagParts = (qs: string[]) => qs.filter(t => t.includes('FROM playtest_tags pt')).map(t => {
    const i = t.indexOf('FROM playtest_tags pt')
    return t.slice(i, t.indexOf('GROUP BY', i))
  })

  it('report daily', async () => {
    await reportDaily(req('/api/report/daily?from=2026-11-01&to=2026-11-07&category=all'))
    expectAllCarry(geQueries())
    const tags = tagParts(geQueries())
    expect(tags).toHaveLength(1)
    // (the day pick subquery on g2 inside it keeps its own evaluation rule)
    expect(tags[0]).not.toContain('ge.pair_back')
  })

  it('report daily, one evaluator (self scope)', async () => {
    await reportDaily(req('/api/report/daily?from=2026-11-01&to=2026-11-07&evaluator=ThuDT'))
    expectAllCarry(geQueries())
    const tags = tagParts(geQueries())
    expect(tags).toHaveLength(1)
    // (the day pick subquery on g2 inside it keeps its own evaluation rule)
    expect(tags[0]).not.toContain('ge.pair_back')
  })

  it('report rollup', async () => {
    await rollup(req('/api/cron/report-rollup', { method: 'POST', headers: { 'x-webhook-secret': 's' }, body: '{}' }))
    // the two INSERT ... SELECT statements (evaluation, recording); recSlotRows fragments sit inside them
    const qs = geQueries().filter(t => t.includes('INSERT INTO report_rollup'))
    expect(qs).toHaveLength(2)
    expectAllCarry(qs)
    // the recording statement reads two slots, both carry it
    const rec = qs.find(t => t.includes("'recording'"))!
    expect((rec.match(/pair_back/g) || []).length).toBe(2)
    expectMedia(rec)
    const ev = qs.find(t => !t.includes("'recording'"))!
    expect(ev).toContain(EVAL)
  })

  it('pending holders', async () => {
    await pendingHolders(req('/api/operations/pending-holders?category=puzzle'))
    expectAllCarry(geQueries())
  })

  it('assign-setup preview: the waiting count carries it, the not-yet-pushed existence test does not', async () => {
    await assignPreview(req('/api/assign-setup/preview'))
    const waiting = geQueries().filter(t => t.includes('initial_evaluator IS NULL'))
    expect(waiting).toHaveLength(1)
    expectAllCarry(waiting)
  })

  it('rescue scan counts (candidate selection is Task 7)', async () => {
    await scanRoster({ category: 'puzzle', config: { staleDays: 14, cooldownDays: 3, activeDays: 7 } as never })
    const qs = texts().filter(t => /WITH today AS/.test(t))
    expect(qs).toHaveLength(1)
    // both CTEs (pend, act) carry it, and the candidate query (Task 7) is not part of this statement
    expect((qs[0].match(/pair_back/g) || []).length).toBe(2)
  })

  it('effort-sessions: the events read and the record slots', async () => {
    await effortSessions(req('/api/external/effort-sessions?from=2026-11-01&to=2026-11-07&employee_id=x', { headers: { 'x-api-key': KEY } }))
    const qs = geQueries()
    expect(qs).toHaveLength(2)
    expectAllCarry(qs)
    const slots = qs.filter(t => t.includes('record_5min_confirmed_at'))
    expect(slots).toHaveLength(1)
    expectMedia(slots[0])
    expect(qs.find(t => !t.includes('record_5min_confirmed_at'))).toContain(EVAL)
  })

  it('effort-game-time: the record slots (panel time reads evaluation_log, written once per pair)', async () => {
    await effortGameTime(req('/api/external/effort-game-time?from=2026-11-01&to=2026-11-07&employee_id=x', { headers: { 'x-api-key': KEY } }))
    const slots = geQueries().filter(t => t.includes('record_5min_confirmed_at'))
    expect(slots).toHaveLength(1)
    expectAllCarry(slots)
    expectMedia(slots[0])
  })

  it('people config totals and the evaluator-name audit', async () => {
    await (configPeople as () => Promise<unknown>)()
    await auditEvaluators()
    const qs = geQueries().filter(t => t.includes('mode() WITHIN GROUP'))
    expect(qs).toHaveLength(2)
    expectAllCarry(qs)
  })
})
