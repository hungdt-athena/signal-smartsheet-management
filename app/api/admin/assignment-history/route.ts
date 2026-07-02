import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Read the assignment_history audit log (migration 025). Filter by evaluator, the
// source of a reassign/handover, category, action, and a run_date range. Default
// window is the last 30 days so "history per person per day" is easy to trace.
//
//   GET /api/admin/assignment-history?evaluator=Nam&category=puzzle&from=2026-06-01&to=2026-06-30

export async function GET(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const p = req.nextUrl.searchParams
  const evaluator = p.get('evaluator')?.trim() || null
  const fromEvaluator = p.get('from_evaluator')?.trim() || null
  const category = p.get('category')?.trim().toLowerCase() || null
  const action = p.get('action')?.trim().toLowerCase() || null
  const dateFrom = p.get('from')?.trim() || null // run_date >=
  const dateTo = p.get('to')?.trim() || null // run_date <=
  const limit = Math.min(Math.max(Number(p.get('limit')) || 200, 1), 1000)

  try {
    const rows = await sql`
      SELECT id, run_date, run_at, category_group, action,
             evaluator_name, from_evaluator, game_count, game_ids, created_by
      FROM assignment_history
      WHERE (${evaluator}::text IS NULL OR evaluator_name = ${evaluator})
        AND (${fromEvaluator}::text IS NULL OR from_evaluator = ${fromEvaluator})
        AND (${category}::text IS NULL OR category_group = ${category})
        AND (${action}::text IS NULL OR action = ${action})
        AND (${dateFrom}::date IS NULL OR run_date >= ${dateFrom}::date)
        AND (${dateTo}::date IS NULL OR run_date <= ${dateTo}::date)
      ORDER BY run_at DESC, id DESC
      LIMIT ${limit}
    `
    return NextResponse.json({ ok: true, count: rows.length, rows }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('GET /api/admin/assignment-history error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
