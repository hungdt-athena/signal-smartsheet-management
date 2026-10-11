import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { getConfigValues } from '@/lib/config'
import { SHORTCUT_EVALUATOR } from '@/lib/system-accounts'
import { getSession } from '@/lib/session'
import { logKindSql, isMissingLogTable, EVALUATION_LOG_MISSING } from '@/lib/evaluation-log'

export const dynamic = 'force-dynamic'

const BUCKETS = ['5min', '20min'] as const
const CATEGORIES = ['puzzle', 'arcade', 'simulation'] as const

// Games pulled into record that were never really evaluated (or only bypassed —
// Bypass / M_ByPass / Playtest & Bypass, all caught by ILIKE '%bypass%') are
// auto-attributed to the `Shortcut` system account with a List_Idea initial + the
// final conclusion the bucket implies (5min → Insight, 20min → Priority IV,
// mirroring effectiveBucket / the record-view filter). A game with a genuine
// evaluation is left untouched. Shortcut keeps this bulk attribution off a real
// person's record and is excluded from the Report tab (see lib/system-accounts).
const AUTO_EVALUATOR = SHORTCUT_EVALUATOR
const FINAL_FOR_BUCKET = { '5min': 'Insight', '20min': 'Priority IV' } as const

// Pull a game into a record bucket by game_id — even if it has no evaluation
// row yet (a catalog game never evaluated, or evaluated in another batch).
// The eval row is created lazily (mirroring cron/push-evaluations) so the
// record flow can operate on it. Returns the eval `id`.
export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  try {
    const {
      game_id, category_group, bucket, batch,
      // Optional eval overrides confirmed in the Add-game popup. When present the
      // caller has explicitly chosen these values, so they're applied as-is (the
      // legacy server-side auto-fill only runs when none are provided).
      initial_evaluator, initial_conclusion, final_conclusion, final_evaluator,
    } = await req.json()
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

    // Normalize the optional overrides: a non-empty string is applied, anything
    // else means "not provided" (leave the column untouched via COALESCE below).
    const clean = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() ? v.trim() : null
    const initEval = clean(initial_evaluator)
    const initConcl = clean(initial_conclusion)
    const finalConcl = clean(final_conclusion)
    const finalEval = clean(final_evaluator)
    const hasOverride = !!(initEval || initConcl || finalConcl || finalEval)

    // Validate the confirmed conclusions against the configured option lists
    // (mirrors the PATCH handler) so a forged value can't slip in.
    if (initConcl) {
      const opts = await getConfigValues('conclusion')
      if (!opts.includes(initConcl)) {
        return NextResponse.json({ error: 'Invalid initial_conclusion' }, { status: 400 })
      }
    }
    if (finalConcl) {
      const opts = await getConfigValues('final_conclusion')
      if (!opts.includes(finalConcl)) {
        return NextResponse.json({ error: 'Invalid final_conclusion' }, { status: 400 })
      }
    }

    // Who pulled the game in, for the evaluation_log row.
    const session = await getSession()
    const actor = session?.user?.name ?? null
    const role = session?.user?.role ?? null

    // Set the bucket, and (when a batch is supplied) move the row into that week so
    // it surfaces in the batch-filtered record list. A NULL batchVal leaves the
    // existing batch untouched.
    let result
    if (hasOverride) {
      // Explicit values confirmed in the popup: apply each (COALESCE keeps the
      // existing value when a field was left blank). evaluate_date /
      // final_conclusion_date only advance when the value actually changed, so
      // confirming an unchanged real evaluation doesn't skew report timing.
      result = await sql`
        WITH old AS (
          SELECT id, game_id, initial_conclusion, initial_evaluator, final_conclusion, evaluate_date, batch
          FROM game_evaluations
          WHERE game_id = ${game_id} AND category_group = ${category_group}
          FOR NO KEY UPDATE
        ), upd AS (
          UPDATE game_evaluations ge
          SET record_bucket = ${bucket},
              batch = COALESCE(${batchVal}, ge.batch),
              initial_evaluator = COALESCE(${initEval}, ge.initial_evaluator),
              initial_conclusion = COALESCE(${initConcl}, ge.initial_conclusion),
              evaluate_date = CASE
                WHEN ${initConcl}::text IS NOT NULL AND ge.initial_conclusion IS DISTINCT FROM ${initConcl}
                  THEN NOW() ELSE ge.evaluate_date END,
              final_conclusion = COALESCE(${finalConcl}, ge.final_conclusion),
              final_conclusion_date = CASE
                WHEN ${finalConcl}::text IS NOT NULL AND ge.final_conclusion IS DISTINCT FROM ${finalConcl}
                  THEN NOW() ELSE ge.final_conclusion_date END,
              final_evaluator = COALESCE(${finalEval}, ge.final_evaluator)
          FROM old WHERE ge.id = old.id
          RETURNING ge.id, ge.initial_conclusion, ge.final_conclusion, ge.batch
        ), logged AS (
          INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, actor_role, owner, source,
            kind, conclusion_before, conclusion_after, final_before, final_after, changed,
            batch_before, batch_after)
          SELECT old.id, old.game_id, ${actor}::text, ${role}::text, old.initial_evaluator, 'add_to_record',
            ${logKindSql(sql, { initialTouched: !!(initEval || initConcl), finalTouched: !!(finalConcl || finalEval) })},
            old.initial_conclusion, upd.initial_conclusion, old.final_conclusion, upd.final_conclusion,
            old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion,
            old.batch, upd.batch
          FROM old JOIN upd ON upd.id = old.id
        )
        SELECT id FROM upd
      `
    } else {
      // Legacy fallback (no overrides — e.g. an n8n caller): when the row has no
      // genuine evaluation yet (initial_conclusion NULL or a bypass verdict),
      // auto-attribute it to Shortcut as a List_Idea with the bucket's final
      // conclusion (5min → Insight, 20min → Priority IV). The CASE guard reads the
      // pre-update value so a real evaluation is never overwritten.
      const finalConclusion = FINAL_FOR_BUCKET[bucket as keyof typeof FINAL_FOR_BUCKET]
      const autoFill = sql`(ge.initial_conclusion IS NULL OR ge.initial_conclusion ILIKE '%bypass%')`
      result = await sql`
        WITH old AS (
          SELECT id, game_id, initial_conclusion, initial_evaluator, final_conclusion, evaluate_date, batch
          FROM game_evaluations
          WHERE game_id = ${game_id} AND category_group = ${category_group}
          FOR NO KEY UPDATE
        ), upd AS (
          UPDATE game_evaluations ge
          SET record_bucket = ${bucket},
              batch = COALESCE(${batchVal}, ge.batch),
              initial_evaluator = CASE WHEN ${autoFill} THEN ${AUTO_EVALUATOR} ELSE ge.initial_evaluator END,
              initial_conclusion = CASE WHEN ${autoFill} THEN 'List_Idea' ELSE ge.initial_conclusion END,
              evaluate_date = CASE WHEN ${autoFill} THEN NOW() ELSE ge.evaluate_date END,
              final_conclusion = CASE WHEN ${autoFill} THEN ${finalConclusion} ELSE ge.final_conclusion END,
              final_conclusion_date = CASE WHEN ${autoFill} THEN NOW() ELSE ge.final_conclusion_date END,
              final_evaluator = CASE WHEN ${autoFill} THEN ${AUTO_EVALUATOR} ELSE ge.final_evaluator END
          FROM old WHERE ge.id = old.id
          RETURNING ge.id, ge.initial_conclusion, ge.final_conclusion, ge.batch
        ), logged AS (
          INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, actor_role, owner, source,
            kind, conclusion_before, conclusion_after, final_before, final_after, changed,
            batch_before, batch_after)
          SELECT old.id, old.game_id, ${actor}::text, ${role}::text, old.initial_evaluator, 'add_to_record',
            ${logKindSql(sql, { initialTouched: true, finalTouched: true })},
            old.initial_conclusion, upd.initial_conclusion, old.final_conclusion, upd.final_conclusion,
            old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion,
            old.batch, upd.batch
          FROM old JOIN upd ON upd.id = old.id
        )
        SELECT id FROM upd
      `
    }
    return NextResponse.json({ ok: true, id: result[0]?.id })
  } catch (err) {
    if (isMissingLogTable(err)) {
      return NextResponse.json({ error: EVALUATION_LOG_MISSING }, { status: 500 })
    }
    console.error('POST /api/evaluations/add-to-record error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
