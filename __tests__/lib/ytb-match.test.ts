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

  it('buildYtMap keys by title+bucket, prefers rows with an id, carries time', () => {
    const map = buildYtMap([
      { gameTitle: 'A', youtubeId: '', duration: '5mins', time: '' },
      { gameTitle: 'A', youtubeId: 'abc', duration: '5mins', time: '2026-06-26T10:00:00Z' },
      { gameTitle: 'A', youtubeId: 'xyz', duration: '20mins', time: '2026-06-27T11:00:00Z' },
      { gameTitle: '', youtubeId: 'skip', duration: '5mins', time: '' },
    ])
    expect(ytLookup(map, 'a', '5min')).toEqual({ id: 'abc', time: '2026-06-26T10:00:00Z' })
    expect(ytLookup(map, 'A', '20min')).toEqual({ id: 'xyz', time: '2026-06-27T11:00:00Z' })
    expect(ytLookup(map, 'A', '5min')?.id).toBe('abc')
    // empty-title row never lands a key
    expect(map.has(ytKey('', '5min'))).toBe(false)
    // unrelated lookup misses
    expect(ytLookup(map, 'B', '5min')).toBeUndefined()
  })

  it('a 20-min upload does not satisfy a 5-min lookup', () => {
    const map = buildYtMap([{ gameTitle: 'Solo', youtubeId: 'v20', duration: '20mins', time: '' }])
    expect(ytLookup(map, 'Solo', '20min')?.id).toBe('v20')
    expect(ytLookup(map, 'Solo', '5min')).toBeUndefined()
  })
})
