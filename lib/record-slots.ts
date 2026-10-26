import { sql } from '@/lib/db'
import type { Bucket } from '@/lib/ytb-match'

// SQL for one Record bucket (slot) of a game_evaluations row aliased `ge`.
//
// A game can go through Record once per bucket: 5 min in one batch, 20 min in a
// later one. Each bucket keeps its own recorder, Confirm, video, upload time and,
// once the game has left it, the batch it was in (migration 051). The bucket the
// game sits in now is its own bucket, the Record tab's rule: record_bucket if set,
// else Priority IV is 20 min, everything else 5 min.
//
// Built per call: a postgres.js fragment is a pending query, not a reusable value.

export const ownBucketSql = () => sql`(CASE
  WHEN ge.record_bucket IN ('5min','20min') THEN ge.record_bucket
  WHEN ge.final_conclusion = 'Priority IV' THEN '20min' ELSE '5min' END)`

export function recordSlot(slot: Bucket) {
  const col = (name: string) => sql.unsafe(`ge.${name}`)
  const assignee = col(`record_${slot}_assignee`)
  const confirmedAt = col(`record_${slot}_confirmed_at`)
  const uploadedAt = col(`youtube_${slot}_uploaded_at`)
  const link = col(`youtube_${slot}_link`)
  const isOwn = sql`${ownBucketSql()} = ${slot}`
  return {
    assigneeCol: `record_${slot}_assignee` as const,
    assignee,
    confirmedAt,
    // When the recording is done: the Confirm if there is one, else the upload
    // (migration 034). Written exactly like idx_game_evaluations_recorded_<slot>_at
    // so a filter on it can use the index.
    doneAt: sql`COALESCE(${confirmedAt}, ${uploadedAt})`,
    // The bucket the game is in now is always credited. A bucket it has left only
    // when that round has a video: the other bucket's recorder column can hold a
    // stray name (the recorder sync once filled it from a same-title game on the
    // other OS), and those never got a video of their own.
    credited: sql`AND (${isOwn} OR ${uploadedAt} IS NOT NULL)`,
    // The round's batch: frozen when the game left the bucket. A finished round
    // keeps it even when the game is dragged back into the bucket; an open round in
    // the own bucket follows the game's batch (NULL for rounds older than 051:
    // they keep ge.batch).
    batch: sql`(CASE
      WHEN ${uploadedAt} IS NOT NULL AND ${col(`record_${slot}_batch`)} IS NOT NULL THEN ${col(`record_${slot}_batch`)}
      WHEN ${isOwn} THEN ge.batch
      ELSE COALESCE(${col(`record_${slot}_batch`)}, ge.batch) END)`,
    // The round's video, only once it was uploaded. Rows from before 051 can have
    // the upload time without the link; the demo link stands in for the own bucket.
    videoLink: sql`(CASE WHEN ${uploadedAt} IS NOT NULL THEN COALESCE(${link}, CASE WHEN ${isOwn} THEN ge.youtube_link END) END)`,
  }
}
