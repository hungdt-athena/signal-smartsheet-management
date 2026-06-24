import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { weekLabelOrder } from '@/lib/weekly-feedback'

export const dynamic = 'force-dynamic'

export async function GET() {
  const guard = await requireAuth()
  if (guard) return guard

  // Batches + evaluators come from weekly_feedback itself (not game_evaluations),
  // so the dropdowns reflect exactly the weeks/people that HAVE feedback —
  // including ones imported from the legacy sheet that never appear in
  // game_evaluations. Batches are sorted newest week → oldest by their
  // "W<n> <Month>, <Year>" label.
  const batchRows = await sql<{ batch: string }[]>`
    SELECT DISTINCT batch FROM weekly_feedback WHERE batch IS NOT NULL
  `
  const batches = batchRows
    .map(r => r.batch)
    .sort((a, b) => weekLabelOrder(b) - weekLabelOrder(a) || b.localeCompare(a))

  const evalRows = await sql<{ evaluator: string }[]>`
    SELECT DISTINCT evaluator FROM weekly_feedback WHERE evaluator IS NOT NULL ORDER BY evaluator
  `

  return NextResponse.json({ batches, evaluators: evalRows.map(r => r.evaluator) })
}
