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
  // One verb for what an evaluator does to a game. The tab used both, sometimes in
  // the same sentence as the KPI named "Evaluated", and the two read as different
  // steps. Identifiers are exempt by the leading [^\w.] (finJudged, enoughToJudge),
  // and "judgement" is not matched: the noun is still the right word for a verdict.
  // What the MODERATOR does is "ruled on", which is a third step and stays distinct.
  ['judge/judged/judging', /(^|[^\w.])judg(e|ed|es|ing)([^\w(:]|$)/i],
  // 2026-09-24: the reader asked for plain words that hit the point. An evaluator
  // SHORTLISTS a game (never keeps it, sends it on, or makes a pick), a moderator
  // gives a FINAL CONCLUSION (never rules on it), new games ARRIVE (never intake),
  // the backlog is the BACKLOG (never stock or a desk), and there is no "bar" to
  // evaluate by - the screen word is shortlist rate. Identifiers stay exempt
  // (keepPair, restKeep, T.intakeGap) by the leading [^\w.].
  ['keeps/kept', /(^|[^\w.])(keeps|kept)([^\w(:]|$)/i],
  ['sent on / send on', /\bsen[dt]s? on\b/i],
  ['ruled on', /\bruled? on\b/i],
  ['held up / hold up', /\b(held|holds?) up\b/i],
  ['intake', /(^|[^\w.])intake([^\w(:]|$)/i],
  ['stock', /\b(the|a|of|not|same) stock\b/i],
  ['desk', /(^|[^\w.])desks?([^\w(:]|$)/i],
  ['pick / picks', /(^|[^\w.'])picks?([^\w(:']|$)/],
  ['the bar / one bar / same bar', /\b(the|one|same|their|a) bar (is|sits|moving|lower|higher)\b|\bby (one|the same) bar\b|\bwhere the bar\b/i],
  ['got through', /\bg(ot|et) through\b/i],
  ['tempo / cadence', /\b(tempo|cadence)\b/i],
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
