// lib/report.ts — pure aggregation + metric helpers for the Report tab.
//
// The heavy per-week aggregation runs in SQL (see the report-rollup cron); these
// helpers roll those weekly rows up to the requested granularity and derive the
// display metrics. Kept pure (no DB, no Date.now) so they are unit-tested and safe
// on both client and server.

export type Domain = 'evaluation' | 'recording'
export type Granularity = 'week' | 'month' | 'quarter' | 'overall'

// A single row from report_rollup. `conclusions` is already parsed JSON.
export interface RollupRow {
  period_week: string        // 'YYYY-MM-DD' (Monday, VN tz)
  period_month: string       // 'YYYY-MM'
  period_quarter: string     // 'YYYY-Qn'
  category_group: string
  domain: Domain
  evaluator: string
  evaluator_key: string
  games: number
  active_days: number
  turnaround_sum: number
  turnaround_count: number
  priority_count: number
  conclusions: Record<string, number>
}

// Additive components — everything that can be SUM()ed across weeks.
export interface Components {
  games: number
  active_days: number
  turnaround_sum: number
  turnaround_count: number
  priority_count: number
  conclusions: Record<string, number>
}

export interface Metrics {
  games: number
  activeDays: number
  throughput: number       // games per active day
  turnaround: number | null // avg days assign→complete (null when no dated rows)
  priorityRate: number     // 0..1 share of Priority* conclusions (evaluation only)
  consistency: number      // 0..1 active days / (weeks in range × 7)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// --- date/period labels (operate on the stored strings, no timezone math) ---

/** Parse 'YYYY-MM-DD' into numeric parts without constructing a Date (tz-safe). */
export function parseISODate(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10))
  return { y, m, d }
}

/** "W2 Jun 2026" from a week-start (Monday) date. Week-of-month = ceil(day/7). */
export function weekLabel(isoWeekStart: string): string {
  const { y, m, d } = parseISODate(isoWeekStart)
  const wom = Math.floor((d - 1) / 7) + 1
  return `W${wom} ${MONTHS[m - 1] ?? '?'} ${y}`
}

/** "Jun 2026" from a 'YYYY-MM' key. */
export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map((n) => parseInt(n, 10))
  return `${MONTHS[m - 1] ?? '?'} ${y}`
}

/** "Q2 2026" from a 'YYYY-Qn' key. */
export function quarterLabel(key: string): string {
  const [y, q] = key.split('-Q')
  return `Q${q} ${y}`
}

/** The grouping key on a rollup row for the requested granularity. */
export function periodKey(row: RollupRow, g: Granularity): string {
  switch (g) {
    case 'week': return row.period_week
    case 'month': return row.period_month
    case 'quarter': return row.period_quarter
    case 'overall': return 'all'
  }
}

/** Human label for a period key at the given granularity. */
export function periodLabel(key: string, g: Granularity): string {
  switch (g) {
    case 'week': return weekLabel(key)
    case 'month': return monthLabel(key)
    case 'quarter': return quarterLabel(key)
    case 'overall': return 'Overall'
  }
}

/** Sort value for a period key (ascending = oldest→newest). */
export function periodOrder(key: string, g: Granularity): number {
  if (g === 'overall') return 0
  if (g === 'week') { const { y, m, d } = parseISODate(key); return y * 10000 + m * 100 + d }
  if (g === 'month') { const [y, m] = key.split('-').map(Number); return y * 100 + m }
  const [y, q] = key.split('-Q').map(Number); return y * 10 + q
}

// --- aggregation ---

export function emptyComponents(): Components {
  return { games: 0, active_days: 0, turnaround_sum: 0, turnaround_count: 0, priority_count: 0, conclusions: {} }
}

/** Fold a rollup row's additive components into an accumulator (in place). */
export function addComponents(acc: Components, row: Pick<RollupRow, keyof Components>): Components {
  acc.games += row.games
  acc.active_days += row.active_days
  acc.turnaround_sum += Number(row.turnaround_sum) || 0
  acc.turnaround_count += row.turnaround_count
  acc.priority_count += row.priority_count
  for (const [k, v] of Object.entries(row.conclusions || {})) {
    acc.conclusions[k] = (acc.conclusions[k] || 0) + (v || 0)
  }
  return acc
}

/** Sum a list of rollup rows into one Components bag. */
export function sumComponents(rows: RollupRow[]): Components {
  return rows.reduce((acc, r) => addComponents(acc, r), emptyComponents())
}

/**
 * Derive display metrics from summed components.
 * `weeksInRange` = distinct weeks covered by the whole filtered dataset — used as
 * the consistency denominator so an evaluator absent some weeks scores lower.
 */
export function deriveMetrics(c: Components, weeksInRange: number): Metrics {
  const denomDays = Math.max(1, weeksInRange) * 7
  return {
    games: c.games,
    activeDays: c.active_days,
    throughput: c.active_days > 0 ? c.games / c.active_days : 0,
    turnaround: c.turnaround_count > 0 ? c.turnaround_sum / c.turnaround_count : null,
    priorityRate: c.games > 0 ? c.priority_count / c.games : 0,
    consistency: Math.min(1, c.active_days / denomDays),
  }
}

/** Group rows by evaluator_key → summed components (with display name preserved). */
export function groupByEvaluator(rows: RollupRow[]): Map<string, { name: string; c: Components }> {
  const out = new Map<string, { name: string; c: Components }>()
  for (const r of rows) {
    let e = out.get(r.evaluator_key)
    if (!e) { e = { name: r.evaluator, c: emptyComponents() }; out.set(r.evaluator_key, e) }
    addComponents(e.c, r)
  }
  return out
}

/** Group rows by period key → summed components, sorted oldest→newest. */
export function groupByPeriod(rows: RollupRow[], g: Granularity): Array<{ key: string; label: string; order: number; c: Components }> {
  const map = new Map<string, Components>()
  for (const r of rows) {
    const k = periodKey(r, g)
    let c = map.get(k)
    if (!c) { c = emptyComponents(); map.set(k, c) }
    addComponents(c, r)
  }
  return Array.from(map.entries())
    .map(([key, c]) => ({ key, label: periodLabel(key, g), order: periodOrder(key, g), c }))
    .sort((a, b) => a.order - b.order)
}

/** Distinct weeks present in a rollup set (consistency denominator). */
export function weeksInRange(rows: RollupRow[]): number {
  return new Set(rows.map((r) => r.period_week)).size
}

/** Percent change cur vs prev; null when prev is 0 (undefined baseline). */
export function pctChange(cur: number, prev: number): number | null {
  if (!prev) return null
  return (cur - prev) / prev
}

/** Merge conclusion maps into a sorted [name, count] list, biggest first. */
export function mergeConclusions(rows: RollupRow[]): Array<{ name: string; count: number }> {
  const m: Record<string, number> = {}
  for (const r of rows) for (const [k, v] of Object.entries(r.conclusions || {})) m[k] = (m[k] || 0) + (v || 0)
  return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
}
