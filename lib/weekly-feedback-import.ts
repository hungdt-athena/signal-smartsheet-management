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

function para(text: string) {
  return text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' }
}

// Column B free text → minimal Tiptap doc. "- "/"• " lines become bullet list
// items (consecutive bullets merge into one list); other non-empty lines become
// paragraphs. Empty input → null.
export function parseFeedbackDoc(text: string): unknown | null {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n')
  const content: unknown[] = []
  let bullets: unknown[] | null = null
  const flush = () => { if (bullets) { content.push({ type: 'bulletList', content: bullets }); bullets = null } }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const m = line.match(/^\s*[-•]\s+(.*)$/)
    if (m) {
      const t = m[1].trim()
      ;(bullets ??= []).push({ type: 'listItem', content: [para(t)] })
      continue
    }
    flush()
    if (line.trim()) content.push(para(line.trim()))
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
