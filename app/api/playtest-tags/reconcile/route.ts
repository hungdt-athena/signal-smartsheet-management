import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { TRENDS_FIELD } from '@/lib/playtest-tags'

export const dynamic = 'force-dynamic'

// POST /api/playtest-tags/reconcile — stamp synced tags that no longer exist in
// Signal Sense.
//
// Signal Sense can delete a custom_field_values row at any time, and it keeps no
// separate log: its tag history reads the rows themselves, so a deletion erases
// the past there. Without this sweep our history keeps asserting 'inserted' for
// a tag that is gone, and a later re-tag of the same trend shows up as a second
// 'inserted' with nothing in between to explain it.
//
// Read-only for Signal Sense: this only writes to playtest_tags. It never
// recreates a row someone deleted. Stamping is once-only (removed_at IS NULL
// guard), so the first observation wins and a re-tag later is a new row.
export async function POST(_req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const removed = await sql`
    UPDATE playtest_tags pt
    SET status = 'removed', removed_at = now(), removed_by = 'signal_sense'
    WHERE pt.status = 'synced'
      AND pt.removed_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM custom_field_values cfv
        WHERE cfv.game_id = pt.game_id
          AND cfv.field_name = ${TRENDS_FIELD}
          AND cfv.field_value = pt.field_value
      )
    RETURNING pt.id, pt.game_id, pt.field_value
  `

  return NextResponse.json({ ok: true, removed: removed.length, rows: removed })
}
