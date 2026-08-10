// lib/rescue-core.ts — the queries behind the stale-backlog Rescue panel.
//
// Reassign (lib/reassign-core.ts) answers "move THIS person's games to THESE people".
// Rescue answers the question before that: which games have gone stale, whose shelf
// they should leave, and who has actually earned the right to receive them. The rules
// that decide it are pure and live in lib/rescue-rules.ts; the moving itself is
// delegated — commitAssignment() and assignGames() are reused untouched.

import { sql } from '@/lib/db'
import type { Candidate } from '@/lib/reassign-core'
import type { RescueConfig } from '@/lib/rescue-config'
import type { RescueStats } from '@/lib/rescue-rules'

// One pass over the bucket: pending / stale / movable / recent-activity per roster
// member. LEFT JOINed onto the roster so someone holding nothing still appears — as a
// receiver candidate, or as neutral with the reason why not.
export async function scanRoster(opts: { category: string; config: RescueConfig }): Promise<RescueStats[]> {
  const { staleDays, cooldownDays, activeDays } = opts.config
  const rows = (await sql`
    WITH today AS (SELECT (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS d),
    cooled AS (
      -- Games moved by ANY operation inside the cool-down window. Covers manual
      -- reassign and handover, not just previous rescues: a game that just changed
      -- hands deserves a fair run with its new holder either way. (A rescue records
      -- its movement as action='reassign', so that value carries both.)
      SELECT DISTINCT unnest(game_ids) AS game_id
      FROM assignment_history
      WHERE action IN ('reassign', 'handover', 'rescue')
        AND run_at > NOW() - (${cooldownDays} * INTERVAL '1 day')
    ),
    pend AS (
      SELECT ge.initial_evaluator AS name,
             count(*)::int AS pending,
             count(*) FILTER (
               WHERE ge.assigned_date IS NOT NULL
                 AND (SELECT d FROM today) - ge.assigned_date > ${staleDays}
             )::int AS stale,
             count(*) FILTER (
               WHERE ge.assigned_date IS NOT NULL
                 AND (SELECT d FROM today) - ge.assigned_date > ${staleDays}
                 AND ge.game_id NOT IN (SELECT game_id FROM cooled)
             )::int AS movable
      FROM game_evaluations ge
      WHERE ge.category_group = ${opts.category}
        AND ge.initial_conclusion IS NULL
        AND ge.initial_evaluator IS NOT NULL
      GROUP BY 1
    ),
    act AS (
      SELECT initial_evaluator AS name, count(*)::int AS evaluated_recent
      FROM game_evaluations
      WHERE category_group = ${opts.category}
        AND initial_conclusion IS NOT NULL
        AND evaluate_date >= (SELECT d FROM today) - (${activeDays} * INTERVAL '1 day')
      GROUP BY 1
    )
    SELECT r.name, r.game_platform, r.weight, r.today_available,
           COALESCE(p.pending, 0) AS pending,
           COALESCE(p.stale, 0) AS stale,
           COALESCE(p.movable, 0) AS movable,
           COALESCE(a.evaluated_recent, 0) AS evaluated_recent
    FROM evaluator_roster r
    LEFT JOIN pend p ON p.name = r.name
    LEFT JOIN act a ON a.name = r.name
    WHERE r.list_type = 'initial' AND r.category_group = ${opts.category}
    ORDER BY r.sort_order NULLS LAST, r.name
  `) as unknown as {
    name: string
    game_platform: string | null
    weight: number | null
    today_available: boolean
    pending: number
    stale: number
    movable: number
    evaluated_recent: number
  }[]

  return rows.map(r => ({
    name: r.name,
    platform: r.game_platform,
    weight: r.weight,
    available: !!r.today_available,
    pending: r.pending,
    stale: r.stale,
    movable: r.movable,
    evaluatedRecent: r.evaluated_recent,
  }))
}

// Stale, movable games held by `from`, oldest assigned_date first. Same shape as
// reassign's Candidate so the whole downstream chain (breakdowns, assignGames,
// commitAssignment, DistResult) is reused verbatim.
export async function selectStaleGames(opts: {
  category: string
  from: string
  config: RescueConfig
  limit?: number | null
}): Promise<Candidate[]> {
  const { staleDays, cooldownDays } = opts.config
  const limit = opts.limit && opts.limit > 0 ? sql`LIMIT ${opts.limit}` : sql``
  return (await sql`
    WITH today AS (SELECT (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS d),
    cooled AS (
      SELECT DISTINCT unnest(game_ids) AS game_id
      FROM assignment_history
      WHERE action IN ('reassign', 'handover', 'rescue')
        AND run_at > NOW() - (${cooldownDays} * INTERVAL '1 day')
    )
    SELECT ge.id, ge.game_id, gi.os, ge.assigned_date::text AS assigned_date
    FROM game_evaluations ge
    JOIN game_info gi ON ge.game_id = gi.game_id
    WHERE ge.category_group = ${opts.category}
      AND ge.initial_evaluator = ${opts.from}
      AND ge.initial_conclusion IS NULL
      AND ge.assigned_date IS NOT NULL
      AND (SELECT d FROM today) - ge.assigned_date > ${staleDays}
      AND ge.game_id NOT IN (SELECT game_id FROM cooled)
    ORDER BY ge.assigned_date, ge.id
    ${limit}
  `) as unknown as Candidate[]
}
