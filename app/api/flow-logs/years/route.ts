import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireRole } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const rows = await sql<{ year: number }[]>`
    SELECT DISTINCT EXTRACT(YEAR FROM log_date)::int AS year
    FROM game_flow_logs
    ORDER BY year DESC
  `

  return NextResponse.json(
    rows.map(r => r.year),
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
