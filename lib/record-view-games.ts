import { sql } from '@/lib/db'
import { listRowFilter, storesSelect, type PairStore } from '@/lib/eval-pairs'
import { recordBucketOf, extractYtId, type YtGame } from '@/lib/ytb-match'

export { recordBucketOf }

// Every game in the Record view, unscoped. resolveYtMatches decides which
// uploads are still unclaimed from the games it is given, so it must always get
// all of them; a caller showing one batch or one recorder filters afterwards.

export interface RecordViewRow {
  id: number
  game_id: string
  batch: string | null
  category_group: string | null
  title: string
  twin_title: string | null       // the other store's title on a linked pair
  record_code: string | null      // the pair's code: own, else the twin's
  stores: PairStore[]             // the row's store plus its twin's, iOS first
  record_bucket: string | null
  final_conclusion: string | null
  record_5min_assignee: string | null
  record_20min_assignee: string | null
  youtube_link: string | null     // the demo link (20min preferred), read by Signal Sense
  youtube_5min_link: string | null
  youtube_20min_link: string | null
  uploaded_local: string | null   // youtube_uploaded_at (= the own bucket's), VN local 'YYYY-MM-DD HH:MM:SS'
  since: string | null            // first assignment day, 'YYYY-MM-DD'
  confirmed: boolean              // a manager confirmed the assignment (Recording, not Draft)
}

const VN = 'Asia/Ho_Chi_Minh'

export async function recordViewRows(): Promise<RecordViewRow[]> {
  return sql<RecordViewRow[]>`
    SELECT ge.id, ge.game_id, ge.batch, ge.category_group, gi.title, twin_gi.title AS twin_title,
      COALESCE(gi.record_code, twin_gi.record_code) AS record_code,
      ${storesSelect(sql)} AS stores,
      ge.record_bucket, ge.final_conclusion,
      ge.record_5min_assignee, ge.record_20min_assignee, ge.youtube_link, ge.youtube_5min_link, ge.youtube_20min_link,
      to_char(ge.youtube_uploaded_at AT TIME ZONE ${VN}, 'YYYY-MM-DD HH24:MI:SS') AS uploaded_local,
      to_char(COALESCE(ge.first_assigned_date, ge.assigned_date), 'YYYY-MM-DD') AS since,
      ge.record_confirmed_at IS NOT NULL AS confirmed
    FROM game_evaluations ge
    JOIN game_info gi ON ge.game_id = gi.game_id
    LEFT JOIN game_evaluations twin ON twin.id = ge.pair_eval_id
    LEFT JOIN game_info twin_gi ON twin_gi.game_id = twin.game_id
    WHERE (ge.record_bucket IN ('5min','20min')
       OR (ge.record_bucket IS NULL AND ge.final_conclusion IN ('Insight','Priority IV')))
      ${listRowFilter(sql)}
  `
}

export function toYtGame(row: RecordViewRow): YtGame {
  const bucket = recordBucketOf(row)
  return {
    key: row.id,
    gameId: row.game_id,
    title: row.title,
    bucket,
    recorder: bucket === '5min' ? row.record_5min_assignee : row.record_20min_assignee,
    since: row.since,
    heldVideo: extractYtId(bucket === '5min' ? row.youtube_20min_link : row.youtube_5min_link),
    ...(row.twin_title != null ? { alt: { title: row.twin_title, gameId: (row.stores || []).find(s => s.game_id !== row.game_id)?.game_id } } : {}),
  }
}
