import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { TRENDS_FIELD, SYNC_USER } from '@/lib/playtest-tags'

export const dynamic = 'force-dynamic'

// GET /api/playtest-tags/history — everything that left the queue (synced,
// rejected or removed), with the provenance Signal Sense cannot store: who
// tagged, who confirmed, what the sync actually did, and whether the tag is
// still there. `in_signal_sense` is read live, so a tag deleted over there shows
// as gone even before the reconcile sweep stamps removed_at; `ours` says whether
// playtest_sync created that row, which is the only case this app may remove.
//
// Readable by any signed-in user, and deliberately not scoped to the reader:
// this is the record evaluators learn from, and a correction is most useful when
// you can see how the same trend was judged on other people's games. `original_*`
// plus `review_note` are what makes that legible — what was proposed, what was
// confirmed, and the admin's reason where they left one.
export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const sp = req.nextUrl.searchParams
  const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1)
  const limit = Math.min(200, Math.max(1, parseInt(sp.get('limit') || '50', 10) || 50))
  const tagger = (sp.get('tagger') || '').trim()
  const from = (sp.get('from') || '').trim()
  const to = (sp.get('to') || '').trim()

  const taggerFilter = tagger ? sql`AND pt.tagged_by = ${tagger}` : sql``
  // tagged_at is timestamptz and the picker means UTC+7 dates, so each bound is
  // anchored in that zone. A bare `::date` bound is read in the session's
  // TimeZone (GMT on Neon), which puts both ends seven hours out: verified on
  // prod, a tag made 03:00 on 1 Aug UTC+7 fell outside "from 1 Aug", and one
  // made 05:00 on 14 Aug fell inside "to 13 Aug". `::timestamp` first is
  // required — `date AT TIME ZONE` resolves through timestamptz and hands back a
  // naive timestamp, converting the wrong way.
  const fromFilter = from
    ? sql`AND pt.tagged_at >= (${from}::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`
    : sql``
  const toFilter = to
    ? sql`AND pt.tagged_at < (${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`
    : sql``

  const [rows, totals, taggers] = await Promise.all([
    sql`
      SELECT
        pt.id, pt.game_id, pt.field_value, pt.status, pt.sync_result,
        pt.tagged_at, pt.confirmed_at, pt.removed_at, pt.removed_by,
        pt.review_note, pt.original_captured_at, pt.original_field_value, pt.edited_at,
        gi.title, gi.icon_url, sv.name AS sub_value_name,
        osv.name AS original_sub_value_name,
        tagger.name AS tagged_by_name, confirmer.name AS confirmed_by_name,
        editor.name AS edited_by_name,
        remover.name AS removed_by_name,
        (cfv.field_value IS NOT NULL) AS in_signal_sense,
        (cfv.created_by = ${SYNC_USER}) AS ours,
        subchg.changed_at AS sub_changed_at,
        subchg.was AS sub_changed_from,
        subchg.now_is AS sub_changed_to,
        subchg.email AS sub_changed_by
      FROM playtest_tags pt
      JOIN game_info gi ON gi.game_id = pt.game_id
      LEFT JOIN sub_value_definitions sv ON sv.id = pt.sub_value_id
      -- The sub-value the evaluator proposed, kept only when an admin edited the
      -- row. original_captured_at is what says whether these columns mean
      -- anything: a NULL original_sub_value_id on an edited row is the real
      -- answer "they proposed no sub-value", not "nothing was recorded".
      LEFT JOIN sub_value_definitions osv ON osv.id = pt.original_sub_value_id
      LEFT JOIN dashboard_users tagger ON tagger.email = pt.tagged_by
      LEFT JOIN dashboard_users confirmer ON confirmer.email = pt.confirmed_by
      -- Who corrected the tag, which is often neither the tagger nor the confirmer.
      LEFT JOIN dashboard_users editor ON editor.email = pt.edited_by
      LEFT JOIN dashboard_users remover ON remover.email = pt.removed_by
      LEFT JOIN custom_field_values cfv
        ON cfv.game_id = pt.game_id AND cfv.field_name = ${TRENDS_FIELD} AND cfv.field_value = pt.field_value
      -- Latest sub-value overwrite made in Signal Sense AFTER our confirm. The
      -- row still exists, so the absence sweep cannot see this: without the
      -- change log, history would keep claiming the sub-value we wrote.
      LEFT JOIN LATERAL (
        SELECT c.changed_at, osv.name AS was, nsv.name AS now_is, cu.email
        FROM custom_field_value_changes c
        LEFT JOIN sub_value_definitions osv ON osv.id = c.old_sub_value_id
        LEFT JOIN sub_value_definitions nsv ON nsv.id = c.new_sub_value_id
        LEFT JOIN users cu ON cu.id = c.changed_by
        WHERE c.game_id = pt.game_id
          AND c.field_name = ${TRENDS_FIELD}
          AND c.field_value = pt.field_value
          AND c.action = 'sub_value_change'
          AND c.changed_at > pt.confirmed_at
        ORDER BY c.changed_at DESC
        LIMIT 1
      ) subchg ON true
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
    // Who the "Proposed by" filter can offer. Deliberately unfiltered: options
    // built from the current range would vanish as the reader narrows the dates,
    // and picking a name would then be able to empty its own dropdown.
    sql`
      SELECT DISTINCT pt.tagged_by AS email, du.name
      FROM playtest_tags pt
      LEFT JOIN dashboard_users du ON du.email = pt.tagged_by
      WHERE pt.status <> 'pending'
      ORDER BY du.name NULLS LAST
    `,
  ])

  return NextResponse.json(
    { rows, total: totals[0]?.total ?? 0, page, limit, taggers },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
