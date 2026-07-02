// lib/operation-runs.ts — shared helpers for operation_runs (migration 028).
// Builds the DistResult-shaped snapshot that reassign + handover store and that the
// Team Operations "Details" popup re-renders, and owns the row insert.

import { sql } from '@/lib/db'
import type { Candidate } from '@/lib/reassign-core'

export type RunKind = 'reassign' | 'handover'
export type RunStatus = 'committed' | 'pending' | 'approved' | 'rejected'

// Mirrors DistResult in components/DistributionResult.tsx — stored verbatim as the
// snapshot/result JSON so the popup renders without a translation layer.
export interface DistSnapshot {
  candidate_count: number
  assignable?: number
  unassignable?: number
  assigned?: number
  per_evaluator: Record<string, number>
  per_evaluator_platform?: Record<string, { ios: number; android: number; other: number }>
  by_platform?: { ios: number; android: number; other: number }
  by_date?: { date: string; count: number }[]
  dryRun: boolean
}

// Source-pool breakdowns: platform totals + games grouped by their original
// assigned_date (newest first, '—' for null-date games last).
export function sourceBreakdowns(candidates: Candidate[]): {
  by_platform: { ios: number; android: number; other: number }
  by_date: { date: string; count: number }[]
} {
  const by_platform = { ios: 0, android: 0, other: 0 }
  const dateCounts = new Map<string, number>()
  for (const c of candidates) {
    const os = (c.os || '').toLowerCase()
    if (os === 'ios') by_platform.ios++
    else if (os === 'android') by_platform.android++
    else by_platform.other++
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
): Record<string, { ios: number; android: number; other: number }> {
  const osById = new Map(candidates.map(c => [c.id, (c.os || '').toLowerCase()]))
  const out: Record<string, { ios: number; android: number; other: number }> = {}
  assignment.forEach((name, id) => {
    const p = (out[name] ??= { ios: 0, android: 0, other: 0 })
    const os = osById.get(id)
    if (os === 'ios') p.ios++
    else if (os === 'android') p.android++
    else p.other++
  })
  return out
}

// Append an operation_runs row; returns the new id.
export async function insertOperationRun(input: {
  kind: RunKind
  category: string
  fromEvaluator: string
  params: unknown
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
      ${JSON.stringify(input.params)}::jsonb, ${JSON.stringify(input.snapshot)}::jsonb,
      ${input.status}, ${input.gameCount}, ${input.submittedBy ?? null}
    )
    RETURNING id
  `
  return (rows[0] as { id: number }).id
}
