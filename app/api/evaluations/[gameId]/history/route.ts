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
// A game that is linked to its twin store reads the log of both game_ids (the `ids`
// CTE, resolved inside each query so the two reads stay parallel); any other game reads
// its own, as before.
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
        WITH ids AS (
          SELECT ${gameId}::text AS game_id
          UNION
          SELECT t.game_id FROM game_evaluations ge
            JOIN game_evaluations t ON t.id = ge.pair_eval_id
           WHERE ge.game_id = ${gameId}
        )
        SELECT l.id::text AS id, l.created_at AS at, l.actor, l.owner, l.source, l.context, l.kind,
               l.conclusion_before, l.conclusion_after, l.final_before, l.final_after,
               l.changed, l.view_s, l.confidence, l.batch_before, l.batch_after, l.demo_added,
               l.bucket_before, l.bucket_after, l.recorder_before, l.recorder_after, l.owner_after,
               l.game_id, l.pair_scope, gi.os,
               (SELECT i.game_id FROM ids i WHERE i.game_id <> l.game_id LIMIT 1) AS other_game_id
        FROM evaluation_log l
        LEFT JOIN game_info gi ON gi.game_id = l.game_id
        WHERE l.game_id IN (SELECT game_id FROM ids)
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT 200
      `.catch((err: unknown) => {
        // Migration 046 not applied yet: show the hand-over history alone.
        if (!isMissingLogTable(err)) throw err
        logReady = false
        return [] as LogRow[]
      }),
      // game_ids holds game_info.game_id values. No index on it: the table has one row
      // per evaluator per run, small enough to scan.
      sql<AssignRow[]>`
        WITH ids AS (
          SELECT ${gameId}::text AS game_id
          UNION
          SELECT t.game_id FROM game_evaluations ge
            JOIN game_evaluations t ON t.id = ge.pair_eval_id
           WHERE ge.game_id = ${gameId}
        )
        SELECT ah.id, ah.run_at AS at, ah.action, ah.evaluator_name, ah.from_evaluator,
               COALESCE(du.name, ah.created_by) AS by,
               ((SELECT count(*) FROM ids) = 2
                 AND ah.game_ids @> ARRAY(SELECT game_id FROM ids)::text[]) AS pair_both,
               (SELECT gi.os FROM game_info gi
                 WHERE gi.game_id = ANY(ah.game_ids) AND gi.game_id IN (SELECT game_id FROM ids)
                 LIMIT 1) AS os
        FROM assignment_history ah
        LEFT JOIN dashboard_users du ON lower(du.email) = lower(ah.created_by)
        WHERE ah.game_ids && ARRAY(SELECT game_id FROM ids)::text[]
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
