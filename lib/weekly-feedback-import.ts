// Pure parsers for the one-off Google Sheets → weekly_feedback import. No IO:
// the script (scripts/import-weekly-feedback.ts) reads the sheet, builds the
// RichCell inputs, matches games against the DB, and persists.

export const WEEK_LABEL_RE = /^W\d+\s+[A-Za-z]+,\s*\d{4}$/

export function isValidWeekLabel(label: string): boolean {
  return WEEK_LABEL_RE.test((label || '').trim())
}

export interface TextRun { start: number; bold: boolean; link: string | null }
export interface RichCell { text: string; runs: TextRun[]; cellLink: string | null }
export interface RawGame { title: string; app_link: string }
export interface RawBlock { name: string; games: RawGame[] }

function paragraph(nodes: unknown[]) {
  return nodes.length ? { type: 'paragraph', content: nodes } : { type: 'paragraph' }
}

// Inline content for [from,to): consecutive chars sharing a link become one text
// node with a link mark; runs of unlinked chars become plain text nodes. The
// script later upgrades link-marked nodes that match a DB game to gameMention.
function inlineRuns(text: string, runs: TextRun[], from: number, to: number): unknown[] {
  const out: unknown[] = []
  let i = from
  while (i < to) {
    const link = runAt(runs, i)?.link ?? null
    let j = i + 1
    while (j < to && (runAt(runs, j)?.link ?? null) === link) j++
    const seg = text.slice(i, j)
    if (seg) out.push(link ? { type: 'text', text: seg, marks: [{ type: 'link', attrs: { href: link } }] } : { type: 'text', text: seg })
    i = j
  }
  return out
}

// Column B → minimal Tiptap doc. "- "/"• " lines become bullet list items
// (consecutive bullets merge into one list); other non-empty lines become
// paragraphs. Hyperlinked spans keep a link mark (see inlineRuns). Empty → null.
export function parseFeedbackDoc(cell: RichCell): unknown | null {
  const text = (cell.text || '').replace(/\r\n/g, '\n')
  const runs = cell.runs ?? []
  const content: unknown[] = []
  let bullets: unknown[] | null = null
  const flush = () => { if (bullets) { content.push({ type: 'bulletList', content: bullets }); bullets = null } }
  let lineStart = 0
  for (const line of text.split('\n')) {
    const lineEnd = lineStart + line.length
    const m = line.match(/^(\s*[-•]\s+)(.*)$/)
    if (m && m[2].trim()) {
      ;(bullets ??= []).push({ type: 'listItem', content: [paragraph(inlineRuns(text, runs, lineStart + m[1].length, lineEnd))] })
    } else {
      flush()
      if (line.trim()) content.push(paragraph(inlineRuns(text, runs, lineStart, lineEnd)))
    }
    lineStart = lineEnd + 1 // + the consumed "\n"
  }
  flush()
  return content.length ? { type: 'doc', content } : null
}

// The run covering character index i = the last run whose start <= i.
function runAt(runs: TextRun[], i: number): TextRun | null {
  let found: TextRun | null = null
  for (const r of runs) { if (r.start <= i) found = r; else break }
  return found
}

// Maximal sub-segments of [from,to) that carry the same non-null link → games.
function linkedSegments(text: string, runs: TextRun[], from: number, to: number): RawGame[] {
  const out: RawGame[] = []
  let i = from
  while (i < to) {
    const link = runAt(runs, i)?.link ?? null
    if (!link) { i++; continue }
    let j = i
    while (j < to && (runAt(runs, j)?.link ?? null) === link) j++
    const title = text.slice(i, j).trim()
    if (title) out.push({ title, app_link: link })
    i = j
  }
  return out
}

// A line is "bold" when all its non-whitespace characters fall in bold runs.
function lineIsBold(runs: TextRun[], from: number, line: string): boolean {
  let any = false
  for (let i = 0; i < line.length; i++) {
    if (/\s/.test(line[i])) continue
    any = true
    if (!runAt(runs, from + i)?.bold) return false
  }
  return any
}

// Column C → named game-alike blocks. Bold lines (or no-link lines ending ":")
// open a new block; linked runs are games added to the current block (an
// unnamed block is created lazily if a game appears before any header).
export function parseAlikeCell(cell: RichCell): RawBlock[] {
  const text = (cell.text || '').replace(/\r\n/g, '\n')
  if ((!cell.runs || cell.runs.length === 0) && cell.cellLink && text.trim()) {
    return [{ name: '', games: [{ title: text.trim(), app_link: cell.cellLink }] }]
  }
  const runs = cell.runs ?? []
  const blocks: RawBlock[] = []
  let current: RawBlock | null = null

  let lineStart = 0
  for (const line of text.split('\n')) {
    const lineEnd = lineStart + line.length
    const games = linkedSegments(text, runs, lineStart, lineEnd)
    if (games.length === 0) {
      const trimmed = line.trim()
      if (trimmed && (lineIsBold(runs, lineStart, line) || trimmed.endsWith(':'))) {
        current = { name: trimmed.replace(/:\s*$/, '').trim(), games: [] }
        blocks.push(current)
      }
      // plain non-link, non-header line → ignored
    } else {
      if (!current) { current = { name: '', games: [] }; blocks.push(current) }
      for (const g of games) current.games.push(g)
    }
    lineStart = lineEnd + 1 // + the consumed "\n"
  }
  return blocks.filter(b => b.name || b.games.length)
}
