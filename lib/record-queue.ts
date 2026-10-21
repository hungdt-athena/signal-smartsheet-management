import { recordViewRows, recordBucketOf, toYtGame } from '@/lib/record-view-games'
import { getCurrentBatch } from '@/lib/current-batch'
import { loadBatchSpans } from '@/lib/report-batches'
import { resolveYtMatches, normalizeName, type Bucket, type YtbMatchRow } from '@/lib/ytb-match'

export interface RecordQueueGame {
  id: number
  title: string
  bucket: Bucket
  batch: string
  category_group: string | null
}

/** The batch the team is in and the one before it: the only two a recorder is chased about.
 *  Older games that never got a video stay on the Record tab but out of the badge. The
 *  previous batch is the one that started just before the current one in `batches`; a
 *  current batch that has no row there (or no table yet) has no previous one. */
export async function recordQueueBatches(): Promise<string[]> {
  const [current, spans] = await Promise.all([getCurrentBatch(), loadBatchSpans()])
  if (!current) return []
  const at = spans.findIndex(s => s.batch === current)
  const prev = at >= 0 ? spans[at + 1]?.batch : undefined
  return prev ? [current, prev] : [current]
}

// Games a recorder still has to record: the manager confirmed the assignment and no
// YouTube upload has been matched yet. This is the Record tab's "Recording" status,
// narrowed to the two batches above. The upload match runs over the whole Record view for
// the same reason the tab does (see record-view-games): matched over a subset, other
// games' uploads look unclaimed.
export async function recordingQueue(recorder: string, ytRows: YtbMatchRow[]): Promise<RecordQueueGame[]> {
  const who = normalizeName(recorder)
  if (!who) return []
  const [rows, batches] = await Promise.all([recordViewRows(), recordQueueBatches()])
  if (batches.length === 0) return []
  const resolved = resolveYtMatches(rows.map(toYtGame), ytRows)
  const out: RecordQueueGame[] = []
  for (const r of rows) {
    if (!r.confirmed || !r.batch || !batches.includes(r.batch) || resolved.has(r.id)) continue
    const bucket = recordBucketOf(r)
    const assignee = bucket === '5min' ? r.record_5min_assignee : r.record_20min_assignee
    if (!assignee || normalizeName(assignee) !== who) continue
    out.push({ id: r.id, title: r.title, bucket, batch: r.batch, category_group: r.category_group })
  }
  return out
}
