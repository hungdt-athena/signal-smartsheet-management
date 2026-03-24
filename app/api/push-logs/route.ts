import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireRole } from '@/lib/auth-guard'

const VALID_SHEETS = ['puzzle', 'arcade', 'simulation']

function verifyWebhookSecret(req: NextRequest) {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

// POST /api/push-logs — n8n calls at end of database-to-smartsheet workflow
// n8n already knows the counts per sheet per platform, so it sends them directly.
//
// Body (one call per sheet):
//   { sheet: 'puzzle', log_date?: 'YYYY-MM-DD', total: 38, ios: 20, android: 18 }
//
// Or send all sheets in one call:
//   { log_date?: 'YYYY-MM-DD', sheets: [
//       { sheet: 'puzzle',     total: 38, ios: 20, android: 18 },
//       { sheet: 'arcade',     total: 25, ios: 12, android: 13 },
//       { sheet: 'simulation', total: 10, ios: 5,  android: 5  }
//   ]}
export async function POST(req: NextRequest) {
  if (!verifyWebhookSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const targetDate = body.log_date ?? new Date().toISOString().slice(0, 10)

  // Auto-detect period from current time UTC+7
  const utc7Hour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' })).getHours()
  const period = utc7Hour < 12 ? 'morning' : 'afternoon'

  // Normalize to array of sheet entries
  const entries: Array<{ sheet: string; total: number }> =
    body.sheets ?? [{ sheet: body.sheet, total: body.total }]

  for (const e of entries) {
    if (!VALID_SHEETS.includes(e.sheet)) {
      return NextResponse.json({ error: `sheet must be one of: ${VALID_SHEETS.join(', ')}` }, { status: 400 })
    }
  }

  for (const e of entries) {
    await sql`
      INSERT INTO game_flow_logs (log_date, flow_type, period, sheet, platform, count)
      VALUES (${targetDate}::date, 'push', ${period}, ${e.sheet}, 'all', ${e.total})
      ON CONFLICT (log_date, sheet, platform, period) WHERE flow_type = 'push'
        DO UPDATE SET count = EXCLUDED.count, created_at = NOW()
    `
  }

  return NextResponse.json({ ok: true, log_date: targetDate, sheets: entries.map(e => e.sheet) })
}

// GET /api/push-logs?date=YYYY-MM-DD
export async function GET(req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const date = new URL(req.url).searchParams.get('date') ?? new Date().toISOString().slice(0, 10)

  const rows = await sql`
    SELECT sheet, platform, count, created_at
    FROM game_flow_logs
    WHERE log_date = ${date}::date AND flow_type = 'push'
    ORDER BY sheet, platform NULLS FIRST
  `

  const result: Record<string, number | null> = {}
  for (const sheet of VALID_SHEETS) {
    result[sheet] = rows.find(r => r.sheet === sheet && r.platform === 'all')?.count ?? null
  }

  const grandTotal = Object.values(result).reduce((sum, c) => sum + (c ?? 0), 0)

  return NextResponse.json({ date, sheets: result, total: grandTotal })
}
