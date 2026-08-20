import { parseMarkdownLite } from '@/lib/markdown-lite'

// Trends `instruction` is authored as markdown in Signal Sense. Only the subset
// that actually appears there is parsed: headings, paragraphs, bullet lists and
// bold runs.
describe('parseMarkdownLite', () => {
  it('reads a heading with its level', () => {
    expect(parseMarkdownLite('## Overview')).toEqual([
      { kind: 'heading', level: 2, text: [{ text: 'Overview', bold: false }] },
    ])
  })

  it('splits a bold run out of a paragraph', () => {
    expect(parseMarkdownLite('uses **merge** rules')).toEqual([
      {
        kind: 'paragraph',
        text: [
          { text: 'uses ', bold: false },
          { text: 'merge', bold: true },
          { text: ' rules', bold: false },
        ],
      },
    ])
  })

  it('gathers consecutive bullets into one list', () => {
    expect(parseMarkdownLite('- one\n- two')).toEqual([
      {
        kind: 'list',
        items: [[{ text: 'one', bold: false }], [{ text: 'two', bold: false }]],
      },
    ])
  })

  it('joins wrapped lines into a single paragraph and drops blank lines', () => {
    expect(parseMarkdownLite('first line\nsecond line\n\nnext para')).toEqual([
      { kind: 'paragraph', text: [{ text: 'first line second line', bold: false }] },
      { kind: 'paragraph', text: [{ text: 'next para', bold: false }] },
    ])
  })

  it('returns nothing for an empty instruction', () => {
    expect(parseMarkdownLite('')).toEqual([])
    expect(parseMarkdownLite(null)).toEqual([])
  })
})
