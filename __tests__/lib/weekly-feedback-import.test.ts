import { isValidWeekLabel, parseFeedbackDoc, parseAlikeCell, RichCell } from '@/lib/weekly-feedback-import'

describe('isValidWeekLabel', () => {
  it('accepts the canonical W<x> <Month>, <Year> form', () => {
    expect(isValidWeekLabel('W1 MAY, 2026')).toBe(true)
    expect(isValidWeekLabel('  W12 June, 2025 ')).toBe(true)
  })
  it('rejects un-normalized labels', () => {
    expect(isValidWeekLabel('May W2')).toBe(false)
    expect(isValidWeekLabel('W2/ Nov')).toBe(false)
    expect(isValidWeekLabel('')).toBe(false)
  })
})

const plain = (text: string): RichCell => ({ text, runs: [], cellLink: null })

describe('parseFeedbackDoc', () => {
  it('returns null for empty text', () => {
    expect(parseFeedbackDoc(plain(''))).toBeNull()
    expect(parseFeedbackDoc(plain('   '))).toBeNull()
  })
  it('turns "- " lines into a bullet list and plain lines into paragraphs', () => {
    const doc = parseFeedbackDoc(plain('Intro line\n- first\n- second')) as any
    expect(doc.type).toBe('doc')
    expect(doc.content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Intro line' }] })
    expect(doc.content[1].type).toBe('bulletList')
    expect(doc.content[1].content).toHaveLength(2)
    expect(doc.content[1].content[0]).toEqual({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] })
  })
  it('keeps a link mark on hyperlinked spans inside a paragraph', () => {
    // "see Tile Cat here" where "Tile Cat" is a hyperlink
    const doc = parseFeedbackDoc(cell([
      ['see ', false, null],
      ['Tile Cat', false, 'https://x/tilecat'],
      [' here', false, null],
    ])) as any
    expect(doc.content[0]).toEqual({ type: 'paragraph', content: [
      { type: 'text', text: 'see ' },
      { type: 'text', text: 'Tile Cat', marks: [{ type: 'link', attrs: { href: 'https://x/tilecat' } }] },
      { type: 'text', text: ' here' },
    ] })
  })
})

// Helper: build a RichCell from segments [text, bold, link].
function cell(segments: [string, boolean, string | null][]): RichCell {
  let text = ''
  const runs = segments.map(([t, bold, link]) => {
    const run = { start: text.length, bold, link }
    text += t
    return run
  })
  return { text, runs, cellLink: null }
}

describe('parseAlikeCell', () => {
  it('splits bold header lines into separate named blocks', () => {
    const c = cell([
      ['Category Match-Card:\n', true, null],
      ['Category Tiles', false, 'https://x/tiles'],
      ['\n', false, null],
      ['Stamp Match', false, 'https://x/stamp'],
      ['\n\n', false, null],
      ['Match-3:\n', true, null],
      ['Wildlife Flip', false, 'https://x/wildlife'],
    ])
    expect(parseAlikeCell(c)).toEqual([
      { name: 'Category Match-Card', games: [
        { title: 'Category Tiles', app_link: 'https://x/tiles' },
        { title: 'Stamp Match', app_link: 'https://x/stamp' },
      ] },
      { name: 'Match-3', games: [{ title: 'Wildlife Flip', app_link: 'https://x/wildlife' }] },
    ])
  })

  it('puts a flat list of links (no headers) into one unnamed block', () => {
    const c = cell([
      ['Roll It On!', false, 'https://x/roll'],
      ['\n', false, null],
      ['Sushi Marge', false, 'https://x/sushi'],
    ])
    expect(parseAlikeCell(c)).toEqual([
      { name: '', games: [
        { title: 'Roll It On!', app_link: 'https://x/roll' },
        { title: 'Sushi Marge', app_link: 'https://x/sushi' },
      ] },
    ])
  })

  it('treats a no-link line ending with ":" as a header even when not bold', () => {
    const c = cell([
      ['Arrow:\n', false, null],
      ['Arrows Flow', false, 'https://x/flow'],
    ])
    expect(parseAlikeCell(c)).toEqual([
      { name: 'Arrow', games: [{ title: 'Arrows Flow', app_link: 'https://x/flow' }] },
    ])
  })

  it('handles a whole-cell hyperlink with no runs as a single game', () => {
    expect(parseAlikeCell({ text: 'Solo Game', runs: [], cellLink: 'https://x/solo' })).toEqual([
      { name: '', games: [{ title: 'Solo Game', app_link: 'https://x/solo' }] },
    ])
  })
})
