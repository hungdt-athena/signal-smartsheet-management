/**
 * @jest-environment node
 */
/* A batch is the team's name for a week, but in the schema it is only a LABEL - and one
 * carried by ~4% of rows, almost all of them shortlisted games. `/api/report` therefore
 * resolves the label to the days it covers and filters on those days like every other
 * view. These tests pin the two halves of that:
 *
 *   1. a resolvable batch filters by DATE and never by the label
 *   2. an unresolvable one falls back to the LABEL
 *
 * (2) is the one that matters. Without the fallback its window carries neither dates nor
 * a label, which is not an error - it is an empty predicate that silently widens to ALL
 * TIME and renders a healthy-looking page of the wrong numbers.
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: Object.assign(jest.fn(), { unsafe: jest.fn(() => '') }) }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn(() => Promise.resolve({ user: { role: 'admin', name: 'Boss' } })) }))
jest.mock('@/lib/auth-guard', () => ({ requireRole: jest.fn(() => Promise.resolve(null)) }))
jest.mock('@/lib/report-config-db', () => ({
  loadReportConfig: jest.fn(() => Promise.resolve({
    config: { excluded: [], weights: { Volume: 40, Consistency: 15, Signal: 15, Survival: 15, Recording: 15 }, credibility: false },
    updatedAt: '2026-08-07T00:00:00Z',
  })),
}))

import { GET } from '@/app/api/report/route'
import { sql } from '@/lib/db'
import { clearBatchSpanCache } from '@/lib/report-batches'

const sqlMock = sql as unknown as jest.Mock

const SPANS = [
  { batch: 'W3 Sep, 2026', from: '2026-09-14', to: '2026-09-21' },
  { batch: 'W2 Sep, 2026', from: '2026-09-07', to: '2026-09-14' },
]

function setup(spans = SPANS) {
  clearBatchSpanCache()
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...params: unknown[]) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    // the span lookup itself
    if (q.includes('lead(f) OVER')) return Promise.resolve(spans)
    // "which batch is newest" (the default key) and the dropdown option list
    if (q.includes('GROUP BY batch')) return Promise.resolve([{ batch: 'W3 Sep, 2026' }, { batch: 'W2 Sep, 2026' }])
    if (q.includes("'week' AS kind")) {
      return Promise.resolve([
        { kind: 'batch', v: 'W3 Sep, 2026' },
        { kind: 'batch', v: 'W2 Sep, 2026' },
        { kind: 'batch', v: 'W2 Aug, 2026' },   // pre-cutoff: must NOT be offered
      ])
    }
    void params
    return Promise.resolve([])
  })
}

/** Every SQL fragment the route built, flattened to text. */
const queries = () => sqlMock.mock.calls
  .map((c) => (Array.isArray(c[0]) ? (c[0] as string[]).join(' ') : ''))
  .filter(Boolean)

/** The parameter values the route bound, flattened. */
const params = () => sqlMock.mock.calls.flatMap((c) => c.slice(1))

/* `category` is part of the route's in-memory cache key, so a test that needs the route
   to actually TALK to the database has to vary it - otherwise it is served the bundle an
   earlier test already built and sees zero queries. */
const call = (key: string, category = 'puzzle') =>
  GET(new NextRequest(`http://localhost/api/report?view=batch&key=${encodeURIComponent(key)}&category=${category}`))

describe('GET /api/report?view=batch', () => {
  it('filters a known batch by its days, not by its label', async () => {
    setup()
    await call('W3 Sep, 2026')
    // the resolved window is bound as a parameter somewhere
    expect(params()).toEqual(expect.arrayContaining(['2026-09-14', '2026-09-21']))
    // and nothing narrows on the label any more - that is what made the view a cohort
    const labelFilters = queries().filter((q) => /AND ge\.batch =/.test(q) || /AND batch =/.test(q))
    expect(labelFilters).toEqual([])
  })

  it('reports the resolved days back to the client', async () => {
    setup()
    const res = await call('W3 Sep, 2026')
    const body = await res.json()
    expect(body.window).toMatchObject({ batch: 'W3 Sep, 2026', from: '2026-09-14', to: '2026-09-21' })
  })

  it('offers only batches it can resolve, labelled with their real dates', async () => {
    setup()
    const body = await (await call('W3 Sep, 2026')).json()
    expect(body.options.batch).toEqual([
      { key: 'W3 Sep, 2026', label: 'W3 Sep, 2026 · 14/9 – 20/9' },
      { key: 'W2 Sep, 2026', label: 'W2 Sep, 2026 · 7/9 – 13/9' },
    ])
  })

  it('falls back to the label when a batch predates the resolvable era, instead of widening to all time', async () => {
    // no span for this label - the pre-cutoff case
    setup([])
    await call('W2 Aug, 2026')
    const all = queries()
    // it must narrow on SOMETHING
    const narrowed = all.filter((q) => /AND ge\.batch =/.test(q) || /AND batch =/.test(q))
    expect(narrowed.length).toBeGreaterThan(0)
    // the label is what got bound, and no window dates were invented for it
    expect(params()).toEqual(expect.arrayContaining(['W2 Aug, 2026']))
    const body = await (await call('W2 Aug, 2026')).json()
    expect(body.window.from).toBeUndefined()
    expect(body.window.to).toBeUndefined()
  })

  it('compares a batch against the batch before it, not against "no previous period"', async () => {
    setup()
    const body = await (await call('W3 Sep, 2026', 'arcade')).json()
    // What matters is that the route ASKED for 7/9 -> 14/9 - the previous batch's span.
    // `prev` itself comes back null here only because the mocked database returns no
    // rows for that query. Batch used to get no previous period at all, on the reasoning
    // that a label has no "one before"; batches tile the calendar, so it does.
    expect(params()).toEqual(expect.arrayContaining(['2026-09-07']))
    expect(body.window.label).toBe('W3 Sep, 2026')
  })
})
