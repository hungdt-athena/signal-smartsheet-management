import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { TRENDS_FIELD } from '@/lib/playtest-tags'
import { fetchQueue } from '@/lib/playtest-tags-queue'

export const dynamic = 'force-dynamic'

// PATCH /api/playtest-tags/[id] — correct one pending proposal from the admin
// review queue, so a right trend with a wrong sub-value can be fixed instead of
// rejected and re-proposed. Admin only.
//
// Only pending rows are editable: a synced or rejected row is history. The row's
// tagged_by / tagged_at are never touched — an admin correcting a tag does not
// become its author. The first correction also snapshots what the evaluator
// proposed into original_*, which is what History shows them the tag against.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireManager()
  if (guard) return guard

  const id = Number(params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  let body: { field_value?: string; sub_value_id?: number | null }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const hasValue = typeof body.field_value === 'string'
  const hasSub = Object.prototype.hasOwnProperty.call(body, 'sub_value_id')
  if (!hasValue && !hasSub) {
    return NextResponse.json({ error: 'field_value or sub_value_id required' }, { status: 400 })
  }

  const fieldValue = (body.field_value || '').trim()
  if (hasValue && !fieldValue) {
    return NextResponse.json({ error: 'field_value cannot be empty' }, { status: 400 })
  }

  let subValueId: number | null = null
  if (hasSub) {
    const raw = body.sub_value_id
    if (raw !== null && raw !== undefined && !Number.isInteger(raw)) {
      return NextResponse.json({ error: 'sub_value_id must be an integer or null' }, { status: 400 })
    }
    subValueId = raw ?? null
  }

  const rows = await sql`
    SELECT id, game_id, field_value, sub_value_id, original_captured_at
    FROM playtest_tags
    WHERE id = ${id} AND status = 'pending'
  `
  if (rows.length === 0) {
    return NextResponse.json({ error: 'Pending tag not found' }, { status: 404 })
  }
  const row = rows[0] as {
    game_id: string; field_value: string; sub_value_id: number | null
    original_captured_at: string | null
  }

  if (hasValue && fieldValue !== row.field_value) {
    // Values are Signal Sense's to own; this app never creates them.
    const ok = await sql`
      SELECT 1 FROM custom_field_definitions
      WHERE field_name = ${TRENDS_FIELD} AND is_active AND field_value = ${fieldValue}
      LIMIT 1
    `
    if (ok.length === 0) {
      return NextResponse.json({ error: `Unknown Trends value: ${fieldValue}` }, { status: 400 })
    }
    // The pending set is keyed on (game, value) by a partial unique index, so
    // renaming onto a value already proposed for this game would violate it.
    // Detect it here rather than letting a raw Postgres error become a 500.
    const clash = await sql`
      SELECT id FROM playtest_tags
      WHERE game_id = ${row.game_id} AND status = 'pending'
        AND field_value = ${fieldValue} AND id <> ${id}
      LIMIT 1
    `
    if (clash.length > 0) {
      return NextResponse.json(
        { error: `"${fieldValue}" is already proposed for this game (tag #${clash[0].id}) — edit or reject that one instead` },
        { status: 409 },
      )
    }
  }

  if (hasSub && subValueId !== null) {
    const ok = await sql`
      SELECT 1 FROM sub_value_definitions WHERE id = ${subValueId} AND is_active LIMIT 1
    `
    if (ok.length === 0) {
      return NextResponse.json({ error: `Unknown sub-value: ${subValueId}` }, { status: 400 })
    }
  }

  const nextValue = hasValue ? fieldValue : row.field_value
  const nextSub = hasSub ? subValueId : row.sub_value_id

  // Snapshot what the evaluator proposed, once, the first time an admin actually
  // moves the row. The SET expressions read the pre-UPDATE values, so this
  // captures the version being replaced rather than the replacement.
  //
  // Two guards, both load-bearing. `original_captured_at IS NULL` keeps a third
  // correction comparing against the evaluator, not against the second
  // correction. And an edit that lands on the value already there is not an
  // edit: stamping it would tell the evaluator they were corrected when nothing
  // about their tag changed.
  const moves = nextValue !== row.field_value || nextSub !== row.sub_value_id
  const snapshot = moves && !row.original_captured_at
    ? sql`,
        original_field_value = field_value,
        original_sub_value_id = sub_value_id,
        original_captured_at = now()`
    : sql``

  let updated
  try {
    updated = await sql`
      UPDATE playtest_tags
      SET field_value = ${nextValue}, sub_value_id = ${nextSub}${snapshot}
      WHERE id = ${id} AND status = 'pending'
      RETURNING id, game_id, field_value, sub_value_id
    `
  } catch (e) {
    // Lost the race with a concurrent proposal of the same value.
    if ((e as { code?: string })?.code === '23505') {
      return NextResponse.json(
        { error: `"${nextValue}" is already proposed for this game — edit or reject that one instead` },
        { status: 409 },
      )
    }
    throw e
  }
  if (updated.length === 0) {
    return NextResponse.json({ error: 'That tag was already confirmed or rejected' }, { status: 409 })
  }

  // Answer with the row as the queue would read it now — conflict flag and
  // Signal Sense comparison recomputed server-side — so the table can redraw
  // this one row instead of refetching the whole queue. The raw row is the
  // fallback if the read-back finds nothing, which would mean the row was
  // resolved in the moment between the two statements.
  const [fresh] = await fetchQueue({ ids: [id] })
  return NextResponse.json({ ok: true, tag: fresh ?? updated[0] })
}
