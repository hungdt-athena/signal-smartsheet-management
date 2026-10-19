// lib/rescue-merge.ts — adds per-bucket Rescue rosters up per person (pure).
import type { RescueStats } from '@/lib/rescue-rules'

export function mergeRosters(perBucket: RescueStats[][]): RescueStats[] {
  const by = new Map<string, RescueStats>()
  for (const rows of perBucket) {
    for (const r of rows) {
      const cur = by.get(r.name)
      if (!cur) { by.set(r.name, { ...r }); continue }
      // staleAll is read BEFORE `stale` is added to: when the first row carried no
      // staleAll, its `stale` is the whole-stock number.
      cur.staleAll = (cur.staleAll ?? cur.stale) + (r.staleAll ?? r.stale)
      // Same for movableAll against `movable`.
      cur.movableAll = (cur.movableAll ?? cur.movable) + (r.movableAll ?? r.movable)
      cur.pending += r.pending
      cur.stale += r.stale
      cur.movable += r.movable
      cur.evaluatedRecent += r.evaluatedRecent
      // Available on ANY roster they are on: today_available is a fact about the
      // person's day, not about a genre.
      cur.available = cur.available || r.available
      cur.platform = cur.platform ?? r.platform
      cur.weight = cur.weight ?? r.weight
    }
  }
  return Array.from(by.values())
}
