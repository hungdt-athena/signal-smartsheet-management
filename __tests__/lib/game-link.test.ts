import { parseStoreLink, looksLikeUrl } from '@/lib/game-link'

describe('lib/game-link', () => {
  it('parses iOS App Store links to the numeric id', () => {
    expect(parseStoreLink('https://apps.apple.com/us/app/color-pop-master/id6757068097'))
      .toEqual({ platform: 'ios', storeId: '6757068097' })
    expect(parseStoreLink('https://apps.apple.com/us/app/id6757068097?l=en'))
      .toEqual({ platform: 'ios', storeId: '6757068097' })
  })

  it('parses Google Play links to the package id', () => {
    expect(parseStoreLink('https://play.google.com/store/apps/details?id=com.foo.bar&hl=en'))
      .toEqual({ platform: 'android', storeId: 'com.foo.bar' })
  })

  it('returns null for non-store text', () => {
    expect(parseStoreLink('Color Pop Master')).toBeNull()
    expect(parseStoreLink('')).toBeNull()
    expect(parseStoreLink('https://example.com/foo')).toBeNull()
  })

  it('looksLikeUrl detects http(s) inputs', () => {
    expect(looksLikeUrl('  https://apps.apple.com/x ')).toBe(true)
    expect(looksLikeUrl('Color Pop')).toBe(false)
  })
})
