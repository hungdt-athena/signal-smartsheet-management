import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { TRENDS_FIELD } from '@/lib/playtest-tags'

export const dynamic = 'force-dynamic'

/** One trend as the listing shows it: what it is, how much it is used, and how
 *  recently. `total` and `last30` count games, not proposals — a tag lives in
 *  custom_field_values once per game. */
interface TrendRow {
  value: string
  total: number
  last30: number
  lastTaggedAt: string | null
  hasInstruction: boolean
}

// The counts move slowly (a handful of tags a day against ~351 trends) while the
// listing is opened repeatedly, so the aggregate is worth holding briefly.
const TTL_MS = 5 * 60 * 1000
let cache: { at: number; data: TrendRow[] } | null = null

// GET /api/trends/catalog — every active Trends definition with its usage, for
// the Tagging tab's listing. Read-only, and read by evaluators as well as
// admins: knowing which trends exist is the point of the view.
export async function GET(_req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  if (cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json({ trends: cache.data }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // Definitions are grouped rather than joined straight: the same field_value
  // can hold more than one definition row, and the listing wants one line per
  // trend. The values side is aggregated before the join so a trend nobody has
  // tagged still comes back, with zeroes.
  const rows = await sql`
    WITH defs AS (
      SELECT field_value, bool_or(instruction IS NOT NULL) AS has_instruction
      FROM custom_field_definitions
      WHERE field_name = ${TRENDS_FIELD} AND is_active
      GROUP BY field_value
    ), used AS (
      SELECT field_value,
             count(*)::int AS total,
             count(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS last30,
             max(created_at) AS last_tagged_at
      FROM custom_field_values
      WHERE field_name = ${TRENDS_FIELD} AND is_active
      GROUP BY field_value
    )
    SELECT d.field_value,
           COALESCE(u.total, 0) AS total,
           COALESCE(u.last30, 0) AS last30,
           u.last_tagged_at,
           d.has_instruction
    FROM defs d
    LEFT JOIN used u ON u.field_value = d.field_value
    ORDER BY COALESCE(u.last30, 0) DESC, COALESCE(u.total, 0) DESC, d.field_value
  `

  const data: TrendRow[] = rows.map(r => ({
    value: r.field_value as string,
    total: Number(r.total ?? 0),
    last30: Number(r.last30 ?? 0),
    lastTaggedAt: (r.last_tagged_at as string | null) ?? null,
    hasInstruction: Boolean(r.has_instruction),
  }))
  cache = { at: Date.now(), data }
  return NextResponse.json({ trends: data }, { headers: { 'Cache-Control': 'no-store' } })
}
