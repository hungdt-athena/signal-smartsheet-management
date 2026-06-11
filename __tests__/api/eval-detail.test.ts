/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/supabase-storage', () => ({
  isStorageConfigured: jest.fn(() => true),
  deleteGameScreenshots: jest.fn().mockResolvedValue(undefined),
}))

import { GET } from '@/app/api/evaluations/[gameId]/route'
import { sql } from '@/lib/db'
import { isStorageConfigured, deleteGameScreenshots } from '@/lib/supabase-storage'

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
