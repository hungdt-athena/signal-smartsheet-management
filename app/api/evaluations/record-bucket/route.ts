import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { getSession } from '@/lib/session'
import { isMissingLogTable, EVALUATION_LOG_MISSING } from '@/lib/evaluation-log'

export const dynamic = 'force-dynamic'

const BUCKETS = ['5min', '20min', 'none'] as const

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  try {
    const { id, bucket } = await req.json()
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }
    if (!BUCKETS.includes(bucket)) {
      return NextResponse.json({ error: 'bucket must be one of 5min, 20min, none' }, { status: 400 })
    }

    const found = await sql`
      SELECT record_bucket, record_5min_assignee, record_20min_assignee, final_conclusion
      FROM game_evaluations WHERE id = ${id}
    `
    if (found.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const row = found[0]

    // Resolve the current effective bucket (manual override wins, else derive
    // from final_conclusion) and the assignee currently in that container.
    const cur =
      row.record_bucket === '5min' || row.record_bucket === '20min'
        ? row.record_bucket
        : row.final_conclusion === 'Priority IV'
          ? '20min'
          : row.final_conclusion === 'Insight'
            ? '5min'
            : null
    const curAssignee =
      cur === '5min' ? row.record_5min_assignee
        : cur === '20min' ? row.record_20min_assignee
          : null

    // Remove from list: clear both assignees + drop confirmation.
    // Move into target container: carry the current recorder into the target
    // duration column, clear the other; keep record_confirmed_at.
    const set = bucket === 'none'
      ? sql`
          record_bucket = 'none',
          record_5min_assignee = NULL,
          record_20min_assignee = NULL,
          record_confirmed_at = NULL`
      : sql`
          record_bucket = ${bucket},
          record_5min_assignee = ${bucket === '5min' ? curAssignee : null},
          record_20min_assignee = ${bucket === '20min' ? curAssignee : null}`

    // Only a real change is logged: a move to another bucket, or removing a game that
    // is in Record. Re-picking the same bucket, or removing a game that is not in
    // Record, is a plain UPDATE with no log row.
    const kind: 'record_move' | 'record_remove' | null =
      bucket === 'none' ? (cur !== null ? 'record_remove' : null)
        : cur !== bucket ? 'record_move' : null

    let result
    if (!kind) {
      result = await sql`
        UPDATE game_evaluations SET ${set}
        WHERE id = ${id}
        RETURNING *
      `
    } else {
      // Who moved it, for the evaluation_log row. NULL without a session (SKIP_AUTH).
      const session = await getSession()
      const actor = session?.user?.name ?? null
      const role = session?.user?.role ?? null
      const bucketAfter = kind === 'record_move' ? bucket : null
      const recorderAfter = kind === 'record_move' ? curAssignee ?? null : null
      result = await sql`
        WITH upd AS (
          UPDATE game_evaluations SET ${set}
          WHERE id = ${id}
          RETURNING *
        ), logged AS (
          -- Casts keep parameter types explicit (postgres.js sends strings untyped).
          INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, actor_role, owner, source,
            kind, bucket_before, bucket_after, recorder_before, recorder_after, batch_before, batch_after)
          SELECT upd.id, upd.game_id, ${actor}::text, ${role}::text, upd.initial_evaluator, 'record_tab',
            ${kind}::text, ${cur}::text, ${bucketAfter}::text, ${curAssignee ?? null}::text, ${recorderAfter}::text,
            upd.batch, upd.batch
          FROM upd
        )
        SELECT * FROM upd
      `
    }

    return NextResponse.json({ ok: true, data: result[0] })
  } catch (err) {
    if (isMissingLogTable(err)) {
      console.error('POST /api/evaluations/record-bucket: evaluation_log missing — apply migration 045')
      return NextResponse.json({ error: EVALUATION_LOG_MISSING }, { status: 500 })
    }
    console.error('POST /api/evaluations/record-bucket error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
