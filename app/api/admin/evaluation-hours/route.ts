import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { loadPanelTime, PANEL_CAP_S, DEMO_CREDIT_S, DEFAULT_TITLES } from '@/lib/evaluation-hours'

export const dynamic = 'force-dynamic'

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
// Inclusive range: 92 calendar days means to - from <= 91.
const MAX_SPAN_DAYS = 91
const DAY_MS = 86_400_000

/** Epoch ms of a real calendar date, or null. Round-trips through UTC so that
 *  2026-02-31 or 2026-13-01 is rejected instead of rolled over. */
function parseRealDate(s: string): number | null {
  const m = DATE.exec(s)
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return new Date(ms).toISOString().slice(0, 10) === s ? ms : null
}

// Panel time per person per VN day (evaluation_log). Admin only: it is per-person time.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin()
  if (guard) return guard
  const from = req.nextUrl.searchParams.get('from') ?? ''
  const to = req.nextUrl.searchParams.get('to') ?? ''
  const fromMs = parseRealDate(from)
  const toMs = parseRealDate(to)
  if (fromMs === null || toMs === null) {
    return NextResponse.json({ error: 'from and to must be real dates (YYYY-MM-DD)' }, { status: 400 })
  }
  const days = (toMs - fromMs) / DAY_MS
  if (days < 0) return NextResponse.json({ error: 'to must not be before from' }, { status: 400 })
  if (days > MAX_SPAN_DAYS) return NextResponse.json({ error: 'range over 92 days' }, { status: 400 })
  try {
    const { time, games } = await loadPanelTime({ from, to })
    return NextResponse.json({ from, to, cap_s: PANEL_CAP_S, demo_credit_s: DEMO_CREDIT_S, titles: DEFAULT_TITLES, time, games })
  } catch (err) {
    console.error('GET /api/admin/evaluation-hours error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
