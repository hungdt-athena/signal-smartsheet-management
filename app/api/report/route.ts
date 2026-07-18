import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { weekLabelOrder } from '@/lib/weekly-feedback'

export const dynamic = 'force-dynamic'

// GET /api/report — live evaluator-performance analytics over game_evaluations.
// Objective metrics only (no note scoring). Recording work is folded into each
// evaluator's profile (as a recorder), not a separate view. A shortlist→final
// funnel measures pick quality. Results are cached in-memory for a few minutes so
// repeated loads are cheap; the dataset (~40k rows) aggregates sub-second anyway.
//
// Params:
//   view=week|month|quarter|batch|custom   (time lens; default 'month')
//   key=<week-start|YYYY-MM|YYYY-Qn|batch label>   (the selected bucket; '' = all)
//   from,to=YYYY-MM-DD                      (custom range)
//   category=all|puzzle|arcade|simulation
// Non-managers are name-scoped to their own row (mirrors quick-stats).

const VN = 'Asia/Ho_Chi_Minh'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
type View = 'week' | 'month' | 'quarter' | 'batch' | 'custom'

// --- tiny in-memory TTL cache (per server instance) ---
const CACHE = new Map<string, { at: number; body: unknown }>()
const TTL_MS = 3 * 60 * 1000

// Resolve a view+key into a concrete window. Date views produce a [from,to] range;
// batch view filters by label instead.
function resolveWindow(view: View, key: string, from: string, to: string): {
  label: string; from?: string; to?: string; batch?: string
} {
  const d = (y: number, m: number, day: number) => `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  if (view === 'batch') return { label: key || 'All batches', batch: key || undefined }
  if (view === 'custom') {
    const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)
    return { label: `${from || '…'} → ${to || '…'}`, from: valid(from) ? from : undefined, to: valid(to) ? to : undefined }
  }
  if (view === 'week' && /^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const [y, m, day] = key.split('-').map(Number)
    const start = new Date(Date.UTC(y, m - 1, day))
    const end = new Date(start.getTime() + 6 * 864e5)
    const wom = Math.floor((day - 1) / 7) + 1
    return { label: `W${wom} ${MONTHS[m - 1]} ${y}`, from: key, to: d(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate()) }
  }
  if (view === 'month' && /^\d{4}-\d{2}$/.test(key)) {
    const [y, m] = key.split('-').map(Number)
    const to = m === 12 ? d(y, 12, 31) : d(y, m + 1, 1)
    return { label: `${MONTHS[m - 1]} ${y}`, from: d(y, m, 1), to }
  }
  if (view === 'quarter' && /^\d{4}-Q[1-4]$/.test(key)) {
    const [y, q] = key.split('-Q').map(Number)
    const sm = (q - 1) * 3 + 1
    const to = q === 4 ? d(y + 1, 1, 1) : d(y, sm + 3, 1)
    return { label: `Q${q} ${y}`, from: d(y, sm, 1), to }
  }
  return { label: 'All time' } // no key → all
}

export async function GET(req: NextRequest) {
  const guard = await requireRole('admin')
  if (guard) return guard

  try {
    const { searchParams } = req.nextUrl
    const view = (['week', 'month', 'quarter', 'batch', 'custom'].includes(searchParams.get('view') || '')
      ? searchParams.get('view') : 'month') as View
    const key = (searchParams.get('key') || '').trim()
    const from = (searchParams.get('from') || '').trim()
    const to = (searchParams.get('to') || '').trim()
    const category = (searchParams.get('category') || 'all').toLowerCase()

    const cacheKey = JSON.stringify({ view, key, from, to, category })
    const hit = CACHE.get(cacheKey)
    if (hit && Date.now() - hit.at < TTL_MS) return NextResponse.json(hit.body)

    const win = resolveWindow(view, key, from, to)

    // WHERE fragments shared by evaluation queries.
    const catF = category !== 'all' ? sql`AND ge.category_group = ${category}` : sql``
    // Window: batch view filters by label; date views filter evaluate_date.
    const winF = win.batch
      ? sql`AND ge.batch = ${win.batch}`
      : sql`
        ${win.from ? sql`AND (ge.evaluate_date AT TIME ZONE ${VN})::date >= ${win.from}::date` : sql``}
        ${win.to ? sql`AND (ge.evaluate_date AT TIME ZONE ${VN})::date < ${win.to}::date` : sql``}`

    // Bucket unit for the time series, from the window span.
    const spanDays = win.from && win.to
      ? Math.round((Date.parse(win.to) - Date.parse(win.from)) / 864e5)
      : win.batch ? 14 : 400
    const unit = spanDays <= 16 ? 'day' : spanDays <= 130 ? 'week' : 'month'

    const evalBase = sql`
      FROM game_evaluations ge
      WHERE ge.evaluate_date IS NOT NULL
        AND ge.initial_evaluator IS NOT NULL AND ge.initial_evaluator <> ''
        ${catF} ${winF}`

    const [perEval, initConcl, finConcl, series, evalSeries, recorders, optRows] = await Promise.all([
      // per-evaluator core + funnel
      sql`
        SELECT lower(ge.initial_evaluator) AS k,
          mode() WITHIN GROUP (ORDER BY ge.initial_evaluator) AS name,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion <> 'Link_dead')::int AS evaluated,
          count(DISTINCT (ge.evaluate_date AT TIME ZONE ${VN})::date)::int AS active_days,
          COALESCE(SUM(CASE WHEN ge.assigned_date IS NOT NULL THEN GREATEST((ge.evaluate_date AT TIME ZONE ${VN})::date - ge.assigned_date, 0) END), 0)::numeric AS ta_sum,
          count(*) FILTER (WHERE ge.assigned_date IS NOT NULL)::int AS ta_count,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion <> 'Link_dead' AND ge.initial_conclusion NOT ILIKE '%bypass%')::int AS escalated,
          count(*) FILTER (WHERE ge.final_conclusion IS NOT NULL AND ge.final_conclusion <> '')::int AS triaged,
          count(*) FILTER (WHERE ge.final_conclusion ILIKE 'Priority%')::int AS final_priority,
          count(*) FILTER (WHERE ge.initial_conclusion = 'Link_dead')::int AS link_dead,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion <> 'Link_dead'
                             AND ge.initial_note IS NOT NULL AND btrim(ge.initial_note) <> '')::int AS noted
        ${evalBase}
        GROUP BY lower(ge.initial_evaluator)`,
      // per-evaluator initial conclusion distribution
      sql`SELECT lower(ge.initial_evaluator) AS k, ge.initial_conclusion AS c, count(*)::int AS n
        ${evalBase} AND ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion <> 'Link_dead'
        GROUP BY lower(ge.initial_evaluator), ge.initial_conclusion`,
      // per-evaluator final conclusion distribution
      sql`SELECT lower(ge.initial_evaluator) AS k, ge.final_conclusion AS c, count(*)::int AS n
        ${evalBase} AND ge.final_conclusion IS NOT NULL AND ge.final_conclusion <> ''
        GROUP BY lower(ge.initial_evaluator), ge.final_conclusion`,
      // team time series (bucketed) — volume plus funnel metrics for trend/sparklines
      sql`SELECT date_trunc(${unit}, ge.evaluate_date AT TIME ZONE ${VN})::date::text AS b,
          count(*)::int AS n,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion <> 'Link_dead')::int AS evaluated,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion <> 'Link_dead' AND ge.initial_conclusion NOT ILIKE '%bypass%')::int AS escalated,
          count(*) FILTER (WHERE ge.final_conclusion IS NOT NULL AND ge.final_conclusion <> '')::int AS triaged,
          count(*) FILTER (WHERE ge.final_conclusion ILIKE 'Priority%')::int AS final_priority
        ${evalBase}
        GROUP BY 1 ORDER BY 1`,
      // per-evaluator time series (heatmap cells)
      sql`SELECT lower(ge.initial_evaluator) AS k, date_trunc(${unit}, ge.evaluate_date AT TIME ZONE ${VN})::date::text AS b, count(*)::int AS n
        ${evalBase}
        GROUP BY 1, 2`,
      // recording per recorder (5min + 20min slots), same window on record_confirmed_at (or batch)
      sql`
        WITH rec AS (
          SELECT lower(ge.record_5min_assignee) AS k, ge.record_5min_assignee AS name, '5min' AS slot
          FROM game_evaluations ge
          WHERE ge.record_confirmed_at IS NOT NULL AND ge.record_5min_assignee IS NOT NULL AND ge.record_5min_assignee <> ''
            ${catF}
            ${win.batch ? sql`AND ge.batch = ${win.batch}` : sql`
              ${win.from ? sql`AND (ge.record_confirmed_at AT TIME ZONE ${VN})::date >= ${win.from}::date` : sql``}
              ${win.to ? sql`AND (ge.record_confirmed_at AT TIME ZONE ${VN})::date < ${win.to}::date` : sql``}`}
          UNION ALL
          SELECT lower(ge.record_20min_assignee), ge.record_20min_assignee, '20min'
          FROM game_evaluations ge
          WHERE ge.record_confirmed_at IS NOT NULL AND ge.record_20min_assignee IS NOT NULL AND ge.record_20min_assignee <> ''
            ${catF}
            ${win.batch ? sql`AND ge.batch = ${win.batch}` : sql`
              ${win.from ? sql`AND (ge.record_confirmed_at AT TIME ZONE ${VN})::date >= ${win.from}::date` : sql``}
              ${win.to ? sql`AND (ge.record_confirmed_at AT TIME ZONE ${VN})::date < ${win.to}::date` : sql``}`}
        )
        SELECT k, mode() WITHIN GROUP (ORDER BY name) AS name,
          count(*)::int AS recorded,
          count(*) FILTER (WHERE slot='5min')::int AS rec5,
          count(*) FILTER (WHERE slot='20min')::int AS rec20
        FROM rec GROUP BY k`,
      // filter dropdown options (distinct weeks/months/quarters/batches)
      sql`
        SELECT 'week' AS kind, date_trunc('week', evaluate_date AT TIME ZONE ${VN})::date::text AS v
          FROM game_evaluations WHERE evaluate_date IS NOT NULL ${category !== 'all' ? sql`AND category_group=${category}` : sql``}
        GROUP BY 1,2
        UNION ALL
        SELECT 'month', to_char(date_trunc('month', evaluate_date AT TIME ZONE ${VN}), 'YYYY-MM')
          FROM game_evaluations WHERE evaluate_date IS NOT NULL ${category !== 'all' ? sql`AND category_group=${category}` : sql``}
        GROUP BY 1,2
        UNION ALL
        SELECT 'quarter', to_char(evaluate_date AT TIME ZONE ${VN}, 'YYYY') || '-Q' || EXTRACT(QUARTER FROM evaluate_date AT TIME ZONE ${VN})::int
          FROM game_evaluations WHERE evaluate_date IS NOT NULL ${category !== 'all' ? sql`AND category_group=${category}` : sql``}
        GROUP BY 1,2
        UNION ALL
        SELECT 'batch', batch FROM game_evaluations WHERE batch IS NOT NULL AND batch <> '' ${category !== 'all' ? sql`AND category_group=${category}` : sql``}
        GROUP BY 1,2`,
    ])

    // fold conclusion maps
    const initBy = new Map<string, Record<string, number>>()
    for (const r of initConcl) { const m = initBy.get(r.k) || {}; m[r.c] = r.n; initBy.set(r.k, m) }
    const finBy = new Map<string, Record<string, number>>()
    for (const r of finConcl) { const m = finBy.get(r.k) || {}; m[r.c] = r.n; finBy.set(r.k, m) }
    const recBy = new Map<string, { recorded: number; rec5: number; rec20: number }>()
    for (const r of recorders) recBy.set(r.k, { recorded: r.recorded, rec5: r.rec5, rec20: r.rec20 })

    // window days for consistency denominator
    let windowDays = spanDays
    if (win.batch || (!win.from && !win.to)) {
      // derive from actual data span in scope
      const span = series.length ? series : null
      windowDays = span ? Math.max(7, Math.round((Date.parse(series[series.length - 1].b) - Date.parse(series[0].b)) / 864e5) + (unit === 'day' ? 1 : unit === 'week' ? 7 : 30)) : 30
    }

    // Outcome quality weights for final conclusions on an evaluator's picks
    // (user-defined ordering: PV > PIV > Insight > Watch List > Theme/Art > Bypass;
    // Not Found is excluded — a game nobody could locate says nothing about the pick).
    const OUTCOME_W: Record<string, number> = {
      'Priority V': 100, 'Priority IV': 80, 'Insight': 60,
      'Watch List': 40, 'Theme/Art': 20, 'Bypass': 0,
    }
    const outcomeScoreOf = (fin: Record<string, number>): number | null => {
      let sum = 0, n = 0
      for (const [c, cnt] of Object.entries(fin)) {
        if (c in OUTCOME_W) { sum += OUTCOME_W[c] * cnt; n += cnt }
      }
      return n > 0 ? sum / n : null
    }

    const evaluators = perEval.map((e) => {
      const evaluated = e.evaluated
      const rec = recBy.get(e.k) || { recorded: 0, rec5: 0, rec20: 0 }
      return {
        key: e.k, name: e.name,
        evaluated,
        activeDays: e.active_days,
        throughput: e.active_days > 0 ? evaluated / e.active_days : 0,
        turnaround: e.ta_count > 0 ? Number(e.ta_sum) / e.ta_count : null,
        signalRate: evaluated > 0 ? e.escalated / evaluated : 0,
        consistency: Math.min(1, e.active_days / Math.max(1, windowDays)),
        escalated: e.escalated,
        triaged: e.triaged,
        finalPriority: e.final_priority,
        survivalRate: e.escalated > 0 ? e.final_priority / e.escalated : 0,
        linkDead: e.link_dead,
        noted: e.noted,
        noteRate: evaluated > 0 ? e.noted / evaluated : 0,
        outcomeScore: outcomeScoreOf(finBy.get(e.k) || {}),
        recorded: rec.recorded, rec5: rec.rec5, rec20: rec.rec20,
        initialConclusions: initBy.get(e.k) || {},
        finalConclusions: finBy.get(e.k) || {},
      }
    })
    // include recorders who did no evaluation in this window
    for (const [k, rec] of Array.from(recBy.entries())) {
      if (!evaluators.find((e) => e.key === k)) {
        const r = recorders.find((x) => x.k === k)!
        evaluators.push({
          key: k, name: r.name, evaluated: 0, activeDays: 0, throughput: 0, turnaround: null,
          signalRate: 0, consistency: 0, escalated: 0, triaged: 0, finalPriority: 0, survivalRate: 0,
          linkDead: 0, noted: 0, noteRate: 0, outcomeScore: null,
          recorded: rec.recorded, rec5: rec.rec5, rec20: rec.rec20, initialConclusions: {}, finalConclusions: {},
        })
      }
    }
    evaluators.sort((a, b) => b.evaluated - a.evaluated)

    // team aggregates
    const sum = (f: (e: typeof evaluators[number]) => number) => evaluators.reduce((s, e) => s + f(e), 0)
    const activeEvals = evaluators.filter((e) => e.evaluated > 0)
    const funnel = {
      evaluated: sum((e) => e.evaluated),
      escalated: sum((e) => e.escalated),
      triaged: sum((e) => e.triaged),
      finalPriority: sum((e) => e.finalPriority),
    }
    const tput = activeEvals.map((e) => e.throughput)
    const tas = evaluators.map((e) => e.turnaround).filter((t): t is number => t != null)
    // team outcome score: weighted over ALL final conclusions in scope
    const teamFin: Record<string, number> = {}
    for (const e of evaluators) for (const [c, n] of Object.entries(e.finalConclusions)) teamFin[c] = (teamFin[c] || 0) + n
    const teamTotals = {
      evaluators: activeEvals.length,
      totalEvaluated: funnel.evaluated,
      avgThroughput: tput.length ? tput.reduce((a, b) => a + b, 0) / tput.length : 0,
      avgTurnaround: tas.length ? tas.reduce((a, b) => a + b, 0) / tas.length : null,
      signalRate: funnel.evaluated ? funnel.escalated / funnel.evaluated : 0,
      survivalRate: funnel.escalated ? funnel.finalPriority / funnel.escalated : 0,
      totalRecorded: sum((e) => e.recorded),
      linkDead: sum((e) => e.linkDead),
      noteRate: funnel.evaluated ? sum((e) => e.noted) / funnel.evaluated : 0,
      outcomeScore: outcomeScoreOf(teamFin),
    }

    // team conclusion distributions
    const mergeMap = (getter: (e: typeof evaluators[number]) => Record<string, number>) => {
      const m: Record<string, number> = {}
      for (const e of evaluators) for (const [c, n] of Object.entries(getter(e))) m[c] = (m[c] || 0) + n
      return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
    }

    // radar (normalize each axis to team max = 100)
    const maxOf = (f: (e: typeof evaluators[number]) => number) => Math.max(1, ...evaluators.map(f))
    const mv = maxOf((e) => e.evaluated), mr = maxOf((e) => e.recorded)
    const radar = evaluators.map((e) => ({
      key: e.key,
      name: e.name,
      axes: {
        Volume: Math.round((e.evaluated / mv) * 100),
        Consistency: Math.round(e.consistency * 100),
        Signal: Math.round(e.signalRate * 100),
        Survival: Math.round(e.survivalRate * 100),
        Recording: Math.round((e.recorded / mr) * 100),
      },
    }))

    // labeled time series
    const bucketLabel = (b: string) => {
      const [y, m, d2] = b.split('-').map(Number)
      return unit === 'month' ? `${MONTHS[m - 1]} ${y}`
        : unit === 'week' ? `W${Math.floor((d2 - 1) / 7) + 1} ${MONTHS[m - 1]}`
        : `${d2}/${m}`
    }
    const seriesLabeled = series.map((s) => ({ label: bucketLabel(s.b), value: s.n }))

    // multi-metric time series (one point per bucket) — powers trend lines & KPI sparklines
    const metricSeries = series.map((s) => ({
      key: s.b,
      label: bucketLabel(s.b),
      volume: s.n,
      evaluated: s.evaluated,
      escalated: s.escalated,
      triaged: s.triaged,
      finalPriority: s.final_priority,
      signalRate: s.evaluated > 0 ? s.escalated / s.evaluated : 0,
      survivalRate: s.escalated > 0 ? s.final_priority / s.escalated : 0,
    }))

    // heatmap: person × bucket
    const bucketKeys = Array.from(new Set(evalSeries.map((r) => r.b))).sort()
    const heatCells = new Map<string, Record<string, number>>()
    for (const r of evalSeries) { const m = heatCells.get(r.k) || {}; m[r.b] = r.n; heatCells.set(r.k, m) }
    const heatmap = {
      periods: bucketKeys.map((b) => ({ key: b, label: bucketLabel(b) })),
      rows: evaluators.filter((e) => e.evaluated > 0).map((e) => ({ name: e.name, cells: heatCells.get(e.key) || {} })),
    }

    // options for adaptive dropdown
    const opts: Record<string, string[]> = { week: [], month: [], quarter: [], batch: [] }
    for (const r of optRows) if (opts[r.kind]) opts[r.kind].push(r.v)
    opts.week.sort().reverse()
    opts.month.sort().reverse()
    opts.quarter.sort().reverse()
    opts.batch.sort((a, b) => weekLabelOrder(b) - weekLabelOrder(a))
    // pretty labels for week keys
    const weekLabels = opts.week.map((w) => {
      const [y, m, d2] = w.split('-').map(Number)
      return { key: w, label: `W${Math.floor((d2 - 1) / 7) + 1} ${MONTHS[m - 1]} ${y}` }
    })
    const monthLabels = opts.month.map((k) => { const [y, m] = k.split('-').map(Number); return { key: k, label: `${MONTHS[m - 1]} ${y}` } })
    const quarterLabels = opts.quarter.map((k) => { const [y, q] = k.split('-Q'); return { key: k, label: `Q${q} ${y}` } })
    const batchLabels = opts.batch.map((k) => ({ key: k, label: k }))

    const body = {
      empty: evaluators.length === 0,
      canSeeTeam: true,
      view, category, window: win,
      options: { week: weekLabels, month: monthLabels, quarter: quarterLabels, batch: batchLabels },
      teamTotals, funnel,
      initialConclusions: mergeMap((e) => e.initialConclusions),
      finalConclusions: mergeMap((e) => e.finalConclusions),
      series: seriesLabeled,
      metricSeries,
      heatmap,
      evaluators, radar,
    }
    CACHE.set(cacheKey, { at: Date.now(), body })
    return NextResponse.json(body)
  } catch (err) {
    console.error('GET /api/report error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
