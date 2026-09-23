/**
 * @jest-environment node
 */
// GET /api/report/daily - the Leaderboard's daily block: ONE day's work per person
// per bucket, plus the index of which days in the range have any work.
//
// The contract worth pinning is not the shape, it is the COUNTING. This table also
// exists as an 18:00 Google Chat card, and that card counts Link_dead into its total.
// Every other number in the Report excludes Link_dead and Stale_release as
// housekeeping rather than decisions. Two totals for one person on one screen is the
// exact bug the Report's redesign was written to stop, so the Report's rule wins here
// and the housekeeping counts come back separately, to be printed as "not counted".
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: Object.assign(jest.fn(), { unsafe: jest.fn(() => '') }) }))
jest.mock('@/lib/session', () => ({ getSession: jest.fn(() => Promise.resolve(null)) }))
jest.mock('@/lib/report-config-db', () => ({
  loadReportConfig: jest.fn(() => Promise.resolve({
    config: { excluded: [], weights: {}, credibility: false },
    updatedAt: '2026-09-01T00:00:00Z',
  })),
}))

import { getSession } from '@/lib/session'
import { loadReportConfig } from '@/lib/report-config-db'
import { GET } from '@/app/api/report/daily/route'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getSession as unknown as jest.Mock
const configMock = loadReportConfig as unknown as jest.Mock

function dbRow(over: Record<string, unknown> = {}) {
  return {
    day_vn: '2026-09-22', bucket: 'puzzle', evaluator: 'ThuDT',
    total: 136, idea: 1, pbp: 0, bypass: 135,
    link_dead: 6, stale_release: 0, tag_rows: 0, tagged: 0,
    ...over,
  }
}

// The two queries are told apart by what they select: the day query joins the
// evaluation and tagging CTEs, the index query is a plain per-day aggregate.
function setupSql(rows: Record<string, unknown>[], index: Record<string, unknown>[] = []) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('FULL OUTER JOIN')) return Promise.resolve(rows)
    if (q.includes('AS date')) return Promise.resolve(index)
    return Promise.resolve([])
  })
}
const templateCalls = () => sqlMock.mock.calls.filter(c => Array.isArray(c[0]) && 'raw' in (c[0] as object))
function queries(): string[] {
  return templateCalls().map(c => (c[0] as string[]).join(' '))
}
function lastQuery(): string {
  return queries().join('\n')
}
// The call whose template text matches -- used to reach a specific query's bound
// arguments, since a nested sql`` fragment is passed BY REFERENCE into each parent
// that interpolates it.
function callMatching(needle: string): unknown[] | undefined {
  const c = templateCalls().find(x => (x[0] as string[]).join(' ').includes(needle))
  return c && c.slice(1)
}
// `<> ALL(${list})` binds the array as an ordinary template VALUE, so it arrives as
// one of the trailing arguments rather than through sql(array); flatten a level to
// read the names out of it.
function boundNames(): unknown[] {
  return sqlMock.mock.calls
    .flatMap(c => c.slice(1))
    .flatMap(v => (Array.isArray(v) ? v : [v]))
}

function get(qs = '') {
  return GET(new NextRequest(`http://localhost/api/report/daily?${qs}`))
}

describe('GET /api/report/daily', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeEach(() => {
    process.env.SKIP_AUTH = ''
    sessionMock.mockResolvedValue({ user: { name: 'Admin', role: 'admin' } })
    configMock.mockResolvedValue({
      config: { excluded: [], weights: {}, credibility: false },
      updatedAt: '2026-09-01T00:00:00Z',
    })
    setupSql([dbRow()])
  })
  afterAll(() => { process.env.SKIP_AUTH = realSkip })

  it('counts a total the rest of the Report agrees with, and reports housekeeping beside it', async () => {
    const json = await (await get('from=2026-09-01&to=2026-09-30')).json()
    const bucket = json.day.buckets[0]

    // 136 judged, and the 6 dead links are NOT inside it.
    expect(bucket.total).toBe(136)
    expect(bucket.rows[0].total).toBe(136)
    expect(bucket.linkDead).toBe(6)
    expect(bucket.staleRelease).toBe(0)

    // and the query really excludes them rather than the assembly quietly subtracting
    const q = lastQuery()
    expect(q).toContain("NOT IN ('Link_dead', 'Stale_release')")
  })

  it('derives Other so a row adds up instead of quietly not adding up', async () => {
    // 10 judged of which 2/3/1 are the three named conclusions: 4 are something else.
    setupSql([dbRow({ total: 10, idea: 2, pbp: 3, bypass: 1 })])
    const json = await (await get()).json()
    expect(json.day.buckets[0].rows[0].other).toBe(4)
  })

  it('groups one day into buckets and people', async () => {
    setupSql([
      dbRow({ bucket: 'puzzle', evaluator: 'ThuDT', total: 100 }),
      dbRow({ bucket: 'puzzle', evaluator: 'NhiLV', total: 40, link_dead: 0 }),
      dbRow({ bucket: 'arcade', evaluator: 'HuyDD', total: 7, link_dead: 0 }),
    ])
    const json = await (await get()).json()
    expect(json.day.date).toBe('2026-09-22')
    expect(json.day.total).toBe(147)
    expect(json.day.buckets.map((b: { bucket: string }) => b.bucket)).toEqual(['puzzle', 'arcade'])
    expect(json.day.buckets[0].evaluators).toBe(2)
    expect(json.day.buckets[0].total).toBe(140)
  })

  it('picks the newest day with work inside SQL, so the first paint is one round trip', async () => {
    await get('from=2026-09-01&to=2026-09-30')
    // Asking the index first and then the day would be two serialized latencies to a
    // database on another continent, every time the tab opens.
    expect(lastQuery()).toContain('SELECT max((g2.evaluate_date AT TIME ZONE')
  })

  it('asks for exactly the day requested, and leaves the strip alone while doing it', async () => {
    setupSql([dbRow({ day_vn: '2026-09-18' })], [{ date: '2026-09-22', total: 5 }])
    const json = await (await get('from=2026-09-01&to=2026-09-30&day=2026-09-18&index=0')).json()
    expect(json.day.date).toBe('2026-09-18')
    // index=0 means the day list is not recomputed: switching day must not pay for it.
    expect(json.index).toEqual([])
    expect(lastQuery()).not.toContain('SELECT max((g2.evaluate_date AT TIME ZONE')
  })

  it('keeps a requested day that turned out empty, rather than dropping the selection', async () => {
    setupSql([])
    const json = await (await get('day=2026-09-20&index=0')).json()
    expect(json.day).toEqual({ date: '2026-09-20', total: 0, buckets: [] })
  })

  it('uses one definition of "a day with work" for the strip and the day it opens on', async () => {
    await get('from=2026-09-01&to=2026-09-30')
    const newest = queries().find(q => q.includes('SELECT max((g2.evaluate_date'))!
    const index = queries().find(q => q.includes('AS date'))!
    // Judged, housekeeping excluded - the same rule the totals use. A plain row count
    // would put a day whose only activity was clearing dead links on the strip,
    // offering a table of zeroes.
    expect(newest).toContain("NOT IN ('Link_dead', 'Stale_release')")
    expect(index).toMatch(/HAVING count\(\*\) FILTER[\s\S]*NOT IN \('Link_dead', 'Stale_release'\)/)
  })

  it('returns the day index for the strip, newest first', async () => {
    setupSql([dbRow()], [{ date: '2026-09-22', total: 140 }, { date: '2026-09-21', total: 9 }])
    const json = await (await get('from=2026-09-01&to=2026-09-30')).json()
    expect(json.index).toEqual([{ date: '2026-09-22', total: 140 }, { date: '2026-09-21', total: 9 }])
  })

  it('obeys the page Category filter, on the day AND on the strip', async () => {
    await get('from=2026-09-01&to=2026-09-30&category=arcade')
    expect(lastQuery()).toContain('ge.category_group = ')
    expect(boundNames()).toContain('arcade')

    // The bucket filter is built once and interpolated into both queries, so the
    // check is that BOTH carry the same fragment object -- if only the day query
    // did, the strip would offer days the table below it cannot fill.
    const fragment = templateCalls()
      .map((c, i) => [c, i] as const)
      .find(([c]) => (c[0] as string[]).join(' ').includes('AND ge.category_group = '))
    expect(fragment).toBeDefined()
    const frag = sqlMock.mock.results[fragment![1]].value
    expect(callMatching('FULL OUTER JOIN')).toContain(frag)
    expect(callMatching('AS date')).toContain(frag)
  })

  it('leaves the bucket filter off entirely on All', async () => {
    await get('from=2026-09-01&to=2026-09-30&category=all')
    expect(lastQuery()).not.toContain('ge.category_group = ')
  })

  // THE BUG THIS BLOCK SHIPPED WITH. The tagging CTE was bounded by the whole PERIOD
  // while only the evaluation CTE was narrowed to the day, so every tag anyone made on
  // any other day in the period arrived as its own row -- a person with 0 judged and a
  // tag count, repeated once per day they had tagged. On screen: DuyenLP three times,
  // KietCD twice, and an evaluator count of 15 for a day that had 8 people in it.
  it('narrows the tagging side to the same single day as the evaluations', async () => {
    await get('from=2026-09-01&to=2026-09-30')
    const dayQuery = queries().find(q => q.includes('FULL OUTER JOIN'))!
    const tg = dayQuery.slice(dayQuery.indexOf('tg AS ('))
    // The range predicate stays (it is what the index serves); the day equality is
    // what stops a whole period of tagging landing in one day's table.
    expect(tg).toContain('pt.tagged_at >=')
    expect(tg).toMatch(/\(pt\.tagged_at AT TIME ZONE [\s\S]*?\)::date =/)
  })

  it('drops any row that is not the day being shown, however it got there', async () => {
    // Belt and braces for the same bug: even handed rows from two days, the block
    // must render ONE day rather than silently mixing them under one date.
    setupSql([
      dbRow({ day_vn: '2026-09-22', evaluator: 'DuyenLP', total: 92 }),
      dbRow({ day_vn: '2026-09-21', evaluator: 'DuyenLP', total: 0, idea: 0, pbp: 0, bypass: 0, link_dead: 0, tag_rows: 3, tagged: 3 }),
    ])
    const json = await (await get()).json()
    expect(json.day.date).toBe('2026-09-22')
    expect(json.day.buckets[0].rows).toHaveLength(1)
    expect(json.day.buckets[0].evaluators).toBe(1)
  })

  it('matches the two sides of the join on a lowered name, so casing drift cannot split a person', async () => {
    // ge.initial_evaluator is sheet data with known casing drift (HuyDD vs Huydd) and
    // du.name is the account's display name. Joining them raw puts the same person on
    // two rows: one with their judgements, one with only their tags.
    await get()
    const dayQuery = queries().find(q => q.includes('FULL OUTER JOIN'))!
    expect(dayQuery).toMatch(/FULL OUTER JOIN tg t[\s\S]*?t\.k = e\.k/)
  })

  it('keeps somebody who only tagged, which an inner join would report as absent', async () => {
    setupSql([dbRow({ evaluator: 'KietCD', total: 0, idea: 0, pbp: 0, bypass: 0, link_dead: 0, tag_rows: 21, tagged: 21 })])
    const json = await (await get()).json()
    expect(json.day.buckets[0].rows[0]).toMatchObject({ name: 'KietCD', total: 0, tagRows: 21, tagged: 21 })
    expect(lastQuery()).toContain('FULL OUTER JOIN')
  })

  it('leaves out the system accounts and anyone Config excluded, on both sides of the join', async () => {
    configMock.mockResolvedValue({
      config: { excluded: ['minhlq1'], weights: {}, credibility: false },
      updatedAt: '2026-09-01T00:00:00Z',
    })
    await get()
    const list = boundNames()
    expect(list).toContain('minhlq1')
    expect(list).toContain('shortcut')
    // the evaluator side AND the tagging side, or a hidden person reappears in one column
    const q = lastQuery()
    expect(q).toContain('lower(ge.initial_evaluator) <> ALL(')
    expect(q).toContain('lower(du.name) <> ALL(')
  })

  it('bounds both date columns with a bare comparison, so their indexes still apply', async () => {
    await get('from=2026-09-01&to=2026-09-30')
    const q = lastQuery()
    // The RANGE predicate is what the index serves, and it reads the bare column.
    // Wrapping it -- `(col AT TIME ZONE ...)::date >= x` -- is what throws the index
    // and the planner's statistics away, and is the trap both this route and the n8n
    // workflow it came from are written around.
    expect(q).toContain('ge.evaluate_date >=')
    expect(q).toContain('ge.evaluate_date <')
    expect(q).toContain('pt.tagged_at >=')
    expect(q).toContain('pt.tagged_at <')
    // The one place a wrapped date is compared is the newest-day pick, and it sits
    // ON TOP of that bounded scan rather than instead of it -- both ends of the range
    // are still in its own subquery.
    const newest = queries().find(x => x.includes('SELECT max((g2.evaluate_date'))!
    expect(newest).toContain('g2.evaluate_date >=')
    expect(newest).toContain('g2.evaluate_date <')
  })

  it('is refused to someone who is not a manager: it is a whole-team table', async () => {
    sessionMock.mockResolvedValue({ user: { name: 'NhiLV', role: 'evaluator' } })
    const res = await get()
    expect(res.status).toBe(403)
    expect(queries().filter(q => q.includes('FROM game_evaluations'))).toEqual([])
  })

  // ---- the one thing a contractor MAY read here: their own days ----
  // A blanket guard at the top of this route shipped once, and it answered 403 to the
  // day breakdown on a contractor's OWN Individual tab - the one tab they are allowed
  // to open. The team table stays manager-only; by=day is their own numbers.

  it('gives a contractor their own day breakdown', async () => {
    sessionMock.mockResolvedValue({ user: { name: 'NhiLV', role: 'evaluator' } })
    setupSql([])
    const res = await get('by=day&evaluator=NhiLV&from=2026-09-01&to=2026-09-30')
    expect(res.status).toBe(200)
    expect(boundNames()).toContain('NhiLV')
  })

  it('ignores the name a contractor asks for and uses their own', async () => {
    // REPLACED, not compared: comparing would still answer differently for a name
    // that exists and one that does not, which is a way to probe the roster.
    sessionMock.mockResolvedValue({ user: { name: 'NhiLV', role: 'evaluator' } })
    setupSql([])
    const res = await get('by=day&evaluator=ThuDT&from=2026-09-01&to=2026-09-30')
    expect(res.status).toBe(200)
    const bound = boundNames()
    expect(bound).toContain('NhiLV')
    expect(bound).not.toContain('ThuDT')
  })

  it('still refuses a contractor the whole team s day, even alongside by=day', async () => {
    sessionMock.mockResolvedValue({ user: { name: 'NhiLV', role: 'evaluator' } })
    setupSql([])
    // no `by=day`, so this is the team table whatever else is on the query string
    const res = await get('evaluator=NhiLV&from=2026-09-01&to=2026-09-30')
    expect(res.status).toBe(403)
    expect(queries().filter(q => q.includes('FROM game_evaluations'))).toEqual([])
  })

  it('lets a manager ask for anybody by name', async () => {
    setupSql([])
    const res = await get('by=day&evaluator=ThuDT&from=2026-09-01&to=2026-09-30')
    expect(res.status).toBe(200)
    expect(boundNames()).toContain('ThuDT')
  })
})
