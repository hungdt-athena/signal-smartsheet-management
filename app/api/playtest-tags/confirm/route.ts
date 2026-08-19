import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireManager } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import { logCfvChanges, type CfvChange } from '@/lib/cfv-change-log'
import {
  classifyTag, readNotes, resolveConfirm, TRENDS_FIELD, SYNC_USER,
  type ExistingTag, type PendingTag, type SyncResult,
} from '@/lib/playtest-tags'

export const dynamic = 'force-dynamic'

// POST /api/playtest-tags/confirm — sync pending Trends tags of one game into
// Signal Sense. Runs in a transaction so a failure leaves every tag it touched
// pending rather than half-applied. `overwrite` carries the conflict ids whose
// playtest sub-value should replace Signal Sense's.
//
// `ids` narrows the run to the tags the admin ticked. Omitting it confirms every
// pending tag of the game, which is what the earlier per-game button did.
//
// `notes` is an optional `{ id: text }` map of the admin's per-tag reasoning.
// It is stored, never acted on: History shows it to the evaluator beside the
// diff between what they proposed and what was confirmed.
export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  let body: { game_id?: string; overwrite?: number[]; ids?: number[]; notes?: Record<string, string> }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const gameId = (body.game_id || '').trim()
  if (!gameId) return NextResponse.json({ error: 'game_id required' }, { status: 400 })
  const overwrite = new Set((body.overwrite || []).filter(n => Number.isInteger(n)))
  // An `ids` array that survives the filter empty asked for nothing, which is
  // not the same as asking for everything — refuse rather than confirm the lot.
  const only = body.ids === undefined ? null : body.ids.filter(n => Number.isInteger(n))
  if (only !== null && only.length === 0) {
    return NextResponse.json({ error: 'ids was empty' }, { status: 400 })
  }

  const notes = readNotes(body.notes)

  const session = process.env.SKIP_AUTH === 'true' ? null : await getServerSession(authOptions)
  const admin = session?.user?.email || 'skip-auth@local'

  const results: { id: number; result: SyncResult }[] = []
  // Tags that never reached Signal Sense and why, so the admin sees more than a
  // count of results they did not ask for.
  const skipped: { id: number; field_value: string; reason: string }[] = []
  // Entries for Signal Sense's change log, appended only for writes that landed.
  const log: CfvChange[] = []

  await sql.begin(async txRaw => {
    // postgres.js types a transaction handle as TransactionSql, which is not
    // callable as a tagged template. Every other transaction in this repo casts
    // it the same way.
    const tx = txRaw as unknown as typeof sql

    const pending = await tx`
      SELECT id, field_value, sub_value_id
      FROM playtest_tags
      WHERE game_id = ${gameId} AND status = 'pending'
        ${only === null ? tx`` : tx`AND id = ANY(${only})`}
      ORDER BY id
    ` as unknown as PendingTag[]
    if (pending.length === 0) return

    const theirs = await tx`
      SELECT field_value, sub_value_id
      FROM custom_field_values
      WHERE game_id = ${gameId} AND field_name = ${TRENDS_FIELD}
    ` as unknown as ExistingTag[]
    const byValue = new Map(theirs.map(t => [t.field_value, t]))

    // Re-check the definitions here, not just at proposal time: days can pass
    // between the two, and a Signal Sense admin may have retired the value in
    // between. Confirming must not resurrect a retired definition.
    const wanted = Array.from(new Set(pending.map(p => p.field_value)))
    const defs = await tx`
      SELECT DISTINCT field_value FROM custom_field_definitions
      WHERE field_name = ${TRENDS_FIELD} AND is_active AND field_value = ANY(${wanted})
    `
    const active = new Set(defs.map(r => r.field_value as string))

    // Their current sub-value for one value, read back after a guarded write
    // affected no row, so the recorded outcome describes what is actually there.
    const readTheirSubValue = async (fieldValue: string): Promise<{ found: boolean; subValueId: number | null }> => {
      const rows = await tx`
        SELECT sub_value_id FROM custom_field_values
        WHERE game_id = ${gameId} AND field_name = ${TRENDS_FIELD} AND field_value = ${fieldValue}
      `
      if (rows.length === 0) return { found: false, subValueId: null }
      return { found: true, subValueId: (rows[0].sub_value_id as number | null) ?? null }
    }

    for (const p of pending) {
      if (!active.has(p.field_value)) {
        await tx`
          UPDATE playtest_tags
          SET status = 'rejected', sync_result = 'inactive',
              confirmed_by = ${admin}, confirmed_at = now(),
              review_note = COALESCE(${notes.get(p.id) ?? null}, review_note)
          WHERE id = ${p.id}
        `
        results.push({ id: p.id, result: 'inactive' })
        skipped.push({
          id: p.id, field_value: p.field_value,
          reason: 'no longer an active Trends value in Signal Sense',
        })
        continue
      }

      const action = classifyTag(p, byValue.get(p.field_value))
      const outcome = resolveConfirm(action, overwrite.has(p.id))
      let status = outcome.status
      let result = outcome.result

      if (outcome.write === 'insert') {
        // RETURNING tells us whether the row is ours; without it a concurrent
        // Signal Sense insert would be reported as an insert we never made.
        const ins = await tx`
          INSERT INTO custom_field_values
            (game_id, field_name, field_value, sub_value_id, created_by, updated_by)
          VALUES (${gameId}, ${TRENDS_FIELD}, ${p.field_value}, ${p.sub_value_id}, ${SYNC_USER}, ${SYNC_USER})
          ON CONFLICT (game_id, field_name, field_value) DO NOTHING
          RETURNING id
        `
        if (ins.length === 0) {
          // They inserted the same value first: the proposal's outcome is met
          // even though we wrote nothing.
          status = 'synced'
          result = 'duplicate'
          skipped.push({
            id: p.id, field_value: p.field_value,
            reason: 'Signal Sense already had this value',
          })
        } else {
          log.push({
            gameId, fieldValue: p.field_value,
            action: 'add', newSubValueId: p.sub_value_id,
          })
        }
      } else if (outcome.write === 'update') {
        // Guarded so we never clobber a sub-value Signal Sense set after we read
        // it: enrich only fills a still-NULL sub-value, overwrite only replaces
        // the exact value the admin decided against (only a confirmed conflict
        // reaches that branch, and it carries that sub-value).
        const theirSubValueId = action.kind === 'conflict' ? action.theirSubValueId : null
        const upd = action.kind === 'enrich'
          ? await tx`
              UPDATE custom_field_values
              SET sub_value_id = ${p.sub_value_id}, updated_by = ${SYNC_USER}, updated_at = now()
              WHERE game_id = ${gameId} AND field_name = ${TRENDS_FIELD}
                AND field_value = ${p.field_value} AND sub_value_id IS NULL
              RETURNING id
            `
          : await tx`
              UPDATE custom_field_values
              SET sub_value_id = ${p.sub_value_id}, updated_by = ${SYNC_USER}, updated_at = now()
              WHERE game_id = ${gameId} AND field_name = ${TRENDS_FIELD}
                AND field_value = ${p.field_value}
                AND sub_value_id = ${theirSubValueId}
              RETURNING id
            `
        if (upd.length === 0) {
          // The row moved underneath us. Report what is there now instead of
          // claiming a write: matching sub-value is a `duplicate`, anything else
          // means Signal Sense's value stands, which is `kept`.
          const now = await readTheirSubValue(p.field_value)
          const ours = p.sub_value_id ?? null
          if (now.found && now.subValueId === ours) {
            status = 'synced'
            result = 'duplicate'
          } else {
            status = 'rejected'
            result = 'kept'
          }
          skipped.push({
            id: p.id, field_value: p.field_value,
            reason: now.found
              ? 'Signal Sense changed this tag while it was under review'
              : 'the Signal Sense row for this value disappeared while it was under review',
          })
        } else {
          // The row stayed and its sub-value moved — Signal Sense's own term for
          // this. enrich came from NULL; overwrite replaced their value.
          log.push({
            gameId, fieldValue: p.field_value,
            action: 'sub_value_change',
            oldSubValueId: theirSubValueId,
            newSubValueId: p.sub_value_id,
          })
        }
      }

      // COALESCE, not a plain assignment: an admin who confirms without typing
      // anything leaves whatever note is already on the row rather than wiping it.
      await tx`
        UPDATE playtest_tags
        SET status = ${status}, sync_result = ${result},
            confirmed_by = ${admin}, confirmed_at = now(),
            review_note = COALESCE(${notes.get(p.id) ?? null}, review_note)
        WHERE id = ${p.id}
      `
      results.push({ id: p.id, result })
    }

    // Signal Sense derives tag history from the value rows, so a write we make
    // without logging is invisible over there. Logged last, inside the same
    // transaction: every entry describes a write that has already succeeded.
    await logCfvChanges(tx, log)
  })

  return NextResponse.json({ ok: true, results, skipped })
}
