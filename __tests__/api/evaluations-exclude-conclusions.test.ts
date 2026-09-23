/**
 * @jest-environment node
 */
// Two opt-in parameters the Report's review table needs, and nothing else sends.
//
// `exclude_conclusions` is how that table asks for "every real call": judged, minus
// the values that are housekeeping rather than decisions (Link_dead = the store page
// went away, Stale_release = the build aged out). It is the same line
// app/api/report/route.ts's own `judged` predicate draws, so the review table and the
// KPIs above it count the same rows. It is an EXCLUSION rather than the list of
// everything else because that list would have to come from the facets response,
// which arrives in a second request -- page 1 would then be fetched once against a
// guess and again when it landed.
//
// `stats=0` drops the page-1 count(*). It runs over the same filtered set as the rows
// beside it and shares their Promise.all, so it costs no extra round trip -- but the
// response still waits for it, and a caller that pages with a sentinel never reads it.
import { NextRequest } from 'next/server'
import { clearAvailableMonthsCache } from '@/lib/evaluations-filters'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { GET } from '@/app/api/evaluations/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

function setupSql() {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('SELECT ge.id')) return Promise.resolve([{ id: 1, game_id: 'g1' }])
    if (q.includes('AS total')) return Promise.resolve([{ total: 7, evaluated: 5 }])
    return Promise.resolve([])
  })
}

// The route builds its fragments as tagged templates, so sql() is called with a
// TemplateStringsArray (it carries `.raw`) plus the bound values. Joining those
// strings reads back which predicates the handler assembled.
const isTemplate = (a: unknown) => Array.isArray(a) && 'raw' in (a as object)
function allQueries(): string {
  return sqlMock.mock.calls
    .filter(c => isTemplate(c[0]))
    .map(c => (c[0] as string[]).join(' '))
    .join('\n')
}
// An IN/NOT IN list goes through the OTHER call shape -- `sql(array)` with a plain
// array as its only argument -- so it is not among a template's bound values.
function listArgs(): unknown[] {
  return sqlMock.mock.calls
    .filter(c => c.length === 1 && Array.isArray(c[0]) && !isTemplate(c[0]))
    .flatMap(c => c[0] as unknown[])
}

function get(qs: string) {
  return GET(new NextRequest(`http://localhost/api/evaluations?${qs}`))
}

describe('GET /api/evaluations exclude_conclusions + stats=0', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-23T10:00:00Z').getTime())
    clearAvailableMonthsCache()
    setupSql()
  })
  afterEach(() => { jest.restoreAllMocks() })

  it('turns exclude_conclusions into "judged, and not one of these"', async () => {
    await get('category=puzzle&from=2026-09-01&to=2026-09-30&exclude_conclusions=Link_dead,Stale_release')
    const q = allQueries()
    expect(q).toContain('ge.initial_conclusion NOT IN')
    // "judged" is half the predicate: a row with no conclusion is not a call either,
    // and without this it would ride along with every All request.
    expect(q).toContain('ge.initial_conclusion IS NOT NULL')
    const list = listArgs()
    expect(list).toContain('Link_dead')
    expect(list).toContain('Stale_release')
  })

  it('leaves the filter off entirely when the parameter is absent', async () => {
    await get('category=puzzle&from=2026-09-01&to=2026-09-30')
    expect(allQueries()).not.toContain('ge.initial_conclusion NOT IN')
  })

  it('lets an explicit conclusion win over the exclusion, rather than ANDing both', async () => {
    await get('category=puzzle&from=2026-09-01&to=2026-09-30&conclusion=Bypass&exclude_conclusions=Link_dead')
    const q = allQueries()
    expect(q).toContain('ge.initial_conclusion = ')
    expect(q).not.toContain('ge.initial_conclusion NOT IN')
  })

  it('skips the page-1 count and its body fields when stats=0', async () => {
    const res = await get('category=puzzle&from=2026-09-01&to=2026-09-30&page=1&stats=0')
    const json = await res.json()
    expect(allQueries()).not.toContain('AS total')
    expect(json.total).toBeUndefined()
    expect(json.stats).toBeUndefined()
    // the rows themselves are untouched
    expect(json.data).toHaveLength(1)
  })

  it('still counts on page 1 when stats is not passed, so the Evaluations page keeps its total', async () => {
    const res = await get('category=puzzle&from=2026-09-01&to=2026-09-30&page=1')
    const json = await res.json()
    expect(allQueries()).toContain('AS total')
    expect(json.total).toBe(7)
    expect(json.stats).toEqual({ total: 7, evaluated: 5, pending: 2 })
  })
})
