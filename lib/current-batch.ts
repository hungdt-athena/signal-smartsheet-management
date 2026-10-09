import { sql } from '@/lib/db'
import { weekLabelOrder } from '@/lib/weekly-feedback'

/** app_config key holding the ONE current batch shared by every category group. */
export const CURRENT_BATCH_KEY = 'current_batch'
const LEGACY_PREFIX = 'current_batch:'

interface ConfigRow { key: string; value: string | null }

/** Pure choice of the current batch from the app_config rows that matched.
 *
 *  A global row is authoritative even when its value is empty: clearing the batch must
 *  mean "none", not "whatever a legacy per-category row still says". Legacy rows
 *  (`current_batch:<category>`) only matter until migration 045 folds them into the
 *  global row; until then the newest one by week order stands in, so code deployed
 *  before the migration never reports "no active batch" for the whole system. */
export function pickCurrentBatch(rows: ConfigRow[]): string | null {
  const global = rows.find(r => r.key === CURRENT_BATCH_KEY)
  if (global) return global.value || null
  let best: string | null = null
  for (const r of rows) {
    if (!r.key.startsWith(LEGACY_PREFIX) || !r.value) continue
    if (best === null || weekLabelOrder(r.value) > weekLabelOrder(best)) best = r.value
  }
  return best
}

/** The current batch, or null when none is set. One query: the database is ~225ms
 *  away, so the legacy fallback rides along in the same read instead of a second one. */
export async function getCurrentBatch(): Promise<string | null> {
  const rows = await sql`
    SELECT key, value FROM app_config
    WHERE key = 'current_batch' OR key LIKE 'current_batch:%'
  `
  return pickCurrentBatch(rows as unknown as ConfigRow[])
}
