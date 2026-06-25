import type { Section, AlikeBlock, GameAlikeGame } from '@/components/weekly-feedback/types'

// Sortable key for a "W<week> <Month>, <Year>" batch label (e.g. "W4 Jun, 2026").
// Higher = more recent, so sort descending for newest-first. Unparseable labels
// return -1 (sort to the end). Pure — safe to use on client and server.
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
export function weekLabelOrder(label: string): number {
  const m = (label || '').trim().match(/^W(\d+)\s+([A-Za-z]+),\s*(\d{4})$/i)
  if (!m) return -1
  const mon = MONTHS[m[2].slice(0, 3).toLowerCase()] ?? 0
  return parseInt(m[3], 10) * 10000 + mon * 100 + parseInt(m[1], 10)
}

// Tiptap's Link extension only sanitizes hrefs at editor-input time, not when
// generateHTML serializes stored JSON. Feedback can be written via the API
// directly, so strip link marks with unsafe href protocols before persisting —
// otherwise a crafted javascript:/data: href would XSS an admin viewing it.
const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|\/|#)/i

export function isSafeHref(href: unknown): boolean {
  return typeof href === 'string' && SAFE_HREF.test(href.trim())
}

function sanitizeNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  const n = node as { marks?: unknown; content?: unknown; [k: string]: unknown }
  const out: Record<string, unknown> = { ...n }
  if (Array.isArray(n.marks)) {
    out.marks = (n.marks as unknown[]).filter((m) => {
      const mark = m as { type?: string; attrs?: { href?: unknown } }
      if (mark?.type !== 'link') return true
      return isSafeHref(mark?.attrs?.href)
    })
  }
  // gameMention is a node (not a mark) with its own href attr — sanitize it too.
  const typed = n as { type?: string; attrs?: { href?: unknown } }
  if (typed.type === 'gameMention') {
    const attrs = (typed.attrs ?? {}) as Record<string, unknown>
    out.attrs = { ...attrs, href: isSafeHref(attrs.href) ? attrs.href : null }
  }
  if (Array.isArray(n.content)) {
    out.content = (n.content as unknown[]).map(sanitizeNode)
  }
  return out
}

function sanitizeDoc(doc: unknown): unknown {
  if (!doc || typeof doc !== 'object') return doc
  return sanitizeNode(doc)
}

function sanitizeGame(g: unknown): GameAlikeGame {
  const x = (g ?? {}) as Record<string, unknown>
  return {
    game_id: typeof x.game_id === 'string' ? x.game_id : null,
    title: typeof x.title === 'string' ? x.title : '',
    app_link: isSafeHref(x.app_link) ? (x.app_link as string) : null,
    icon_url: isSafeHref(x.icon_url) ? (x.icon_url as string) : null,
    manual: !!x.manual,
  }
}

// Flat-list variant for the evaluation "Game Alike" field (no named groups).
// Reuses sanitizeGame's per-field XSS guard; drops entries with no title.
export function sanitizeAlikeGames(input: unknown): GameAlikeGame[] {
  if (!Array.isArray(input)) return []
  return input.map(sanitizeGame).filter((g) => g.title.trim().length > 0)
}

function sanitizeAlike(raw: unknown): AlikeBlock {
  const a = (raw ?? {}) as Record<string, unknown>
  return {
    name: typeof a.name === 'string' ? a.name : '',
    games: Array.isArray(a.games) ? a.games.map(sanitizeGame) : [],
  }
}

// Accept the new `alikes` array; fold a legacy single `alike` object into a
// one-element array. Drop fully-empty blocks (no name, no games) so an old
// blank `alike` doesn't surface as a stray empty group.
function sanitizeAlikes(x: Record<string, unknown>): AlikeBlock[] {
  const raw = Array.isArray(x.alikes) ? x.alikes : (x.alike != null ? [x.alike] : [])
  return raw.map(sanitizeAlike).filter((b) => b.name || b.games.length)
}

export function sanitizeSections(input: unknown): Section[] {
  if (!Array.isArray(input)) return []
  return input.map((s, i) => {
    const x = (s ?? {}) as Record<string, unknown>
    return {
      id: typeof x.id === 'string' && x.id ? x.id : `s_${i}`,
      feedback: sanitizeDoc(x.feedback ?? null),
      alikes: sanitizeAlikes(x),
    }
  })
}

// Pre-018 rows store `feedback` (Tiptap doc) + `game_alike` (an old structured
// [{name,games}] array or a Tiptap doc) in separate columns. Fold them into a
// single section so old records keep rendering after the migration.
export function legacyToSections(feedback: unknown, gameAlike: unknown): Section[] {
  const games: GameAlikeGame[] = []
  if (Array.isArray(gameAlike)) {
    for (const sec of gameAlike) {
      const gs = (sec as { games?: unknown })?.games
      // Legacy game_alike entries predate the DB-matching pipeline and have no
      // reliable game_id, so mark them all manual:true rather than trusting a
      // stored flag that was never populated by a real search.
      if (Array.isArray(gs)) for (const g of gs) games.push({ ...sanitizeGame(g), manual: true })
    }
  }
  const fb = feedback ?? (!Array.isArray(gameAlike) ? (gameAlike ?? null) : null)
  if (!fb && !games.length) return []
  return [{ id: 'legacy', feedback: fb ?? null, alikes: games.length ? [{ name: '', games }] : [] }]
}

export function rowToSections(row: { sections?: unknown; feedback?: unknown; game_alike?: unknown }): Section[] {
  if (Array.isArray(row.sections)) return sanitizeSections(row.sections)
  return legacyToSections(row.feedback, row.game_alike)
}
