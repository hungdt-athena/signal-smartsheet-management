import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const guard = await requireAuth()
  if (guard) return guard

  // Distinct weekly labels, newest activity first. GROUP BY already yields one
  // row per batch; ordered by the latest assignment date per label so the
  // dropdown reads top-down by week. (No SELECT DISTINCT: combined with an
  // aggregate ORDER BY, Postgres requires DISTINCT exprs in the select list —
  // 42P10 — and GROUP BY makes it redundant anyway.)
  const rows = await sql<{ batch: string }[]>`
    SELECT batch
    FROM game_evaluations
    WHERE batch IS NOT NULL
    GROUP BY batch
    ORDER BY MAX(COALESCE(assigned_date, imported_at::date)) DESC NULLS LAST
  `

  // Distinct evaluator names across ALL categories — union of initial/final
  // evaluator columns. Powers the admin/moderator picker in the Weekly Feedback
  // tab (avoids the n8n-webhook /api/evaluators, which 500s).
  const evalRows = await sql<{ name: string }[]>`
    SELECT DISTINCT name FROM (
      SELECT initial_evaluator AS name FROM game_evaluations WHERE initial_evaluator IS NOT NULL
      UNION
      SELECT final_evaluator   AS name FROM game_evaluations WHERE final_evaluator   IS NOT NULL
    ) e ORDER BY name
  `

  return NextResponse.json({ batches: rows.map(r => r.batch), evaluators: evalRows.map(r => r.name) })
}
