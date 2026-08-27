// lib/assign-roster.ts — groups evaluator_roster rows by person for the
// single-page Assign table. One DB row is one (person, genre) pair; the table
// groups them so the Evaluator and Available columns can span a person's rows.
import { BUCKETS, type Bucket } from '@/lib/buckets'

export interface RosterRow {
  id: number
  name: string
  category_group: Bucket
  today_available: boolean
  game_platform: string
  game_category: string
  weight: number
}

export interface PersonGroup {
  name: string
  today_available: boolean
  rows: RosterRow[]
  missingGenres: Bucket[]
}

const bucketRank = (b: string): number => {
  const i = (BUCKETS as readonly string[]).indexOf(b)
  return i === -1 ? BUCKETS.length : i
}

const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' })

export function groupRosterByPerson(rows: RosterRow[]): PersonGroup[] {
  const buckets = new Map<string, RosterRow[]>()
  for (const r of rows) {
    const list = buckets.get(r.name)
    if (list) list.push(r)
    else buckets.set(r.name, [r])
  }

  return Array.from(buckets.entries())
    .sort((a, b) => byName(a[0], b[0]))
    .map(([name, list]) => {
      const sorted = [...list].sort((a, b) => bucketRank(a.category_group) - bucketRank(b.category_group))
      const have = new Set(sorted.map(r => r.category_group))
      return {
        name,
        // Availability is a fact about the person. Rows disagreeing with each
        // other is leftover data from the three-tab era; the group takes the first
        // row's value, and since every write updates all rows with that name, the
        // disagreement clears itself on the first edit.
        today_available: sorted[0].today_available,
        rows: sorted,
        missingGenres: BUCKETS.filter(b => !have.has(b)),
      }
    })
}
