import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

// List operation_runs (migration 028) for the Team Operations history containers.
// One row per reassign/handover operation, with its full snapshot/result so the
// "Details" popup renders without a second fetch. `viewer` is the caller's email so
// the UI can hide Approve/Reject on a manager's own pending handover request.
//
//   GET /api/operations/runs?kind=reassign|handover&category=puzzle&limit=100

export async function GET(req: NextRequest) {
  const guard = await requireRole(['admin', 'moderator', 'evaluator'])
  if (guard) return guard

  const p = req.nextUrl.searchParams
  const kind = p.get('kind')?.trim().toLowerCase() || null
  const category = p.get('category')?.trim().toLowerCase() || null
  const limit = Math.min(Math.max(Number(p.get('limit')) || 100, 1), 500)

  if (kind !== 'reassign' && kind !== 'handover') {
    return NextResponse.json({ error: "kind must be 'reassign' or 'handover'" }, { status: 400 })
  }

  const session = await getServerSession(authOptions)
  const viewer = session?.user?.email ?? null
  const isEvaluator = session?.user?.role === 'evaluator'

  // Evaluators get a scoped, read-only view (never the whole team's history):
  //   handover → only their OWN requests (from_evaluator = them).
  //   reassign → only runs they are involved in — as the source (from) OR as a
  //              recipient (a key in the resulting per_evaluator split, or picked in
  //              params.selected_evaluators).
  const scopeName = isEvaluator ? (session?.user?.name || '__no_such_evaluator__') : null

  try {
    const rows = await sql`
      SELECT id, kind, category_group, from_evaluator, params, snapshot, result,
             status, game_count, submitted_by, submitted_at, reviewed_by, reviewed_at, review_note
      FROM operation_runs
      WHERE kind = ${kind}
        AND (${category}::text IS NULL OR category_group = ${category})
        AND (
          ${scopeName}::text IS NULL
          OR from_evaluator = ${scopeName}
          OR (
            ${kind} = 'reassign' AND (
              jsonb_exists(COALESCE(result -> 'per_evaluator', snapshot -> 'per_evaluator', '{}'::jsonb), ${scopeName})
              OR jsonb_exists(COALESCE(params -> 'selected_evaluators', '[]'::jsonb), ${scopeName})
            )
          )
        )
      ORDER BY submitted_at DESC, id DESC
      LIMIT ${limit}
    `
    return NextResponse.json({ ok: true, viewer, count: rows.length, rows }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('GET /api/operations/runs error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
