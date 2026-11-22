/**
 * @jest-environment node
 */
// Unified playtest phase 2, Task 5 (spec 6.1): the routes that COUNT history (per person / per
// date / per conclusion) read the view `eval_stats_rows` (migration 055) instead of
// `game_evaluations`, so a back row that phase 2 linked keeps counting with its frozen credit.
//   evaluation counts: FROM eval_stats_rows ge ... AND ge.eval_row   (was notPairCopy)
//   media counts:      FROM eval_stats_rows ge ... AND ge.media_row  (was mediaRowFilter)
// The view applies the row rule, so these statements carry no pair_back condition of their own.
// People config totals and the evaluator-name audit are history too (controller ruling R10).
// Work-queue routes (assign preview, rescue, pending holders) stay on game_evaluations +
// notPairCopy: a back row is not work, credited or not.
// Joins that read game_evaluations only to pick the category (Trends tags, panel time) take the
// credit's category: COALESCE(ge.credit ->> 'category_group', ge.category_group).
// The mock composes nested fragments into one text, so checks run on the whole statement.
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tag: any = jest.fn((strings: unknown, ...binds: unknown[]) => {
    if (typeof strings === 'string') return mk(strings)            // identifier: sql('ge')
    if (!Array.isArray(strings)) return mk('')
    return mk(render(strings as string[], binds))
  })
  tag.unsafe = jest.fn((s: string) => mk(s))
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
import { GET as effortSessions } from '@/app/api/external/effort-sessions/route'
import { GET as effortGameTime } from '@/app/api/external/effort-game-time/route'
import { GET as pendingHolders } from '@/app/api/operations/pending-holders/route'
import { GET as assignPreview } from '@/app/api/assign-setup/preview/route'
import { GET as configPeople } from '@/app/api/config/people/route'
import { GET as auditEvaluators } from '@/app/api/admin/users/audit-evaluators/route'
import { scanRoster } from '@/lib/rescue-core'

const sqlMock = sql as unknown as jest.Mock
const KEY = 'k'
const texts = () => sqlMock.mock.results
  .map(r => r.value as { __text?: string })
  .filter(v => v && typeof v.__text === 'string')
  .map(v => v.__text as string)
// whole statements only: a fragment is also a mock call, but the outermost text contains it
const statements = () => {
  const all = texts().filter(t => /SELECT/.test(t))
  return all.filter(t => !all.some(o => o !== t && o.length > t.length && o.includes(t)))
}
const VIEW = /(FROM|JOIN) eval_stats_rows (ge|g2)\b/
const TABLE = /(FROM|JOIN) game_evaluations (ge|g2)\b/
const viewReads = () => statements().filter(t => VIEW.test(t))
const count = (t: string, s: string) => t.split(s).length - 1
const isRescue = (t: string) => /WITH today AS/.test(t)
const CREDIT_CAT = "COALESCE(ge.credit ->> 'category_group', ge.category_group)"

function expectEval(q: string, alias = 'ge') {
  expect(q).toMatch(new RegExp(`FROM eval_stats_rows ${alias}\\b`))
  expect(q).toContain(`AND ${alias}.eval_row`)
  expect(q).not.toContain('media_row')
  expect(q).not.toContain('pair_back')
}
function expectMedia(q: string) {
  expect(q).toContain('FROM eval_stats_rows ge')
  expect(q).toContain('AND ge.media_row')
  expect(q).not.toContain('eval_row')
  expect(q).not.toContain('pair_back')
}

beforeAll(() => {
  process.env.SKIP_AUTH = 'true'
  process.env.EFFORT_TRACKER_API_KEY = KEY
  process.env.WEBHOOK_SECRET = 's'
})
beforeEach(() => sqlMock.mockClear())

const req = (u: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://localhost${u}`, init)

describe('counting routes read eval_stats_rows', () => {
  it('quick stats: totals, conclusions and platforms (the game_info join stays)', async () => {
    await quickStats(req('/api/evaluations/quick-stats?category=puzzle'))
    const qs = viewReads()
    expect(qs).toHaveLength(3)
    for (const q of qs) expectEval(q)
    expect(qs.filter(q => q.includes('JOIN game_info gi ON ge.game_id = gi.game_id'))).toHaveLength(1)
    expect(statements().filter(t => TABLE.test(t))).toHaveLength(0)
  })

  it('report: every evaluation read uses eval_row, the recording reads use media_row', async () => {
    await report(req('/api/report?category=puzzle&view=month&key=2026-11'))
    // The Rescue block the report embeds is the rescue scan (lib/rescue-core), a work queue:
    // it stays on the table (checked below with the queue routes).
    const rescue = statements().filter(isRescue)
    expect(rescue).toHaveLength(1)
    expect(rescue[0]).not.toContain('eval_stats_rows')
    const all = statements().filter(t => !isRescue(t))
    // nothing else in the report reads the table through the `ge` alias any more; the two plain
    // lookups left on game_evaluations (newest batch label, filter dropdown options) count nothing
    expect(all.filter(t => TABLE.test(t))).toHaveLength(0)
    expect(all.join('\n')).not.toContain('pair_back')
    const qs = viewReads()
    const isRec = (t: string) => /WITH rec AS|AS record_confirmed_at/.test(t)
    const rec = qs.filter(isRec)
    expect(rec).toHaveLength(2)
    for (const q of rec) {
      expectMedia(q)
      expect(count(q, 'AND ge.media_row')).toBe(2)   // one per bucket (5', 20')
    }
    const evals = qs.filter(t => !isRec(t))
    expect(evals.length).toBeGreaterThanOrEqual(15)
    for (const q of evals) expectEval(q)
  })

  it('report, batch view', async () => {
    await report(req('/api/report?category=arcade&view=batch&key=W3%20Nov%2C%202026'))
    const all = statements().filter(t => !isRescue(t))
    expect(viewReads().length).toBeGreaterThanOrEqual(15)
    expect(all.filter(t => TABLE.test(t))).toHaveLength(0)
    expect(all.join('\n')).not.toContain('pair_back')
  })

  // A Trends tag row is never a copy; its join to the evaluation row only picks the category.
  const tagParts = (qs: string[]) => qs.filter(t => t.includes('FROM playtest_tags pt')).map(t => {
    const i = t.indexOf('FROM playtest_tags pt')
    return t.slice(i, t.indexOf('GROUP BY', i))
  })

  it('report daily: the day rows, the index and the day-pick subquery (g2)', async () => {
    await reportDaily(req('/api/report/daily?from=2026-11-01&to=2026-11-07&category=all'))
    const all = statements()
    expect(all.join('\n')).not.toContain('pair_back')
    const day = all.find(t => t.includes('day_vn'))!
    expectEval(day.slice(0, day.indexOf('tg AS')))
    expect(day).toContain('FROM eval_stats_rows g2')
    expect(day).toContain('AND g2.eval_row')
    const tags = tagParts(all)
    expect(tags).toHaveLength(1)
    expect(tags[0]).toContain('JOIN game_evaluations ge ON ge.game_id = pt.game_id')
    // the tag row's bucket is the row's counted category (its credit's, after phase 2)
    const tg = day.slice(day.indexOf('tg AS'))
    expect(tg).toContain(`${CREDIT_CAT} AS bucket`)
    expect(tg).not.toContain('ge.category_group AS bucket')
    const index = all.filter(t => t.includes('HAVING'))
    expect(index).toHaveLength(1)
    expectEval(index[0])
  })

  it('report daily, one evaluator by day', async () => {
    await reportDaily(req('/api/report/daily?from=2026-11-01&to=2026-11-07&evaluator=ThuDT&by=day'))
    const q = statements().find(t => t.includes('WITH ev AS'))!
    expectEval(q.slice(0, q.indexOf('tg AS')))
    expect(tagParts([q])[0]).toContain('JOIN game_evaluations ge ON ge.game_id = pt.game_id')
  })

  it('report daily, one category: the eval reads filter the view column, the tag joins the credit category', async () => {
    await reportDaily(req('/api/report/daily?from=2026-11-01&to=2026-11-07&category=puzzle'))
    const day = statements().find(t => t.includes('day_vn'))!
    const ev = day.slice(0, day.indexOf('tg AS'))
    expect(ev).toContain('AND ge.category_group = ?')
    const tag = tagParts([day])[0]
    expect(tag).toContain(`AND ${CREDIT_CAT} = ?`)
    expect(tag).not.toContain('AND ge.category_group =')
    await reportDaily(req('/api/report/daily?from=2026-11-01&to=2026-11-07&evaluator=ThuDT&by=day&category=puzzle'))
    const byDay = statements().find(t => t.includes('WITH ev AS') && t.includes('tg AS') && !t.includes('day_vn'))!
    expect(tagParts([byDay])[0]).toContain(`AND ${CREDIT_CAT} = ?`)
    expect(tagParts([byDay])[0]).not.toContain('AND ge.category_group =')
  })

  it('report rollup: the evaluation and the recording INSERT ... SELECT', async () => {
    await rollup(req('/api/cron/report-rollup', { method: 'POST', headers: { 'x-webhook-secret': 's' }, body: '{}' }))
    const qs = statements().filter(t => t.includes('INSERT INTO report_rollup'))
    expect(qs).toHaveLength(2)
    const rec = qs.find(t => t.includes("'recording'"))!
    expectMedia(rec)
    expect(count(rec, 'FROM eval_stats_rows ge')).toBe(2)
    expect(count(rec, 'AND ge.media_row')).toBe(2)
    expectEval(qs.find(t => !t.includes("'recording'"))!)
  })

  it('effort-sessions: the events read and the record slots', async () => {
    await effortSessions(req('/api/external/effort-sessions?from=2026-11-01&to=2026-11-07&employee_id=x', { headers: { 'x-api-key': KEY } }))
    const qs = viewReads()
    expect(qs).toHaveLength(2)
    const slots = qs.filter(t => t.includes('record_5min_confirmed_at'))
    expect(slots).toHaveLength(1)
    expectMedia(slots[0])
    expectEval(qs.find(t => !t.includes('record_5min_confirmed_at'))!)
    expect(statements().filter(t => TABLE.test(t))).toHaveLength(0)
  })

  it('effort-game-time: the record slots; the panel-time category lookup by id stays on the table', async () => {
    await effortGameTime(req('/api/external/effort-game-time?from=2026-11-01&to=2026-11-07&employee_id=x', { headers: { 'x-api-key': KEY } }))
    const slots = viewReads()
    expect(slots).toHaveLength(1)
    expectMedia(slots[0])
    const panel = statements().filter(t => t.includes('FROM evaluation_log l'))
    expect(panel).toHaveLength(1)
    expect(panel[0]).toContain('LEFT JOIN game_evaluations ge ON ge.id = ev.ge_id')
    expect(panel[0]).toContain(`${CREDIT_CAT} AS genre`)
    expect(panel[0]).not.toContain('ge.category_group AS genre')
  })

  // Review Focus 5 (was in pair-counts.test.ts): an evaluator sees only their own rows; the
  // own-only condition survives the move to the view.
  it('quick stats scoped to the evaluator keeps the own-only condition on the view', async () => {
    ;(getSession as jest.Mock).mockResolvedValueOnce({ user: { name: 'NhiLV', role: 'evaluator' } })
    const prev = process.env.SKIP_AUTH
    process.env.SKIP_AUTH = 'false'
    try { await quickStats(req('/api/evaluations/quick-stats?category=puzzle')) } finally { process.env.SKIP_AUTH = prev }
    const qs = viewReads()
    expect(qs).toHaveLength(3)
    for (const q of qs) {
      expectEval(q)
      expect(q).toContain('lower(ge.initial_evaluator) = lower(')
    }
  })

  it('report daily scoped to the evaluator (by day) keeps the own-only condition on the view', async () => {
    ;(getSession as jest.Mock).mockResolvedValueOnce({ user: { name: 'NhiLV', role: 'evaluator' } })
    const prev = process.env.SKIP_AUTH
    process.env.SKIP_AUTH = 'false'
    try { await reportDaily(req('/api/report/daily?from=2026-11-01&to=2026-11-07&evaluator=SomeoneElse&by=day')) } finally { process.env.SKIP_AUTH = prev }
    const q = statements().find(t => t.includes('WITH ev AS'))!
    const ev = q.slice(0, q.indexOf('tg AS'))
    expectEval(ev)
    expect(ev).toContain('lower(ge.initial_evaluator) = lower(')
  })

  it('people config totals and the evaluator-name audit (history, R10)', async () => {
    await (configPeople as () => Promise<unknown>)()
    await auditEvaluators()
    const qs = statements().filter(t => t.includes('mode() WITHIN GROUP') && VIEW.test(t))
    expect(qs).toHaveLength(2)
    for (const q of qs) expectEval(q)
    expect(statements().filter(t => TABLE.test(t))).toHaveLength(0)
  })
})

describe('work-queue routes stay on game_evaluations + notPairCopy', () => {
  const NOT_PAIR_COPY = 'NOT (ge.pair_back'
  const expectQueue = (qs: string[], n: number) => {
    expect(qs).toHaveLength(n)
    for (const q of qs) {
      expect(q).toMatch(TABLE)
      expect(q).toContain(NOT_PAIR_COPY)
      expect(q).not.toContain('eval_stats_rows')
    }
  }

  it('pending holders', async () => {
    await pendingHolders(req('/api/operations/pending-holders?category=puzzle'))
    expectQueue(statements().filter(t => TABLE.test(t)), 1)
  })

  it('assign-setup preview: the waiting count', async () => {
    await assignPreview(req('/api/assign-setup/preview'))
    expectQueue(statements().filter(t => t.includes('initial_evaluator IS NULL') && TABLE.test(t)), 1)
  })

  it('rescue scan', async () => {
    await scanRoster({ category: 'puzzle', config: { staleDays: 14, cooldownDays: 3, activeDays: 7 } as never })
    const qs = statements().filter(t => /WITH today AS/.test(t))
    expectQueue(qs, 1)
    expect(count(qs[0], NOT_PAIR_COPY)).toBe(2)
  })

  it('no statement anywhere mixes the view with notPairCopy', async () => {
    await quickStats(req('/api/evaluations/quick-stats?category=arcade'))
    await reportDaily(req('/api/report/daily?from=2026-10-01&to=2026-10-07&category=puzzle'))
    for (const q of viewReads()) expect(q).not.toContain(NOT_PAIR_COPY)
  })
})
