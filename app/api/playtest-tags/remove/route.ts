import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireManager } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import { TRENDS_FIELD, SYNC_USER } from '@/lib/playtest-tags'

export const dynamic = 'force-dynamic'

// POST /api/playtest-tags/remove — take a confirmed Trends tag back out of
// Signal Sense and record who did it.
//
// This is the only place this app deletes another application's data, so it is
// deliberately narrow: it will only delete a custom_field_values row that
// playtest_sync created. A row created by a Signal Sense user — one we merely
// enriched with a sub-value — is theirs, and the request is refused with the
// creator named so the admin can remove it there instead. Deleting it here would
// destroy a tag this app never made.
export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  let body: { id?: number }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const id = body.id
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const session = process.env.SKIP_AUTH === 'true' ? null : await getServerSession(authOptions)
  const admin = session?.user?.email || 'skip-auth@local'

  let outcome: 'deleted' | 'already_gone' = 'already_gone'
  let refusal: { status: number; error: string } | null = null

  await sql.begin(async txRaw => {
    const tx = txRaw as unknown as typeof sql

    const rows = await tx`
      SELECT id, game_id, field_value FROM playtest_tags
      WHERE id = ${id} AND status = 'synced'
      LIMIT 1
    `
    if (rows.length === 0) {
      refusal = { status: 404, error: 'No synced tag with that id — only a confirmed tag can be removed.' }
      return
    }
    const tag = rows[0] as { id: number; game_id: string; field_value: string }

    const theirs = await tx`
      SELECT cfv.created_by, cfv.sub_value_id, u.first_name, u.last_name, u.email
      FROM custom_field_values cfv
      LEFT JOIN users u ON u.id = cfv.created_by
      WHERE cfv.game_id = ${tag.game_id}
        AND cfv.field_name = ${TRENDS_FIELD}
        AND cfv.field_value = ${tag.field_value}
      LIMIT 1
    `

    if (theirs.length > 0) {
      const row = theirs[0] as {
        created_by: string | null; sub_value_id: number | null
        first_name: string | null; last_name: string | null; email: string | null
      }
      if (row.created_by !== SYNC_USER) {
        const who = [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email || 'someone in Signal Sense'
        refusal = {
          status: 409,
          error: `That tag was created in Signal Sense by ${who}, not by playtest sync. Remove it there — this app only removes what it added.`,
        }
        return
      }
      // Log before deleting, in the same transaction, so Signal Sense's own tag
      // history shows a Remove rather than a tag that silently vanished.
      // changed_by is a users(id) FK: the removing admin usually has no row
      // there, so it records the playtest app as the actor. Which admin it was
      // is already in playtest_tags.removed_by below.
      await tx`
        INSERT INTO custom_field_value_changes
          (game_id, field_name, field_value, action, old_sub_value_id, changed_by)
        VALUES (${tag.game_id}, ${TRENDS_FIELD}, ${tag.field_value}, 'remove', ${row.sub_value_id}, ${SYNC_USER})
      `
      await tx`
        DELETE FROM custom_field_values
        WHERE game_id = ${tag.game_id}
          AND field_name = ${TRENDS_FIELD}
          AND field_value = ${tag.field_value}
          AND created_by = ${SYNC_USER}
      `
      outcome = 'deleted'
    }

    // Stamped either way: if the row was already gone, the tag still stopped
    // existing and history should say so rather than staying silent.
    await tx`
      UPDATE playtest_tags
      SET status = 'removed', removed_at = now(), removed_by = ${admin}
      WHERE id = ${tag.id}
    `
  })

  if (refusal) return NextResponse.json({ error: refusal.error }, { status: refusal.status })
  return NextResponse.json({ ok: true, outcome })
}
