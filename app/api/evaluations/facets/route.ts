import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { getSession } from '@/lib/session'
import { sql } from '@/lib/db'
import { getConfigValues } from '@/lib/config'
import { visibleEvaluators } from '@/lib/people-config'
import { loadHiddenEvaluatorKeys } from '@/lib/people-config-db'
import {
  buildFilters, loadAvailableMonths, rangeFilterFor, readDateBasis,
  resolveEvaluatorScope, resolveRange,
} from '@/lib/evaluations-filters'

export const dynamic = 'force-dynamic'

// GET /api/evaluations/facets — everything the filter dropdowns need, and nothing the
// table needs.
//
// This used to ride along on every /api/evaluations page-1 response. The two have very
// different refresh rates: the rows change with every filter, sort and batch click,
// while the dropdown contents only move when the category, evaluator, conclusion or
// date range moves -- and `available_batches` and `default_batch` deliberately ignore
// the batch filter entirely, so switching batch (the single most common action on Short
// List) could never change any of this yet re-ran all of it.
//
// Splitting them lets the client refetch each on its own schedule. Filters are built by
// lib/evaluations-filters so this endpoint scopes its answers exactly the way the rows
// endpoint scopes the list they describe.
export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const { searchParams } = req.nextUrl
    const category = searchParams.get('category') || 'puzzle'
    const session = process.env.SKIP_AUTH === 'true' ? null : await getSession()
    const evaluator = resolveEvaluatorScope(searchParams, session)
    const basis = readDateBasis(searchParams)
    const f = buildFilters(searchParams, evaluator, basis)

    // month=auto needs the month list before it can pick one, so this one read has to
    // land first. Everything after it goes out together.
    const availableMonths = await loadAvailableMonths(category, f.pickerDate, f.evaluatorFilter)
    const { from, to, appliedMonth } = resolveRange(searchParams, availableMonths)
    const rangeFilter = rangeFilterFor(f.pickerDate, from, to)

    const filtersNoBatch = sql`
      ${f.evaluatorFilter}
      ${f.conclusionFilter}
      ${f.finalConclusionFilter}
      ${f.statusFilter}
      ${rangeFilter}
      ${f.assignmentFilter}
      ${f.recordingFilter}
      ${f.recorderFilter}
      ${f.recordViewFilter}
    `

    const [
      conclusionOptions, hiddenEvaluatorKeys, distinctEvaluators,
      distinctConclusions, batchRows, cfg, presentRows,
    ] = await Promise.all([
      getConfigValues('conclusion'),
      loadHiddenEvaluatorKeys(),
      // Full evaluator list for the category — deliberately ignores month and
      // pagination so the filter dropdown shows everyone, not just whoever happens to
      // be in the currently loaded rows. Grouped case-insensitively (sheet data has
      // Huydd vs HuyDD drift); the dominant casing wins.
      sql`
        SELECT mode() WITHIN GROUP (ORDER BY ge.initial_evaluator) AS e
        FROM game_evaluations ge
        WHERE ge.category_group = ${category}
          AND ge.initial_evaluator IS NOT NULL
        GROUP BY lower(ge.initial_evaluator)
        ORDER BY 1
      `,
      sql`
        SELECT DISTINCT ge.initial_conclusion AS c
        FROM game_evaluations ge
        WHERE ge.category_group = ${category}
          AND ge.initial_conclusion IS NOT NULL
          ${f.evaluatorFilter}
          ${rangeFilter}
      `,
      // Distinct batches present for this view — deliberately ignores the date range
      // and the batch filter so the Short List batch dropdown can offer every batch
      // regardless of the (all-time) date picker.
      sql<{ batch: string }[]>`
        SELECT DISTINCT ge.batch
        FROM game_evaluations ge
        WHERE ge.category_group = ${category}
          AND ge.batch IS NOT NULL
          ${f.evaluatorFilter}
          ${f.conclusionFilter}
          ${f.finalConclusionFilter}
      `,
      sql`SELECT value FROM app_config WHERE key = ${`current_batch:${category}`}`,
      sql<{ batch: string }[]>`
        SELECT DISTINCT ge.batch
        FROM game_evaluations ge
        JOIN game_info gi ON ge.game_id = gi.game_id
        WHERE ge.category_group = ${category}
          AND ge.batch IS NOT NULL
          ${filtersNoBatch}
      `,
    ])

    const present: string[] = (distinctConclusions as unknown as { c: string }[]).map(r => r.c)
    const currentBatchVal: string | null = (cfg[0]?.value as string | undefined) ?? null

    // default_batch: the batch the client should pre-select. Normally the team's
    // current batch, but if that batch has no games in this view yet (e.g. a fresh
    // week), fall back to the most recent older batch that DOES have games so the list
    // isn't empty on open.
    let defaultBatch = currentBatchVal
    if (currentBatchVal) {
      const { weekLabelOrder } = await import('@/lib/weekly-feedback')
      const presentBatches = presentRows.map(r => r.batch)
      if (!presentBatches.includes(currentBatchVal)) {
        const curOrder = weekLabelOrder(currentBatchVal)
        const byRecent = (a: string, b: string) => weekLabelOrder(b) - weekLabelOrder(a)
        const older = presentBatches.filter(b => weekLabelOrder(b) < curOrder).sort(byRecent)
        // Prefer the newest batch older than current; if none exists fall back to the
        // newest present batch overall so any data still surfaces.
        defaultBatch = older[0] ?? presentBatches.slice().sort(byRecent)[0] ?? null
      }
    }

    return NextResponse.json({
      available_months: availableMonths,
      applied_month: appliedMonth,
      conclusion_options: conclusionOptions,
      // Config › People decides who is offered here. Hiding someone never touches
      // data — their name stays on every game they evaluated, and a filter already set
      // to that name keeps working.
      available_evaluators: visibleEvaluators(
        (distinctEvaluators as unknown as { e: string }[]).map(r => r.e),
        hiddenEvaluatorKeys,
      ),
      available_conclusions: conclusionOptions.filter(c => present.includes(c))
        .concat(present.filter(c => !conclusionOptions.includes(c)).sort()),
      available_batches: batchRows.map(r => r.batch),
      current_batch: currentBatchVal,
      default_batch: defaultBatch,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('GET /api/evaluations/facets error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
