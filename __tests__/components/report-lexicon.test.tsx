import fs from 'fs'
import path from 'path'

// The Report told one story in four words - queue, backlog, pile, waiting - and two
// tabs disagreed about what each meant. This guards the settlement. It reads the
// SOURCE rather than a rendered tab because a banned word can hide in a branch no
// fixture reaches.
const SRC = fs.readFileSync(
  path.join(process.cwd(), 'components/report/ReportView.tsx'), 'utf8',
)

// Strip the things that are not screen text: line comments, block comments, and
// identifiers (a word touching a letter, digit, underscore or dot on either side).
function screenText(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

const BANNED: Array<[string, RegExp]> = [
  ['queue', /(^|[^\w.])queue(s)?([^\w(:]|$)/i],
  ['pile', /(^|[^\w.])pile(s)?([^\w(]|$)/i],
  ['waiting games', /waiting games/i],
  ['Signal rate', /Signal rate/],
  ['Credibility', /Credibility/],
  ['turnaround', /(^|[^\w.])turnaround([^\w(:]|$)/i],
]

describe('Report lexicon', () => {
  const text = screenText(SRC)
  it.each(BANNED)('never says %s on screen', (_word, re) => {
    const hits = text.split('\n')
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => re.test(l))
    expect(hits.map(([n, l]) => `${n}: ${l.trim()}`)).toEqual([])
  })
})
