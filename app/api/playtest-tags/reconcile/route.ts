import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { TRENDS_FIELD } from '@/lib/playtest-tags'

export const dynamic = 'force-dynamic'

// POST /api/playtest-tags/reconcile — stamp synced tags that stopped existing in
// Signal Sense.
//
// Two passes, in this order:
//
//  1. Signal Sense's own change log (`custom_field_value_changes`, append-only)
//     names who removed a tag and when, so it is the better source. Only a
//     removal AFTER our confirm counts — an earlier one belongs to a previous
//     tag of the same trend, not to this proposal.
//  2. An absence sweep, kept as a safety net. The log misses three deletion
//     paths (definition merge, definition deactivation, and the cascade when a
//     game is deleted) and has no backfill before 13 Aug 2026, so a row can be
//     gone with nothing logged. Attribution is unknowable there, hence the
//     'signal_sense' sentinel.
//
// Read-only for Signal Sense: this writes to playtest_tags only. It never
// recreates a row someone deleted, and never touches the change log.
export async function POST(_req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  // Pass 1 — attributed removals from the change log.
  const logged = await sql`
    UPDATE playtest_tags pt
    SET status = 'removed',
        removed_at = ev.changed_at,
        removed_by = COALESCE(ev.email, 'signal_sense')
    FROM (
      SELECT DISTINCT ON (c.game_id, c.field_value)
             c.game_id, c.field_value, c.changed_at, u.email
      FROM custom_field_value_changes c
      LEFT JOIN users u ON u.id = c.changed_by
      WHERE c.field_name = ${TRENDS_FIELD} AND c.action = 'remove'
      ORDER BY c.game_id, c.field_value, c.changed_at DESC
    ) ev
    WHERE pt.status = 'synced'
      AND pt.removed_at IS NULL
      AND pt.game_id = ev.game_id
      AND pt.field_value = ev.field_value
      AND ev.changed_at > pt.confirmed_at
    RETURNING pt.id, pt.game_id, pt.field_value, pt.removed_by, pt.removed_at
  `

  // Pass 2 — the row is gone but nothing logged it.
  const unlogged = await sql`
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

  return NextResponse.json({
    ok: true,
    removed: logged.length + unlogged.length,
    attributed: logged.length,
    unattributed: unlogged.length,
    rows: [...logged, ...unlogged],
  })
}
