import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireRole } from '@/lib/auth-guard'

// GET /api/flow-logs?date=YYYY-MM-DD
// Returns grouped history for the dashboard timeline
export async function GET(req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const date = new URL(req.url).searchParams.get('date') ?? new Date().toISOString().slice(0, 10)

  const rows = await sql`
    SELECT flow_type, period, sheet, platform, count, created_at
    FROM game_flow_logs
    WHERE log_date = ${date}::date
    ORDER BY created_at ASC, flow_type, period
  `

  // Group into summary entries
  const groups: Record<string, {
    flow_type: string
    period: string
    total: number
    created_at: string
    detail: Record<string, number>
  }> = {}

  for (const row of rows) {
    const key = `${row.flow_type}-${row.period}`
    if (!groups[key]) {
      groups[key] = {
        flow_type: row.flow_type,
        period: row.period,
        total: 0,
        created_at: row.created_at,
        detail: {},
      }
    }

    if (row.flow_type === 'pull') {
      if (row.platform === 'all') groups[key].total = Number(row.count)
      else groups[key].detail[row.platform] = Number(row.count)
    } else {
      // push: total = sum of sheets
      if (row.sheet && row.platform === 'all') {
        groups[key].total += Number(row.count)
        groups[key].detail[row.sheet] = Number(row.count)
      }
    }
  }

  // Sort: morning before afternoon, pull before push within same period
  const order = ['pull-morning', 'push-morning', 'pull-afternoon', 'push-afternoon']
  const result = Object.values(groups).sort(
    (a, b) => order.indexOf(`${a.flow_type}-${a.period}`) - order.indexOf(`${b.flow_type}-${b.period}`)
  )

  return NextResponse.json(result)
}
