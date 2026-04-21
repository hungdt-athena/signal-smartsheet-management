import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireRole } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const year = new URL(req.url).searchParams.get('year')
  if (!year) return NextResponse.json({ error: 'year is required' }, { status: 400 })

  const rows = await sql<{ month: number }[]>`
    SELECT DISTINCT EXTRACT(MONTH FROM log_date)::int AS month
    FROM game_flow_logs
    WHERE EXTRACT(YEAR FROM log_date) = ${parseInt(year)}
    ORDER BY month DESC
  `

  return NextResponse.json(
    rows.map(r => r.month),
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
