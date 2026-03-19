import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

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
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Global stats today
  const [globalStats] = await sql`
    SELECT games_pulled, games_pushed
    FROM daily_stats
    WHERE stat_date = CURRENT_DATE AND evaluator_name IS NULL
  `

  // Latest successful import run today for category/OS breakdown
  const [latestImport] = await sql`
    SELECT summary FROM ops_logs
    WHERE workflow_name = 'import_daily_game'
      AND status = 'success'
      AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'
    ORDER BY created_at DESC
    LIMIT 1
  `

  // Last run per workflow
  const workflows = await sql`
    SELECT DISTINCT ON (workflow_name) workflow_name, status, created_at
    FROM ops_logs
    ORDER BY workflow_name, created_at DESC
  `

  return NextResponse.json({
    today: {
      games_pulled: globalStats?.games_pulled ?? 0,
      games_pushed: globalStats?.games_pushed ?? 0,
      ...(latestImport?.summary ?? { total: 0, puzzle: 0, arcade: 0, sim: 0, ios: 0, android: 0 }),
    },
    workflows,
  })
}
