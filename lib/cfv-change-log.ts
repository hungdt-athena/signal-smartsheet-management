import type { sql as Sql } from '@/lib/db'
import { TRENDS_FIELD, SYNC_USER } from '@/lib/playtest-tags'

/** What happened to a custom-field tag, in Signal Sense's terms. `add`: the
 *  value row was created. `remove`: it was deleted. `sub_value_change`: the row
 *  stayed, its sub-value changed. (Their migrations 019 + 020.) */
export type CfvChangeAction = 'add' | 'remove' | 'sub_value_change'

export interface CfvChange {
  gameId: string
  fieldValue: string
  action: CfvChangeAction
  oldSubValueId?: number | null
  newSubValueId?: number | null
}

/**
 * Append a row to Signal Sense's `custom_field_value_changes` log for a Trends
 * tag this app changed.
 *
 * Why this exists: everywhere else Signal Sense derives custom-field tag history
 * from the `custom_field_values` rows themselves, so a deleted row takes its
 * history with it and an overwritten sub-value leaves nothing behind. Their log
 * is the only record of those events — and since migration 020 it is meant to
 * hold every tag event in one table, additions included. Writes this app makes
 * without logging are invisible over there.
 *
 * `changed_by` is a `users(id)` FK. Admins in this app generally have no row in
 * that table, so every entry is attributed to the `playtest_sync` system
 * account: "the playtest app did this". Which admin it was lives in
 * `playtest_tags.confirmed_by` / `removed_by` on our side. Passing an email here
 * would violate the FK.
 *
 * Each entry goes in its own SAVEPOINT. Signal Sense's own repository logs after
 * the edit has committed and swallows failures, on the reasoning that a missing
 * log line must never take a successful edit down with it. A savepoint keeps that
 * protection — a bad row (say a sub-value deleted since, tripping its FK) rolls
 * back alone and the caller's transaction survives — while still making the line
 * atomic with the change it describes, so it cannot be lost to a crash between
 * commit and logging.
 *
 * Returns how many rows were written.
 */
export async function logCfvChanges(
  tx: typeof Sql,
  changes: CfvChange[],
): Promise<number> {
  let written = 0
  for (const c of changes) {
    try {
      await (tx as unknown as { savepoint: (cb: (sp: typeof Sql) => Promise<unknown>) => Promise<unknown> })
        .savepoint(async sp => sp`
          INSERT INTO custom_field_value_changes
            (game_id, field_name, field_value, action, old_sub_value_id, new_sub_value_id, changed_by)
          VALUES (
            ${c.gameId}, ${TRENDS_FIELD}, ${c.fieldValue}, ${c.action},
            ${c.oldSubValueId ?? null}, ${c.newSubValueId ?? null}, ${SYNC_USER}
          )
        `)
      written += 1
    } catch (err) {
      console.error(
        `[playtest-tags] failed to log ${c.action} for ${c.gameId} / ${c.fieldValue}:`,
        (err as Error).message,
      )
    }
  }
  return written
}
