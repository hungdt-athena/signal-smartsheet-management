// lib/assignment-history.ts — append rows to assignment_history (migration 025).
// One row per evaluator per run. Used by the daily auto-assign ('assign'),
// manual re-assign ('reassign'), and handover ('handover') flows so managers can
// trace "who got which games on which day". run_date is the VN calendar date.

import { sql } from '@/lib/db'

export type AssignAction = 'assign' | 'reassign' | 'handover'

export interface HistoryInput {
  category: string
  action: AssignAction
  // evaluator name -> the game_info.game_id values they received this run
  perEvaluator: Map<string, string[]>
  fromEvaluator?: string | null // source evaluator for reassign/handover
  createdBy?: string | null // session email, or 'cron' for scheduled runs
}

// Best-effort append; callers decide whether to await. Evaluators with an empty
// game list are skipped so the log only records real movement.
export async function writeAssignmentHistory(input: HistoryInput): Promise<number> {
  let rows = 0
  for (const [name, gameIds] of Array.from(input.perEvaluator.entries())) {
    if (!gameIds || gameIds.length === 0) continue
    await sql`
      INSERT INTO assignment_history
        (run_date, category_group, action, evaluator_name, from_evaluator, game_count, game_ids, created_by)
      VALUES (
        (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
        ${input.category}, ${input.action}, ${name},
        ${input.fromEvaluator ?? null}, ${gameIds.length}, ${gameIds}, ${input.createdBy ?? null}
      )
    `
    rows++
  }
  return rows
}
