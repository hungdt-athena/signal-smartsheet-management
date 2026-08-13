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
/**
 * Give a tag its missing `add` line, from the value row's own provenance.
 *
 * Tags created before Signal Sense's log existed — or through a path of theirs
 * that does not log, such as the Custom Field Tags dialog's replace-all save —
 * have no `add` entry. Once the row is deleted that provenance is unrecoverable,
 * so this runs while the row is still there, immediately before a removal: the
 * result is a complete chain (added → changed → removed) instead of a tag whose
 * history starts at its removal.
 *
 * Attribution and time come from the row (`created_by`, `created_at`), not from
 * this app — the point is to record who really added it. `NOT EXISTS` keeps it to
 * one `add` per tag, so a tag already logged is left alone.
 *
 * `created_at` is a naive `timestamp` while `changed_at` is `timestamptz`. The
 * conversion is written as `AT TIME ZONE 'UTC'` rather than a plain cast, because
 * a plain cast reads the naive value in the session's TimeZone: verified on prod,
 * the same row yields `03:54:44+00` under GMT and `03:54:44+07` under
 * Asia/Ho_Chi_Minh — a seven-hour error in the recorded instant. `COALESCE` on
 * `now()` covers a NULL `created_at`, which would otherwise violate NOT NULL.
 *
 * Returns how many rows were written (0 or 1).
 */
export async function backfillMissingAdd(
  tx: typeof Sql,
  gameId: string,
  fieldValue: string,
): Promise<number> {
  try {
    const rows = await (tx as unknown as { savepoint: (cb: (sp: typeof Sql) => Promise<unknown>) => Promise<unknown> })
      .savepoint(async sp => sp`
        INSERT INTO custom_field_value_changes
          (game_id, field_name, field_value, action, new_sub_value_id, changed_by, changed_at)
        SELECT cfv.game_id, cfv.field_name, cfv.field_value, 'add', cfv.sub_value_id, cfv.created_by,
               COALESCE(cfv.created_at AT TIME ZONE 'UTC', now())
        FROM custom_field_values cfv
        WHERE cfv.game_id = ${gameId}
          AND cfv.field_name = ${TRENDS_FIELD}
          AND cfv.field_value = ${fieldValue}
          AND NOT EXISTS (
            SELECT 1 FROM custom_field_value_changes a
            WHERE a.game_id = cfv.game_id
              AND a.field_name = cfv.field_name
              AND a.field_value = cfv.field_value
              AND a.action = 'add'
          )
        RETURNING id
      `)
    return (rows as unknown[]).length
  } catch (err) {
    console.error(
      `[playtest-tags] failed to backfill add for ${gameId} / ${fieldValue}:`,
      (err as Error).message,
    )
    return 0
  }
}

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
