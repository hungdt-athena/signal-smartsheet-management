/**
 * @jest-environment node
 */
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

// The local backend is the one that runs off Replit, so it is the one these
// tests exercise; the Replit branch only swaps where the bytes land.
const TMP = path.join(os.tmpdir(), `shots-test-${process.pid}`)
process.env.SCREENSHOT_LOCAL_DIR = TMP
process.env.SCREENSHOT_STORE = 'local'

import {
  backend, bucketName, checkStorage, deleteGameScreenshots, deleteScreenshotByUrl, isStorageConfigured,
  mimeForExt, objectNameFromUrl, readScreenshot, uploadScreenshot,
} from '@/lib/screenshot-store'

afterAll(async () => { await fs.rm(TMP, { recursive: true, force: true }) })

describe('backend selection', () => {
  const OLD = process.env.SCREENSHOT_STORE
  afterEach(() => { process.env.SCREENSHOT_STORE = OLD })

  it('honours an explicit choice', () => {
    process.env.SCREENSHOT_STORE = 'replit'
    expect(backend()).toBe('replit')
    process.env.SCREENSHOT_STORE = 'local'
    expect(backend()).toBe('local')
  })

  // The whole point of not sniffing for the sidecar: production must never
  // quietly write screenshots to a container disk that a redeploy wipes.
  it('defaults to replit in production and local outside it', () => {
    delete process.env.SCREENSHOT_STORE
    const oldNode = process.env.NODE_ENV
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true })
    expect(backend()).toBe('replit')
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'development', configurable: true })
    expect(backend()).toBe('local')
    Object.defineProperty(process.env, 'NODE_ENV', { value: oldNode, configurable: true })
  })

  // Nothing is left to leave unconfigured -- that was the reason to move off the
  // Supabase bucket, whose project could vanish while both env vars stayed set.
  it('reports storage as always available', () => {
    expect(isStorageConfigured()).toBe(true)
  })
})

describe('objectNameFromUrl', () => {
  it('extracts the object name from a URL we minted', () => {
    expect(objectNameFromUrl('/api/screenshots/game123/1717000000-0.png'))
      .toBe('screenshots/game123/1717000000-0.png')
  })

  it('decodes percent-encoded game ids', () => {
    expect(objectNameFromUrl('/api/screenshots/com.foo%2Fbar/1-0.png'))
      .toBe('screenshots/com.foo/bar/1-0.png')
  })

  it('rejects foreign URLs', () => {
    expect(objectNameFromUrl('https://x.supabase.co/storage/v1/object/public/game-screenshots/a.png')).toBeNull()
    expect(objectNameFromUrl('/api/screenshots/')).toBeNull()
    expect(objectNameFromUrl('not a url')).toBeNull()
  })

  it('rejects traversal and empty segments', () => {
    expect(objectNameFromUrl('/api/screenshots/game123/../other/1-0.png')).toBeNull()
    expect(objectNameFromUrl('/api/screenshots/%2E%2E/secrets.png')).toBeNull()
    expect(objectNameFromUrl('/api/screenshots/game123//1-0.png')).toBeNull()
  })

  it('returns null on malformed percent-encoding', () => {
    expect(objectNameFromUrl('/api/screenshots/%zz/a.png')).toBeNull()
  })
})

describe('local round trip', () => {
  it('uploads, serves back the same bytes, and deletes', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const url = await uploadScreenshot('game123', bytes, 'png', 0)
    expect(url).toMatch(/^\/api\/screenshots\/game123\/\d+-0\.png$/)

    const name = objectNameFromUrl(url)!
    expect(await readScreenshot(name)).toEqual(bytes)

    await deleteScreenshotByUrl(url, 'game123')
    expect(await readScreenshot(name)).toBeNull()
  })

  it('reports a missing object as null rather than throwing', async () => {
    expect(await readScreenshot('screenshots/game123/nope.png')).toBeNull()
  })

  it('clears every shot under one game and leaves other games alone', async () => {
    const a = await uploadScreenshot('gameA', Buffer.from([1]), 'png', 0)
    const b = await uploadScreenshot('gameA', Buffer.from([2]), 'png', 1)
    const keep = await uploadScreenshot('gameB', Buffer.from([3]), 'png', 0)

    await deleteGameScreenshots('gameA')

    expect(await readScreenshot(objectNameFromUrl(a)!)).toBeNull()
    expect(await readScreenshot(objectNameFromUrl(b)!)).toBeNull()
    expect(await readScreenshot(objectNameFromUrl(keep)!)).toEqual(Buffer.from([3]))
  })

  // Two shots staged in the same millisecond must not collide on one name.
  it('gives each index its own object name', async () => {
    const [x, y] = await Promise.all([
      uploadScreenshot('gameC', Buffer.from([1]), 'png', 0),
      uploadScreenshot('gameC', Buffer.from([2]), 'png', 1),
    ])
    expect(x).not.toEqual(y)
  })
})

describe('cross-game guard', () => {
  it('refuses a URL pointing at another game', async () => {
    await expect(deleteScreenshotByUrl('/api/screenshots/otherGame/1-0.png', 'game123'))
      .rejects.toThrow('does not belong to this game')
  })

  // A prefix that merely starts with the game id is a different game.
  it('refuses a neighbouring prefix', async () => {
    await expect(deleteScreenshotByUrl('/api/screenshots/game123evil/1-0.png', 'game123'))
      .rejects.toThrow('does not belong to this game')
  })

  it('refuses a URL it cannot parse', async () => {
    await expect(deleteScreenshotByUrl('https://evil.com/a.png', 'game123'))
      .rejects.toThrow('does not belong to this game')
  })
})

describe('mimeForExt', () => {
  it('maps the accepted extensions and nothing else', () => {
    expect(mimeForExt('png')).toBe('image/png')
    expect(mimeForExt('jpg')).toBe('image/jpeg')
    expect(mimeForExt('webp')).toBe('image/webp')
    expect(mimeForExt('svg')).toBe('application/octet-stream')
  })
})

describe('checkStorage', () => {
  it('round-trips a probe and cleans up after itself', async () => {
    const res = await checkStorage()
    expect(res).toEqual({ ok: true, backend: 'local', bucket: null })

    // The probe must not linger as a fake game in the store.
    const left = await fs.readdir(path.join(TMP, 'screenshots')).catch(() => [])
    expect(left).not.toContain('.storage-check')
  })

  it('reports the pinned bucket when one is set', async () => {
    process.env.SCREENSHOT_BUCKET = 'storekitScreenshot'
    expect(bucketName()).toBe('storekitScreenshot')
    expect((await checkStorage()).bucket).toBe('storekitScreenshot')
    delete process.env.SCREENSHOT_BUCKET
  })

  // The whole point: a broken backend has to come back as a failure, not as ok.
  it('names the step that failed instead of claiming success', async () => {
    process.env.SCREENSHOT_LOCAL_DIR = '/dev/null/nope'
    jest.resetModules()
    const mod = await import('@/lib/screenshot-store')
    const res = await mod.checkStorage()
    expect(res.ok).toBe(false)
    expect(res.step).toBe('upload')
    expect(res.error).toBeTruthy()
    process.env.SCREENSHOT_LOCAL_DIR = TMP
    jest.resetModules()
  })
})
