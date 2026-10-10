import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { loadPanelTime, PANEL_CAP_S, DEFAULT_TITLES } from '@/lib/evaluation-hours'

export const dynamic = 'force-dynamic'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 92

// Panel time per person per VN day (evaluation_log). Admin only: it is per-person time.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin()
  if (guard) return guard
  const from = req.nextUrl.searchParams.get('from') ?? ''
  const to = req.nextUrl.searchParams.get('to') ?? ''
  if (!DATE.test(from) || !DATE.test(to)) {
    return NextResponse.json({ error: 'from and to must be YYYY-MM-DD' }, { status: 400 })
  }
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000
  if (!(days >= 0)) return NextResponse.json({ error: 'to must not be before from' }, { status: 400 })
  if (days > MAX_DAYS) return NextResponse.json({ error: `range over ${MAX_DAYS} days` }, { status: 400 })
  try {
    const { time, games } = await loadPanelTime({ from, to })
    return NextResponse.json({ from, to, cap_s: PANEL_CAP_S, titles: DEFAULT_TITLES, time, games })
  } catch (err) {
    console.error('GET /api/admin/evaluation-hours error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
