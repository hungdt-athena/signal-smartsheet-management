// Client-side matching between game titles and YouTube uploads tracked in the
// `ytb_uploaded` sheet. Keyed by title + duration bucket so a 20-min upload
// can't mark a 5-min recording as done (and vice versa).

export type Bucket = '5min' | '20min'

// Minimal shape this module needs from a sheet row (structural — the page's
// own YtbRow satisfies it without importing server-only google-sheets code).
export interface YtbMatchRow {
  gameTitle: string
  youtubeId: string
  duration: string
  time: string
  pic?: string
}

// A resolved match: the YouTube id, when the file was uploaded (sheet `time`),
// and the person who uploaded it (sheet `pic`) — used to reconcile the DB
// recorder against who actually recorded.
export interface YtMatch {
  id: string
  time: string
  pic: string
}

// Typographic punctuation → ASCII. Store titles and sheet titles are typed by
// different people from different sources, so the same game arrives as
// "Rotate'n Match" in one and "Rotate’n Match" in the other; without folding
// these the exact key misses and the row looks like it was never uploaded.
const PUNCT_FOLD: Array<[RegExp, string]> = [
  [/[‘’‚‛′＇]/g, "'"],   // curly / prime / fullwidth apostrophes
  [/[“”„‟″＂]/g, '"'],   // curly / fullwidth quotes
  [/[‐-―−－]/g, '-'],              // en/em dash, minus, fullwidth hyphen
  [/[！]/g, '!'], [/[？]/g, '?'], [/[：]/g, ':'],
  [/[（]/g, '('], [/[）]/g, ')'], [/[　 ]/g, ' '],
]

export function normalizeTitle(s: string): string {
  // NFD decomposes accented chars into base + combining marks; the range
  // U+0300–U+036F is the Combining Diacritical Marks block. Explicit range
  // avoids the \p{Diacritic} escape (needs the `u` flag / es6+ tsc target;
  // this project's tsconfig has no `target`).
  let out = (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  for (const [re, to] of PUNCT_FOLD) out = out.replace(re, to)
  return out.toLowerCase().trim().replace(/\s+/g, ' ')
}

// Punctuation-insensitive key, used ONLY as a fallback when the exact key misses
// (see ytLookup). Folding alone does not save "Cube Pop 3D" vs "Cube Pop 3D!" —
// one side simply dropped a character. Returns '' when nothing alphanumeric
// survives (non-latin titles), which disables the fallback for that title.
export function looseTitle(s: string): string {
  return normalizeTitle(s).replace(/[^a-z0-9]+/g, '')
}

// Sheet `duration` is hand-entered ("5", "5mins", "20", "20mins"). Parse the
// leading integer; >= 15 → 20min, otherwise 5min (unparseable → 5min).
export function durationBucket(duration: string): Bucket {
  const n = parseInt(String(duration || '').trim(), 10)
  return Number.isFinite(n) && n >= 15 ? '20min' : '5min'
}

// Same normalization as titles (strip accents/case/whitespace) — used to match
// a sheet `pic` value against a `dashboard_users.name`, tolerating casing drift
// (e.g. sheet "MYTL" → DB "MyTL").
export function normalizeName(s: string): string {
  return normalizeTitle(s)
}

export function ytKey(title: string, bucket: Bucket): string {
  return `${normalizeTitle(title)}|${bucket}`
}

// Loose keys live in the same map behind a prefix that can never collide with an
// exact key (an exact key is a normalized title, which never starts with '~').
function looseKey(title: string, bucket: Bucket): string | null {
  const l = looseTitle(title)
  return l ? `~${l}|${bucket}` : null
}

// Parse the sheet `time` to a sortable timestamp; unparseable times sort last so
// a real date always wins over a blank/garbage one.
function timeRank(time: string): number {
  const ms = Date.parse((time || '').trim())
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

export function buildYtMap(rows: YtbMatchRow[]): Map<string, YtMatch> {
  // For each game+bucket, keep the EARLIEST upload that has a real youtubeId
  // ("record cũ nhất để sync" — when two people upload the same game, the one
  // who uploaded first is the source of truth). Equal ranks keep the first seen
  // (sheet row order), so a blank-time row can't displace an earlier one.
  const m = new Map<string, YtMatch>()
  const rank = new Map<string, number>()
  // Distinct exact titles seen behind each loose key. More than one means the
  // loose key is ambiguous (two genuinely different games collapsing together),
  // and we drop it rather than guess — a wrong link is worse than no link.
  const looseTitles = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!row.gameTitle || !row.youtubeId) continue
    const bucket = durationBucket(row.duration)
    const match: YtMatch = { id: row.youtubeId, time: row.time || '', pic: row.pic || '' }
    const r = timeRank(row.time)
    for (const key of [ytKey(row.gameTitle, bucket), looseKey(row.gameTitle, bucket)]) {
      if (!key) continue
      if (!m.has(key) || r < rank.get(key)!) { m.set(key, match); rank.set(key, r) }
    }
    const lk = looseKey(row.gameTitle, bucket)
    if (lk) {
      const seen = looseTitles.get(lk) || new Set<string>()
      seen.add(normalizeTitle(row.gameTitle))
      looseTitles.set(lk, seen)
    }
  }
  for (const [lk, titles] of looseTitles) if (titles.size > 1) m.delete(lk)
  return m
}

export function ytLookup(map: Map<string, YtMatch>, title: string, bucket: Bucket): YtMatch | undefined {
  const exact = map.get(ytKey(title, bucket))
  if (exact) return exact
  // Fallback: same game, punctuation typed differently on one side.
  const lk = looseKey(title, bucket)
  return lk ? map.get(lk) : undefined
}
