import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { TRENDS_FIELD } from '@/lib/playtest-tags'

export const dynamic = 'force-dynamic'

interface Row {
  id: number
  game_id: string
  title: string
  publisher_name: string | null
  icon_url: string | null
  initial_evaluator: string | null
  field_value: string
  sub_value_id: number | null
  sub_value_name: string | null
  tagged_by_name: string | null
  tagged_at: string
  their_sub_value_id: number | null
  their_sub_value_name: string | null
}

// GET /api/playtest-tags/pending — the admin review queue, grouped by game.
// `conflict` marks a tag whose value already exists in Signal Sense with a
// different sub-value; confirming does not write it unless the admin overwrites.
export async function GET(_req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const rows = await sql`
    SELECT
      pt.id, pt.game_id, pt.field_value, pt.sub_value_id, pt.tagged_at,
      gi.title, gi.icon_url,
      COALESCE(dev.developer_name, dev.dev_company) AS publisher_name,
      ge.initial_evaluator,
      du.name AS tagged_by_name,
      sv.name AS sub_value_name,
      cfv.sub_value_id AS their_sub_value_id,
      their_sv.name AS their_sub_value_name
    FROM playtest_tags pt
    JOIN game_info gi ON gi.game_id = pt.game_id
    LEFT JOIN developer dev ON gi.publisher_id = dev.id
    LEFT JOIN game_evaluations ge ON ge.game_id = pt.game_id
    LEFT JOIN dashboard_users du ON du.email = pt.tagged_by
    LEFT JOIN sub_value_definitions sv ON sv.id = pt.sub_value_id
    LEFT JOIN custom_field_values cfv
      ON cfv.game_id = pt.game_id AND cfv.field_name = ${TRENDS_FIELD} AND cfv.field_value = pt.field_value
    LEFT JOIN sub_value_definitions their_sv ON their_sv.id = cfv.sub_value_id
    WHERE pt.status = 'pending'
    ORDER BY pt.tagged_at DESC, pt.field_value
  ` as unknown as Row[]

  // Group in JS: one card per game, tags in the order the query returned them.
  const games = new Map<string, {
    game_id: string; title: string; publisher_name: string | null
    icon_url: string | null; initial_evaluator: string | null; tags: unknown[]
  }>()
  for (const r of rows) {
    let g = games.get(r.game_id)
    if (!g) {
      g = {
        game_id: r.game_id, title: r.title, publisher_name: r.publisher_name,
        icon_url: r.icon_url, initial_evaluator: r.initial_evaluator, tags: [],
      }
      games.set(r.game_id, g)
    }
    // A conflict needs both sides to carry a sub-value and to disagree; the
    // fill-an-empty-sub-value case is applied silently on confirm.
    const conflict = r.their_sub_value_id !== null
      && r.sub_value_id !== null
      && r.their_sub_value_id !== r.sub_value_id
    g.tags.push({
      id: r.id, field_value: r.field_value, sub_value_id: r.sub_value_id,
      sub_value_name: r.sub_value_name, tagged_by_name: r.tagged_by_name,
      tagged_at: r.tagged_at, their_sub_value_id: r.their_sub_value_id,
      their_sub_value_name: r.their_sub_value_name, conflict,
    })
  }

  return NextResponse.json({ games: Array.from(games.values()) }, { headers: { 'Cache-Control': 'no-store' } })
}
