/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/session', () => ({ getSession: jest.fn().mockResolvedValue(null) }))
jest.mock('@/lib/screenshot-store', () => ({
  isStorageConfigured: jest.fn(() => true),
  deleteGameScreenshots: jest.fn().mockResolvedValue(undefined),
}))

import { GET } from '@/app/api/evaluations/[gameId]/route'
import { sql } from '@/lib/db'
import { deleteGameScreenshots } from '@/lib/screenshot-store'

const sqlMock = sql as unknown as jest.Mock
const flush = () => new Promise(r => setTimeout(r, 0))

const store = (o: Record<string, unknown>) => ({
  os: 'ios', game_id: '111', eval_id: 1, app_link: 'https://apps.apple.com/x', is_active: true, dead: false,
  title: 'Foo', icon_url: 'i.png', release_date: '2026-10-01', publisher_name: 'Pub', publisher_link: null,
  screenshot_urls: null, manual_screenshot_urls: null, description: null, subtitle: null, content_rating: null,
  demo_code: null, record_code: null, conclusion: null, ...o,
})

// The front row is iOS (id 1, game 111); the back row is Android (id 2, game com.foo).
const FRONT = {
  id: 1, game_id: '111', os: 'ios', initial_conclusion: 'Bypass', demo_code: null, record_code: 'ABC123',
  screenshot_urls: null, manual_screenshot_urls: null, pair_eval_id: 2,
}

function setup(row: Record<string, unknown> | null) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('SELECT ge.id')) return Promise.resolve(row ? [{ ...row }] : [])
    return Promise.resolve([])
  })
}

describe('GET /api/evaluations/[gameId] for a linked pair', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => {
    if (realSkip === undefined) delete process.env.SKIP_AUTH
    else process.env.SKIP_AUTH = realSkip
  })
  beforeEach(() => jest.clearAllMocks())

  const open = (id: string, qs = '') => GET(new NextRequest(`http://localhost/api/evaluations/${id}${qs}`), { params: { gameId: id } })

  it('opening with the back store id returns the front row as data and selects the back store', async () => {
    setup({
      ...FRONT,
      pair_stores: [
        store({ os: 'ios', game_id: '111', eval_id: 1, record_code: 'ABC123', conclusion: 'Bypass' }),
        store({ os: 'android', game_id: 'com.foo', eval_id: 2, app_link: 'https://play.google.com/x', record_code: null, conclusion: 'Bypass' }),
      ],
    })
    const json = await (await open('com.foo')).json()
    expect(json.data.id).toBe(1)
    expect(json.data.game_id).toBe('111')
    expect(json.pair.selected_game_id).toBe('com.foo')
    expect(json.pair.stores.map((s: { os: string }) => s.os)).toEqual(['ios', 'android'])
    expect(json.pair.stores[1]).toMatchObject({ game_id: 'com.foo', eval_id: 2, dead: false, conclusion: 'Bypass' })
    // the internals of the query do not leak
    expect(json.data).not.toHaveProperty('pair_stores')
    expect(json.data).not.toHaveProperty('pair_eval_id')
  })

  it('sorts iOS first even when the query returns Android first', async () => {
    setup({
      ...FRONT,
      pair_stores: [store({ os: 'android', game_id: 'com.foo', eval_id: 2 }), store({ os: 'ios' })],
    })
    const json = await (await open('111')).json()
    expect(json.pair.stores.map((s: { os: string }) => s.os)).toEqual(['ios', 'android'])
    expect(json.pair.selected_game_id).toBe('111')
  })

  it('demo and record codes are the pair\'s: the front row\'s, else the twin\'s', async () => {
    setup({
      ...FRONT, demo_code: null, record_code: null,
      pair_stores: [store({ os: 'ios', demo_code: null }), store({ os: 'android', game_id: 'com.foo', eval_id: 2, demo_code: 'DEM999' })],
    })
    const json = await (await open('111')).json()
    expect(json.data.demo_code).toBe('DEM999')
    expect(json.data.record_code).toBeNull()
    expect(json.pair.stores.every((s: { demo_code: string }) => s.demo_code === 'DEM999')).toBe(true)
  })

  it('a game that is not linked returns pair: null and the same data as before', async () => {
    setup({ ...FRONT, pair_eval_id: null, pair_stores: null })
    const json = await (await open('111')).json()
    expect(json.pair).toBeNull()
    expect(json.data.id).toBe(1)
  })

  it('a missing game is a 404', async () => {
    setup(null)
    expect((await open('nope')).status).toBe(404)
  })

  it('screenshot rules apply to each store: the store with StoreKit drops its own manual copies', async () => {
    setup({
      ...FRONT,
      pair_stores: [
        store({ os: 'ios', screenshot_urls: ['s1'], manual_screenshot_urls: ['m1'] }),
        store({ os: 'android', game_id: 'com.foo', eval_id: 2, screenshot_urls: null, manual_screenshot_urls: ['m2'] }),
      ],
      screenshot_urls: ['s1'], manual_screenshot_urls: ['m1'],
    })
    const json = await (await open('com.foo')).json()
    expect(json.data.manual_screenshot_urls).toBeNull()
    expect(json.pair.stores[0].manual_screenshot_urls).toBeNull()
    expect(json.pair.stores[1].manual_screenshot_urls).toEqual(['m2'])
    await flush()
    expect(deleteGameScreenshots).toHaveBeenCalledTimes(1)
    expect(deleteGameScreenshots).toHaveBeenCalledWith('111')
  })

  it('keeps the hot path at two parallel reads: the pair comes from the one query (LATERAL), not a second one', async () => {
    setup({ ...FRONT, pair_stores: [store({}), store({ os: 'android', game_id: 'com.foo', eval_id: 2 })] })
    await open('com.foo', '?category=puzzle')
    const texts = sqlMock.mock.calls.map(c => (c[0] as string[]).join(' '))
    const rowQueries = texts.filter(t => t.includes('FROM game_evaluations'))
    expect(rowQueries).toHaveLength(1)
    expect(rowQueries[0]).toContain('LATERAL')
    expect(rowQueries[0]).toContain('rq.game_id =')
  })
})
