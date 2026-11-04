/**
 * @jest-environment node
 */
import { NextRequest, NextResponse } from 'next/server'

jest.mock('@/lib/auth-guard', () => ({ requireAuth: jest.fn(async () => null) }))
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/drive-file-name', () => {
  const actual = jest.requireActual('@/lib/drive-file-name')
  return { ...actual, lookupDriveFileName: jest.fn() }
})

import { POST } from '@/app/api/evaluations/check-demo-link/route'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { lookupDriveFileName, titleFromDriveHtml } from '@/lib/drive-file-name'

const sqlMock = sql as unknown as jest.Mock
const lookup = lookupDriveFileName as jest.Mock
const LINK = 'https://drive.google.com/file/d/1RkrD1SUgo_g2vCD3rxOAJw5LB5fBIaTx/view'
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/evaluations/check-demo-link', {
  method: 'POST', body: JSON.stringify(body),
} as never))

describe('POST /api/evaluations/check-demo-link', () => {
  beforeEach(() => {
    sqlMock.mockReset(); lookup.mockReset()
    ;(requireAuth as jest.Mock).mockResolvedValue(null)
  })

  it('401 without a session', async () => {
    ;(requireAuth as jest.Mock).mockResolvedValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const res = await post({ gameId: 'g1', link: LINK })
    expect(res.status).toBe(401)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('400 without gameId or link', async () => {
    for (const body of [{}, { gameId: 'g1' }, { link: LINK }, { gameId: 5, link: LINK }, { gameId: 'g1', link: '' }]) {
      expect((await post(body)).status).toBe(400)
    }
    expect(sqlMock).not.toHaveBeenCalled()
  })

  it('unknown for a link that is not on Drive, without touching the DB or Drive', async () => {
    const res = await post({ gameId: 'g1', link: 'https://youtube.com/watch?v=x' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'unknown' })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(sqlMock).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('ok when the file is named after the game', async () => {
    sqlMock.mockResolvedValue([{ title: 'Ocean Crown', demo_code: 'QD6SF3' }])
    lookup.mockResolvedValue('Ocean Crown.mp4')
    const res = await post({ gameId: 'com.x', link: LINK })
    expect(await res.json()).toEqual({
      status: 'ok', fileName: 'Ocean Crown.mp4', expected: { code: 'QD6SF3', title: 'Ocean Crown' },
    })
    expect(lookup).toHaveBeenCalledWith('1RkrD1SUgo_g2vCD3rxOAJw5LB5fBIaTx')
  })

  it('mismatch when the file is named after another game', async () => {
    sqlMock.mockResolvedValue([{ title: 'Pocket Front PVP', demo_code: null }])
    lookup.mockResolvedValue('Ocean Crown.mp4')
    const res = await post({ gameId: '6823207281', link: LINK })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({
      status: 'mismatch', fileName: 'Ocean Crown.mp4', expected: { code: null, title: 'Pocket Front PVP' },
    })
  })

  it('unknown when the name lookup throws or finds nothing', async () => {
    sqlMock.mockResolvedValue([{ title: 'Ocean Crown', demo_code: null }])
    lookup.mockRejectedValueOnce(new Error('boom'))
    expect(await (await post({ gameId: 'g1', link: LINK })).json()).toEqual({ status: 'unknown' })
    lookup.mockResolvedValueOnce(null)
    expect(await (await post({ gameId: 'g1', link: LINK })).json()).toEqual({ status: 'unknown' })
  })

  it('unknown for a game that is not in game_info, or has no title and no code', async () => {
    sqlMock.mockResolvedValueOnce([])
    expect(await (await post({ gameId: 'nope', link: LINK })).json()).toEqual({ status: 'unknown' })
    sqlMock.mockResolvedValueOnce([{ title: null, demo_code: null }])
    expect(await (await post({ gameId: 'g1', link: LINK })).json()).toEqual({ status: 'unknown' })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('unknown when the DB read fails', async () => {
    sqlMock.mockRejectedValue(new Error('db down'))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post({ gameId: 'g1', link: LINK })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'unknown' })
    spy.mockRestore()
  })
})

describe('titleFromDriveHtml', () => {
  it('reads og:title and unescapes entities', () => {
    const html = '<html><head><meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;Run&quot;.mp4">'
      + '<title>Tom &amp; Jerry&#39;s &quot;Run&quot;.mp4 - Google Drive</title></head></html>'
    expect(titleFromDriveHtml(html)).toBe('Tom & Jerry\'s "Run".mp4')
  })

  it('falls back to <title> without the " - Google Drive" suffix', () => {
    expect(titleFromDriveHtml('<title>Ocean Crown.mp4 - Google Drive</title>')).toBe('Ocean Crown.mp4')
    expect(titleFromDriveHtml('<title>Caf&#xE9; &#8211; Days.mp4 - Google Drive</title>')).toBe('Café – Days.mp4')
  })

  it('reads og:title with content before property', () => {
    expect(titleFromDriveHtml('<meta content="Bloom Dash.mp4" property="og:title" />')).toBe('Bloom Dash.mp4')
  })

  it('null for the sign-in page and for a page without a title', () => {
    expect(titleFromDriveHtml('<html><head><title>Google Drive: Sign-in</title></head></html>')).toBeNull()
    expect(titleFromDriveHtml('<title>Sign in - Google Accounts</title>')).toBeNull()
    expect(titleFromDriveHtml('<title>Google Drive</title>')).toBeNull()
    expect(titleFromDriveHtml('<html><body>nothing</body></html>')).toBeNull()
    expect(titleFromDriveHtml('')).toBeNull()
  })
})
