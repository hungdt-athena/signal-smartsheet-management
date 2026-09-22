// app/api/assign-setup/preview/route.ts — read-only "what would the next run
// do", for the Assign tab's side panel.
//
// Deliberately NOT a dryRun call into the cron routes: those are POSTs that
// write unless a flag says otherwise, they are admin-only, and they answer for
// one genre per request. This is a GET that cannot write and costs three
// queries for all three genres.
//
// The eligibility predicate below still mirrors the one in
// /api/cron/push-evaluations by hand, EXCEPT for the scraper-type list, which is
// now `pushSourceFilter()` in lib/push-sources.ts - the one part of it that drifted
// in practice, because adding an importer meant editing four files. The window and
// the remaining clauses are still copies, and __tests__/api/assign-setup-preview.test.ts
// asserts the two predicates keep reading the same.
//
// COST. Counting eligible games means scanning game_info against a date window
// and a jsonb category test; measured against production it is ~9s for all
// three genres in parallel, and the first shape tried here (one query with a
// lateral join over categories and a DISTINCT) was 75s -- past this route's own
// maxDuration. Two things follow:
//   * the per-genre EXISTS form below is the one the cron uses, and is the fast
//     one. Do not "simplify" it back into a join.
//   * the tally is cached for a minute. New games arrive from a scraper, not
//     from anything happening on this screen, so a minute-old count is exact
//     enough -- while the roster half (crew, availability, weights, waiting
//     rows) is read fresh on every call, because that is what the operator is
//     editing and expects to see move. ?fresh=1 skips the cache.
import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { BUCKETS, type Bucket } from '@/lib/buckets'
import { loadGenreTargets } from '@/lib/genre-config-db'
import { loadPushWindowConfig } from '@/lib/push-window-db'
import { pushWindowFor, type PushWindowConfig } from '@/lib/push-window'
import { pushSourceFilter } from '@/lib/push-sources'
import {
  buildPushPreview, emptyOs,
  type CrewMember, type GenreInput, type OsCounts,
} from '@/lib/push-preview'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface OsRow { category_group: string; os: string; n: string }
interface CountRow { os: string; n: string }
interface CrewRow { name: string; category_group: string; game_platform: string; weight: number }

const INCOMING_TTL_MS = 60_000
// Keyed on the windows as well as the clock: changing a genre's window in Config
// must move the panel immediately, not a minute later.
let incomingCache: { at: number; key: string; data: Partial<Record<Bucket, OsCounts>> } | null = null

/** 'ios' | 'android' | anything else (including null) → the OsCounts key. */
function osKey(v: string | null): keyof OsCounts {
  const s = (v ?? '').toLowerCase()
  return s === 'ios' || s === 'android' ? s : 'other'
}

function tally(rows: OsRow[]): Partial<Record<Bucket, OsCounts>> {
  const out: Partial<Record<Bucket, OsCounts>> = {}
  for (const r of rows) {
    const b = r.category_group as Bucket
    if (!(BUCKETS as readonly string[]).includes(b)) continue
    const counts = (out[b] ??= emptyOs())
    counts[osKey(r.os)] += Number(r.n) || 0
  }
  return out
}

/**
 * Eligible-but-not-yet-pushed games, per genre, counted by platform.
 *
 * One query per genre, in the same EXISTS shape /api/cron/push-evaluations
 * uses. See the COST note at the top before changing the shape.
 */
async function loadIncoming(windows: PushWindowConfig): Promise<Partial<Record<Bucket, OsCounts>>> {
  const mappings = await sql<{ genre: string; category_group: string }[]>`
    SELECT lower(genre) AS genre, category_group
    FROM category_mappings WHERE active = TRUE
  `
  const catsFor = (bucket: Bucket) =>
    mappings.filter(m => m.category_group === bucket).map(m => m.genre)

  const pairs = await Promise.all(BUCKETS.map(async bucket => {
    const cats = catsFor(bucket)
    if (cats.length === 0) return [bucket, emptyOs()] as const
    const windowDays = pushWindowFor(windows, bucket)
    const rows = await sql<CountRow[]>`
      SELECT COALESCE(lower(gi.os), 'other') AS os, count(*)::text AS n
      FROM game_info gi
      CROSS JOIN LATERAL (
        SELECT COALESCE(gi.initial_release, gi.temp_release) AS rel,
               (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS today
      ) w
      WHERE (
              w.rel BETWEEN (w.today - (${windowDays} || ' days')::interval) AND w.today
              OR (w.rel IS NULL AND gi.created_date BETWEEN (w.today - (${windowDays} || ' days')::interval) AND w.today)
            )
        AND ${pushSourceFilter()}
        AND gi.app_link IS NOT NULL
        AND gi.is_active = TRUE
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(gi.metadata -> 'categories') AS cat
          WHERE lower(cat) = ANY(${cats})
        )
        AND NOT EXISTS (
          SELECT 1 FROM game_evaluations ge
          WHERE ge.game_id = gi.game_id AND ge.category_group = ${bucket}
        )
      GROUP BY 1
    `
    const counts = emptyOs()
    for (const r of rows) counts[osKey(r.os)] += Number(r.n) || 0
    return [bucket, counts] as const
  }))

  return Object.fromEntries(pairs) as Partial<Record<Bucket, OsCounts>>
}

export async function GET(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const fresh = req.nextUrl.searchParams.get('fresh') === '1'

  try {
    const windows = await loadPushWindowConfig()
    const cacheKey = JSON.stringify(windows)
    const cacheHit = !fresh && incomingCache
      && incomingCache.key === cacheKey
      && Date.now() - incomingCache.at < INCOMING_TTL_MS

    const [incoming, waitingRows, crewRows, targets] = await Promise.all([
      cacheHit ? Promise.resolve(incomingCache!.data) : loadIncoming(windows),
      // Step 2's leftovers: rows the last assign run did not place. Cheap, and
      // it moves when the operator acts, so it is never cached.
      sql<OsRow[]>`
        SELECT ge.category_group, COALESCE(lower(gi.os), 'other') AS os, count(*)::text AS n
        FROM game_evaluations ge
        JOIN game_info gi ON ge.game_id = gi.game_id
        WHERE ge.initial_evaluator IS NULL
        GROUP BY 1, 2
      `,
      // Same filter and same order as the cron: assignGames walks the crew in
      // order, so a different order is a different split.
      sql<CrewRow[]>`
        SELECT name, category_group, game_platform, weight
        FROM evaluator_roster
        WHERE list_type = 'initial' AND today_available = TRUE
        ORDER BY sort_order NULLS LAST, name
      `,
      loadGenreTargets(),
    ])

    if (!cacheHit) incomingCache = { at: Date.now(), key: cacheKey, data: incoming }
    const waiting = tally(waitingRows)

    const input: Partial<Record<Bucket, GenreInput>> = {}
    for (const bucket of BUCKETS) {
      const crew: CrewMember[] = crewRows
        .filter(r => r.category_group === bucket)
        .map(r => ({ name: r.name, platform: r.game_platform || 'all', weight: Number(r.weight) || 100 }))
      input[bucket] = {
        incoming: incoming[bucket] ?? emptyOs(),
        waiting: waiting[bucket] ?? emptyOs(),
        crew,
      }
    }

    return NextResponse.json(
      { ...buildPushPreview(input, targets), windows },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    console.error('GET /api/assign-setup/preview error:', err)
    return NextResponse.json({ error: 'Failed to build preview' }, { status: 500 })
  }
}
