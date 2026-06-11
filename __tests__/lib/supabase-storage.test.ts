/**
 * @jest-environment node
 */
import { isStorageConfigured, pathFromPublicUrl, deleteScreenshotByUrl } from '@/lib/supabase-storage'

describe('supabase-storage helpers', () => {
  const OLD_ENV = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY }
  afterEach(() => {
    if (OLD_ENV.url === undefined) delete process.env.SUPABASE_URL
    else process.env.SUPABASE_URL = OLD_ENV.url
    if (OLD_ENV.key === undefined) delete process.env.SUPABASE_SERVICE_KEY
    else process.env.SUPABASE_SERVICE_KEY = OLD_ENV.key
  })

  it('isStorageConfigured requires both env vars', () => {
    process.env.SUPABASE_URL = 'https://x.supabase.co'
    delete process.env.SUPABASE_SERVICE_KEY
    expect(isStorageConfigured()).toBe(false)
    process.env.SUPABASE_SERVICE_KEY = 'svc'
    expect(isStorageConfigured()).toBe(true)
    delete process.env.SUPABASE_URL
    expect(isStorageConfigured()).toBe(false)
  })

  it('pathFromPublicUrl extracts the object path from our bucket URLs', () => {
    expect(pathFromPublicUrl(
      'https://x.supabase.co/storage/v1/object/public/game-screenshots/game123/1717000000-0.png'
    )).toBe('game123/1717000000-0.png')
  })

  it('pathFromPublicUrl rejects foreign URLs', () => {
    expect(pathFromPublicUrl('https://x.supabase.co/storage/v1/object/public/other-bucket/a.png')).toBeNull()
    expect(pathFromPublicUrl('https://evil.com/storage/v1/object/public/game-screenshots/')).toBeNull()
    expect(pathFromPublicUrl('not a url')).toBeNull()
  })

  it('pathFromPublicUrl returns null on malformed percent-encoding', () => {
    expect(pathFromPublicUrl('https://x.supabase.co/storage/v1/object/public/game-screenshots/%zz')).toBeNull()
  })

  it('deleteScreenshotByUrl rejects URLs pointing at another game', async () => {
    await expect(deleteScreenshotByUrl(
      'https://x.supabase.co/storage/v1/object/public/game-screenshots/otherGame/1-0.png',
      'game123'
    )).rejects.toThrow('does not belong to this game')
  })
})
