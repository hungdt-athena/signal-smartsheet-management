import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { TRENDS_FIELD } from '@/lib/playtest-tags'

export const dynamic = 'force-dynamic'

/** How many recent games one trend shows. Enough to recognise the pattern a
 *  trend stands for without turning the popup into a second listing. */
const RECENT = 20

// GET /api/trends/detail?value=X — what a trend means and which games carry it.
//
// The instruction is Signal Sense's own guidance for the tag, written as
// markdown; the games are whatever holds the trend now, newest tag first,
// wherever the tag came from.
export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const value = req.nextUrl.searchParams.get('value')?.trim()
  if (!value) return NextResponse.json({ error: 'value is required' }, { status: 400 })

  const [defs, games] = await Promise.all([
    sql`
      SELECT instruction FROM custom_field_definitions
      WHERE field_name = ${TRENDS_FIELD} AND field_value = ${value} AND is_active
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1
    `,
    sql`
      SELECT v.game_id, gi.title, gi.icon_url, sv.name AS sub_value_name, v.created_at
      FROM custom_field_values v
      JOIN game_info gi ON gi.game_id = v.game_id
      LEFT JOIN sub_value_definitions sv ON sv.id = v.sub_value_id
      WHERE v.field_name = ${TRENDS_FIELD} AND v.field_value = ${value} AND v.is_active
      ORDER BY v.created_at DESC
      LIMIT ${RECENT}
    `,
  ])

  return NextResponse.json({
    value,
    instruction: (defs[0]?.instruction as string | null) ?? null,
    games: games.map(g => ({
      game_id: g.game_id as string,
      title: g.title as string,
      icon_url: (g.icon_url as string | null) ?? null,
      sub_value_name: (g.sub_value_name as string | null) ?? null,
      created_at: g.created_at as string,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
