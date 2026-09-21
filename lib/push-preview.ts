// lib/push-preview.ts — what the next run would do, from the roster as it
// stands right now. PURE: no DB import, so the route loads the rows, this
// decides what happens to them, and the browser can re-run it when someone
// unticks an evaluator.
//
// The daily pipeline is two steps and the panel has to preview BOTH:
//   1. push   (/api/cron/push-evaluations) — eligible game_info rows that are
//      not in game_evaluations yet become unassigned rows.
//   2. assign (/api/cron/assign-evaluators) — every unassigned row in the genre
//      is split among today's available evaluators by weight.
// Previewing only step 2 reads zero forever, because step 2 empties its own
// queue every morning. `incoming` is step 1, `waiting` is whatever step 2 did
// not get to, and the split runs over both.
//
// To be worth trusting it must agree with the cron exactly, so the split reuses
// `assignGames` — the same function the cron calls — and repeats the same gate:
// a genre runs only when its toggle is on AND somebody is available for it.

import { assignGames } from '@/lib/assign-evaluators'
import { BUCKETS, type Bucket } from '@/lib/buckets'
import type { GenreTarget } from '@/lib/genre-config'
import type { PushWindowConfig } from '@/lib/push-window'

/**
 * Games counted by platform rather than listed.
 *
 * `assignGames` only ever asks a game which platform it is, and a game is
 * interchangeable with any other of the same platform, so per-evaluator COUNTS
 * depend on the multiset and not on the order or the ids. That is what lets the
 * panel ship three numbers per genre instead of six thousand rows, and re-run
 * the real algorithm in the browser on every checkbox click.
 */
export interface OsCounts { ios: number; android: number; other: number }

export interface CrewMember { name: string; platform: string; weight: number }

export type GenreStatus = 'ready' | 'off' | 'no-evaluator' | 'no-games'

export interface GenrePreview {
  bucket: Bucket
  status: GenreStatus
  enabled: boolean
  available: number
  /** Eligible games not in game_evaluations yet — what the push step would add. */
  incoming: number
  /** Already in game_evaluations with no evaluator — what the last run left. */
  waiting: number
  /** incoming + waiting: everything the assign step would face. */
  pool: number
  assigned: number
  /** In the pool but matching no available evaluator's platform. */
  unmatched: number
  os: OsCounts
  crew: CrewMember[]
  perEvaluator: { name: string; count: number }[]
}

export interface PushPreview {
  /** Games that would land on somebody, across every genre that runs. */
  total: number
  incoming: number
  waiting: number
  /** In the pool of a genre that is off or has nobody available. */
  blocked: number
  genres: GenrePreview[]
  /** The windows the counts were taken with, so the panel can name them and
   *  point at the setting rather than leaving the number unexplained. Optional:
   *  buildPushPreview does not know them, the route attaches them. */
  windows?: PushWindowConfig
}

export const emptyOs = (): OsCounts => ({ ios: 0, android: 0, other: 0 })
export const osTotal = (os: OsCounts): number => os.ios + os.android + os.other

/**
 * Does this parsed JSON actually look like a preview?
 *
 * The client treats any 200 from the preview endpoint as a preview, and a body
 * of the wrong shape then took the whole Assign tab down on `genres.map`. The
 * panel is the least important thing on that screen, so a reply it cannot read
 * has to degrade to "no panel", never to a blank page.
 */
export function isPushPreview(v: unknown): v is PushPreview {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return Array.isArray(o.genres)
    && typeof o.total === 'number'
    && typeof o.incoming === 'number'
    && typeof o.waiting === 'number'
    && typeof o.blocked === 'number'
}

/**
 * Run the real assignment over a platform tally.
 *
 * Shared by the server (first paint) and the browser (every time a checkbox
 * changes), so an unticked evaluator produces the same numbers either way.
 */
export function splitAmong(os: OsCounts, crew: CrewMember[]): {
  assigned: number
  unmatched: number
  perEvaluator: { name: string; count: number }[]
} {
  const pool = osTotal(os)
  if (pool === 0 || crew.length === 0) {
    return { assigned: 0, unmatched: pool, perEvaluator: crew.map(c => ({ name: c.name, count: 0 })) }
  }

  const games: { id: number; os: string | null }[] = []
  let id = 0
  for (let i = 0; i < os.ios; i++) games.push({ id: id++, os: 'ios' })
  for (let i = 0; i < os.android; i++) games.push({ id: id++, os: 'android' })
  for (let i = 0; i < os.other; i++) games.push({ id: id++, os: null })

  const assignment = assignGames(games, crew)
  const counts = new Map<string, number>()
  // Everyone on the crew appears, including a zero: "rostered and getting
  // nothing" is the result most worth seeing, and it vanishes from a total.
  for (const c of crew) counts.set(c.name, 0)
  assignment.forEach(name => counts.set(name, (counts.get(name) ?? 0) + 1))

  return {
    assigned: assignment.size,
    unmatched: pool - assignment.size,
    perEvaluator: Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })),
  }
}

export interface GenreInput {
  incoming: OsCounts
  waiting: OsCounts
  crew: CrewMember[]
}

export function buildPushPreview(
  input: Partial<Record<Bucket, GenreInput>>,
  targets: GenreTarget[],
): PushPreview {
  const genres = BUCKETS.map((bucket): GenrePreview => {
    const g = input[bucket]
    const target = targets.find(t => t.bucket === bucket)
    const enabled = target?.enabled === true
    const available = target?.available ?? 0

    const incomingOs = g?.incoming ?? emptyOs()
    const waitingOs = g?.waiting ?? emptyOs()
    const crew = g?.crew ?? []

    const incoming = osTotal(incomingOs)
    const waiting = osTotal(waitingOs)
    const os: OsCounts = {
      ios: incomingOs.ios + waitingOs.ios,
      android: incomingOs.android + waitingOs.android,
      other: incomingOs.other + waitingOs.other,
    }
    const pool = incoming + waiting

    const base = {
      bucket, enabled, available, incoming, waiting, pool,
      assigned: 0, unmatched: 0, os, crew, perEvaluator: [] as { name: string; count: number }[],
    }

    // The gate, in the cron's own order. A disabled genre reports as disabled
    // even when nobody is available, because turning it on is the first fix and
    // naming the second one would send the reader to the wrong control.
    if (!enabled) return { ...base, status: 'off' }
    if (available === 0 || crew.length === 0) return { ...base, status: 'no-evaluator' }
    if (pool === 0) return { ...base, status: 'no-games', perEvaluator: crew.map(c => ({ name: c.name, count: 0 })) }

    return { ...base, status: 'ready', ...splitAmong(os, crew) }
  })

  return {
    total: genres.reduce((n, g) => n + g.assigned, 0),
    incoming: genres.reduce((n, g) => n + g.incoming, 0),
    waiting: genres.reduce((n, g) => n + g.waiting, 0),
    blocked: genres.reduce((n, g) => n + (g.status === 'off' || g.status === 'no-evaluator' ? g.pool : 0), 0),
    genres,
  }
}
