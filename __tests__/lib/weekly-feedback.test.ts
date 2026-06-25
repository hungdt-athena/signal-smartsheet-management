import { sanitizeSections, legacyToSections, rowToSections, isSafeHref, sanitizeAlikeGames } from '@/lib/weekly-feedback'

describe('lib/weekly-feedback', () => {
  it('folds a legacy single `alike` object into `alikes[]`', () => {
    const out = sanitizeSections([
      { id: 'a', feedback: null, alike: { name: 'Match-3', games: [{ title: 'X', app_link: 'https://x', manual: true }] } },
    ])
    expect(out).toEqual([
      { id: 'a', feedback: null, alikes: [{ name: 'Match-3', games: [{ game_id: null, title: 'X', app_link: 'https://x', icon_url: null, manual: true }] }] },
    ])
  })

  it('passes through a new `alikes[]` array and drops fully-empty blocks', () => {
    const out = sanitizeSections([
      { id: 'b', feedback: null, alikes: [{ name: '', games: [] }, { name: 'Arrow', games: [] }] },
    ])
    expect(out[0].alikes).toEqual([{ name: 'Arrow', games: [] }])
  })

  it('strips a link mark with an unsafe href (regression)', () => {
    const doc = { type: 'doc', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }
    const out = sanitizeSections([{ id: 'c', feedback: doc, alikes: [] }])
    const marks = (out[0].feedback as any).content[0].marks
    expect(marks).toEqual([])
    expect(isSafeHref('javascript:alert(1)')).toBe(false)
    expect(isSafeHref('https://ok')).toBe(true)
  })

  it('legacyToSections wraps collected games into one block', () => {
    const out = legacyToSections({ type: 'doc', content: [] }, [{ games: [{ title: 'G', app_link: 'https://g', manual: false }] }])
    expect(out[0].alikes).toEqual([{ name: '', games: [{ game_id: null, title: 'G', app_link: 'https://g', icon_url: null, manual: true }] }])
  })

  it('rowToSections prefers sections and folds legacy alike on read', () => {
    expect(rowToSections({ sections: [{ id: 's', feedback: null, alike: { name: 'N', games: [] } }] })[0].alikes).toEqual([{ name: 'N', games: [] }])
    expect(rowToSections({ feedback: null, game_alike: [{ games: [] }] })).toEqual([])
  })

  it('sanitizeAlikeGames keeps safe games, drops blanks and unsafe links', () => {
    expect(sanitizeAlikeGames([
      { game_id: 'g1', title: 'Candy', app_link: 'https://a', icon_url: 'https://i', manual: false },
      { title: '   ', app_link: 'https://b', manual: true },
      { title: 'Bad', app_link: 'javascript:alert(1)', manual: true },
    ])).toEqual([
      { game_id: 'g1', title: 'Candy', app_link: 'https://a', icon_url: 'https://i', manual: false },
      { game_id: null, title: 'Bad', app_link: null, icon_url: null, manual: true },
    ])
  })

  it('sanitizeAlikeGames returns [] for non-arrays', () => {
    expect(sanitizeAlikeGames(null)).toEqual([])
    expect(sanitizeAlikeGames({})).toEqual([])
  })
})
