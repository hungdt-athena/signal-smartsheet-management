import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { isMissingLogTable } from '@/lib/evaluation-log'
import { mergeHistory, type AssignRow, type LogRow } from '@/lib/evaluation-history'

export const dynamic = 'force-dynamic'

// The panel's History modal: every save of this game (evaluation_log) and every time
// it changed hands (assignment_history), newest first. Same guard as the panel's own
// GET. Read by game_id, not the evaluation row id, so rows of a deleted duplicate row
// still show. Fetched only when the modal opens.
export async function GET(
  _req: NextRequest,
  { params }: { params: { gameId: string } }
) {
  const guard = await requireAuth()
  if (guard) return guard

  const gameId = params.gameId
  if (!gameId) return NextResponse.json({ error: 'Invalid game_id' }, { status: 400 })

  try {
    let logReady = true
    const [log, assign] = await Promise.all([
      sql<LogRow[]>`
        SELECT l.id::text AS id, l.created_at AS at, l.actor, l.owner, l.source, l.context, l.kind,
               l.conclusion_before, l.conclusion_after, l.final_before, l.final_after,
               l.changed, l.view_s, l.confidence, l.batch_before, l.batch_after
        FROM evaluation_log l
        WHERE l.game_id = ${gameId}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT 200
      `.catch((err: unknown) => {
        // Migration 045 not applied yet: show the hand-over history alone.
        if (!isMissingLogTable(err)) throw err
        logReady = false
        return [] as LogRow[]
      }),
      // game_ids holds game_info.game_id values. No index on it: the table has one row
      // per evaluator per run, small enough to scan.
      sql<AssignRow[]>`
        SELECT ah.id, ah.run_at AS at, ah.action, ah.evaluator_name, ah.from_evaluator,
               COALESCE(du.name, ah.created_by) AS by
        FROM assignment_history ah
        LEFT JOIN dashboard_users du ON lower(du.email) = lower(ah.created_by)
        WHERE ${gameId} = ANY(ah.game_ids)
        ORDER BY ah.run_at DESC
        LIMIT 100
      `,
    ])
    return NextResponse.json({ events: mergeHistory(log, assign), log_ready: logReady })
  } catch (err) {
    console.error('GET /api/evaluations/[gameId]/history error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
