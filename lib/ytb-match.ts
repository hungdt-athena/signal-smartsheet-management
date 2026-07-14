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

export function normalizeTitle(s: string): string {
  // NFD decomposes accented chars into base + combining marks; the range
  // U+0300–U+036F is the Combining Diacritical Marks block. Explicit range
  // avoids the \p{Diacritic} escape (needs the `u` flag / es6+ tsc target;
  // this project's tsconfig has no `target`).
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
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
  for (const row of rows) {
    if (!row.gameTitle || !row.youtubeId) continue
    const key = ytKey(row.gameTitle, durationBucket(row.duration))
    const r = timeRank(row.time)
    if (!m.has(key) || r < rank.get(key)!) {
      m.set(key, { id: row.youtubeId, time: row.time || '', pic: row.pic || '' })
      rank.set(key, r)
    }
  }
  return m
}

export function ytLookup(map: Map<string, YtMatch>, title: string, bucket: Bucket): YtMatch | undefined {
  return map.get(ytKey(title, bucket))
}
