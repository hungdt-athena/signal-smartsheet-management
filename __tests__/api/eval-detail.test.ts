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
import { isStorageConfigured, deleteGameScreenshots } from '@/lib/screenshot-store'
import { getSession } from '@/lib/session'

const sqlMock = sql as unknown as jest.Mock
const PARAMS = { params: { gameId: 'game123' } }

function setupRow(row: Record<string, unknown>) {
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('SELECT ge.id')) return Promise.resolve([row])
    return Promise.resolve([])
  })
}

function metadataClearCalled(): boolean {
  return sqlMock.mock.calls.some(c =>
    Array.isArray(c[0]) && (c[0] as string[]).join(' ').includes("- 'manual_screenshot_urls'"))
}

const flush = () => new Promise(r => setTimeout(r, 0))

describe('GET /api/evaluations/[gameId] manual screenshots', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => {
    if (realSkip === undefined) delete process.env.SKIP_AUTH
    else process.env.SKIP_AUTH = realSkip
  })
  beforeEach(() => {
    jest.clearAllMocks()
    ;(isStorageConfigured as jest.Mock).mockReturnValue(true)
  })

  const req = new NextRequest('http://localhost/api/evaluations/game123')

  it('returns manual URLs when StoreKit is absent', async () => {
    setupRow({ game_id: 'game123', screenshot_urls: null, manual_screenshot_urls: ['m1', 'm2'] })
    const res = await GET(req, PARAMS)
    const json = await res.json()
    expect(json.data.manual_screenshot_urls).toEqual(['m1', 'm2'])
    expect(deleteGameScreenshots).not.toHaveBeenCalled()
  })

  it('returns StoreKit and triggers cleanup when both exist', async () => {
    setupRow({ game_id: 'game123', screenshot_urls: ['s1'], manual_screenshot_urls: ['m1'] })
    const res = await GET(req, PARAMS)
    const json = await res.json()
    expect(json.data.screenshot_urls).toEqual(['s1'])
    expect(json.data.manual_screenshot_urls).toBeNull()
    await flush()
    expect(deleteGameScreenshots).toHaveBeenCalledWith('game123')
    expect(metadataClearCalled()).toBe(true)
  })

  it('does not clean up when storage is unconfigured', async () => {
    ;(isStorageConfigured as jest.Mock).mockReturnValue(false)
    setupRow({ game_id: 'game123', screenshot_urls: ['s1'], manual_screenshot_urls: ['m1'] })
    const res = await GET(req, PARAMS)
    const json = await res.json()
    expect(json.data.manual_screenshot_urls).toBeNull()
    await flush()
    expect(deleteGameScreenshots).not.toHaveBeenCalled()
    expect(metadataClearCalled()).toBe(false)
  })

  it('plain StoreKit-only games are untouched', async () => {
    setupRow({ game_id: 'game123', screenshot_urls: ['s1'], manual_screenshot_urls: null })
    const res = await GET(req, PARAMS)
    const json = await res.json()
    expect(json.data.screenshot_urls).toEqual(['s1'])
    await flush()
    expect(deleteGameScreenshots).not.toHaveBeenCalled()
  })
})

// A game can have one row per genre (UNIQUE(game_id, category_group)). 438 games had
// two on 2026-09-24, each assigned to a different person. The Evaluate list is
// per genre, and the panel asked for the game by id alone, so it opened whichever
// row came back first: DuyenLP's pending puzzle game showed HuyDD's arcade
// evaluation, she could not save hers, and a manager's save landed in his.
describe('GET /api/evaluations/[gameId] with a row in two genres', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'true' })
  afterAll(() => {
    if (realSkip === undefined) delete process.env.SKIP_AUTH
    else process.env.SKIP_AUTH = realSkip
  })

  const huy = { id: 1, game_id: 'game123', category_group: 'arcade', initial_evaluator: 'HuyDD', initial_conclusion: 'Bypass' }
  const duyen = { id: 2, game_id: 'game123', category_group: 'puzzle', initial_evaluator: 'DuyenLP', initial_conclusion: null }

  function setupRows(rows: Record<string, unknown>[]) {
    sqlMock.mockReset()
    sqlMock.mockImplementation((strings: unknown, ...values: unknown[]) => {
      if (!Array.isArray(strings)) return Promise.resolve([])
      const q = (strings as string[]).join(' ')
      if (q.includes('SELECT ge.id')) {
        // The category filter arrives as a nested fragment; model it by value.
        const cat = values.find(v => v === 'puzzle' || v === 'arcade')
        return Promise.resolve(cat ? rows.filter(r => r.category_group === cat) : rows)
      }
      return Promise.resolve([])
    })
    // Fragments (sql`AND ...`) are called with a strings array too; pass values through.
  }

  it("opens the caller's own row when no genre is given", async () => {
    setupRows([huy, duyen])
    ;(getSession as jest.Mock).mockResolvedValue({ user: { name: 'DuyenLP', role: 'evaluator' } })
    const res = await GET(new NextRequest('http://localhost/api/evaluations/game123'), PARAMS)
    const json = await res.json()
    expect(json.data.id).toBe(2)
    expect(json.data.initial_evaluator).toBe('DuyenLP')
  })

  it('matches the name case-insensitively (imported names drift: Huydd vs HuyDD)', async () => {
    setupRows([duyen, huy])
    ;(getSession as jest.Mock).mockResolvedValue({ user: { name: 'huydd', role: 'evaluator' } })
    const json = await (await GET(new NextRequest('http://localhost/api/evaluations/game123'), PARAMS)).json()
    expect(json.data.id).toBe(1)
  })

  it('falls back to the first row when neither is the caller\'s', async () => {
    setupRows([huy, duyen])
    ;(getSession as jest.Mock).mockResolvedValue({ user: { name: 'HungDT', role: 'admin' } })
    const json = await (await GET(new NextRequest('http://localhost/api/evaluations/game123'), PARAMS)).json()
    expect(json.data.id).toBe(1)
  })

  it('orders the rows by id so that first row is always the same one', async () => {
    setupRows([huy])
    await GET(new NextRequest('http://localhost/api/evaluations/game123'), PARAMS)
    const q = sqlMock.mock.calls.map(c => (Array.isArray(c[0]) ? (c[0] as string[]).join(' ') : '')).find(t => t.includes('SELECT ge.id'))
    expect(q?.replace(/\s+/g, ' ')).toContain('ORDER BY ge.id')
  })
})
