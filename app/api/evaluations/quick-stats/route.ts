import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/evaluations/quick-stats — per-evaluator totals for the stats modal.
// Managers (admin/moderator) see every evaluator; evaluators only themselves —
// enforced server-side from the session, not from a query param.
export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const { searchParams } = req.nextUrl
    const category = searchParams.get('category') || 'puzzle'
    const year = parseInt(searchParams.get('year') || '0')
    const month = parseInt(searchParams.get('month') || '0')

    let restrictTo = ''
    if (process.env.SKIP_AUTH !== 'true') {
      const session = await getServerSession(authOptions)
      const role = session?.user?.role
      if (role !== 'admin' && role !== 'moderator') {
        restrictTo = session?.user?.name || ''
        if (!restrictTo) return NextResponse.json({ data: [] })
      }
    }

    const monthFilter = year > 0 && month > 0
      ? sql`AND ge.assigned_date >= make_date(${year}, ${month}, 1)
            AND ge.assigned_date < make_date(${year}, ${month}, 1) + interval '1 month'`
      : sql``
    const evaluatorFilter = restrictTo
      ? sql`AND lower(ge.initial_evaluator) = lower(${restrictTo})`
      : sql``
    const baseWhere = sql`
      ge.category_group = ${category}
        AND ge.initial_evaluator IS NOT NULL
        ${monthFilter}
        ${evaluatorFilter}
    `

    // Grouped case-insensitively (sheet data has Huydd vs HuyDD drift).
    const [totals, conclusions, platforms] = await Promise.all([
      sql`
        SELECT lower(ge.initial_evaluator) AS k,
          mode() WITHIN GROUP (ORDER BY ge.initial_evaluator) AS evaluator,
          count(*)::int AS total,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL)::int AS done,
          count(*) FILTER (WHERE ge.drive_link IS NOT NULL AND ge.drive_link <> '')::int AS drive_links
        FROM game_evaluations ge
        WHERE ${baseWhere}
        GROUP BY lower(ge.initial_evaluator)
        ORDER BY total DESC, 2
      `,
      sql`
        SELECT lower(ge.initial_evaluator) AS k,
          ge.initial_conclusion AS conclusion,
          count(*)::int AS n
        FROM game_evaluations ge
        WHERE ${baseWhere}
          AND ge.initial_conclusion IS NOT NULL
          AND ge.initial_conclusion <> 'Link_dead'
        GROUP BY lower(ge.initial_evaluator), ge.initial_conclusion
      `,
      sql`
        SELECT lower(ge.initial_evaluator) AS k,
          lower(COALESCE(gi.os, 'unknown')) AS os,
          count(*)::int AS n
        FROM game_evaluations ge
        JOIN game_info gi ON ge.game_id = gi.game_id
        WHERE ${baseWhere}
        GROUP BY lower(ge.initial_evaluator), lower(COALESCE(gi.os, 'unknown'))
      `,
    ])

    const byKey = new Map<string, Record<string, number>>()
    for (const row of conclusions) {
      const m = byKey.get(row.k) || {}
      m[row.conclusion] = row.n
      byKey.set(row.k, m)
    }

    const platByKey = new Map<string, Record<string, number>>()
    for (const row of platforms) {
      const m = platByKey.get(row.k) || {}
      m[row.os] = row.n
      platByKey.set(row.k, m)
    }

    const data = totals.map(t => ({
      evaluator: t.evaluator,
      total: t.total,
      done: t.done,
      pending: t.total - t.done,
      drive_links: t.drive_links,
      conclusions: byKey.get(t.k) || {},
      platforms: platByKey.get(t.k) || {},
    }))

    return NextResponse.json({ data })
  } catch (err) {
    console.error('GET /api/evaluations/quick-stats error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
