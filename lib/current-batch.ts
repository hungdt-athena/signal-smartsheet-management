import { sql } from '@/lib/db'

/** category -> its current batch label. A category with no batch set is absent. */
export type CurrentBatches = Record<string, string>

/** The one place that knows how "current batch" is stored.
 *
 *  Today it is per category: app_config `current_batch:<category>`. When it becomes a
 *  single global value, change THIS function to return that value for every category
 *  and nothing else has to move -- onlyCurrentBatch() and everything built on it only
 *  ever ask "is this row's batch the current one for its category". */
export async function getCurrentBatches(): Promise<CurrentBatches> {
  const rows = await sql`SELECT key, value FROM app_config WHERE key LIKE 'current_batch:%'`
  const out: CurrentBatches = {}
  for (const r of rows as unknown as { key: string; value: string | null }[]) {
    if (r.value) out[r.key.slice('current_batch:'.length)] = r.value
  }
  return out
}

/** Rows whose batch is the current one for their own category. */
export function onlyCurrentBatch<T extends { category_group: string; batch: string | null }>(
  rows: T[],
  current: CurrentBatches,
): T[] {
  return rows.filter(r => r.batch != null && current[r.category_group] === r.batch)
}
