import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireRole } from '@/lib/auth-guard'

// GET /api/flow-logs — all logs, newest date first
export async function GET(_req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const rows = await sql`
    SELECT log_date, flow_type, period, sheet, platform, count, created_at
    FROM game_flow_logs
    ORDER BY log_date DESC, created_at DESC, flow_type, period
  `

  // Group by (log_date, flow_type, period)
  const groups: Record<string, {
    log_date: string
    flow_type: string
    period: string
    total: number
    created_at: string
    detail: Record<string, number>
  }> = {}

  for (const row of rows) {
    const dateStr = new Date(row.log_date).toISOString().slice(0, 10)
    const key = `${dateStr}-${row.flow_type}-${row.period}`
    if (!groups[key]) {
      groups[key] = { log_date: dateStr, flow_type: row.flow_type, period: row.period, total: 0, created_at: row.created_at, detail: {} }
    }
    if (row.flow_type === 'pull') {
      if (row.platform === 'all') groups[key].total = Number(row.count)
      else groups[key].detail[row.platform] = Number(row.count)
    } else {
      if (row.sheet && row.platform === 'all') {
        groups[key].total += Number(row.count)
        groups[key].detail[row.sheet] = Number(row.count)
      }
    }
  }

  // Sort: newest date first, within same date: morning before afternoon, pull before push
  const periodOrder = ['pull-morning', 'push-morning', 'pull-afternoon', 'push-afternoon']
  const result = Object.values(groups).sort((a, b) => {
    if (b.log_date !== a.log_date) return b.log_date.localeCompare(a.log_date)
    return periodOrder.indexOf(`${a.flow_type}-${a.period}`) - periodOrder.indexOf(`${b.flow_type}-${b.period}`)
  })

  return NextResponse.json(result)
}
