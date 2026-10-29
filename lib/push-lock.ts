// lib/push-lock.ts — one writer at a time into game_evaluations from game_info.
//
// "One game, one genre" is enforced by a NOT EXISTS on game_id inside each push. Under
// READ COMMITTED two pushes that overlap do not see each other's uncommitted rows, so a
// game that is Casual + Action passes both and gets a row in puzzle AND arcade, each
// assigned to a different person. UNIQUE (game_id, category_group) cannot catch it: the
// two rows differ in category_group. 788 games ended up like this between 2026-10-11 and
// 2026-10-29 (see the cleanup backups game_evaluations_dup_backup_2026*).
//
// The lock is held by a transaction of its own while `fn` runs on the normal pool. `fn`
// commits its INSERT before the lock is released, and the next push takes its snapshot
// only after it gets the lock, so its NOT EXISTS sees those rows. It waits rather than
// skipping: a skipped genre would lose a day of pushes.
import { sql } from '@/lib/db'

// Arbitrary, but fixed: every writer that pushes game_info rows must use the same key.
export const PUSH_LOCK_KEY = 7_411_902

export async function withPushLock<T>(fn: () => Promise<T>): Promise<T> {
  const out = await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as typeof sql
    await tx`SELECT pg_advisory_xact_lock(${PUSH_LOCK_KEY})`
    return fn()
  })
  return out as T
}
