// The WHERE fragments and window resolution shared by /api/evaluations (rows) and
// /api/evaluations/facets (dropdown contents).
//
// Both routes have to interpret the same query string identically: if the facets
// endpoint scoped "which batches exist" by a slightly different evaluator or date
// predicate than the list it decorates, the dropdown would offer batches the list
// cannot show (or hide ones it can). Keeping one builder is what stops that drift --
// the same reason the list and stats queries in the rows route share `listFilters`.

import { sql } from '@/lib/db'
import { isManagerRole } from '@/lib/roles'
import type { Session } from 'next-auth'

export type DateBasis = 'assigned' | 'evaluated'
export interface YearMonth { year: number; month: number }

/** Resolve who the caller is allowed to see.
 *
 *  Privacy: evaluators may only ever see their OWN rows. Managers query freely.
 *  Enforced server-side so a crafted ?evaluator= can't reveal another evaluator's
 *  games (the client also locks the picker, but this is the gate). A name-less
 *  non-manager gets a sentinel that matches nothing rather than leaking all. */
export function resolveEvaluatorScope(
  searchParams: URLSearchParams,
  session: Session | null,
): string {
  const skipAuth = process.env.SKIP_AUTH === 'true'
  const isManager = skipAuth || isManagerRole(session?.user?.role)
  return isManager
    ? (searchParams.get('evaluator') || '')
    : (session?.user?.name || ' __no_evaluator__')
}

const pad = (n: number) => String(n).padStart(2, '0')
const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate()

/** The month picker filters on different dates per view: the standard evaluators tab
 *  tracks when work was assigned (assigned_date); Short List tracks when games were
 *  evaluated/decided (evaluate_date), falling back to updated_at for rows synced
 *  without an eval date. Short List sends date_basis=evaluated. */
export function pickerDateExpr(basis: DateBasis) {
  return basis === 'evaluated'
    ? sql`COALESCE(ge.evaluate_date, ge.updated_at)`
    : sql`ge.assigned_date`
}

export function readDateBasis(searchParams: URLSearchParams): DateBasis {
  return searchParams.get('date_basis') === 'evaluated' ? 'evaluated' : 'assigned'
}

/** Resolve the active inclusive date range [from, to] (YYYY-MM-DD).
 *  Priority: explicit from/to -> year/month(/day) -> month=auto. `appliedMonth` is
 *  echoed to the client so it can lock in the auto-resolved month. */
export function resolveRange(
  searchParams: URLSearchParams,
  availableMonths: YearMonth[],
): { from: string | null; to: string | null; appliedMonth: YearMonth | null } {
  const monthParam = searchParams.get('month') || ''
  const autoMonth = monthParam === 'auto'
  const year = parseInt(searchParams.get('year') || '0')
  const month = autoMonth ? 0 : parseInt(monthParam || '0')
  const day = parseInt(searchParams.get('day') || '0')
  const from = searchParams.get('from') || ''
  const to = searchParams.get('to') || ''

  if (from && to) return { from, to, appliedMonth: null }
  if (year > 0 && month > 0 && day > 0) {
    const d = isoDate(year, month, day)
    return { from: d, to: d, appliedMonth: null }
  }
  if (year > 0 && month > 0) {
    return {
      from: isoDate(year, month, 1),
      to: isoDate(year, month, lastDay(year, month)),
      appliedMonth: { year, month },
    }
  }
  if (autoMonth) {
    const nowVN = new Date(Date.now() + 7 * 3600 * 1000)
    const curY = nowVN.getUTCFullYear()
    const curM = nowVN.getUTCMonth() + 1
    let applied: YearMonth | null = null
    if (availableMonths.some(m => m.year === curY && m.month === curM)) {
      applied = { year: curY, month: curM }
    } else if (availableMonths.length > 0) {
      applied = { year: availableMonths[0].year, month: availableMonths[0].month }
    }
    if (applied) {
      return {
        from: isoDate(applied.year, applied.month, 1),
        to: isoDate(applied.year, applied.month, lastDay(applied.year, applied.month)),
        appliedMonth: applied,
      }
    }
  }
  return { from: null, to: null, appliedMonth: null }
}

export const FINAL_NONE = '(none)'

/** Every content filter the two routes share, built from one query string. */
export function buildFilters(searchParams: URLSearchParams, evaluator: string, basis: DateBasis) {
  const pickerDate = pickerDateExpr(basis)

  const status = searchParams.get('status') || ''
  const statusFilter = status === 'pending'
    ? sql`AND ge.initial_conclusion IS NULL`
    : status === 'done'
      ? sql`AND ge.initial_conclusion IS NOT NULL`
      : sql``

  // Case-insensitive: sheet data has casing drift (Huydd vs HuyDD) — match all variants.
  const evaluatorFilter = evaluator
    ? sql`AND lower(ge.initial_evaluator) = lower(${evaluator})`
    : sql``

  const conclusion = searchParams.get('conclusion') || ''
  const conclusionList = (searchParams.get('conclusions') || '')
    .split(',').map(c => c.trim()).filter(Boolean)
  const conclusionFilter = conclusionList.length > 0
    ? sql`AND ge.initial_conclusion IN ${sql(conclusionList)}`
    : conclusion
      ? sql`AND ge.initial_conclusion = ${conclusion}`
      : sql``

  // Short List "Final conclusion" filter. Multi-select over final_conclusion, with a
  // '(none)' sentinel meaning "not yet decided" (final_conclusion IS NULL).
  const finalConclusionList = (searchParams.get('final_conclusions') || '')
    .split(',').map(c => c.trim()).filter(Boolean)
  const finalConclusionValues = finalConclusionList.filter(c => c !== FINAL_NONE)
  const finalIncludesNone = finalConclusionList.includes(FINAL_NONE)
  const finalConclusionFilter = finalConclusionList.length === 0
    ? sql``
    : finalConclusionValues.length === 0
      ? sql`AND ge.final_conclusion IS NULL`
      : finalIncludesNone
        ? sql`AND (ge.final_conclusion IN ${sql(finalConclusionValues)} OR ge.final_conclusion IS NULL)`
        : sql`AND ge.final_conclusion IN ${sql(finalConclusionValues)}`

  const assignmentStatus = searchParams.get('assignment_status') || ''
  const assignmentFilter = assignmentStatus === 'unassigned'
    ? sql`AND ge.record_5min_assignee IS NULL AND ge.record_20min_assignee IS NULL`
    : assignmentStatus === 'assigned'
      ? sql`AND (ge.record_5min_assignee IS NOT NULL OR ge.record_20min_assignee IS NOT NULL)`
      : sql``

  const recordingFilter = searchParams.get('has_recording') === 'true'
    ? sql`AND (ge.record_5min_assignee IS NOT NULL OR ge.record_20min_assignee IS NOT NULL)`
    : sql``

  const recorder = searchParams.get('recorder') || ''
  const recorderFilter = recorder
    ? sql`AND (ge.record_5min_assignee = ${recorder} OR ge.record_20min_assignee = ${recorder})`
    : sql``

  // Record tab membership: manual bucket override OR auto by final_conclusion.
  const recordViewFilter = searchParams.get('record_view') === '1'
    ? sql`AND (ge.record_bucket IN ('5min','20min')
              OR (ge.record_bucket IS NULL AND ge.final_conclusion IN ('Insight','Priority IV')))`
    : sql``

  const batch = searchParams.get('batch') || ''
  const batchFilter = batch ? sql`AND ge.batch = ${batch}` : sql``

  return {
    pickerDate,
    evaluatorFilter,
    conclusionFilter,
    finalConclusionFilter,
    statusFilter,
    assignmentFilter,
    recordingFilter,
    recorderFilter,
    recordViewFilter,
    batchFilter,
  }
}

/** One range filter on pickerDate covers day / month / custom-range alike. */
export function rangeFilterFor(pickerDate: ReturnType<typeof pickerDateExpr>, from: string | null, to: string | null) {
  return from && to
    ? sql`AND ${pickerDate} >= ${from}::date
          AND ${pickerDate} < ${to}::date + interval '1 day'`
    : sql``
}

/** Months that have data, for the picker and for resolving month=auto. */
export async function loadAvailableMonths(
  category: string,
  pickerDate: ReturnType<typeof pickerDateExpr>,
  evaluatorFilter: ReturnType<typeof buildFilters>['evaluatorFilter'],
): Promise<YearMonth[]> {
  const rows = await sql`
    SELECT DISTINCT
      EXTRACT(YEAR FROM ${pickerDate})::int AS year,
      EXTRACT(MONTH FROM ${pickerDate})::int AS month
    FROM game_evaluations ge
    WHERE ge.category_group = ${category}
      AND ${pickerDate} IS NOT NULL
      ${evaluatorFilter}
    ORDER BY year DESC, month DESC
  `
  return rows as unknown as YearMonth[]
}
