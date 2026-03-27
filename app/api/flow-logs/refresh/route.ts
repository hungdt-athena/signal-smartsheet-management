import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireRole } from '@/lib/auth-guard'

// POST /api/flow-logs/refresh — manual pull log snapshot (same logic as n8n schedule)
export async function POST(_req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  await sql`
    INSERT INTO game_flow_logs (log_date, flow_type, period, sheet, platform, count)
    SELECT CURRENT_DATE, 'pull',
      CASE WHEN EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh') < 12 THEN 'morning' ELSE 'afternoon' END,
      NULL, p, cnt
    FROM (
      SELECT 'all'      AS p, COUNT(*)                                AS cnt FROM game_info WHERE created_date = CURRENT_DATE
      UNION ALL
      SELECT 'ios',          COUNT(*) FILTER (WHERE os = 'ios')      FROM game_info WHERE created_date = CURRENT_DATE
      UNION ALL
      SELECT 'android',      COUNT(*) FILTER (WHERE os = 'android')  FROM game_info WHERE created_date = CURRENT_DATE
    ) counts
    ON CONFLICT (log_date, period, platform) WHERE flow_type = 'pull'
      DO UPDATE SET count = EXCLUDED.count, created_at = NOW()
  `

  return NextResponse.json({ ok: true })
}
