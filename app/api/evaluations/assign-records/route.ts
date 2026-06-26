import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

interface Assignment {
  id: number
  record_5min_assignee?: string | null
  record_20min_assignee?: string | null
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'moderator'])
  if (guard) return guard

  try {
    const body = await req.json()
    const assignments: Assignment[] = body.assignments

    if (!Array.isArray(assignments) || assignments.length === 0) {
      return NextResponse.json({ error: 'assignments array is required' }, { status: 400 })
    }
    if (assignments.length > 100) {
      return NextResponse.json({ error: 'Max 100 assignments per batch' }, { status: 400 })
    }

    let updated = 0
    for (const a of assignments) {
      if (!a.id) continue
      const has5 = a.record_5min_assignee !== undefined
      const has20 = a.record_20min_assignee !== undefined
      if (!has5 && !has20) continue

      const r5 = has5 ? (a.record_5min_assignee || null) : null
      const r20 = has20 ? (a.record_20min_assignee || null) : null

      const result = await sql`
        UPDATE game_evaluations SET
          record_5min_assignee = CASE WHEN ${has5} THEN ${r5} ELSE record_5min_assignee END,
          record_5min_date = CASE
            WHEN ${has5} AND ${r5}::text IS NULL THEN NULL
            WHEN ${has5} AND ${r5}::text IS NOT NULL AND record_5min_assignee IS NULL THEN NOW()
            ELSE record_5min_date END,
          record_20min_assignee = CASE WHEN ${has20} THEN ${r20} ELSE record_20min_assignee END,
          record_20min_date = CASE
            WHEN ${has20} AND ${r20}::text IS NULL THEN NULL
            WHEN ${has20} AND ${r20}::text IS NOT NULL AND record_20min_assignee IS NULL THEN NOW()
            ELSE record_20min_date END,
          record_confirmed_at = CASE
            WHEN (${has5} AND ${r5} IS DISTINCT FROM record_5min_assignee)
              OR (${has20} AND ${r20} IS DISTINCT FROM record_20min_assignee)
            THEN NULL ELSE record_confirmed_at END
        WHERE id = ${a.id}
      `
      updated += result.count
    }

    return NextResponse.json({ updated })
  } catch (err) {
    console.error('POST /api/evaluations/assign-records error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
