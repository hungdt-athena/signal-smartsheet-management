// A very small markdown reader for the Trends `instruction` field.
//
// Signal Sense stores those instructions as markdown, and they use one narrow
// subset: `#`/`##`/`###` headings, paragraphs, `-` bullets and `**bold**` runs.
// Parsing that subset here keeps a markdown dependency out of the bundle, and
// keeps rendering to text nodes — no dangerouslySetInnerHTML over a field this
// app does not own.
//
// Anything outside the subset survives as plain text rather than being dropped.

export interface Inline {
  text: string
  bold: boolean
}

export type Block =
  | { kind: 'heading'; level: number; text: Inline[] }
  | { kind: 'paragraph'; text: Inline[] }
  | { kind: 'list'; items: Inline[][] }

/** Split `**bold**` runs out of one line. Unpaired `**` stays literal. */
function inlines(line: string): Inline[] {
  const out: Inline[] = []
  let rest = line
  while (rest) {
    const open = rest.indexOf('**')
    const close = open === -1 ? -1 : rest.indexOf('**', open + 2)
    if (open === -1 || close === -1) {
      out.push({ text: rest, bold: false })
      break
    }
    if (open > 0) out.push({ text: rest.slice(0, open), bold: false })
    const bold = rest.slice(open + 2, close)
    if (bold) out.push({ text: bold, bold: true })
    rest = rest.slice(close + 2)
  }
  return out.filter(i => i.text !== '')
}

export function parseMarkdownLite(md: string | null | undefined): Block[] {
  if (!md) return []
  const blocks: Block[] = []
  // Paragraph lines held until a blank line, a heading or a bullet ends them:
  // markdown wraps a paragraph over several lines, and they read as one.
  let para: string[] = []
  const flush = () => {
    if (para.length === 0) return
    blocks.push({ kind: 'paragraph', text: inlines(para.join(' ')) })
    para = []
  }

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) { flush(); continue }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1].length, text: inlines(heading[2]) })
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      flush()
      const last = blocks[blocks.length - 1]
      if (last && last.kind === 'list') last.items.push(inlines(bullet[1]))
      else blocks.push({ kind: 'list', items: [inlines(bullet[1])] })
      continue
    }

    para.push(line)
  }
  flush()
  return blocks
}
