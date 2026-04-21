import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireRole } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

interface RawRow {
  log_date: Date
  flow_type: string
  period: string
  sheet: string | null
  platform: string
  count: string
  created_at: string
}

interface EntryRow {
  flow_type: 'pull' | 'push'
  period: 'morning' | 'afternoon'
  total: number
  detail: Record<string, number>
  created_at: string
}

interface DayGroup {
  log_date: string
  entries: EntryRow[]
}

const ENTRY_ORDER = ['pull-morning', 'pull-afternoon', 'push-morning', 'push-afternoon']

export async function GET(req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const params = new URL(req.url).searchParams
  const year = params.get('year')
  const month = params.get('month')
  if (!year || !month) {
    return NextResponse.json({ error: 'year and month are required' }, { status: 400 })
  }

  const rows = await sql<RawRow[]>`
    SELECT log_date, flow_type, period, sheet, platform, count, created_at
    FROM game_flow_logs
    WHERE EXTRACT(YEAR FROM log_date) = ${parseInt(year)}
      AND EXTRACT(MONTH FROM log_date) = ${parseInt(month)}
    ORDER BY log_date DESC, flow_type, period
  `

  const dayMap: Record<string, DayGroup> = {}

  for (const row of rows) {
    const dateStr = new Date(row.log_date).toISOString().slice(0, 10)
    if (!dayMap[dateStr]) dayMap[dateStr] = { log_date: dateStr, entries: [] }

    const day = dayMap[dateStr]
    let entry = day.entries.find(e => e.flow_type === row.flow_type && e.period === row.period)
    if (!entry) {
      entry = {
        flow_type: row.flow_type as 'pull' | 'push',
        period: row.period as 'morning' | 'afternoon',
        total: 0,
        detail: {},
        created_at: row.created_at,
      }
      day.entries.push(entry)
    }

    if (row.flow_type === 'pull') {
      if (row.platform === 'all') entry.total = Number(row.count)
      else entry.detail[row.platform] = Number(row.count)
    } else {
      if (row.sheet && row.platform === 'all') {
        entry.total += Number(row.count)
        entry.detail[row.sheet] = Number(row.count)
      }
    }
  }

  for (const day of Object.values(dayMap)) {
    day.entries.sort((a, b) =>
      ENTRY_ORDER.indexOf(`${a.flow_type}-${a.period}`) - ENTRY_ORDER.indexOf(`${b.flow_type}-${b.period}`)
    )
  }

  const result = Object.values(dayMap).sort((a, b) => b.log_date.localeCompare(a.log_date))

  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
