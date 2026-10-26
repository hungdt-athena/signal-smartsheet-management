import { normalizeTitle, durationBucket, ytKey, buildYtMap, ytLookup, resolveYtMatches } from '@/lib/ytb-match'

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

// Real prod misses: an upload only exists for an assigned game, so an upload no
// game claims exactly is a typo of one.
describe('resolveYtMatches', () => {
  const up = (gameTitle: string, duration: string, pic: string, id = gameTitle, time = '') =>
    ({ gameTitle, youtubeId: id, duration, pic, time })
  const one = (title: string, bucket: '5min' | '20min', recorder: string, rows: ReturnType<typeof up>[]) =>
    resolveYtMatches([{ key: 1, title, bucket, recorder }], rows).get(1)

  it('exact title+bucket still wins and carries no approx flag', () => {
    expect(one('Yarn Drop', '20min', 'KietCD', [up('Yarn Drop', '20', 'KietCD', 'a')])).toEqual({ id: 'a', time: '', pic: 'KietCD' })
  })

  it('tier A: sheet title is a word-prefix of the store title (dropped subtitle)', () => {
    expect(one('Ant Jam - Bus Color Master', '5min', 'QuangVN', [up('Ant Jam', '5', 'QuangVN', 'a')])?.id).toBe('a')
    expect(one('Tracewing: Word Search', '20min', 'ThuDT', [up('Tracewing Word Search Art', '20', 'ThuDT', 'a')])?.id).toBe('a')
  })

  it('tier A: one typo', () => {
    expect(one('Yarn Drop', '20min', 'KietCD', [up('Yan Drop', '20', 'KietCD', 'a')])?.id).toBe('a')
    expect(one('Snacky Traffic', '20min', 'MiTT', [up('Snacks Traffic', '20', 'MYTL', 'a')])?.id).toBe('a') // other uploader is fine
    expect(one('Peng Shot', '20min', 'KietCD', [up('Peng Short', '20', 'KietCD', 'a')])?.id).toBe('a')
  })

  it('tier B: shared words count only with the same recorder', () => {
    const rows = [up('Pixel Gem Loop - Sort Flow', '20', 'ThuDT', 'a')]
    expect(one('Pixel Gem Loop - Jewel Flow', '20min', 'ThuDT', rows)?.id).toBe('a')
    expect(one('Pixel Gem Loop - Jewel Flow', '20min', 'MiTT', rows)).toBeUndefined()
  })

  it('does not match unrelated titles that share a word or two', () => {
    expect(one('Jelly Color Jam: Color Sort', '20min', 'MiTT', [up('Word Jam Sort', '20', 'MiTT')])).toBeUndefined()
    expect(one('Gift Triple - Fruit Match Game', '5min', 'HuyDD', [up('Screw Triple Match', '5', 'MYTL')])).toBeUndefined()
    // one bare word is too common without the same recorder
    expect(one('Block Reveal!', '20min', 'MyTL', [up('Block', '20', 'ThuDT')])).toBeUndefined()
  })

  it('wrong duration: same title in the other bucket matches', () => {
    expect(one('Dig Treasure!', '5min', 'PhuongNT1', [up('Dig Treasure!', '15', 'PhuongNT1', 'a')])?.id).toBe('a')
  })

  it('wrong duration + typo needs the same recorder', () => {
    const rows = [up('Perfect Plan: Logic Puzzle', '20', 'KietCD', 'a')]
    expect(one('Perfect Plan: Logic Puzzles', '5min', 'KietCD', rows)?.id).toBe('a')
    expect(one('Perfect Plan: Logic Puzzles', '5min', 'ThuDT', rows)).toBeUndefined()
  })

  it('same bucket beats the other bucket', () => {
    const rows = [up('Peng Short', '5', 'KietCD', 'five'), up('Peng Short', '20', 'KietCD', 'twenty')]
    expect(one('Peng Shot', '20min', 'KietCD', rows)?.id).toBe('twenty')
  })

  it('never takes an upload another game matches exactly', () => {
    const out = resolveYtMatches(
      [{ key: 1, title: 'Peng Shot', bucket: '20min', recorder: 'KietCD' }, { key: 2, title: 'Peng Short', bucket: '20min', recorder: 'KietCD' }],
      [up('Peng Short', '20', 'KietCD', 'a')],
    )
    expect(out.get(2)?.id).toBe('a')
    expect(out.get(1)).toBeUndefined()
  })

  it('an upload that two different titles want equally goes to neither', () => {
    const out = resolveYtMatches(
      [{ key: 1, title: 'Tile Sort A', bucket: '5min', recorder: 'X' }, { key: 2, title: 'Tile Sort B', bucket: '5min', recorder: 'X' }],
      [up('Tile Sort', '5', 'X', 'a')],
    )
    expect(out.size).toBe(0)
  })

  it('android and ios rows with one title share the upload', () => {
    const out = resolveYtMatches(
      [{ key: 1, title: 'Ant Jam - Bus Color Master', bucket: '5min', recorder: 'Q' }, { key: 2, title: 'Ant Jam - Bus Color Master', bucket: '5min', recorder: 'Q' }],
      [up('Ant Jam', '5', 'Q', 'a')],
    )
    expect(out.get(1)?.id).toBe('a')
    expect(out.get(2)?.id).toBe('a')
  })

  it('records which upload title an approximate match came from', () => {
    expect(one('Yarn Drop', '20min', 'K', [up('Yan Drop', '20', 'K', 'a')])?.approx).toBe('Yan Drop')
  })

  // W3 Oct 2026: "Climb the Wall" took the August upload of "Blast the Wall"
  // on "the" + "wall" (2 of 3 words).
  it('tier B does not count filler words like "the"', () => {
    expect(one('Climb the Wall', '20min', 'KietCD', [up('Blast the Wall', '20', 'KietCD', 'a')])).toBeUndefined()
    // real words still carry it
    expect(one('Pixel Gem Loop - Diamond Sort', '20min', 'ThuDT', [up('Pixel Gem Loop - Sort Flow', '20', 'ThuDT', 'a')])?.id).toBe('a')
  })

  // W3 Oct 2026: "Car Loop Puzzle" (first assigned 13/10) took the 07/10 upload of
  // "Car Loop", a W1 Oct game the batch-scoped auto-sync could not see.
  it('an upload older than the day the game was first assigned is never its video', () => {
    const rows = [up('Car Loop', '20', 'KietCD', 'a', '2026-10-07 09:02:02')]
    const at = (since: string | null) =>
      resolveYtMatches([{ key: 1, title: 'Car Loop Puzzle', bucket: '20min', recorder: 'KietCD', since }], rows).get(1)
    expect(at('2026-10-13')).toBeUndefined()
    expect(at('2026-10-06')?.id).toBe('a')
    expect(at('2026-10-07')?.id).toBe('a')   // same day, whatever the timezone
    expect(at(null)?.id).toBe('a')           // no date, no gate
  })

  // A game recorded 5' in one batch and pulled into Record again for 20': its 5'
  // upload no longer matches its own title+bucket and looked unclaimed, so the
  // "wrong duration" rule handed it to the 20' round (migration 051).
  it('a game never takes the video it holds for its other bucket', () => {
    const rows = [up('Bus Flow 3D', '5', 'MYTL', 'five')]
    const as = (heldVideo: string | null) =>
      resolveYtMatches([{ key: 1, title: 'Bus Flow 3D', bucket: '20min', recorder: 'HuyDD', heldVideo }], rows).get(1)
    expect(as(null)?.id).toBe('five')      // the old behavior: wrong duration wins
    expect(as('five')).toBeUndefined()
  })

  it('a held video is still shared by exact title (the same game on the other OS)', () => {
    const out = resolveYtMatches([
      { key: 1, title: 'Bus Flow 3D', bucket: '20min', heldVideo: 'five' },
      { key: 2, title: 'Bus Flow 3D', bucket: '5min' },
    ], [up('Bus Flow 3D', '5', 'MYTL', 'five')])
    expect(out.get(2)?.id).toBe('five')
    expect(out.get(1)).toBeUndefined()
  })

  it('the gate only guards approximate matches, never an exact title', () => {
    const out = resolveYtMatches(
      [{ key: 1, title: 'Car Loop', bucket: '20min', recorder: 'KietCD', since: '2026-10-13' }],
      [up('Car Loop', '20', 'KietCD', 'a', '2026-10-07 09:02:02')],
    )
    expect(out.get(1)?.id).toBe('a')
  })
})
