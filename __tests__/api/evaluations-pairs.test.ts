/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/auth', () => ({ authOptions: {} }))
jest.mock('@/lib/config', () => ({ getConfigValues: jest.fn(async () => []) }))
jest.mock('@/lib/people-config-db', () => ({ loadHiddenEvaluatorKeys: jest.fn(async () => []) }))
jest.mock('@/lib/session', () => ({ getSession: jest.fn(async () => ({ user: { name: 'KietCD', role: 'admin' } })) }))
jest.mock('@/lib/current-batch', () => ({ getCurrentBatch: jest.fn(async () => 'W3 Nov, 2026') }))

import { GET as getList } from '@/app/api/evaluations/route'
import { GET as getFacets } from '@/app/api/evaluations/facets/route'
import { GET as getMissingDemo } from '@/app/api/evaluations/missing-demo/route'
import { GET as getFeedbackBatches } from '@/app/api/weekly-feedback/batches/route'
import { recordViewRows } from '@/lib/record-view-games'
import { loadExportGames } from '@/lib/shortlist-export/games'
import { buildTabs } from '@/lib/shortlist-export/table'
import { clearAvailableMonthsCache } from '@/lib/evaluations-filters'
import { sql } from '@/lib/db'

const sqlMock = sql as unknown as jest.Mock
// Each tagged-template call is one entry. A nested fragment (listRowFilter etc.) is a call of
// its own, so "the query has pair_back" means some call in the request did.
const calls = () => sqlMock.mock.calls.filter(c => Array.isArray(c[0])).map(c => (c[0] as string[]).join('?'))
const has = (needle: string) => calls().some(t => t.includes(needle))
const withText = (needle: string) => calls().filter(t => t.includes(needle))

beforeAll(() => { process.env.SKIP_AUTH = 'true' })
beforeEach(() => {
  clearAvailableMonthsCache()
  sqlMock.mockReset()
  sqlMock.mockImplementation(() => Promise.resolve([]))
})

describe('GET /api/evaluations: a linked pair shows once', () => {
  const get = (qs: string) => getList(new NextRequest(`http://localhost/api/evaluations?${qs}`))

  it('drops the back row in the list, the count and the facet reads', async () => {
    await get('category=puzzle&limit=10')
    // list SELECT, count and the breakdown/facet queries all carry the fragment
    expect(withText('.pair_back').length).toBeGreaterThanOrEqual(1)
    const listQuery = calls().find(t => t.includes('FROM game_evaluations ge') && t.includes('LEFT JOIN developer'))!
    expect(listQuery).toContain('twin_gi.demo_code')
    expect(listQuery).toContain('twin_gi.record_code')
  })

  it('selects stores from the twin row', async () => {
    await get('category=puzzle&limit=10')
    const t = withText('pair_eval_id').join('\n')
    expect(t).toContain('json_agg')
    expect(t).toContain("'app_link'")
    expect(t).toContain('t.id = ')
  })

  it('searching a game id also looks at the twin game id (the back row is hidden)', async () => {
    await get('category=puzzle&q=6822015244&limit=10')
    const t = withText('pe.id = ')
    expect(t.length).toBeGreaterThanOrEqual(1)
    expect(t.join('\n')).toContain('pair_eval_id')
    expect(t.join('\n')).toContain('pe.game_id ILIKE')
    // ranking: the id you pasted ranks first whichever store it names
    expect(t.join('\n')).toContain('pe.game_id = ')
  })

  it('returns the rows with their stores untouched', async () => {
    const stores = [
      { os: 'ios', game_id: '6835071657', eval_id: 2121989, app_link: 'https://apps.apple.com/app/id1', is_active: true, dead: false },
      { os: 'android', game_id: 'com.x', eval_id: 2118286, app_link: 'https://play.google.com/x', is_active: true, dead: false },
    ]
    sqlMock.mockImplementation((strings: unknown) => {
      const q = Array.isArray(strings) ? (strings as string[]).join('?') : ''
      if (q.includes('FROM game_evaluations ge') && q.includes('LEFT JOIN developer')) {
        return Promise.resolve([{ id: 1, game_id: 'com.x', stores, demo_code: 'ABC123' }])
      }
      return Promise.resolve([])
    })
    const res = await get('category=puzzle&limit=10&meta=0')
    const body = await res.json()
    const rows = body.data
    expect(rows[0].stores).toEqual(stores)
    expect(rows[0].demo_code).toBe('ABC123')
  })

  it('facets: batch and conclusion lists skip back rows', async () => {
    await getFacets(new NextRequest('http://localhost/api/evaluations/facets?category=puzzle&month=2026-11'))
    expect(withText('.pair_back').length).toBeGreaterThanOrEqual(3)
  })
})

describe('other list-type readers', () => {
  it('missing-demo prompt shows a pair once and carries the pair code', async () => {
    await getMissingDemo(new NextRequest('http://localhost/api/evaluations/missing-demo'))
    expect(has('.pair_back')).toBe(true)
    expect(withText('FROM game_evaluations ge').join('\n')).toContain('twin_gi.demo_code')
  })

  it('weekly-feedback batches skip back rows', async () => {
    await getFeedbackBatches()
    expect(has('.pair_back')).toBe(true)
  })

  it('Record view rows: front rows only, pair code and stores', async () => {
    await recordViewRows()
    const t = withText('FROM game_evaluations ge').join('\n')
    expect(has('.pair_back')).toBe(true)
    expect(t).toContain('twin_gi.record_code')
    expect(has('json_agg')).toBe(true)
  })

  it('Short List export: one row per pair, both store links', async () => {
    sqlMock.mockImplementation((strings: unknown) => {
      const q = Array.isArray(strings) ? (strings as string[]).join('?') : ''
      if (!q.includes('DISTINCT ON')) return Promise.resolve([])
      return Promise.resolve([{
        game_id: 'com.x', title: 'X', developer_name: 'P', os: 'android', app_link: 'https://play/x', icon_url: null,
        initial_release: null, final_conclusion: 'Insight', batch: 'W3 Oct, 2026', evaluate_date: null,
        youtube_5min_link: null, youtube_20min_link: null,
        stores: [
          { os: 'ios', game_id: '1', eval_id: 2, app_link: 'https://apps/x', is_active: true, dead: false },
          { os: 'android', game_id: 'com.x', eval_id: 1, app_link: 'https://play/x', is_active: true, dead: false },
        ],
      }])
    })
    const games = await loadExportGames(['W3 Oct, 2026'], ['insight'])
    expect(has('.pair_back')).toBe(true)
    expect(games).toHaveLength(1)
    const [tab] = buildTabs(games, ['insight'])
    expect(tab.rows[0]).toEqual(['com.x', 'X', 'P', 'https://play/x', 'https://apps/x'])
  })
})
