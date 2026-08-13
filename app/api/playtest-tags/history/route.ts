import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/playtest-tags/history — everything that left the queue (synced or
// rejected), with the provenance Signal Sense cannot store: who tagged, who
// confirmed, and what the sync actually did.
export async function GET(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const sp = req.nextUrl.searchParams
  const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1)
  const limit = Math.min(200, Math.max(1, parseInt(sp.get('limit') || '50', 10) || 50))
  const tagger = (sp.get('tagger') || '').trim()
  const from = (sp.get('from') || '').trim()
  const to = (sp.get('to') || '').trim()

  const taggerFilter = tagger ? sql`AND pt.tagged_by = ${tagger}` : sql``
  const fromFilter = from ? sql`AND pt.tagged_at >= ${from}::date` : sql``
  const toFilter = to ? sql`AND pt.tagged_at < (${to}::date + 1)` : sql``

  const [rows, totals] = await Promise.all([
    sql`
      SELECT
        pt.id, pt.game_id, pt.field_value, pt.status, pt.sync_result,
        pt.tagged_at, pt.confirmed_at,
        gi.title, gi.icon_url, sv.name AS sub_value_name,
        tagger.name AS tagged_by_name, confirmer.name AS confirmed_by_name
      FROM playtest_tags pt
      JOIN game_info gi ON gi.game_id = pt.game_id
      LEFT JOIN sub_value_definitions sv ON sv.id = pt.sub_value_id
      LEFT JOIN dashboard_users tagger ON tagger.email = pt.tagged_by
      LEFT JOIN dashboard_users confirmer ON confirmer.email = pt.confirmed_by
      WHERE pt.status <> 'pending'
        ${taggerFilter} ${fromFilter} ${toFilter}
      ORDER BY pt.confirmed_at DESC NULLS LAST, pt.id DESC
      LIMIT ${limit} OFFSET ${(page - 1) * limit}
    `,
    sql`
      SELECT count(*)::int AS total
      FROM playtest_tags pt
      WHERE pt.status <> 'pending'
        ${taggerFilter} ${fromFilter} ${toFilter}
    `,
  ])

  return NextResponse.json(
    { rows, total: totals[0]?.total ?? 0, page, limit },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
