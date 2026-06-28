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
}

// A resolved match: the YouTube id plus when the file was uploaded (sheet `time`).
export interface YtMatch {
  id: string
  time: string
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

export function ytKey(title: string, bucket: Bucket): string {
  return `${normalizeTitle(title)}|${bucket}`
}

export function buildYtMap(rows: YtbMatchRow[]): Map<string, YtMatch> {
  const m = new Map<string, YtMatch>()
  for (const row of rows) {
    if (!row.gameTitle) continue
    const key = ytKey(row.gameTitle, durationBucket(row.duration))
    // Prefer rows that actually have a youtubeId.
    if (row.youtubeId && (!m.has(key) || !m.get(key)!.id)) m.set(key, { id: row.youtubeId, time: row.time || '' })
    else if (!m.has(key)) m.set(key, { id: row.youtubeId || '', time: row.time || '' })
  }
  // Drop entries that never resolved to a real id.
  for (const [k, v] of Array.from(m.entries())) if (!v.id) m.delete(k)
  return m
}

export function ytLookup(map: Map<string, YtMatch>, title: string, bucket: Bucket): YtMatch | undefined {
  return map.get(ytKey(title, bucket))
}
