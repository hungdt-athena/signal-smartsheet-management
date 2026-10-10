// lib/effort-sessions.ts — pure helpers for GET /api/external/effort-sessions,
// the read-only feed the Effort Tracker pulls to set each freelancer's declared
// effort beside the moments they actually set a status in Signal.

import { timingSafeEqual } from 'crypto'

export const MAX_RANGE_DAYS = 62

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const EMPLOYEE_ID_RE = /^[a-z0-9._-]{1,64}$/i

/** A real calendar date in YYYY-MM-DD, or null. Rejects 2026-02-30. */
function parseDay(v: string | null): Date | null {
  if (!v || !DATE_RE.test(v)) return null
  const d = new Date(`${v}T00:00:00Z`)
  return d.toISOString().slice(0, 10) === v ? d : null
}

export type RangeParams =
  | { ok: true; from: string; to: string; employeeId: string | null }
  | { ok: false; error: string }

export function parseParams(sp: URLSearchParams): RangeParams {
  const from = sp.get('from'), to = sp.get('to')
  const f = parseDay(from), t = parseDay(to)
  if (!f || !t) return { ok: false, error: 'from and to are required, as YYYY-MM-DD' }
  if (f > t) return { ok: false, error: 'from must be on or before to' }
  const days = Math.round((t.getTime() - f.getTime()) / 86_400_000) + 1
  if (days > MAX_RANGE_DAYS) return { ok: false, error: `range is ${days} days, the limit is ${MAX_RANGE_DAYS}` }

  const raw = (sp.get('employee_id') || '').trim()
  if (raw && !EMPLOYEE_ID_RE.test(raw)) return { ok: false, error: 'employee_id is invalid' }
  return { ok: true, from: from!, to: to!, employeeId: raw ? raw.toLowerCase() : null }
}

/** Constant-time check of the x-api-key header. Closed when the env var is unset. */
export function hasValidApiKey(given: string | null, expected: string | undefined): boolean {
  if (!expected || !given) return false
  const a = Buffer.from(given), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export type Person = { employee_id: string; name: string }

export type EventRow = {
  evaluator_key: string // lower(initial_evaluator)
  date: string          // YYYY-MM-DD, VN
  time: string          // HH24:MI:SS, VN
  game_id: string
  game: string | null
  genre: string | null
  status: string | null
  comment: string | null
}

export type Session = Omit<EventRow, 'evaluator_key' | 'date'>

export type RecordRow = {
  assignee_key: string  // lower(record_<n>min_assignee)
  date: string          // YYYY-MM-DD, VN, of the assignment
  time: string          // HH24:MI:SS, VN
  game_id: string
  game: string | null
  genre: string | null
  duration_min: 5 | 20
}

export type RecordOut = Omit<RecordRow, 'assignee_key' | 'date'>

export type Day = { date: string; sessions: Session[]; records: RecordOut[] }

export type PersonOut = Person & { days: Day[] }

/** Put evaluations and confirmed record assignments under each person, by day.
 *  Every requested person is returned, even with no days, so the caller can
 *  tell "no work" apart from "unknown person". Days come out in date order;
 *  items keep the order of the (time-sorted) input rows. */
export function groupByPerson(people: Person[], rows: EventRow[], records: RecordRow[] = []): PersonOut[] {
  const days = new Map<string, Map<string, Day>>()
  for (const p of people) days.set(p.name.toLowerCase(), new Map())

  const dayOf = (key: string, date: string): Day | null => {
    const m = days.get(key)
    if (!m) return null
    let d = m.get(date)
    if (!d) { d = { date, sessions: [], records: [] }; m.set(date, d) }
    return d
  }

  for (const r of rows) {
    dayOf(r.evaluator_key, r.date)?.sessions.push({
      time: r.time, game_id: r.game_id, game: r.game,
      genre: r.genre, status: r.status, comment: r.comment,
    })
  }
  for (const r of records) {
    dayOf(r.assignee_key, r.date)?.records.push({
      time: r.time, game_id: r.game_id, game: r.game,
      genre: r.genre, duration_min: r.duration_min,
    })
  }

  return people.map(p => ({
    ...p,
    days: Array.from(days.get(p.name.toLowerCase())!.values())
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
  }))
}
