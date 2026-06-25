import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { weekLabelOrder } from '@/lib/weekly-feedback'

export const dynamic = 'force-dynamic'

export async function GET() {
  const guard = await requireAuth()
  if (guard) return guard

  // `batches` come from weekly_feedback itself (not game_evaluations), so the
  // Overview filter reflects exactly the weeks that HAVE feedback — including
  // ones imported from the legacy sheet that never appear in game_evaluations.
  const byOrder = (a: string, b: string) => weekLabelOrder(b) - weekLabelOrder(a) || b.localeCompare(a)
  const batchRows = await sql<{ batch: string }[]>`
    SELECT DISTINCT batch FROM weekly_feedback WHERE batch IS NOT NULL
  `
  const batches = batchRows.map(r => r.batch).sort(byOrder)

  // `allBatches` is the full universe for the Editor's batch cards: every week
  // an evaluator might need to write feedback for = weeks games are assigned to
  // (game_evaluations) UNION weeks that already have feedback (incl. legacy).
  // Cards for weeks with no feedback yet render as faint "add…" prompts.
  const gameBatchRows = await sql<{ batch: string }[]>`
    SELECT DISTINCT batch FROM game_evaluations WHERE batch IS NOT NULL
  `
  const allBatches = Array.from(new Set([...batches, ...gameBatchRows.map(r => r.batch)])).sort(byOrder)

  const evalRows = await sql<{ evaluator: string }[]>`
    SELECT DISTINCT evaluator FROM weekly_feedback WHERE evaluator IS NOT NULL ORDER BY evaluator
  `

  return NextResponse.json({ batches, allBatches, evaluators: evalRows.map(r => r.evaluator) })
}
