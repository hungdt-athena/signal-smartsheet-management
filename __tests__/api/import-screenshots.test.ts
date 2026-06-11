/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({
  sql: Object.assign(jest.fn(), { json: (v: unknown) => v }),
}))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/supabase-storage', () => ({
  isStorageConfigured: jest.fn(() => true),
  uploadScreenshot: jest.fn(),
}))

import { POST } from '@/app/api/admin/import-screenshots/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'
import { isStorageConfigured, uploadScreenshot } from '@/lib/supabase-storage'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as jest.Mock
const SECRET = 'test-secret'

function post(body: unknown, withSecret = true) {
  return POST(new NextRequest('http://localhost/api/admin/import-screenshots', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: withSecret
      ? { 'Content-Type': 'application/json', 'x-webhook-secret': SECRET }
      : { 'Content-Type': 'application/json' },
  }))
}

function mockStates(states: { game_id: string; has_storekit?: boolean; has_manual?: boolean }[]) {
  sqlMock.mockImplementation((strings: unknown) => {
    if (!Array.isArray(strings)) return Promise.resolve([])
    const q = (strings as string[]).join(' ')
    if (q.includes('SELECT game_id')) {
      return Promise.resolve(states.map(s => ({
        game_id: s.game_id, has_storekit: !!s.has_storekit, has_manual: !!s.has_manual,
      })))
    }
    return Promise.resolve([])
  })
}

function mockImageFetch(contentType = 'image/png', bytes = 100, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    arrayBuffer: async () => new ArrayBuffer(bytes),
  })
}

describe('POST /api/admin/import-screenshots', () => {
  const realFetch = global.fetch
  const realSecret = process.env.WEBHOOK_SECRET
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.WEBHOOK_SECRET = SECRET; process.env.SKIP_AUTH = 'false' })
  afterAll(() => {
    global.fetch = realFetch
    if (realSecret === undefined) delete process.env.WEBHOOK_SECRET
    else process.env.WEBHOOK_SECRET = realSecret
    if (realSkip === undefined) delete process.env.SKIP_AUTH
    else process.env.SKIP_AUTH = realSkip
  })
  beforeEach(() => {
    jest.clearAllMocks()
    ;(isStorageConfigured as jest.Mock).mockReturnValue(true)
    sessionMock.mockResolvedValue(null)
    mockStates([])
  })

  it('401 without secret or admin session', async () => {
    const res = await post({ items: [] }, false)
    expect(res.status).toBe(401)
  })

  it('allows an admin session without the secret', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'Boss' } })
    const res = await post({ items: [] }, false)
    expect(res.status).toBe(200)
  })

  it('503 when storage unconfigured', async () => {
    ;(isStorageConfigured as jest.Mock).mockReturnValue(false)
    const res = await post({ items: [] })
    expect(res.status).toBe(503)
  })

  it('400 when items missing or too many', async () => {
    expect((await post({})).status).toBe(400)
    const many = Array.from({ length: 51 }, (_, i) => ({ game_id: `g${i}`, image_urls: ['https://t/a.png'] }))
    expect((await post({ items: many })).status).toBe(400)
  })

  it('skips not-found, has-storekit and has-manual games without downloading', async () => {
    mockStates([
      { game_id: 'sk', has_storekit: true },
      { game_id: 'man', has_manual: true },
    ])
    mockImageFetch()
    const res = await post({ items: [
      { game_id: 'sk', image_urls: ['https://t/a.png'] },
      { game_id: 'man', image_urls: ['https://t/b.png'] },
      { game_id: 'ghost', image_urls: ['https://t/c.png'] },
    ] })
    const json = await res.json()
    expect(json.skipped_has_storekit).toBe(1)
    expect(json.skipped_has_manual).toBe(1)
    expect(json.skipped_not_found).toBe(1)
    expect(json.uploaded).toBe(0)
    expect(uploadScreenshot).not.toHaveBeenCalled()
  })

  it('downloads, uploads and appends metadata with the raw URL array (sql.json)', async () => {
    mockStates([{ game_id: 'g1' }])
    mockImageFetch('image/png')
    ;(uploadScreenshot as jest.Mock).mockResolvedValue('https://supa/x.png')
    const res = await post({ items: [{ game_id: 'g1', image_urls: ['https://t/a.png'] }] })
    const json = await res.json()
    expect(json.uploaded).toBe(1)
    expect(json.failed).toEqual([])
    const updateCall = sqlMock.mock.calls.find(c =>
      Array.isArray(c[0]) && (c[0] as string[]).join(' ').includes('UPDATE game_info'))
    expect(updateCall).toBeTruthy()
    expect(updateCall!.slice(1)).toContainEqual(['https://supa/x.png'])
  })

  it('download HTTP failure lands in failed[]', async () => {
    mockStates([{ game_id: 'g1' }])
    mockImageFetch('image/png', 100, 403)
    const res = await post({ items: [{ game_id: 'g1', image_urls: ['https://t/a.png'] }] })
    const json = await res.json()
    expect(json.uploaded).toBe(0)
    expect(json.failed).toEqual([{ game_id: 'g1', error: 'download HTTP 403' }])
  })

  it('non-image content-type lands in failed[]', async () => {
    mockStates([{ game_id: 'g1' }])
    mockImageFetch('text/html')
    const res = await post({ items: [{ game_id: 'g1', image_urls: ['https://t/a.png'] }] })
    const json = await res.json()
    expect(json.failed).toEqual([{ game_id: 'g1', error: 'unsupported type text/html' }])
  })
})
