import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const guard = await requireAuth()
  if (guard) return guard

  // Distinct weekly labels, newest activity first. Ordered by the latest
  // assignment date seen for each label so the dropdown reads top-down by week.
  const rows = await sql<{ batch: string }[]>`
    SELECT DISTINCT batch
    FROM game_evaluations
    WHERE batch IS NOT NULL
    GROUP BY batch
    ORDER BY MAX(COALESCE(assigned_date, imported_at::date)) DESC NULLS LAST
  `
  return NextResponse.json({ batches: rows.map(r => r.batch) })
}
