import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireRole } from '@/lib/auth-guard'

function verifyWebhookSecret(req: NextRequest) {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

// POST /api/pull-logs — n8n calls after each import run
// Body: { log_date?: 'YYYY-MM-DD' }
// Endpoint auto-detects period from current time (UTC+7):
//   if hour < 12 → 'morning', else → 'afternoon'
// Counts from game_info directly, stores total + ios + android breakdown
export async function POST(req: NextRequest) {
  if (!verifyWebhookSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { log_date } = body

  const targetDate = log_date ?? new Date().toISOString().slice(0, 10)

  // Auto-detect period based on current time in UTC+7 (Asia/Ho_Chi_Minh)
  const now = new Date()
  const utc7Time = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
  const hour = utc7Time.getHours()
  const period = hour < 12 ? 'morning' : 'afternoon'

  const [counts] = await sql<[{ total: string; ios: string; android: string }]>`
    SELECT
      COUNT(*)                                    AS total,
      COUNT(*) FILTER (WHERE os = 'ios')          AS ios,
      COUNT(*) FILTER (WHERE os = 'android')      AS android
    FROM game_info
    WHERE created_date = ${targetDate}::date
  `

  const total = parseInt(counts.total)
  const ios = parseInt(counts.ios)
  const android = parseInt(counts.android)

  // Upsert: total row + per-platform rows
  await sql`
    INSERT INTO game_flow_logs (log_date, flow_type, period, sheet, platform, count)
    VALUES
      (${targetDate}::date, 'pull', ${period}, NULL, 'all',     ${total}),
      (${targetDate}::date, 'pull', ${period}, NULL, 'ios',     ${ios}),
      (${targetDate}::date, 'pull', ${period}, NULL, 'android', ${android})
    ON CONFLICT (log_date, period, platform) WHERE flow_type = 'pull'
      DO UPDATE SET count = EXCLUDED.count, created_at = NOW()
  `

  return NextResponse.json({ ok: true, log_date: targetDate, period, total, ios, android })
}

// GET /api/pull-logs?date=YYYY-MM-DD
export async function GET(req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const date = new URL(req.url).searchParams.get('date') ?? new Date().toISOString().slice(0, 10)

  const rows = await sql`
    SELECT period, platform, count, created_at
    FROM game_flow_logs
    WHERE log_date = ${date}::date AND flow_type = 'pull'
    ORDER BY period, platform NULLS FIRST
  `

  const get = (period: string, platform: string) =>
    rows.find(r => r.period === period && r.platform === platform)?.count ?? null

  const morning   = { total: get('morning', 'all'),   ios: get('morning', 'ios'),   android: get('morning', 'android') }
  const afternoon = { total: get('afternoon', 'all'), ios: get('afternoon', 'ios'), android: get('afternoon', 'android') }
  const delta = morning.total !== null && afternoon.total !== null
    ? { total: afternoon.total - morning.total, ios: (afternoon.ios ?? 0) - (morning.ios ?? 0), android: (afternoon.android ?? 0) - (morning.android ?? 0) }
    : null

  return NextResponse.json({ date, morning, afternoon, delta })
}
