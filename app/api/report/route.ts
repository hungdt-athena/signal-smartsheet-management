import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import {
  groupByEvaluator, groupByPeriod, deriveMetrics, weeksInRange, mergeConclusions,
  pctChange,
  type RollupRow, type Domain, type Granularity,
} from '@/lib/report'

export const dynamic = 'force-dynamic'

// GET /api/report — reads the precomputed report_rollup and returns one bundle that
// powers every Report sub-tab (Team Overview / Leaderboard / Individual / Heatmap).
// Params: domain=evaluation|recording, period=week|month|quarter|overall,
//         category=all|puzzle|arcade|simulation, from?/to?=YYYY-MM-DD (period_week).
// Non-managers are name-scoped to themselves (mirrors quick-stats).

const GRANS: Granularity[] = ['week', 'month', 'quarter', 'overall']

export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const { searchParams } = req.nextUrl
    const domain: Domain = searchParams.get('domain') === 'recording' ? 'recording' : 'evaluation'
    const period = (searchParams.get('period') || 'week') as Granularity
    const granularity: Granularity = GRANS.includes(period) ? period : 'week'
    const category = (searchParams.get('category') || 'all').toLowerCase()
    const from = (searchParams.get('from') || '').trim()
    const to = (searchParams.get('to') || '').trim()

    // Row-level scoping: managers see everyone, others only their own name.
    let restrictTo = ''
    if (process.env.SKIP_AUTH !== 'true') {
      const session = await getServerSession(authOptions)
      const role = session?.user?.role
      if (role !== 'admin' && role !== 'moderator') {
        restrictTo = session?.user?.name || ''
        if (!restrictTo) return NextResponse.json(emptyBundle(domain, granularity, category, true))
      }
    }

    const catFilter = category !== 'all' ? sql`AND category_group = ${category}` : sql``
    const scopeFilter = restrictTo ? sql`AND evaluator_key = lower(${restrictTo})` : sql``
    const fromFilter = /^\d{4}-\d{2}-\d{2}$/.test(from) ? sql`AND period_week >= ${from}::date` : sql``
    const toFilter = /^\d{4}-\d{2}-\d{2}$/.test(to) ? sql`AND period_week <= ${to}::date` : sql``

    const rows = await sql<RollupRow[]>`
      SELECT period_week::text, period_month, period_quarter, category_group, domain,
             evaluator, evaluator_key, games, active_days, turnaround_sum,
             turnaround_count, priority_count, conclusions
      FROM report_rollup
      WHERE domain = ${domain}
        ${catFilter} ${scopeFilter} ${fromFilter} ${toFilter}
    `

    if (rows.length === 0) {
      return NextResponse.json(emptyBundle(domain, granularity, category, restrictTo === ''))
    }

    const weeks = weeksInRange(rows)

    // Per-period team buckets (for the selected granularity) — powers the volume /
    // trend charts and the heatmap columns.
    const buckets = groupByPeriod(rows, granularity)
    const periods = buckets.map((b) => ({ key: b.key, label: b.label }))
    const teamSeries = buckets.map((b) => ({
      key: b.key, label: b.label,
      games: b.c.games, activeDays: b.c.active_days,
      turnaround: b.c.turnaround_count > 0 ? b.c.turnaround_sum / b.c.turnaround_count : null,
      priorityCount: b.c.priority_count,
    }))

    // Per-evaluator aggregates + per-bucket series (heatmap cells + individual view).
    const byEval = groupByEvaluator(rows)
    const evaluators = Array.from(byEval.entries()).map(([key, { name, c }]) => {
      const evRows = rows.filter((r) => r.evaluator_key === key)
      const series: Record<string, number> = {}
      for (const b of groupByPeriod(evRows, granularity)) series[b.key] = b.c.games
      return {
        key, name,
        metrics: deriveMetrics(c, weeks),
        conclusions: c.conclusions,
        series,
      }
    }).sort((a, b) => b.metrics.games - a.metrics.games)

    // Team KPI headline. avgThroughput/avgTurnaround are means across evaluators so
    // one prolific person doesn't distort the "typical" rate.
    const totalGames = evaluators.reduce((s, e) => s + e.metrics.games, 0)
    const activePeople = evaluators.filter((e) => e.metrics.games > 0).length
    const throughputs = evaluators.filter((e) => e.metrics.games > 0).map((e) => e.metrics.throughput)
    const turnarounds = evaluators.map((e) => e.metrics.turnaround).filter((t): t is number => t != null)
    const teamTotals = {
      totalGames,
      activePeople,
      avgThroughput: throughputs.length ? throughputs.reduce((a, b) => a + b, 0) / throughputs.length : 0,
      avgTurnaround: turnarounds.length ? turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length : null,
      priorityRate: totalGames ? evaluators.reduce((s, e) => s + e.metrics.priorityRate * e.metrics.games, 0) / totalGames : 0,
    }

    // Team-level trend: last comparable bucket vs the one before it.
    const teamTrend = teamSeries.length >= 2
      ? pctChange(teamSeries[teamSeries.length - 1].games, teamSeries[teamSeries.length - 2].games)
      : null

    return NextResponse.json({
      stale: false,
      domain, period: granularity, category,
      canSeeTeam: restrictTo === '',
      weeksInRange: weeks,
      periods, teamSeries, teamTotals, teamTrend,
      evaluators,
      conclusions: mergeConclusions(rows),
    })
  } catch (err) {
    console.error('GET /api/report error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

function emptyBundle(domain: Domain, period: Granularity, category: string, canSeeTeam: boolean) {
  return {
    stale: true,
    domain, period, category, canSeeTeam,
    weeksInRange: 0,
    periods: [], teamSeries: [], evaluators: [], conclusions: [],
    teamTotals: { totalGames: 0, activePeople: 0, avgThroughput: 0, avgTurnaround: null, priorityRate: 0 },
    teamTrend: null,
  }
}
