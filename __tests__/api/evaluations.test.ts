/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'
import { clearAvailableMonthsCache } from '@/lib/evaluations-filters'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { GET } from '@/app/api/evaluations/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock

interface MockData {
  months?: { year: number; month: number }[]
  rows?: Record<string, unknown>[]
  stats?: { total: number; evaluated: number }[]
  conclusions?: { c: string }[]
}

// Routes mock results by inspecting the SQL text. All tagged-template calls
// (queries and fragments alike) receive a strings array; calls that match no
// keyword branch — fragments and the sql(array) IN-list helper — resolve [].
function setupSql({ months = [], rows = [], stats = [{ total: 0, evaluated: 0 }], conclusions = [] }: MockData = {}) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('EXTRACT(YEAR')) return Promise.resolve(months)
    if (q.includes('count(*)')) return Promise.resolve(stats)
    if (q.includes('initial_conclusion AS c')) return Promise.resolve(conclusions)
    if (q.includes('SELECT ge.id')) return Promise.resolve(rows)
    return Promise.resolve([])
  })
}

// All SQL text seen by the mock, for shape assertions.
function allQueries(): string {
  return sqlMock.mock.calls
    .filter(c => Array.isArray(c[0]))
    .map(c => (c[0] as string[]).join(' '))
    .join('\n')
}

function get(qs: string) {
  return GET(new NextRequest(`http://localhost/api/evaluations?${qs}`))
}

describe('GET /api/evaluations', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  beforeEach(() => {
    // 2026-06-15 in UTC — current month in UTC+7 is June 2026.
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-06-15T10:00:00Z').getTime())
    // The month list is cached for a minute so month=auto does not pay a serialized
    // round-trip on every page open. These cases hand it a different list each time,
    // with a frozen clock, so the cache has to be cleared between them.
    clearAvailableMonthsCache()
  })
  afterEach(() => { jest.restoreAllMocks() })

  it('month=auto picks the current month when it has data', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }, { year: 2026, month: 5 }] })
    const res = await get('category=puzzle&month=auto&page=1')
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.applied_month).toEqual({ year: 2026, month: 6 })
  })

  it('month=auto falls back to the latest month with data', async () => {
    setupSql({ months: [{ year: 2026, month: 5 }, { year: 2026, month: 4 }] })
    const res = await get('category=puzzle&month=auto&page=1')
    const json = await res.json()
    expect(json.applied_month).toEqual({ year: 2026, month: 5 })
  })

  it('month=auto with no data applies no month and returns applied_month null', async () => {
    setupSql({ months: [] })
    const res = await get('category=puzzle&month=auto&page=1')
    const json = await res.json()
    expect(json.applied_month).toBeNull()
    expect(json.data).toEqual([])
  })

  it('page 1 returns stats computed from the aggregate query', async () => {
    setupSql({
      months: [{ year: 2026, month: 6 }],
      stats: [{ total: 320, evaluated: 200 }],
    })
    const res = await get('category=puzzle&month=auto&page=1')
    const json = await res.json()
    expect(json.total).toBe(320)
    // dead_links was dropped from this stat block on purpose (f8c3b88).
    expect(json.stats).toEqual({ total: 320, evaluated: 200, pending: 120 })
    expect(json.available_months).toEqual([{ year: 2026, month: 6 }])
  })

  it('page > 1 skips meta and stats queries entirely', async () => {
    setupSql({ rows: [{ id: 1 }] })
    const res = await get('category=puzzle&year=2026&month=6&page=2')
    const json = await res.json()
    expect(json.data).toEqual([{ id: 1 }])
    expect(json.stats).toBeUndefined()
    expect(json.available_months).toBeUndefined()
    expect(json.available_conclusions).toBeUndefined()
    const q = allQueries()
    expect(q).not.toContain('count(*)')
    expect(q).not.toContain('EXTRACT(YEAR')
  })

  it('list query no longer selects screenshot_urls or categories', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&month=auto&page=1')
    const q = allQueries()
    expect(q).not.toContain('screenshot_urls')
    expect(q).not.toContain("metadata->'categories'")
  })

  it('list query selects game_alike and final_note', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&month=auto&page=1')
    const q = allQueries()
    expect(q).toContain('ge.game_alike')
    expect(q).toContain('ge.final_note')
  })

  it('explicit month filter uses a sargable date range, not EXTRACT', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=3&page=1')
    const q = allQueries()
    // A half-open range compared against the bare column, so the index on it stays
    // usable. (The make_date form this used to assert was rewritten during the load
    // optimisation; the column itself arrives as an interpolated fragment.)
    expect(q).toContain("::date + interval '1 day'")
    expect(q).toContain('ge.assigned_date')
    // The months meta query legitimately uses EXTRACT(MONTH ...)::int;
    // only the old equality-filter form must be gone.
    expect(q).not.toContain('EXTRACT(MONTH FROM ge.assigned_date) =')
  })
})

// Search (?q=) — see lib/evaluations-filters. The predicate has to sit on game_info,
// where the trigram indexes are: measured against the real database, putting the id
// half on `ge` instead costs a 625k-row parallel seq scan (1275ms vs 209ms).
describe('GET /api/evaluations?q=', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-06-15T10:00:00Z').getTime())
    clearAvailableMonthsCache()
  })
  afterEach(() => { jest.restoreAllMocks() })

  it('matches title and game_id on game_info, where the trigram indexes are', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=6&page=1&q=merge')
    const q = allQueries()
    expect(q).toContain('gi.title ILIKE')
    expect(q).toContain('gi.game_id ILIKE')
    // The id half on `ge` is what loses the index.
    expect(q).not.toContain('ge.game_id ILIKE')
  })

  it('passes the search term as a contains pattern on both columns', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=6&page=1&q=merge')
    const params = sqlMock.mock.calls.flatMap(c => c.slice(1))
    expect(params).toContain('%merge%')
  })

  it('searches all time: the date range filter is dropped', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=6&page=1&meta=0&q=merge')
    expect(allQueries()).not.toContain('::date')
  })

  it('drops the conclusion and status filters so a search cannot return nothing by accident', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=6&page=1&meta=0&status=pending&conclusion=List_Idea&q=merge')
    const q = allQueries()
    // The filter fragments, which all lead with AND -- the ordering mentions
    // initial_conclusion too, and that one is meant to be there.
    expect(q).not.toContain('AND ge.initial_conclusion IS NULL')
    expect(q).not.toContain('AND ge.initial_conclusion =')
  })

  it('keeps the evaluator filter: search must not widen who you can see', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=6&page=1&evaluator=VinhTD&q=merge')
    expect(allQueries()).toContain('lower(ge.initial_evaluator)')
  })

  it('ignores a term under 3 characters, which no trigram index can serve', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=6&page=1&q=me')
    const q = allQueries()
    expect(q).not.toContain('gi.title ILIKE')
    // The normal month filter is still in force.
    expect(q).toContain('::date')
  })

  it('escapes LIKE metacharacters so % is searched for, not matched with', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=6&page=1&q=' + encodeURIComponent('100%_win'))
    const params = sqlMock.mock.calls.flatMap(c => c.slice(1))
    expect(params).toContain('%100\\%\\_win%')
  })

  // Ordering, in three tiers: how well the term matches, then how far the game got in
  // the funnel, then recency. See lib/evaluations-filters for the whole rule.
  it('ranks an exact store id first and an exact title second', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=6&page=1&q=merge')
    const q = allQueries()
    expect(q).toContain('WHEN gi.game_id =')
    expect(q).toContain('lower(gi.title) = lower(')
  })

  it('ranks a title that starts with the term above one that merely contains it', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=6&page=1&q=merge')
    const params = sqlMock.mock.calls.flatMap(c => c.slice(1))
    expect(params).toContain('merge%')
  })

  it('counts a term that starts a word as a better match than one buried in one', async () => {
    // 'Ball Merge' beats 'Cosmerge'. The boundary is on the START of a word only:
    // anchoring both ends would drop plurals, so 'Groveland Blocks' would not count
    // as a match for 'block'.
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=6&page=1&q=merge')
    const q = allQueries()
    expect(q).toContain('gi.title ~*')
    expect(q).toContain('gi.game_id ~*')
    const params = sqlMock.mock.calls.flatMap(c => c.slice(1))
    expect(params).toContain('\\ymerge')
  })

  it('escapes regex metacharacters in the word pattern', async () => {
    // Regex escaping is not LIKE escaping: '(' would make the pattern invalid and the
    // whole query fail, where '%' and '_' are literal here.
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=6&page=1&q=' + encodeURIComponent('go (2'))
    const params = sqlMock.mock.calls.flatMap(c => c.slice(1))
    expect(params).toContain('\\ygo \\(2')
  })

  it('skips the word tier for a term that cannot start a word', async () => {
    // '\y%merge' asks for a word boundary immediately before '%', which is not what
    // anyone typing that means -- so the term just ranks by containment.
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=6&page=1&q=' + encodeURIComponent('%merge'))
    expect(allQueries()).not.toContain('gi.title ~*')
  })

  it('ranks a decided or shortlisted game above a bypassed one', async () => {
    // final_conclusion IS NOT NULL is NOT the test: it also holds for Bypass and
    // Not Found, which would put rejected games at the top.
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=6&page=1&q=merge')
    const q = allQueries()
    expect(q).toContain('ge.final_conclusion IN')
    expect(q).toContain("ge.initial_conclusion = 'List_Idea'")
    // Which values count as decided is the constant's business, not the query's --
    // see the POSITIVE_FINAL_CONCLUSIONS cases in __tests__/lib/eval-search.
  })

  it('breaks the remaining ties by newest evaluation, then assignment, then row id', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=6&page=1&q=merge')
    const q = allQueries()
    expect(q).toContain('ge.evaluate_date DESC NULLS LAST')
    expect(q).toContain('ge.assigned_date DESC NULLS LAST')
    // Unique last resort: the infinite scroll pages with OFFSET, and a non-unique
    // sort key lets rows repeat or vanish between pages.
    expect(q).toContain('ge.id DESC')
  })

  it('leaves the ordering of an ordinary month view alone', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }] })
    await get('category=puzzle&year=2026&month=6&page=1&meta=0')
    const q = allQueries()
    expect(q).not.toContain('~*')
    expect(q).not.toContain("'List_Idea'")
    expect(q).toContain('ge.imported_at DESC')
  })

  it('caps the total count instead of paying for an all-time count(*)', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }], stats: [{ total: 501, evaluated: 300 }] })
    const res = await get('category=puzzle&year=2026&month=6&page=1&q=merge')
    const json = await res.json()
    expect(allQueries()).toContain('LIMIT')
    expect(json.total).toBe(501)
    expect(json.total_capped).toBe(true)
  })

  it('reports an uncapped search total as exact', async () => {
    setupSql({ months: [{ year: 2026, month: 6 }], stats: [{ total: 42, evaluated: 20 }] })
    const res = await get('category=puzzle&year=2026&month=6&page=1&q=merge')
    const json = await res.json()
    expect(json.total).toBe(42)
    expect(json.total_capped).toBe(false)
  })
})
