import type { Section, AlikeBlock, GameAlikeGame } from '@/components/weekly-feedback/types'

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
