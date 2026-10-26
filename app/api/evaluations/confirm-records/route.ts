import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { getSession } from '@/lib/session'
import { isMissingLogTable, EVALUATION_LOG_MISSING } from '@/lib/evaluation-log'
import { ownBucketSql } from '@/lib/record-slots'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  try {
    const { ids, unset } = await req.json()
    const list = Array.isArray(ids) ? ids.map(Number).filter(Boolean) : []
    if (list.length === 0) {
      return NextResponse.json({ error: 'ids array is required' }, { status: 400 })
    }
    // The Confirm belongs to the round in the game's own bucket (migration 051);
    // record_confirmed_at, which the WHEREs read, is kept equal to it by the trigger.
    const own = ownBucketSql()
    const stamp = (v: ReturnType<typeof sql>) => sql`
        record_5min_confirmed_at = CASE WHEN ${own} = '5min' THEN ${v} ELSE ge.record_5min_confirmed_at END,
        record_20min_confirmed_at = CASE WHEN ${own} = '20min' THEN ${v} ELSE ge.record_20min_confirmed_at END`

    // Reset (recording → draft): clear the confirmation so the recorder can be
    // reassigned. The dropdown unlocks client-side once confirmed_at is null.
    // Not logged: the assignment is logged when it is confirmed again.
    if (unset) {
      const result = await sql`
        UPDATE game_evaluations ge
        SET ${stamp(sql`NULL`)}
        WHERE ge.id IN ${sql(list)} AND ge.record_confirmed_at IS NOT NULL
      `
      return NextResponse.json({ reset: result.count })
    }

    // Who confirmed, for the evaluation_log row. NULL without a session (SKIP_AUTH).
    const session = await getSession()
    const actor = session?.user?.name ?? null
    const role = session?.user?.role ?? null

    // Confirm and log in one statement. The draft assignment (assign-records) is
    // logged here, once: one record_assign row per confirmed game whose effective
    // bucket has a recorder, unless that recorder is the one the game's latest Record
    // log row already ends with (re-confirming the same person after a reset logs
    // nothing; a different person logs a reassign with recorder_before).
    // Effective bucket: same rule as record-bucket/route.ts.
    const result = await sql`
      WITH old AS (
        SELECT id, game_id, initial_evaluator, batch, record_bucket, final_conclusion,
          record_5min_assignee, record_20min_assignee
        FROM game_evaluations
        WHERE id IN ${sql(list)} AND record_confirmed_at IS NULL
        FOR NO KEY UPDATE
      ), upd AS (
        UPDATE game_evaluations ge
        SET ${stamp(sql`NOW()`)}
        -- The join is what makes the locked read of "old" run first (see the PATCH).
        FROM old WHERE ge.id = old.id
        RETURNING ge.id
      ), cur AS (
        SELECT old.id, old.game_id, old.initial_evaluator, old.batch, eb.bucket,
          CASE eb.bucket WHEN '5min' THEN old.record_5min_assignee
                         WHEN '20min' THEN old.record_20min_assignee END AS recorder,
          (SELECT l.recorder_after FROM evaluation_log l
           WHERE l.game_evaluation_id = old.id
             AND l.kind IN ('record_assign', 'record_move', 'record_remove')
           ORDER BY l.id DESC LIMIT 1) AS prev_recorder
        FROM old JOIN upd ON upd.id = old.id
        CROSS JOIN LATERAL (SELECT CASE
          WHEN old.record_bucket IN ('5min', '20min') THEN old.record_bucket
          WHEN old.final_conclusion = 'Priority IV' THEN '20min'
          WHEN old.final_conclusion = 'Insight' THEN '5min'
        END AS bucket) eb
      ), logged AS (
        INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, actor_role, owner, source,
          kind, bucket_after, recorder_before, recorder_after, batch_before, batch_after)
        SELECT cur.id, cur.game_id, ${actor}::text, ${role}::text, cur.initial_evaluator, 'record_tab',
          'record_assign', cur.bucket, cur.prev_recorder, cur.recorder, cur.batch, cur.batch
        FROM cur
        -- Same person is the same person whatever the casing (MyTL / mytl).
        WHERE cur.recorder IS NOT NULL AND lower(cur.recorder) IS DISTINCT FROM lower(cur.prev_recorder)
      )
      SELECT count(*)::int AS confirmed FROM upd
    `
    return NextResponse.json({ confirmed: result[0]?.confirmed ?? 0 })
  } catch (err) {
    if (isMissingLogTable(err)) {
      console.error('POST /api/evaluations/confirm-records: evaluation_log missing — apply migration 046')
      return NextResponse.json({ error: EVALUATION_LOG_MISSING }, { status: 500 })
    }
    console.error('POST /api/evaluations/confirm-records error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
