// lib/operation-runs.ts — shared helpers for operation_runs (migration 028).
// Builds the DistResult-shaped snapshot that reassign + handover store and that the
// Team Operations "Details" popup re-renders, and owns the row insert.

import type postgres from 'postgres'
import { sql } from '@/lib/db'
import type { Candidate } from '@/lib/reassign-core'

// The values we store are plainly JSON-serializable; this narrows to what sql.json wants.
type Json = postgres.JSONValue

// 'rescue' is a reassign whose source/target sets were chosen by the stale-backlog
// rules (lib/rescue-core.ts) rather than by hand. It gets its own kind so the Rescue
// tab's history stays separate from manual reassigns, while the game movement it
// records in assignment_history is written as a plain 'reassign'.
export type RunKind = 'reassign' | 'handover' | 'rescue'
export type RunStatus = 'committed' | 'pending' | 'approved' | 'rejected'

// Mirrors DistResult in components/DistributionResult.tsx — stored verbatim as the
// snapshot/result JSON so the popup renders without a translation layer.
export interface DistSnapshot {
  candidate_count: number
  assignable?: number
  unassignable?: number
  assigned?: number
  per_evaluator: Record<string, number>
  per_evaluator_platform?: Record<string, PlatformSplit>
  by_platform?: PlatformSplit
  by_date?: { date: string; count: number }[]
  dryRun: boolean
}

// Per-platform tally. `pair` = a linked pair (os 'pair', one game for both stores);
// optional because snapshots stored before pairs existed have no such key.
export interface PlatformSplit { ios: number; android: number; other: number; pair?: number }

function bump(p: PlatformSplit, os: string) {
  if (os === 'ios') p.ios++
  else if (os === 'android') p.android++
  else if (os === 'pair') p.pair = (p.pair ?? 0) + 1
  else p.other++
}

// Source-pool breakdowns: platform totals + games grouped by their original
// assigned_date (newest first, '—' for null-date games last).
export function sourceBreakdowns(candidates: Candidate[]): {
  by_platform: PlatformSplit
  by_date: { date: string; count: number }[]
} {
  const by_platform: PlatformSplit = { ios: 0, android: 0, other: 0, pair: 0 }
  const dateCounts = new Map<string, number>()
  for (const c of candidates) {
    bump(by_platform, (c.os || '').toLowerCase())
    const d = c.assigned_date ?? '—'
    dateCounts.set(d, (dateCounts.get(d) || 0) + 1)
  }
  const by_date = Array.from(dateCounts.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([date, count]) => ({ date, count }))
  return { by_platform, by_date }
}

// Per-evaluator platform split of a resulting assignment (game_evaluations.id -> name).
export function perEvaluatorPlatform(
  candidates: Candidate[],
  assignment: Map<number, string>,
): Record<string, PlatformSplit> {
  const osById = new Map(candidates.map(c => [c.id, (c.os || '').toLowerCase()]))
  const out: Record<string, PlatformSplit> = {}
  assignment.forEach((name, id) => {
    bump((out[name] ??= { ios: 0, android: 0, other: 0, pair: 0 }), osById.get(id) ?? '')
  })
  return out
}

// Append an operation_runs row; returns the new id.
export async function insertOperationRun(input: {
  kind: RunKind
  category: string
  fromEvaluator: string
  params: Record<string, unknown>
  snapshot: DistSnapshot
  status: RunStatus
  gameCount: number
  submittedBy?: string | null
}): Promise<number> {
  const rows = await sql`
    INSERT INTO operation_runs
      (kind, category_group, from_evaluator, params, snapshot, status, game_count, submitted_by)
    VALUES (
      ${input.kind}, ${input.category}, ${input.fromEvaluator},
      ${sql.json(input.params as Json)}, ${sql.json(input.snapshot as unknown as Json)},
      ${input.status}, ${input.gameCount}, ${input.submittedBy ?? null}
    )
    RETURNING id
  `
  return (rows[0] as { id: number }).id
}
