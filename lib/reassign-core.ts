// lib/reassign-core.ts — shared DB helpers for the re-assign and handover flows.
// Both flows: pull a source evaluator's still-pending games (no initial_conclusion
// yet) and redistribute them to a set of target evaluators via the weighted,
// platform-aware algorithm in lib/assign-evaluators. This module owns the SQL so
// the routes stay thin; the distribution math lives in assign-evaluators.

import { sql } from '@/lib/db'
import { assignGames } from '@/lib/assign-evaluators'

export interface Candidate {
  id: number // game_evaluations.id
  game_id: string // game_info.game_id (for history / tracing)
  os: string | null
}

export interface RosterRow {
  name: string
  game_platform: string | null
  weight: number | null
}

// Pending games currently held by `from` in `category`, optionally narrowed by an
// assigned_date range and/or capped at `count` (oldest first). "Pending" = not yet
// concluded, so we never move a game an evaluator already finished.
export async function selectPendingGames(opts: {
  category: string
  from: string
  startDate?: string | null
  endDate?: string | null
  count?: number | null
}): Promise<Candidate[]> {
  const dateFilter =
    opts.startDate && opts.endDate
      ? sql`AND ge.assigned_date BETWEEN ${opts.startDate} AND ${opts.endDate}`
      : sql``
  const limit = opts.count && opts.count > 0 ? sql`LIMIT ${opts.count}` : sql``
  return (await sql`
    SELECT ge.id, ge.game_id, gi.os
    FROM game_evaluations ge
    JOIN game_info gi ON ge.game_id = gi.game_id
    WHERE ge.category_group = ${opts.category}
      AND ge.initial_evaluator = ${opts.from}
      AND ge.initial_conclusion IS NULL
      ${dateFilter}
    ORDER BY ge.assigned_date NULLS LAST, ge.id
    ${limit}
  `) as unknown as Candidate[]
}

// Load target evaluators for `category`. Pass `names` for an explicit re-assign
// pick; omit it (with onlyAvailable) for handover (everyone currently available).
export async function loadRoster(opts: {
  category: string
  names?: string[] | null
  onlyAvailable?: boolean
}): Promise<RosterRow[]> {
  const availFilter = opts.onlyAvailable ? sql`AND today_available = TRUE` : sql``
  const nameFilter =
    opts.names && opts.names.length ? sql`AND name = ANY(${opts.names})` : sql``
  return (await sql`
    SELECT name, game_platform, weight
    FROM evaluator_roster
    WHERE list_type = 'initial' AND category_group = ${opts.category}
      ${availFilter}
      ${nameFilter}
    ORDER BY sort_order NULLS LAST, name
  `) as unknown as RosterRow[]
}

// Persist an assignment (game_evaluations.id -> evaluator name), stamping
// assigned_date = today (VN). Returns the per-evaluator game_id lists for history.
export async function commitAssignment(
  assignment: Map<number, string>,
  idToGameId: Map<number, string>,
): Promise<Map<string, string[]>> {
  const byEvaluatorIds = new Map<string, number[]>()
  assignment.forEach((name, id) => {
    const arr = byEvaluatorIds.get(name) || []
    arr.push(id)
    byEvaluatorIds.set(name, arr)
  })
  for (const [name, ids] of Array.from(byEvaluatorIds.entries())) {
    await sql`
      UPDATE game_evaluations
      SET initial_evaluator = ${name},
          assigned_date = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
          updated_at = NOW()
      WHERE id IN ${sql(ids)}
    `
  }
  const byEvaluatorGameIds = new Map<string, string[]>()
  byEvaluatorIds.forEach((ids, name) => {
    byEvaluatorGameIds.set(name, ids.map(id => idToGameId.get(id)!).filter(Boolean))
  })
  return byEvaluatorGameIds
}

// Distribute candidates among the roster, excluding the source evaluator.
// Returns the assignment map plus the per-evaluator count summary.
export function distribute(
  candidates: Candidate[],
  roster: RosterRow[],
  exclude?: string | null,
): { assignment: Map<number, string>; perEvaluator: Record<string, number> } {
  const targets = roster
    .filter(r => r.name && r.name.trim() !== (exclude ?? '').trim())
    .map(r => ({ name: r.name, platform: r.game_platform, weight: r.weight }))
  const assignment = assignGames(candidates.map(c => ({ id: c.id, os: c.os })), targets)
  const perEvaluator: Record<string, number> = {}
  assignment.forEach(name => {
    perEvaluator[name] = (perEvaluator[name] || 0) + 1
  })
  return { assignment, perEvaluator }
}
