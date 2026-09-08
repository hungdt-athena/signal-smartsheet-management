import {
  splitOnMatch, wordStartPattern, POSITIVE_FINAL_CONCLUSIONS,
} from '@/lib/eval-search'

// Splitting a label around what the user typed, for the highlight in the results table.
// It has to agree with what the server matched on: ILIKE '%term%', which is
// case-insensitive, finds every occurrence, and treats the term as literal text.

describe('splitOnMatch', () => {
  it('marks the matched run and leaves the rest alone', () => {
    expect(splitOnMatch('Merge Whale', 'whale')).toEqual([
      { text: 'Merge ', hit: false },
      { text: 'Whale', hit: true },
    ])
  })

  it('matches regardless of case, keeping the original casing in the output', () => {
    expect(splitOnMatch('MERGE Whale', 'merge')).toEqual([
      { text: 'MERGE', hit: true },
      { text: ' Whale', hit: false },
    ])
  })

  it('marks every occurrence, not just the first', () => {
    expect(splitOnMatch('Merge Merge Go', 'merge')).toEqual([
      { text: 'Merge', hit: true },
      { text: ' ', hit: false },
      { text: 'Merge', hit: true },
      { text: ' Go', hit: false },
    ])
  })

  it('treats the term as literal text, not a pattern', () => {
    // A term built into a RegExp would either throw on '(' or match the wrong thing.
    expect(splitOnMatch('100% (Party)', '% (p')).toEqual([
      { text: '100', hit: false },
      { text: '% (P', hit: true },
      { text: 'arty)', hit: false },
    ])
    expect(splitOnMatch('a.b.c', '.')).toEqual([
      { text: 'a', hit: false },
      { text: '.', hit: true },
      { text: 'b', hit: false },
      { text: '.', hit: true },
      { text: 'c', hit: false },
    ])
  })

  it('returns the text untouched when there is nothing to mark', () => {
    expect(splitOnMatch('Merge Whale', 'zzz')).toEqual([{ text: 'Merge Whale', hit: false }])
    expect(splitOnMatch('Merge Whale', '')).toEqual([{ text: 'Merge Whale', hit: false }])
    expect(splitOnMatch('', 'merge')).toEqual([])
  })

  it('marks the whole label when the term covers it', () => {
    expect(splitOnMatch('6762543798', '6762543798')).toEqual([
      { text: '6762543798', hit: true },
    ])
  })
})

describe('POSITIVE_FINAL_CONCLUSIONS', () => {
  it('holds every outcome that means the game got somewhere', () => {
    expect(POSITIVE_FINAL_CONCLUSIONS).toEqual(
      ['Priority IV', 'Insight', 'Watch List', 'Priority V', 'Theme/Art'],
    )
  })

  it('excludes the outcomes that mean it did not', () => {
    // This is the whole reason the tier is not `final_conclusion IS NOT NULL`: on
    // production, 31 puzzle games carry a final of Bypass and 23 Not Found. Ranking
    // those above a shortlisted game would put rejects at the top of a search.
    expect(POSITIVE_FINAL_CONCLUSIONS).not.toContain('Bypass')
    expect(POSITIVE_FINAL_CONCLUSIONS).not.toContain('Not Found')
  })
})

describe('wordStartPattern', () => {
  it('anchors the term to the start of a word', () => {
    expect(wordStartPattern('merge')).toBe('\\ymerge')
  })

  it('escapes regex metacharacters, which are not the ones LIKE cares about', () => {
    // An unescaped '(' makes the pattern invalid and takes the whole query with it.
    expect(wordStartPattern('go (2')).toBe('\\ygo \\(2')
    expect(wordStartPattern('a.b')).toBe('\\ya\\.b')
    // '%' and '_' are literal in a regex -- escaping them here would be wrong.
    expect(wordStartPattern('win_100%')).toBe('\\ywin_100%')
  })

  it('declines a term that cannot start a word', () => {
    // '\y%merge' asks for a boundary before '%', which matches nothing anyone meant.
    expect(wordStartPattern('%merge')).toBeNull()
    expect(wordStartPattern(' merge')).toBeNull()
    expect(wordStartPattern('')).toBeNull()
  })

  it('accepts a term that starts with a non-latin letter or a digit', () => {
    expect(wordStartPattern('hợp')).toBe('\\yhợp')
    expect(wordStartPattern('합치기')).toBe('\\y합치기')
    expect(wordStartPattern('100')).toBe('\\y100')
  })
})
