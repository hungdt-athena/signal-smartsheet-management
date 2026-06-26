import { normalizeTitle, durationBucket, ytKey, buildYtMap, ytLookup } from '@/lib/ytb-match'

describe('lib/ytb-match', () => {
  it('normalizeTitle strips accents/case/extra spaces', () => {
    expect(normalizeTitle('  Screw  Jaming ')).toBe('screw jaming')
    expect(normalizeTitle('Yàrrów')).toBe('yarrow')
    expect(normalizeTitle('')).toBe('')
  })

  it('durationBucket parses leading number, >=15 → 20min', () => {
    expect(durationBucket('5')).toBe('5min')
    expect(durationBucket('5mins')).toBe('5min')
    expect(durationBucket('20')).toBe('20min')
    expect(durationBucket('20mins')).toBe('20min')
    expect(durationBucket('')).toBe('5min')
    expect(durationBucket('garbage')).toBe('5min')
  })

  it('buildYtMap keys by title+bucket and prefers rows with an id', () => {
    const map = buildYtMap([
      { gameTitle: 'A', youtubeId: '', duration: '5mins' },
      { gameTitle: 'A', youtubeId: 'abc', duration: '5mins' },
      { gameTitle: 'A', youtubeId: 'xyz', duration: '20mins' },
      { gameTitle: '', youtubeId: 'skip', duration: '5mins' },
    ])
    expect(ytLookup(map, 'a', '5min')).toBe('abc')
    expect(ytLookup(map, 'A', '20min')).toBe('xyz')
    expect(ytLookup(map, 'A', '5min')).toBe('abc')
    // empty-title row never lands a key
    expect(map.has(ytKey('', '5min'))).toBe(false)
    // unrelated lookup misses
    expect(ytLookup(map, 'B', '5min')).toBeUndefined()
  })

  it('a 20-min upload does not satisfy a 5-min lookup', () => {
    const map = buildYtMap([{ gameTitle: 'Solo', youtubeId: 'v20', duration: '20mins' }])
    expect(ytLookup(map, 'Solo', '20min')).toBe('v20')
    expect(ytLookup(map, 'Solo', '5min')).toBeUndefined()
  })
})
