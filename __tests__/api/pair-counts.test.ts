/**
 * @jest-environment node
 */
// Task 6 (unified playtest): work counts count a linked pair once. The WORK-QUEUE routes read
// `game_evaluations ge` with notPairCopy (a back row that is only a copy is dropped; a back row
// holding Link_dead / Stale_release is real work and stays). The routes that count history
// (Report, report daily, rollup, Quick stats, Effort) moved to the view eval_stats_rows in
// phase 2 (migration 055): see eval-stats-rows.test.ts.
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
import { GET as pendingHolders } from '@/app/api/operations/pending-holders/route'
import { GET as assignPreview } from '@/app/api/assign-setup/preview/route'
import { GET as configPeople } from '@/app/api/config/people/route'
import { GET as auditEvaluators } from '@/app/api/admin/users/audit-evaluators/route'
import { scanRoster } from '@/lib/rescue-core'

const sqlMock = sql as unknown as jest.Mock
const texts = () => sqlMock.mock.results
  .map(r => r.value as { __text?: string })
  .filter(v => v && typeof v.__text === 'string')
  .map(v => v.__text as string)
// statements (not fragments) that read game_evaluations as ge
const geQueries = () => texts().filter(t => /(FROM|JOIN) game_evaluations (ge|g2)\b/.test(t) && /SELECT/.test(t))
function expectAllCarry(qs: string[]) {
  expect(qs.length).toBeGreaterThan(0)
  for (const q of qs) expect(q).toContain('pair_back')
}

beforeAll(() => {
  process.env.SKIP_AUTH = 'true'
})
beforeEach(() => sqlMock.mockClear())

const req = (u: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://localhost${u}`, init)

describe('work counts drop the copy row of a linked pair', () => {
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

  it('people config totals and the evaluator-name audit', async () => {
    await (configPeople as () => Promise<unknown>)()
    await auditEvaluators()
    const qs = geQueries().filter(t => t.includes('mode() WITHIN GROUP'))
    expect(qs).toHaveLength(2)
    expectAllCarry(qs)
  })
})
