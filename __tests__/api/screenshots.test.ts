/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }))
jest.mock('@/lib/supabase-storage', () => ({
  isStorageConfigured: jest.fn(() => true),
  uploadScreenshot: jest.fn(),
  deleteScreenshotByUrl: jest.fn(),
  deleteGameScreenshots: jest.fn(),
}))

import { POST, DELETE } from '@/app/api/evaluations/[gameId]/screenshots/route'
import { sql } from '@/lib/db'
import { getServerSession } from 'next-auth'
import {
  isStorageConfigured, uploadScreenshot, deleteScreenshotByUrl, deleteGameScreenshots,
} from '@/lib/supabase-storage'

const sqlMock = sql as unknown as jest.Mock
const sessionMock = getServerSession as jest.Mock
const PARAMS = { params: { gameId: 'game123' } }

function pngFile(name = 'shot.png', bytes = 100): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' })
}

function postReq(files: File[]): NextRequest {
  const form = new FormData()
  files.forEach(f => form.append('files', f))
  return new NextRequest('http://localhost/api/evaluations/game123/screenshots', {
    method: 'POST',
    body: form,
  })
}

function deleteReq(body?: object): NextRequest {
  return new NextRequest('http://localhost/api/evaluations/game123/screenshots', {
    method: 'DELETE',
    body: JSON.stringify(body ?? {}),
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('screenshots route', () => {
  const realSkip = process.env.SKIP_AUTH
  beforeAll(() => { process.env.SKIP_AUTH = 'false' })
  afterAll(() => {
    if (realSkip === undefined) delete process.env.SKIP_AUTH
    else process.env.SKIP_AUTH = realSkip
  })

  beforeEach(() => {
    jest.clearAllMocks()
    ;(isStorageConfigured as jest.Mock).mockReturnValue(true)
    // default: admin session
    sessionMock.mockResolvedValue({ user: { role: 'admin', name: 'Boss' } })
    // default sql behavior: evaluator lookup + metadata update both succeed
    sqlMock.mockImplementation((strings: unknown) => {
      if (!Array.isArray(strings)) return Promise.resolve([])
      const q = (strings as string[]).join(' ')
      if (q.includes('SELECT initial_evaluator')) return Promise.resolve([{ initial_evaluator: 'Nam' }])
      if (q.includes('UPDATE game_info')) return Promise.resolve([{ urls: ['u1', 'u2'] }])
      if (q.includes('SELECT metadata')) return Promise.resolve([{ urls: [] }])
      return Promise.resolve([])
    })
  })

  it('401 without a session', async () => {
    sessionMock.mockResolvedValue(null)
    const res = await POST(postReq([pngFile()]), PARAMS)
    expect(res.status).toBe(401)
  })

  it('403 for an evaluator who is not assigned', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'SomeoneElse' } })
    const res = await POST(postReq([pngFile()]), PARAMS)
    expect(res.status).toBe(403)
  })

  it('allows the assigned evaluator', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'Nam' } })
    ;(uploadScreenshot as jest.Mock).mockResolvedValue('https://x/u1.png')
    const res = await POST(postReq([pngFile()]), PARAMS)
    expect(res.status).toBe(200)
  })

  it('503 when storage is not configured', async () => {
    ;(isStorageConfigured as jest.Mock).mockReturnValue(false)
    const res = await POST(postReq([pngFile()]), PARAMS)
    expect(res.status).toBe(503)
  })

  it('400 when more than 10 files', async () => {
    const res = await POST(postReq(Array.from({ length: 11 }, (_, i) => pngFile(`s${i}.png`))), PARAMS)
    expect(res.status).toBe(400)
  })

  it('rejects oversized and wrong-type files into failed[] without uploading them', async () => {
    ;(uploadScreenshot as jest.Mock).mockResolvedValue('https://x/ok.png')
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })
    const gif = new File([new Uint8Array(10)], 'anim.gif', { type: 'image/gif' })
    const res = await POST(postReq([pngFile('ok.png'), big, gif]), PARAMS)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(uploadScreenshot).toHaveBeenCalledTimes(1)
    expect(json.failed.map((f: { name: string }) => f.name).sort()).toEqual(['anim.gif', 'big.png'])
  })

  it('400 when every file is rejected', async () => {
    const gif = new File([new Uint8Array(10)], 'anim.gif', { type: 'image/gif' })
    const res = await POST(postReq([gif]), PARAMS)
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.failed).toEqual([{ name: 'anim.gif', error: 'Unsupported type' }])
    expect(uploadScreenshot).not.toHaveBeenCalled()
  })

  it('appends uploaded URLs to metadata and returns the full array', async () => {
    ;(uploadScreenshot as jest.Mock)
      .mockResolvedValueOnce('https://x/u1.png')
      .mockResolvedValueOnce('https://x/u2.png')
    const res = await POST(postReq([pngFile('a.png'), pngFile('b.png')]), PARAMS)
    const json = await res.json()
    expect(json.urls).toEqual(['u1', 'u2'])
    expect(json.failed).toEqual([])
    const updateCall = sqlMock.mock.calls.find(c => Array.isArray(c[0]) && (c[0] as string[]).join(' ').includes('UPDATE game_info'))
    expect(updateCall).toBeTruthy()
    // The uploaded URLs must be the jsonb parameter appended to the array.
    expect(updateCall!.slice(1)).toContain(JSON.stringify(['https://x/u1.png', 'https://x/u2.png']))
  })

  it('a failed upload lands in failed[] while successes persist', async () => {
    ;(uploadScreenshot as jest.Mock)
      .mockResolvedValueOnce('https://x/u1.png')
      .mockRejectedValueOnce(new Error('storage down'))
    const res = await POST(postReq([pngFile('a.png'), pngFile('b.png')]), PARAMS)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.failed).toEqual([{ name: 'b.png', error: 'storage down' }])
  })

  it('DELETE with url removes one object scoped to this game and filters metadata', async () => {
    const url = 'https://x/storage/v1/object/public/game-screenshots/game123/1-0.png'
    const res = await DELETE(deleteReq({ url }), PARAMS)
    expect(res.status).toBe(200)
    expect(deleteScreenshotByUrl).toHaveBeenCalledWith(url, 'game123')
  })

  it('DELETE without url clears everything', async () => {
    const res = await DELETE(deleteReq(), PARAMS)
    expect(res.status).toBe(200)
    expect(deleteGameScreenshots).toHaveBeenCalledWith('game123')
  })

  it('DELETE is forbidden for a non-assigned evaluator', async () => {
    sessionMock.mockResolvedValue({ user: { role: 'evaluator', name: 'SomeoneElse' } })
    const res = await DELETE(deleteReq(), PARAMS)
    expect(res.status).toBe(403)
  })
})
