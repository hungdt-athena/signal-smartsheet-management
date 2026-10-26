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
      SELECT record_bucket, record_5min_assignee, record_20min_assignee, final_conclusion,
        record_5min_confirmed_at, record_20min_confirmed_at, record_5min_date, record_20min_date,
        youtube_5min_uploaded_at IS NOT NULL AS done_5min, youtube_20min_uploaded_at IS NOT NULL AS done_20min
      FROM game_evaluations WHERE id = ${id}
    `
    if (found.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const row = found[0]

    // Resolve the current effective bucket (manual override wins, else derive
    // from final_conclusion) and the assignee currently in that container.
    const cur: '5min' | '20min' | null =
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

    // Each bucket is its own round (migration 051). A round that already has its
    // video is finished and stays as it is, whatever happens to the game next: a game
    // recorded 5' and moved to 20' keeps its 5' recorder, Confirm and video.
    // Remove from list: clear every unfinished round (recorder, Confirm, date).
    // Move into target container: an unfinished current round is a wrong bucket, so its
    // recorder, Confirm and date are carried into the target, unless the target holds a
    // finished round of its own; a finished current round stays and the target keeps what
    // it has. Every other unfinished round is cleared.
    type Slot = { assignee: string | null; confirmed: Date | null; date: Date | null }
    const slots: Record<'5min' | '20min', Slot & { done: boolean }> = {
      '5min': { assignee: row.record_5min_assignee, confirmed: row.record_5min_confirmed_at, date: row.record_5min_date, done: row.done_5min },
      '20min': { assignee: row.record_20min_assignee, confirmed: row.record_20min_confirmed_at, date: row.record_20min_date, done: row.done_20min },
    }
    const empty: Slot = { assignee: null, confirmed: null, date: null }
    const carry = bucket !== 'none' && cur !== null && cur !== bucket && !slots[cur].done
    const next = (b: '5min' | '20min'): Slot => {
      const s = slots[b]
      if (s.done) return s
      if (b === bucket) return carry && cur ? slots[cur] : s
      return empty
    }
    const n5 = next('5min'), n20 = next('20min')
    // The old record_confirmed_at is not written: the 051 trigger keeps it equal to
    // the own bucket's Confirm, and a write to it would land in that bucket.
    const set = sql`
          record_bucket = ${bucket},
          record_5min_assignee = ${n5.assignee}, record_5min_confirmed_at = ${n5.confirmed}::timestamptz, record_5min_date = ${n5.date}::timestamptz,
          record_20min_assignee = ${n20.assignee}, record_20min_confirmed_at = ${n20.confirmed}::timestamptz, record_20min_date = ${n20.date}::timestamptz`

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
      const recorderAfter = kind === 'record_move' ? (bucket === '5min' ? n5 : n20).assignee : null
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
      console.error('POST /api/evaluations/record-bucket: evaluation_log missing — apply migration 046')
      return NextResponse.json({ error: EVALUATION_LOG_MISSING }, { status: 500 })
    }
    console.error('POST /api/evaluations/record-bucket error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
