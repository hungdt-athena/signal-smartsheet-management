import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

const BUCKETS = ['5min', '20min'] as const
const CATEGORIES = ['puzzle', 'arcade', 'simulation'] as const

// Games pulled into record that were never really evaluated (or only bypassed —
// Bypass / M_ByPass / Playtest & Bypass, all caught by ILIKE '%bypass%') are
// auto-attributed to VinhTD with a List_Idea initial + the final conclusion the
// bucket implies (5min → Insight, 20min → Priority IV, mirroring effectiveBucket
// / the record-view filter). A game with a genuine evaluation is left untouched.
const AUTO_EVALUATOR = 'VinhTD'
const FINAL_FOR_BUCKET = { '5min': 'Insight', '20min': 'Priority IV' } as const

// Pull a game into a record bucket by game_id — even if it has no evaluation
// row yet (a catalog game never evaluated, or evaluated in another batch).
// The eval row is created lazily (mirroring cron/push-evaluations) so the
// record flow can operate on it. Returns the eval `id`.
export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'moderator'])
  if (guard) return guard
  try {
    const { game_id, category_group, bucket, batch } = await req.json()
    if (!game_id) {
      return NextResponse.json({ error: 'game_id is required' }, { status: 400 })
    }
    // The week the game is being pulled into. Stamped onto the row so it shows in
    // the currently-selected week — the record list filters strictly by batch
    // (see /api/evaluations record view), so an unstamped row stays invisible.
    const batchVal: string | null = typeof batch === 'string' && batch.trim() ? batch.trim() : null
    if (!CATEGORIES.includes(category_group)) {
      return NextResponse.json({ error: 'invalid category_group' }, { status: 400 })
    }
    if (!BUCKETS.includes(bucket)) {
      return NextResponse.json({ error: 'bucket must be 5min or 20min' }, { status: 400 })
    }

    // Game must exist in the catalog. (Search already enforces this, but guard
    // against a stale/forged game_id.)
    const game = await sql`SELECT game_id FROM game_info WHERE game_id = ${game_id} LIMIT 1`
    if (game.length === 0) {
      return NextResponse.json({ error: 'Game not found in catalog' }, { status: 404 })
    }

    // Create the eval row if this game has never been evaluated in this category.
    await sql`
      INSERT INTO game_evaluations (game_id, category_group, batch)
      VALUES (${game_id}, ${category_group}, ${batchVal})
      ON CONFLICT (game_id, category_group) DO NOTHING
    `

    // Set the bucket, and (when a batch is supplied) move the row into that week so
    // it surfaces in the batch-filtered record list. A NULL batchVal leaves the
    // existing batch untouched.
    //
    // When the row has no genuine evaluation yet (initial_conclusion NULL or a
    // bypass verdict), auto-fill it as a VinhTD List_Idea with the bucket's final
    // conclusion. The `autoFill` CASE guard reads the pre-update initial_conclusion
    // so a real evaluation is never overwritten. Dates mirror the PATCH handler.
    const finalConclusion = FINAL_FOR_BUCKET[bucket as keyof typeof FINAL_FOR_BUCKET]
    const autoFill = sql`(initial_conclusion IS NULL OR initial_conclusion ILIKE '%bypass%')`
    const result = await sql`
      UPDATE game_evaluations
      SET record_bucket = ${bucket},
          batch = COALESCE(${batchVal}, batch),
          initial_evaluator = CASE WHEN ${autoFill} THEN ${AUTO_EVALUATOR} ELSE initial_evaluator END,
          initial_conclusion = CASE WHEN ${autoFill} THEN 'List_Idea' ELSE initial_conclusion END,
          evaluate_date = CASE WHEN ${autoFill} THEN NOW() ELSE evaluate_date END,
          final_conclusion = CASE WHEN ${autoFill} THEN ${finalConclusion} ELSE final_conclusion END,
          final_conclusion_date = CASE WHEN ${autoFill} THEN NOW() ELSE final_conclusion_date END,
          final_evaluator = CASE WHEN ${autoFill} THEN ${AUTO_EVALUATOR} ELSE final_evaluator END
      WHERE game_id = ${game_id} AND category_group = ${category_group}
      RETURNING id
    `
    return NextResponse.json({ ok: true, id: result[0]?.id })
  } catch (err) {
    console.error('POST /api/evaluations/add-to-record error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
