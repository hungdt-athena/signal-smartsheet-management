import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireRole } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

function verifyWebhookSecret(req: NextRequest) {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

export async function POST(req: NextRequest) {
  if (!verifyWebhookSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { stat_date, evaluator_name = null, games_pulled, games_pushed, games_assigned, games_evaluated } = body

  if (!stat_date) {
    return NextResponse.json({ error: 'stat_date is required' }, { status: 400 })
  }

  await sql`
    INSERT INTO daily_stats (stat_date, evaluator_name, games_pulled, games_pushed, games_assigned, games_evaluated)
    VALUES (
      ${stat_date}::date,
      ${evaluator_name},
      ${games_pulled ?? 0},
      ${games_pushed ?? 0},
      ${games_assigned ?? 0},
      ${games_evaluated ?? 0}
    )
    ON CONFLICT (stat_date, evaluator_name) DO UPDATE SET
      games_pulled    = daily_stats.games_pulled    + EXCLUDED.games_pulled,
      games_pushed    = daily_stats.games_pushed    + EXCLUDED.games_pushed,
      games_assigned  = daily_stats.games_assigned  + EXCLUDED.games_assigned,
      games_evaluated = daily_stats.games_evaluated + EXCLUDED.games_evaluated,
      updated_at      = NOW()
  `

  return NextResponse.json({ ok: true })
}

export async function GET(_req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const [
    pullRealtime,
    pullCheckpoints,
    pushLogs,
    workflows,
  ] = await Promise.all([
    // Realtime: count directly from game_info — always live
    sql<[{ total: string; ios: string; android: string }]>`
      SELECT
        COUNT(*)                                  AS total,
        COUNT(*) FILTER (WHERE os = 'ios')        AS ios,
        COUNT(*) FILTER (WHERE os = 'android')    AS android
      FROM game_info
      WHERE created_date = CURRENT_DATE
    `,

    // Checkpoints at 12h and 16h (set by n8n cron)
    sql`
      SELECT period, platform, count
      FROM game_flow_logs
      WHERE log_date = CURRENT_DATE AND flow_type = 'pull'
      ORDER BY period, platform NULLS FIRST
    `,

    // Push counts per sheet today — sum all periods (morning + afternoon runs)
    sql`
      SELECT sheet, SUM(count) AS count
      FROM game_flow_logs
      WHERE log_date = CURRENT_DATE AND flow_type = 'push' AND platform = 'all'
      GROUP BY sheet
    `,

    // Last run per workflow (for status badges)
    sql`
      SELECT DISTINCT ON (workflow_name) workflow_name, status, created_at
      FROM ops_logs
      ORDER BY workflow_name, created_at DESC
    `,
  ])

  const getCP = (period: string, platform: string) =>
    pullCheckpoints.find(r => r.period === period && r.platform === platform)?.count ?? null
  const getSheet = (sheet: string) =>
    pushLogs.find(r => r.sheet === sheet) ? Number(pushLogs.find(r => r.sheet === sheet)!.count) : null

  const morning   = { total: getCP('morning', 'all'),   ios: getCP('morning', 'ios'),   android: getCP('morning', 'android') }
  const afternoon = { total: getCP('afternoon', 'all'), ios: getCP('afternoon', 'ios'), android: getCP('afternoon', 'android') }

  return NextResponse.json({
    pull: {
      realtime: {
        total:   parseInt(pullRealtime[0].total),
        ios:     parseInt(pullRealtime[0].ios),
        android: parseInt(pullRealtime[0].android),
      },
      morning,
      afternoon,
      delta: morning.total !== null && afternoon.total !== null
        ? { total: afternoon.total - morning.total, ios: (afternoon.ios ?? 0) - (morning.ios ?? 0), android: (afternoon.android ?? 0) - (morning.android ?? 0) }
        : null,
    },
    push: {
      puzzle:     getSheet('puzzle'),
      arcade:     getSheet('arcade'),
      simulation: getSheet('simulation'),
    },
    workflows,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
