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
    expect(ytLookup(map, 'a', '5min')).toEqual({ id: 'abc', time: '2026-06-26T10:00:00Z', pic: '' })
    expect(ytLookup(map, 'A', '20min')).toEqual({ id: 'xyz', time: '2026-06-27T11:00:00Z', pic: '' })
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

  // Real prod misses: the store title and the sheet title were typed with
  // different punctuation, so the exact key never matched and four uploaded
  // videos read as "recorded, no link".
  it('folds typographic punctuation to ASCII', () => {
    expect(normalizeTitle('Rotate’n Match')).toBe(normalizeTitle("Rotate'n Match"))
    expect(normalizeTitle('Match Me Out！')).toBe(normalizeTitle('Match Me Out!'))
    expect(normalizeTitle('Merge – Idle')).toBe(normalizeTitle('Merge - Idle'))
  })

  it('matches across punctuation the other side dropped entirely', () => {
    const map = buildYtMap([
      { gameTitle: 'Cube Pop 3D', youtubeId: 'cp3', duration: '20', time: '' },
      { gameTitle: 'Pop’n Sort', youtubeId: 'pns', duration: '20', time: '' },
    ])
    expect(ytLookup(map, 'Cube Pop 3D!', '20min')?.id).toBe('cp3')   // loose fallback
    expect(ytLookup(map, "Pop'n Sort", '20min')?.id).toBe('pns')     // punctuation fold
    // the fallback is still bucket-scoped
    expect(ytLookup(map, 'Cube Pop 3D!', '5min')).toBeUndefined()
  })

  it('refuses to guess when two different games share a loose key', () => {
    const map = buildYtMap([
      { gameTitle: 'Sort It!', youtubeId: 'one', duration: '5', time: '2026-01-01 10:00:00' },
      { gameTitle: 'Sort-It', youtubeId: 'two', duration: '5', time: '2026-01-02 10:00:00' },
    ])
    // exact titles still resolve
    expect(ytLookup(map, 'Sort It!', '5min')?.id).toBe('one')
    expect(ytLookup(map, 'Sort-It', '5min')?.id).toBe('two')
    // a third spelling is ambiguous → no match rather than a wrong link
    expect(ytLookup(map, 'Sort It', '5min')).toBeUndefined()
  })

  it('a title with nothing alphanumeric gets no loose key', () => {
    const map = buildYtMap([{ gameTitle: '★★★', youtubeId: 'stars', duration: '5', time: '' }])
    expect(ytLookup(map, '★★★', '5min')?.id).toBe('stars')
    expect(ytLookup(map, '☆☆☆', '5min')).toBeUndefined()
  })
})
