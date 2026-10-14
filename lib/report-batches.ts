import { sql } from '@/lib/db'

/* A batch is the team's own name for a week of work - "W3 Sep, 2026". In the schema it is
   only a label on `game_evaluations.batch`, carried by ~5% of rows (almost all shortlisted
   games), so filtering the Performance tab by the label alone shows a cohort, not a week:
   415 games for W3 Sep against the 4,903 the team actually judged.

   So each batch has a row in `batches` with the day it starts (migration 049). It ends the
   day the next batch starts, and the newest one runs to today, so consecutive batches tile
   the calendar whatever length the team ran them for. The day a batch is closed belongs to
   the OLD batch; the new one starts the next day. Starts are set by a manager when the
   current batch is changed - they are not Mondays.

   This used to be INFERRED: start = the first day any game with that label was judged.
   Managers then began moving games between batches in bulk (a game judged 07/09 and later
   moved to "W1 Oct" pulled that batch back three weeks), and an inferred date cannot tell a
   moved game from a real one. An explicit date can.

   How a game picks its batch is the Report route's job (label wins, dates only place the
   unlabeled games); this file only says which days a label covers. */

export type BatchSpan = { batch: string; from: string; to: string }

// Spans change when the team opens a new batch, i.e. about once a week, so a short
// process-local cache turns the extra round-trip into a first-request cost. The TTL is the
// invalidation, except in the process that saved a batch, which clears it on write.
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
        SELECT label AS batch,
               starts_on::text AS from,
               -- exclusive, and it is the NEXT batch's start rather than this batch's last
               -- day: consecutive batches tile the calendar with no gap and no overlap.
               -- GREATEST keeps a batch scheduled for tomorrow from getting a window that
               -- ends before it starts.
               GREATEST(
                 COALESCE(lead(starts_on) OVER (ORDER BY starts_on),
                          (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 1),
                 starts_on + 1)::text AS to
        FROM batches
        ORDER BY starts_on DESC`
      cache = { at: Date.now(), rows }
      return rows
    } catch (err) {
      // `batches` missing (migration 049 not applied yet) must not take the whole Report
      // down: with no spans every batch is unresolvable and falls back to its label,
      // exactly like the pre-July leftovers. Not cached, so it heals once the table exists.
      console.error('loadBatchSpans failed, batches fall back to their label:', err)
      return []
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** The days a batch label covers, or null when the label has no row in `batches`. */
export async function resolveBatchSpan(batch: string): Promise<BatchSpan | null> {
  if (!batch) return null
  const spans = await loadBatchSpans()
  return spans.find((s) => s.batch === batch) ?? null
}
