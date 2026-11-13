/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/session', () => ({ getSession: jest.fn() }))
jest.mock('@/lib/ytb-cache', () => ({ getYtbUploaded: jest.fn(), invalidateYtbCache: jest.fn() }))
jest.mock('@/lib/ytb-mirror', () => ({ mirrorYtbUploads: jest.fn() }))
jest.mock('@/lib/google-sheets', () => ({ updateYtbRow: jest.fn() }))

import { NextRequest } from 'next/server'
import { GET, PATCH, DELETE } from '@/app/api/youtube/videos/route'
import { sql } from '@/lib/db'
import { getSession } from '@/lib/session'
import { getYtbUploaded, invalidateYtbCache } from '@/lib/ytb-cache'
import { mirrorYtbUploads } from '@/lib/ytb-mirror'
import { updateYtbRow } from '@/lib/google-sheets'
import { parseUploadTitle, titleError } from '@/lib/youtube-manage'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getSession as unknown as jest.Mock
const rowsMock = getYtbUploaded as unknown as jest.Mock
const updateMock = updateYtbRow as unknown as jest.Mock
const mirrorMock = mirrorYtbUploads as unknown as jest.Mock
const fetchMock = jest.fn()

const ID = 'XfZFRn17xwA'
const row = {
  row_index: 12, fileId: 'f1', time: '2026-11-05 10:00:00', status: 'DONE',
  fileName: 'Word Brick Sort_ThuDT_20mins.MP4', youtubeId: ID, gameTitle: 'Word Brick Sort', pic: 'ThuDT', duration: '20',
}
const req = (method: string, body: unknown) =>
  new NextRequest('http://x/api/youtube/videos', { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const n8nReply = (body: unknown, status = 200) => fetchMock.mockResolvedValue({ ok: status < 300, status, json: async () => body })

describe('/api/youtube/videos', () => {
  const env = { ...process.env }
  beforeAll(() => {
    process.env.SKIP_AUTH = 'false'
    process.env.WEBHOOK_YTB_MANAGE = 'https://n8n.test/webhook/ytb-manage'
    process.env.WEBHOOK_SECRET = 's3cret'
    global.fetch = fetchMock as unknown as typeof fetch
  })
  afterAll(() => { process.env = env })
  beforeEach(() => {
    jest.clearAllMocks()
    sessionMock.mockResolvedValue({ user: { email: 'boss@x.io', name: 'Boss', role: 'admin' } })
    rowsMock.mockResolvedValue([row])
    sqlMock.mockResolvedValue({ count: 1 })
    mirrorMock.mockResolvedValue({ rows: 1, synced_at: '' })
  })

  it('is for managers only', async () => {
    sessionMock.mockResolvedValue({ user: { email: 'e@x.io', role: 'evaluator' } })
    expect((await DELETE(req('DELETE', { row_index: 12, youtubeId: ID }))).status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses when the sheet row no longer holds that video (rows shift)', async () => {
    rowsMock.mockResolvedValue([{ ...row, youtubeId: 'otherVideo1' }])
    const res = await DELETE(req('DELETE', { row_index: 12, youtubeId: ID }))
    expect(res.status).toBe(409)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('delete: calls n8n with the secret, marks the row DELETED, clears the id and the DB links', async () => {
    n8nReply({ ok: true, action: 'delete', youtubeId: ID, gone: false })
    const res = await DELETE(req('DELETE', { row_index: 12, youtubeId: ID }))
    expect(res.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://n8n.test/webhook/ytb-manage')
    expect(init.headers['x-webhook-secret']).toBe('s3cret')
    expect(JSON.parse(init.body)).toEqual({ action: 'delete', youtubeId: ID, by: 'boss@x.io' })
    expect(updateMock).toHaveBeenCalledWith(12, { status: 'DELETED', youtubeId: '' })
    expect(sqlMock).toHaveBeenCalledTimes(1)
    expect(invalidateYtbCache).toHaveBeenCalled()
    expect(mirrorMock).toHaveBeenCalled()
  })

  it('delete: a video already gone from YouTube still frees the row', async () => {
    n8nReply({ ok: true, action: 'delete', youtubeId: ID, gone: true })
    const res = await DELETE(req('DELETE', { row_index: 12, youtubeId: ID }))
    expect(res.status).toBe(200)
    expect((await res.json()).gone).toBe(true)
    expect(updateMock).toHaveBeenCalledWith(12, { status: 'DELETED', youtubeId: '' })
  })

  it('delete: a YouTube failure changes nothing', async () => {
    n8nReply({ ok: false, action: 'delete', error: 'delete_failed_403: forbidden' })
    const res = await DELETE(req('DELETE', { row_index: 12, youtubeId: ID }))
    expect(res.status).toBe(502)
    expect(updateMock).not.toHaveBeenCalled()
    expect(sqlMock).not.toHaveBeenCalled()
  })

  it('rename: writes only fileName (F:H are an ARRAYFORMULA), and returns the derived fields for the UI', async () => {
    n8nReply({ ok: true, action: 'rename', youtubeId: ID, title: 'Word Brick Sort 2_HuyDD_5mins', old_title: row.fileName })
    const res = await PATCH(req('PATCH', { row_index: 12, youtubeId: ID, title: '  Word Brick Sort 2_HuyDD_5mins ' }))
    expect(res.status).toBe(200)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: 'rename', youtubeId: ID, title: 'Word Brick Sort 2_HuyDD_5mins', by: 'boss@x.io' })
    // A literal in game title / pic / duration blocks the formula: the whole column goes #REF!.
    expect(updateMock).toHaveBeenCalledWith(12, { fileName: 'Word Brick Sort 2_HuyDD_5mins' })
    expect((await res.json()).updates).toEqual({ fileName: 'Word Brick Sort 2_HuyDD_5mins', gameTitle: 'Word Brick Sort 2', pic: 'HuyDD', duration: '5' })
    expect(sqlMock).not.toHaveBeenCalled()
  })

  it('rename: a free-form title only changes the file name column', async () => {
    n8nReply({ ok: true, action: 'rename', youtubeId: ID, title: 'Gameplay trailer' })
    await PATCH(req('PATCH', { row_index: 12, youtubeId: ID, title: 'Gameplay trailer' }))
    expect(updateMock).toHaveBeenCalledWith(12, { fileName: 'Gameplay trailer' })
  })

  it('rename: rejects a bad title before calling YouTube', async () => {
    const res = await PATCH(req('PATCH', { row_index: 12, youtubeId: ID, title: 'a<b' }))
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rename: video missing on the channel is a 404', async () => {
    n8nReply({ ok: false, action: 'rename', error: 'not_found' })
    expect((await PATCH(req('PATCH', { row_index: 12, youtubeId: ID, title: 'X' }))).status).toBe(404)
    expect(updateMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/youtube/videos (real title + length)', () => {
  beforeAll(() => {
    process.env.SKIP_AUTH = 'false'
    process.env.WEBHOOK_YTB_MANAGE = 'https://n8n.test/webhook/ytb-manage'
    process.env.WEBHOOK_SECRET = 's3cret'
    global.fetch = fetchMock as unknown as typeof fetch
  })
  beforeEach(() => {
    jest.clearAllMocks()
    sessionMock.mockResolvedValue({ user: { email: 'e@x.io', role: 'evaluator' } })
  })
  const get = (ids: string) => GET(new NextRequest(`http://x/api/youtube/videos?ids=${ids}`))

  it('asks n8n once, then answers from cache; unknown ids come back null', async () => {
    n8nReply({ ok: true, action: 'info', items: [{ id: 'AAAAAAAAAA1', title: 'Real title', duration_s: 1281, privacy: 'unlisted' }] })
    const body = await (await get('AAAAAAAAAA1,BBBBBBBBBB2')).json()
    expect(body.items).toEqual({ AAAAAAAAAA1: { id: 'AAAAAAAAAA1', title: 'Real title', duration_s: 1281, privacy: 'unlisted' }, BBBBBBBBBB2: null })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: 'info', ids: ['AAAAAAAAAA1', 'BBBBBBBBBB2'] })
    await get('AAAAAAAAAA1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects bad ids without calling n8n', async () => {
    expect((await get('nope')).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('youtube-manage helpers', () => {
  it('parses the upload title format the n8n scanner uses', () => {
    expect(parseUploadTitle('Pixel Sand Blast_ThuDT_5mins.mp4')).toEqual({ gameTitle: 'Pixel Sand Blast', pic: 'ThuDT', duration: '5' })
    expect(parseUploadTitle('Pixel Sand Blast')).toBeNull()
  })
  it('checks YouTube title rules', () => {
    expect(titleError('')).toBeTruthy()
    expect(titleError('x'.repeat(101))).toBeTruthy()
    expect(titleError('ok title')).toBeNull()
  })
})
