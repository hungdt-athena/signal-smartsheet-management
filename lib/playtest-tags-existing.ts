// Editing a Trends tag that is ALREADY in Signal Sense, from this app.
//
// Until now this app only ever added to custom_field_values, and would refuse to
// touch a row a Signal Sense user created ("this app only removes what it
// added"). That rule is gone: an admin or moderator here owns every Trends tag
// on a game, whoever first put it there. What replaces the rule is bookkeeping —
// every change writes Signal Sense's own change log, and every change leaves a
// row in playtest_tags so the Tagging > History view shows it too.
//
// A tag Signal Sense made has no playtest_tags row to stamp, so one is opened
// for it: proposed by whoever tagged it over there, at the time they did, and
// edited (or removed) by the admin here. Three names on one line, the same shape
// migration 039 established for proposals.
import type { sql as Sql } from '@/lib/db'
import { backfillMissingAdd, logCfvChanges } from '@/lib/cfv-change-log'
import { TRENDS_FIELD } from '@/lib/playtest-tags'

export type ExistingTagAction = 'set_sub_value' | 'remove'

export interface ExistingTagRequest {
  gameId: string
  fieldValue: string
  action: ExistingTagAction
  /** The sub-value to move to. `null` clears it. Ignored by `remove`. */
  subValueId?: number | null
  /** Email of the admin or moderator making the change. */
  admin: string
}

export type ExistingTagOutcome = 'updated' | 'unchanged' | 'deleted' | 'already_gone'

export interface ExistingTagRefusal { status: number; error: string }

/** The Signal Sense row being edited, plus who made it. */
interface TheirRow {
  created_by: string | null
  sub_value_id: number | null
  first_name: string | null
  last_name: string | null
  email: string | null
  created_at_utc: Date | null
}

/** Whom to credit as the proposer of a tag this app never proposed. The email is
 *  what `playtest_tags.tagged_by` holds everywhere else; `signal_sense` is the
 *  same sentinel the reconcile sweep uses when the actor cannot be named. */
function proposer(row: TheirRow): string {
  return row.email || 'signal_sense'
}

/**
 * Apply one change to a Trends tag that already lives in custom_field_values.
 *
 * Runs inside the caller's transaction. Returns a refusal to be turned into an
 * HTTP status, or the outcome. Order is fixed and matters: rescue the tag's
 * `add` line while the row still carries its provenance, log what is about to
 * happen while the old sub-value is still readable, then write.
 */
export async function applyExistingTagChange(
  tx: typeof Sql,
  { gameId, fieldValue, action, subValueId, admin }: ExistingTagRequest,
): Promise<ExistingTagRefusal | { outcome: ExistingTagOutcome }> {
  const found = await tx`
    SELECT cfv.created_by, cfv.sub_value_id,
           u.first_name, u.last_name, u.email,
           cfv.created_at AT TIME ZONE 'UTC' AS created_at_utc
    FROM custom_field_values cfv
    LEFT JOIN users u ON u.id = cfv.created_by
    WHERE cfv.game_id = ${gameId}
      AND cfv.field_name = ${TRENDS_FIELD}
      AND cfv.field_value = ${fieldValue}
    LIMIT 1
  `
  const theirs = (found[0] as unknown as TheirRow) ?? null

  if (!theirs) {
    // Gone from Signal Sense before this request landed. A removal still gets
    // recorded -- the tag did stop existing, and staying silent is what
    // migration 036 was written to stop -- but nothing goes in Signal Sense's
    // change log, because this app removed nothing.
    if (action === 'remove') {
      await recordRemoval(tx, { gameId, fieldValue, admin, theirs: null })
      return { outcome: 'already_gone' }
    }
    return {
      status: 404,
      error: `${fieldValue} is no longer in Signal Sense — someone removed it there. Reload to see the current tags.`,
    }
  }
  const oldSub = theirs.sub_value_id ?? null

  if (action === 'set_sub_value') {
    const newSub = subValueId ?? null
    // No write, no log line: history must not record a change that never
    // happened. Two admins landing on the same sub-value is a no-op, not an edit.
    if (newSub === oldSub) return { outcome: 'unchanged' }

    await backfillMissingAdd(tx, gameId, fieldValue)
    await logCfvChanges(tx, [{
      gameId, fieldValue, action: 'sub_value_change',
      oldSubValueId: oldSub, newSubValueId: newSub,
    }])
    await tx`
      UPDATE custom_field_values
      SET sub_value_id = ${newSub}
      WHERE game_id = ${gameId}
        AND field_name = ${TRENDS_FIELD}
        AND field_value = ${fieldValue}
    `
    await recordEdit(tx, { gameId, fieldValue, admin, theirs, newSub })
    return { outcome: 'updated' }
  }

  await backfillMissingAdd(tx, gameId, fieldValue)
  await logCfvChanges(tx, [{ gameId, fieldValue, action: 'remove', oldSubValueId: oldSub }])
  await tx`
    DELETE FROM custom_field_values
    WHERE game_id = ${gameId}
      AND field_name = ${TRENDS_FIELD}
      AND field_value = ${fieldValue}
  `
  await recordRemoval(tx, { gameId, fieldValue, admin, theirs })
  return { outcome: 'deleted' }
}

/** The live playtest_tags row for a (game, value) pair, if this app has one.
 *  Written as a scalar sub-select because the pair can repeat across history —
 *  removed and re-tagged — and only the current one may be stamped. */
async function recordEdit(
  tx: typeof Sql,
  a: { gameId: string; fieldValue: string; admin: string; theirs: TheirRow; newSub: number | null },
): Promise<void> {
  const stamped = await tx`
    UPDATE playtest_tags
    SET sub_value_id = ${a.newSub}, edited_by = ${a.admin}, edited_at = now()
    WHERE id = (
      SELECT id FROM playtest_tags
      WHERE game_id = ${a.gameId} AND field_value = ${a.fieldValue}
        AND status = 'synced' AND removed_at IS NULL
      ORDER BY confirmed_at DESC NULLS LAST, id DESC
      LIMIT 1
    )
    RETURNING id
  `
  if (stamped.length > 0) return
  await tx`
    INSERT INTO playtest_tags
      (game_id, field_value, sub_value_id, status, tagged_by, tagged_at, edited_by, edited_at)
    VALUES (
      ${a.gameId}, ${a.fieldValue}, ${a.newSub}, 'synced',
      ${proposer(a.theirs)}, COALESCE(${a.theirs.created_at_utc}::timestamptz, now()),
      ${a.admin}, now()
    )
  `
}

/** `theirs` is null when the row was already gone: there is provenance to copy
 *  only when the row is still there, so a tag this app never proposed AND no
 *  longer exists gets no invented history row. */
async function recordRemoval(
  tx: typeof Sql,
  a: { gameId: string; fieldValue: string; admin: string; theirs: TheirRow | null },
): Promise<void> {
  const stamped = await tx`
    UPDATE playtest_tags
    SET status = 'removed', removed_at = now(), removed_by = ${a.admin}
    WHERE id = (
      SELECT id FROM playtest_tags
      WHERE game_id = ${a.gameId} AND field_value = ${a.fieldValue}
        AND status = 'synced' AND removed_at IS NULL
      ORDER BY confirmed_at DESC NULLS LAST, id DESC
      LIMIT 1
    )
    RETURNING id
  `
  if (stamped.length > 0 || !a.theirs) return
  await tx`
    INSERT INTO playtest_tags
      (game_id, field_value, sub_value_id, status, tagged_by, tagged_at, removed_by, removed_at)
    VALUES (
      ${a.gameId}, ${a.fieldValue}, ${a.theirs.sub_value_id ?? null}, 'removed',
      ${proposer(a.theirs)}, COALESCE(${a.theirs.created_at_utc}::timestamptz, now()),
      ${a.admin}, now()
    )
  `
}
