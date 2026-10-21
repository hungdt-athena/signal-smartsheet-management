import { sql } from '@/lib/db'
import type { Bucket, YtGame } from '@/lib/ytb-match'

// Every game in the Record view, unscoped. resolveYtMatches decides which
// uploads are still unclaimed from the games it is given, so it must always get
// all of them; a caller showing one batch or one recorder filters afterwards.

export interface RecordViewRow {
  id: number
  game_id: string
  batch: string | null
  category_group: string | null
  title: string
  record_bucket: string | null
  final_conclusion: string | null
  record_5min_assignee: string | null
  record_20min_assignee: string | null
  youtube_link: string | null
  uploaded_local: string | null   // youtube_uploaded_at, VN local 'YYYY-MM-DD HH:MM:SS'
  since: string | null            // first assignment day, 'YYYY-MM-DD'
}

const VN = 'Asia/Ho_Chi_Minh'

export async function recordViewRows(): Promise<RecordViewRow[]> {
  return sql<RecordViewRow[]>`
    SELECT ge.id, ge.game_id, ge.batch, ge.category_group, gi.title, ge.record_bucket, ge.final_conclusion,
      ge.record_5min_assignee, ge.record_20min_assignee, ge.youtube_link,
      to_char(ge.youtube_uploaded_at AT TIME ZONE ${VN}, 'YYYY-MM-DD HH24:MI:SS') AS uploaded_local,
      to_char(COALESCE(ge.first_assigned_date, ge.assigned_date), 'YYYY-MM-DD') AS since
    FROM game_evaluations ge
    JOIN game_info gi ON ge.game_id = gi.game_id
    WHERE ge.record_bucket IN ('5min','20min')
       OR (ge.record_bucket IS NULL AND ge.final_conclusion IN ('Insight','Priority IV'))
  `
}

// The bucket the game sits in, same rule as the Record tab.
export function recordBucketOf(row: Pick<RecordViewRow, 'record_bucket' | 'final_conclusion'>): Bucket {
  return row.record_bucket === '5min' || row.record_bucket === '20min'
    ? row.record_bucket
    : (row.final_conclusion === 'Priority IV' ? '20min' : '5min')
}

export function toYtGame(row: RecordViewRow): YtGame {
  const bucket = recordBucketOf(row)
  return {
    key: row.id,
    title: row.title,
    bucket,
    recorder: bucket === '5min' ? row.record_5min_assignee : row.record_20min_assignee,
    since: row.since,
  }
}
