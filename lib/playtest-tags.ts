// Trends tags proposed during playtest, and the rules for merging them into
// Signal Sense's custom_field_values on confirm.
//
// A tag's identity there is (game_id, field_name, field_value) -- enforced by
// `unique_game_field_value` -- and the sub-value is an attribute of that tag,
// not part of its identity. Signal Sense relies on that exact 3-column index in
// an ON CONFLICT inference clause, so we merge into the existing row instead of
// ever adding a second row for the same value.

export const TRENDS_FIELD = 'Trends'

/** System account credited for tags synced from playtest (migration 035). */
export const SYNC_USER = 'playtest_sync'

export interface PendingTag {
  id: number
  field_value: string
  sub_value_id: number | null
}

/** A Trends row already in Signal Sense for the same game + value. */
export interface ExistingTag {
  field_value: string
  sub_value_id: number | null
}

export type TagAction =
  | { kind: 'insert' }
  | { kind: 'duplicate' }
  | { kind: 'enrich' }
  | { kind: 'conflict'; theirSubValueId: number }

/** `inactive`: the value stopped being an active Trends definition between
 *  proposal and confirm, so nothing was written and the row is rejected. The
 *  definition list is Signal Sense's to own. */
export type SyncResult =
  | 'inserted' | 'duplicate' | 'enriched' | 'overwritten' | 'kept' | 'inactive'

export interface ConfirmOutcome {
  /** What to do to custom_field_values. */
  write: 'insert' | 'update' | null
  /** Where the playtest_tags row lands. */
  status: 'synced' | 'rejected'
  result: SyncResult
}

/** Compare one proposal against the Signal Sense row for the same value. */
export function classifyTag(pending: PendingTag, existing: ExistingTag | undefined): TagAction {
  if (!existing) return { kind: 'insert' }
  const theirs = existing.sub_value_id ?? null
  const ours = pending.sub_value_id ?? null
  if (theirs === ours) return { kind: 'duplicate' }
  // Their sub-value is empty and we have one: fill it in.
  if (theirs === null) return { kind: 'enrich' }
  // We have none and they do: they already know more, nothing to add.
  if (ours === null) return { kind: 'duplicate' }
  return { kind: 'conflict', theirSubValueId: theirs }
}

/** Turn an action into the write + the row's final state. `overwrite` only
 *  matters for a conflict: true means the playtest sub-value wins. A conflict
 *  left alone ends as `rejected`/`kept` because nothing was written. */
export function resolveConfirm(action: TagAction, overwrite: boolean): ConfirmOutcome {
  switch (action.kind) {
    case 'insert':
      return { write: 'insert', status: 'synced', result: 'inserted' }
    case 'enrich':
      return { write: 'update', status: 'synced', result: 'enriched' }
    case 'conflict':
      return overwrite
        ? { write: 'update', status: 'synced', result: 'overwritten' }
        : { write: null, status: 'rejected', result: 'kept' }
    case 'duplicate':
    default:
      return { write: null, status: 'synced', result: 'duplicate' }
  }
}
