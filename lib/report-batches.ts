import { sql } from '@/lib/db'

/* A batch is the team's own name for a week of work - "W3 Sep, 2026". It is not a date
   range in the schema: `game_evaluations.batch` is a label, written in exactly one place
   (`/api/evaluations/add-to-record`) and therefore carried by only ~5% of rows, almost
   all of them shortlisted games. Filtering the Performance tab by that label showed a
   cohort, not a week: 415 games for W3 Sep against the 4,903 the team actually judged
   that week, a Shortlist rate near 85% instead of 5.7%, and - because the all-history
   backlog was then divided by that cohort's pace - "197 days to clear, add 1,153
   person-days".

   So the label is resolved to the days it covers instead, and the tab filters by those
   days like every other view. The rule, which is the team's own:

     start = the first day any game in that batch was judged
     end   = the start of the next batch
     the newest batch runs to today

   Nothing is stored. The same rule that would drive a backfill derives the answer at
   read time, which means a batch the team creates tomorrow needs no migration, no
   stamping step, and cannot drift from the rows it describes. It also gives the
   behaviour the team asked for - recording counts into the week the game was first
   judged - for the whole history and for free, because the span comes from the
   judgement date rather than from when someone pressed a button.

   The one thing deriving cannot do is let someone move a game into a different week by
   hand. Nobody has asked for that; if they do, a stored column can be added on top. */

// Batch labels older than this are not in chronological order and cannot be read as
// weeks: `W2 Aug, 2026` starts 15 May, `W1 Jul, 2026` starts 11 Jun, and several span a
// single day. They are leftovers from the Sheet -> Postgres migration. Weeks before the
// cutoff are still reachable through the Week / Month / Quarter views, which do not
// depend on the label at all.
export const BATCH_ERA_START = '2026-07-06'

export type BatchSpan = { batch: string; from: string; to: string }

// Spans change when the team opens a new batch, i.e. about once a week, so a short
// process-local cache turns the extra round-trip into a first-request cost. Same
// contract as `loadAvailableMonths`: the TTL is the invalidation, nothing hooks it.
const TTL_MS = 5 * 60_000
let cache: { at: number; rows: BatchSpan[] } | null = null
let inflight: Promise<BatchSpan[]> | null = null

export function clearBatchSpanCache() { cache = null; inflight = null }

export async function loadBatchSpans(): Promise<BatchSpan[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const rows = await sql<{ batch: string; from: string; to: string }[]>`
        WITH b AS (
          SELECT ge.batch,
                 min((ge.evaluate_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS f
          FROM game_evaluations ge
          WHERE ge.batch IS NOT NULL AND ge.batch <> '' AND ge.evaluate_date IS NOT NULL
          GROUP BY 1
        )
        SELECT batch,
               f::text AS from,
               -- exclusive, and it is the NEXT batch's first day rather than this
               -- batch's last: consecutive batches then tile the calendar with no gap
               -- and no overlap, whatever length the team ran them for.
               COALESCE(lead(f) OVER (ORDER BY f), CURRENT_DATE + 1)::text AS to
        FROM b
        WHERE f >= ${BATCH_ERA_START}::date
        ORDER BY f DESC`
      cache = { at: Date.now(), rows }
      return rows
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** The days a batch label covers, or null when the label is unknown or pre-cutoff. */
export async function resolveBatchSpan(batch: string): Promise<BatchSpan | null> {
  if (!batch) return null
  const spans = await loadBatchSpans()
  return spans.find((s) => s.batch === batch) ?? null
}
