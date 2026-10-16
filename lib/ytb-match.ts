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
  // Set only when the upload was matched approximately (resolveYtMatches): the
  // sheet title it was matched through, for a tooltip. Absent on exact matches.
  approx?: string
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
  for (const [lk, titles] of Array.from(looseTitles)) if (titles.size > 1) m.delete(lk)
  return m
}

export function ytLookup(map: Map<string, YtMatch>, title: string, bucket: Bucket): YtMatch | undefined {
  const exact = map.get(ytKey(title, bucket))
  if (exact) return exact
  // Fallback: same game, punctuation typed differently on one side.
  const lk = looseKey(title, bucket)
  return lk ? map.get(lk) : undefined
}

// ── Approximate matching ─────────────────────────────────────────────────────
//
// An upload only exists once a game was assigned to record, so an upload that
// no game claims exactly is almost always a typo of an assigned game's title
// (recorders type "Peng Short" for "Peng Shot", drop the subtitle, or write 20
// for a 5-min game). resolveYtMatches therefore lets a game that found nothing
// exactly borrow an UNCLAIMED upload that is close enough.
//
// Never steals: only uploads no game matched exactly are candidates, and one
// upload never serves two different titles (a tie is dropped, not guessed).

export interface YtGame {
  key: number | string
  title: string
  bucket: Bucket
  recorder?: string | null   // assignee of the game's own bucket
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

function titleTokens(s: string): string[] {
  return normalizeTitle(s).split(/[^a-z0-9]+/).filter(Boolean)
}

// 0 = same title, 1 = tier A (title is a word-prefix of the other, or one typo),
// 2 = tier B (most words shared on both sides; only trusted with the same recorder), null = no.
function similarity(game: string, upload: string, sameRecorder: boolean): 0 | 1 | 2 | null {
  const gl = looseTitle(game), ul = looseTitle(upload)
  if (!gl || !ul) return null
  if (gl === ul) return 0
  const gt = titleTokens(game), ut = titleTokens(upload)
  const [short, long] = gt.length <= ut.length ? [gt, ut] : [ut, gt]
  if (short.every((t, i) => long[i] === t)) {
    // One bare word ("Block") is too common to trust on its own.
    if (short.length > 1 || sameRecorder) return Math.min(gl.length, ul.length) >= 4 ? 1 : null
  }
  if (Math.min(gl.length, ul.length) >= 6 && levenshtein(gl, ul) <= Math.max(1, Math.floor(Math.min(gl.length, ul.length) / 10))) return 1
  if (sameRecorder && ut.length >= 2) {
    const gs = new Set(gt)
    const shared = ut.filter(t => gs.has(t)).length
    // Measured against the longer side, so a short title can't ride on two
    // common words ("Word Jam Sort" vs "Jelly Color Jam: Color Sort").
    if (shared >= 2 && shared / Math.max(gt.length, ut.length) >= 0.6) return 2
  }
  return null
}

/**
 * Resolve every game to its upload: exact title+bucket first (same as
 * ytLookup), then approximate for the games left over. Returns game.key → match;
 * games with no upload are absent.
 *
 * Rank, best first: same bucket (0 same title, 1 tier A, 2 tier B), then the
 * other bucket (same tiers, but a non-identical title there also needs the same
 * recorder).
 */
export function resolveYtMatches(games: YtGame[], rows: YtbMatchRow[]): Map<number | string, YtMatch> {
  const exactMap = buildYtMap(rows)
  const out = new Map<number | string, YtMatch>()
  const ownedKeys = new Set<string>()   // title|bucket keys some game already holds
  const left: YtGame[] = []
  for (const g of games) {
    const hit = ytLookup(exactMap, g.title, g.bucket)
    if (hit) {
      out.set(g.key, hit)
      // Everything that title+bucket resolves to is spoken for, duplicates too.
      ownedKeys.add(ytKey(g.title, g.bucket))
      const lk = looseKey(g.title, g.bucket)
      if (lk) ownedKeys.add(lk)
    } else left.push(g)
  }
  if (left.length === 0) return out

  // Unclaimed uploads: earliest per title+bucket, none that duplicate a claimed one.
  const pool = new Map<string, { row: YtbMatchRow; bucket: Bucket }>()
  for (const row of rows) {
    if (!row.gameTitle || !row.youtubeId) continue
    const bucket = durationBucket(row.duration)
    const k = ytKey(row.gameTitle, bucket)
    const lk = looseKey(row.gameTitle, bucket)
    if (ownedKeys.has(k) || (lk && ownedKeys.has(lk))) continue
    const cur = pool.get(k)
    if (!cur || timeRank(row.time) < timeRank(cur.row.time)) pool.set(k, { row, bucket })
  }
  if (pool.size === 0) return out

  type Pick = { game: YtGame; poolKey: string; rank: number }
  const picks: Pick[] = []
  for (const g of left) {
    let best: { poolKey: string; rank: number } | null = null
    let tie = false
    for (const [poolKey, { row, bucket }] of Array.from(pool)) {
      const sameRecorder = !!g.recorder && !!row.pic && normalizeName(g.recorder) === normalizeName(row.pic)
      const cross = bucket !== g.bucket
      const sim = similarity(g.title, row.gameTitle, sameRecorder)
      if (sim === null) continue
      if (cross && sim !== 0 && !sameRecorder) continue
      const rank = sim + (cross ? 3 : 0)
      if (!best || rank < best.rank) { best = { poolKey, rank }; tie = false }
      else if (rank === best.rank) tie = true
    }
    if (best && !tie) picks.push({ game: g, poolKey: best.poolKey, rank: best.rank })
  }

  // One upload, one title: if games with different titles want the same upload
  // the strictly better rank wins, a tie gives it to nobody.
  const byUpload = new Map<string, Pick[]>()
  for (const p of picks) byUpload.set(p.poolKey, [...(byUpload.get(p.poolKey) || []), p])
  for (const [poolKey, ps] of Array.from(byUpload)) {
    const minRank = Math.min(...ps.map(p => p.rank))
    const top = ps.filter(p => p.rank === minRank)
    if (new Set(top.map(p => looseTitle(p.game.title))).size > 1) continue
    const { row } = pool.get(poolKey)!
    for (const p of top) {
      out.set(p.game.key, { id: row.youtubeId, time: row.time || '', pic: row.pic || '', approx: row.gameTitle })
    }
  }
  return out
}
