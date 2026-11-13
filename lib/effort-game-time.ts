// lib/effort-game-time.ts — helpers for GET /api/external/effort-game-time: the seconds a
// person had each game open in the Evaluate panel, per VN day, for the Effort Tracker.
// effort-sessions says WHEN someone set a verdict; this says for HOW LONG they looked.
// Params, key check and the Person/Record shapes are effort-sessions' own, reused as is.

import type { Person, RecordRow, RecordOut } from '@/lib/effort-sessions'

/** One row of the log query: a person, a VN day, a game and one evaluation row of it.
 *  duration_s is null when that day's only trace is a seed row (judged before the log). */
export type GameTimeRow = {
  person_key: string // lower(name) — actor for panel saves, owner for seed rows
  date: string       // YYYY-MM-DD, VN, of the save
  game_id: string
  game: string | null
  genre: string | null
  duration_s: number | null
}


/** What a game looks like in the output: its category group is the key it sits under. */
export type GameOut = { game_id: string; game: string | null; duration_s: number | null }

/** The three category groups (puzzle | arcade | simulation). Always present, [] when empty. */
export const CATEGORY_KEYS = ['puzzle', 'arcade', 'simulation'] as const
export type CategoryKey = typeof CATEGORY_KEYS[number]
/** `other` only shows up when a game has no category group, or one we do not know. */
export type GamesByCategory = Record<CategoryKey, GameOut[]> & { other?: GameOut[] }

const keyOf = (g: string | null): CategoryKey | 'other' => {
  const k = (g ?? '').toLowerCase()
  return k === 'puzzle' || k === 'arcade' || k === 'simulation' ? k : 'other'
}

export type Day = {
  date: string
  games: GamesByCategory
  records: RecordOut[]
  records_5min: number
  records_20min: number
}

export type PersonOut = Person & { days: Day[] }

/** Put each person's games and confirmed record assignments under their VN days.
 *
 *  Games are merged by game_id within a day: a game can still hold a row in two genres,
 *  and a person who judged both would otherwise appear twice. Durations add up; the
 *  genre is the one that took longer, else the first one known. A game with no measured
 *  second at all stays null rather than 0, so "not measured" is not read as "no time".
 *  Games keep the order of the (first-save-sorted) input rows; days come out in date order.
 *  Every requested person is returned, even with no days. */
export function groupGameTime(people: Person[], rows: GameTimeRow[], records: RecordRow[] = []): PersonOut[] {
  type Acc = { game_id: string; game: string | null; genre: string | null; duration_s: number | null; best: number }
  type DayAcc = { date: string; games: Map<string, Acc>; records: RecordOut[] }
  const byPerson = new Map<string, Map<string, DayAcc>>()
  for (const p of people) byPerson.set(p.name.toLowerCase(), new Map())

  const dayOf = (key: string, date: string): DayAcc | null => {
    const m = byPerson.get(key)
    if (!m) return null
    let d = m.get(date)
    if (!d) { d = { date, games: new Map(), records: [] }; m.set(date, d) }
    return d
  }

  for (const r of rows) {
    const day = dayOf(r.person_key, r.date)
    if (!day) continue
    const g = day.games.get(r.game_id)
    if (!g) {
      day.games.set(r.game_id, {
        game_id: r.game_id, game: r.game, genre: r.genre, duration_s: r.duration_s, best: r.duration_s ?? -1,
      })
      continue
    }
    if (r.duration_s !== null) g.duration_s = (g.duration_s ?? 0) + r.duration_s
    if (r.duration_s !== null && r.duration_s > g.best) { g.best = r.duration_s; g.genre = r.genre ?? g.genre }
    else if (g.genre === null) g.genre = r.genre
    if (g.game === null) g.game = r.game
  }

  for (const r of records) {
    dayOf(r.assignee_key, r.date)?.records.push({
      time: r.time, game_id: r.game_id, game: r.game, genre: r.genre, duration_min: r.duration_min,
    })
  }

  return people.map(p => ({
    ...p,
    days: Array.from(byPerson.get(p.name.toLowerCase())!.values())
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map(d => {
        const games = Object.fromEntries(CATEGORY_KEYS.map(k => [k, [] as GameOut[]])) as GamesByCategory
        for (const g of Array.from(d.games.values())) {
          const k = keyOf(g.genre)
          const out: GameOut = { game_id: g.game_id, game: g.game, duration_s: g.duration_s }
          if (k === 'other') (games.other ??= []).push(out)
          else games[k].push(out)
        }
        return {
          date: d.date,
          games,
          records: d.records,
          records_5min: d.records.filter(x => x.duration_min === 5).length,
          records_20min: d.records.filter(x => x.duration_min === 20).length,
        }
      }),
  }))
}
