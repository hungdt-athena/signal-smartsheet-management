import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { weekLabelOrder } from '@/lib/weekly-feedback'
import { teamBench, weekLabel } from '@/lib/report'
import { SYSTEM_EVALUATOR_KEY_LIST } from '@/lib/system-accounts'
import { allRounderScore } from '@/lib/report-config'
import { loadReportConfig } from '@/lib/report-config-db'

export const dynamic = 'force-dynamic'

// Lowercase names kept out of every report aggregation (evaluation + recording).
const EXCLUDED = SYSTEM_EVALUATOR_KEY_LIST

// GET /api/report - live evaluator-performance analytics over game_evaluations.
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
    // `to` is EXCLUSIVE → next Monday, so Sunday stays inside the week
    const end = new Date(start.getTime() + 7 * 864e5)
    return { label: weekLabel(key), from: key, to: d(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate()) }
  }
  if (view === 'month' && /^\d{4}-\d{2}$/.test(key)) {
    const [y, m] = key.split('-').map(Number)
    const to = m === 12 ? d(y + 1, 1, 1) : d(y, m + 1, 1)
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
  const guard = await requireRole(['admin', 'evaluator'])
  if (guard) return guard

  try {
    // Evaluators may read this endpoint, but only their OWN performance: the response
    // is rebuilt below with every other person's row removed. Team AGGREGATES stay
    // (the "vs team" benchmark lines and the funnel counts) - user's call: an
    // evaluator should know where they sit against the team, without seeing who is
    // who. Their key is their display name, lowercased, exactly like every other
    // self-scoped route (see quick-stats).
    const session = process.env.SKIP_AUTH === 'true' ? null : await getServerSession(authOptions)
    // SKIP_AUTH local dev has no session and gets the full admin view on purpose.
    const scoped = !!session && session.user?.role !== 'admin'
    const selfKey = (session?.user?.name || '').toLowerCase()
    if (scoped && !selfKey) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { searchParams } = req.nextUrl
    const view = (['week', 'month', 'quarter', 'batch', 'custom'].includes(searchParams.get('view') || '')
      ? searchParams.get('view') : 'month') as View
    const key = (searchParams.get('key') || '').trim()
    const from = (searchParams.get('from') || '').trim()
    const to = (searchParams.get('to') || '').trim()
    const category = (searchParams.get('category') || 'all').toLowerCase()
    // Title lens: narrow every people-based aggregate to one job classification
    // (dashboard_users.title). Only Fulltime/Freelancer are exposed as filters, and
    // only to admins - it is a team lens, and honouring it for a scoped request would
    // let an evaluator probe team benchmarks sliced by job type.
    const titleParam = (searchParams.get('title') || '').toLowerCase()
    const title = !scoped && ['fulltime', 'freelancer'].includes(titleParam) ? titleParam : 'all'

    // Admin settings (who counts + all-rounder weights). Its updated_at is part of
    // the cache key so saving the Config tab invalidates every cached bundle.
    const { config: rcfg, updatedAt: cfgAt } = await loadReportConfig()
    // `scope` MUST be part of the key: without it an admin's full bundle could be
    // served straight out of the cache to an evaluator asking for the same window.
    const cacheKey = JSON.stringify({ view, key, from, to, category, title, cfgAt, scope: scoped ? selfKey : 'all' })
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
    // Activity views (heatmap + movement charts) read cadence, so they stay finer
    // than the trend buckets: a week/month/batch window breaks down by DAY, a
    // quarter by WEEK, and only all-time falls back to months.
    const actUnit = spanDays <= 62 ? 'day' : spanDays <= 200 ? 'week' : 'month'

    // Only people currently declared on the Assign roster count in the report -
    // historical/one-off names (tiennh, quangnm…) and system accounts are noise.
    // Falls back to the system-account exclusion if the roster table is empty.
    const rosterRows = await sql`SELECT lower(name) AS k FROM evaluator_roster WHERE list_type = 'initial'`
    // Config tab exclusions come off the roster before anything else, so an excluded
    // person disappears from every stat, chart and denominator - not just the lists.
    let roster: string[] = rosterRows.map((r) => r.k).filter((k) => !rcfg.excluded.includes(k))
    // title map keyed by lower(display name) - report keys are display names too
    const titleRows = await sql`SELECT lower(name) AS k, title FROM dashboard_users WHERE name IS NOT NULL AND name <> ''`
    const titleBy = new Map<string, string | null>(titleRows.map((r) => [r.k, r.title]))
    if (title !== 'all') {
      const titled = titleRows.filter((r) => (r.title || '').toLowerCase() === title).map((r) => r.k)
        .filter((k) => !rcfg.excluded.includes(k))
      roster = roster.length ? roster.filter((k) => titled.includes(k)) : titled
    }
    // With a title lens the roster IS the filter: an empty list must match
    // nobody instead of falling back to the exclusion-only branch.
    const useRoster = roster.length > 0 || title !== 'all'
    const notSystem = useRoster
      ? sql`AND lower(ge.initial_evaluator) = ANY(${roster})`
      : sql`AND lower(ge.initial_evaluator) <> ALL(${EXCLUDED})`
    const recOk = (col: 'record_5min_assignee' | 'record_20min_assignee') => useRoster
      ? sql`AND lower(ge.${sql.unsafe(col)}) = ANY(${roster})`
      : sql`AND lower(ge.${sql.unsafe(col)}) <> ALL(${EXCLUDED})`

    // When a recording is DONE. The Record tab treats a matching YouTube upload
    // as the truth and the manual Confirm as a weaker "recording" state; Report
    // used to read only the Confirm, so the same game showed Recorded on one
    // screen and Pending on the other. Both now resolve to the same moment: the
    // upload if we have one (migration 034), otherwise the Confirm click.
    const recAt = sql`COALESCE(ge.record_confirmed_at, ge.youtube_uploaded_at)`
    const recAtDate = sql`(COALESCE(ge.record_confirmed_at, ge.youtube_uploaded_at) AT TIME ZONE ${VN})::date`

    const evalBase = sql`
      FROM game_evaluations ge
      WHERE ge.evaluate_date IS NOT NULL
        AND ge.initial_evaluator IS NOT NULL AND ge.initial_evaluator <> ''
        ${notSystem}
        ${catF} ${winF}`

    // Pipeline flow (game-level, NOT person-level): games entering the pipeline
    // (imported_at) vs games evaluated (evaluate_date) vs end-of-bucket backlog
    // (pushed but not yet evaluated). System accounts are NOT excluded - their rows
    // are real games flowing through. Backlog is cumulative over ALL history (so it
    // shows true absolute stock), then sliced to the window. Batch view has no time
    // axis → pipeline is null there.
    const pipelinePromise = win.batch ? Promise.resolve(null) : Promise.all([
      sql`
        WITH r AS (
          SELECT (ge.imported_at AT TIME ZONE ${VN})::date AS in_day,
                 (ge.evaluate_date AT TIME ZONE ${VN})::date AS eval_day,
                 (ge.initial_conclusion IS NOT NULL) AS done
          FROM game_evaluations ge
          WHERE ge.imported_at IS NOT NULL ${catF}
        ), ev AS (
          SELECT in_day AS day, count(*)::int AS new_n, 0 AS eval_n, 0 AS out_n FROM r GROUP BY 1
          UNION ALL
          SELECT eval_day, 0, count(*)::int, 0 FROM r WHERE eval_day IS NOT NULL GROUP BY 1
          UNION ALL
          -- Stock exit day. Two irregular shapes exist in the data:
          --   • backfilled rows whose evaluate_date precedes imported_at (evaluated on
          --     Smartsheet, imported later) → GREATEST keeps backlog from going negative;
          --   • the Jun-2026 bulk import (~5.7k rows) that carries initial_conclusion but
          --     no evaluate_date at all → it arrived already evaluated, so it exits on
          --     its import day instead of sitting in the backlog forever.
          SELECT CASE WHEN eval_day IS NULL THEN in_day ELSE GREATEST(in_day, eval_day) END,
                 0, 0, count(*)::int
          FROM r WHERE eval_day IS NOT NULL OR done GROUP BY 1
        ), daily AS (
          SELECT day, SUM(new_n)::int AS new_n, SUM(eval_n)::int AS eval_n,
            (SUM(SUM(new_n)) OVER (ORDER BY day) - SUM(SUM(out_n)) OVER (ORDER BY day))::int AS backlog
          FROM ev GROUP BY day
        )
        SELECT date_trunc(${unit}, day)::date::text AS b,
          SUM(new_n)::int AS new_games, SUM(eval_n)::int AS evaluated,
          (array_agg(backlog ORDER BY day DESC))[1]::int AS backlog
        FROM daily
        WHERE TRUE
          ${win.from ? sql`AND day >= ${win.from}::date` : sql``}
          ${win.to ? sql`AND day < ${win.to}::date` : sql``}
        GROUP BY 1 ORDER BY 1`,
      sql`
        SELECT count(*)::int AS backlog,
          count(*) FILTER (WHERE CURRENT_DATE - (ge.imported_at AT TIME ZONE ${VN})::date <= 3)::int AS a0,
          count(*) FILTER (WHERE CURRENT_DATE - (ge.imported_at AT TIME ZONE ${VN})::date BETWEEN 4 AND 7)::int AS a1,
          count(*) FILTER (WHERE CURRENT_DATE - (ge.imported_at AT TIME ZONE ${VN})::date BETWEEN 8 AND 14)::int AS a2,
          count(*) FILTER (WHERE CURRENT_DATE - (ge.imported_at AT TIME ZONE ${VN})::date > 14)::int AS a3
        FROM game_evaluations ge
        WHERE ge.evaluate_date IS NULL AND ge.initial_conclusion IS NULL ${catF}`,
      // Ageing of the stock itself: at the END of every bucket, how old were the
      // games still waiting? Answers "is the tail rotting or are we clearing it?".
      // A row is in stock on day D when it arrived on/before D and had not left yet.
      sql`
        WITH r AS (
          SELECT (ge.imported_at AT TIME ZONE ${VN})::date AS in_day,
                 CASE
                   WHEN ge.evaluate_date IS NOT NULL
                     THEN GREATEST((ge.imported_at AT TIME ZONE ${VN})::date, (ge.evaluate_date AT TIME ZONE ${VN})::date)
                   WHEN ge.initial_conclusion IS NOT NULL THEN (ge.imported_at AT TIME ZONE ${VN})::date
                   ELSE NULL
                 END AS out_day
          FROM game_evaluations ge
          WHERE ge.imported_at IS NOT NULL ${catF}
        ), b AS (
          SELECT COALESCE(${win.from ?? null}::date, (SELECT min(in_day) FROM r)) AS f,
                 -- never snapshot past today: a future day would age the stock that
                 -- still sits there and invent a tail that has not happened yet
                 LEAST(COALESCE(${win.to ?? null}::date, CURRENT_DATE + 1), CURRENT_DATE + 1) AS t
        ), snaps AS (
          SELECT date_trunc(${unit}, g)::date AS bkt, max(g::date) AS snap
          FROM b, generate_series(b.f, b.t - 1, interval '1 day') g
          GROUP BY 1
        )
        SELECT s.bkt::text AS b,
          count(*) FILTER (WHERE s.snap - r.in_day <= 3)::int AS a0,
          count(*) FILTER (WHERE s.snap - r.in_day BETWEEN 4 AND 7)::int AS a1,
          count(*) FILTER (WHERE s.snap - r.in_day BETWEEN 8 AND 14)::int AS a2,
          count(*) FILTER (WHERE s.snap - r.in_day > 14)::int AS a3
        FROM snaps s
        JOIN r ON r.in_day <= s.snap AND (r.out_day IS NULL OR r.out_day > s.snap)
        GROUP BY 1 ORDER BY 1`,
      // Capacity on the day: how many rostered evaluators actually logged work in each
      // bucket. Pairs with the flow lines - output dropping while headcount holds is a
      // different problem from output dropping because nobody was working.
      sql`
        SELECT date_trunc(${unit}, (ge.evaluate_date AT TIME ZONE ${VN}))::date::text AS b,
          count(DISTINCT lower(ge.initial_evaluator))::int AS people
        ${evalBase}
        GROUP BY 1 ORDER BY 1`,
      // Clearing mix: of the games evaluated in each bucket, how old were they at the
      // moment of evaluation? Fresh-only clearing means the old tail never moves.
      sql`
        WITH r AS (
          SELECT (ge.imported_at AT TIME ZONE ${VN})::date AS in_day,
                 (ge.evaluate_date AT TIME ZONE ${VN})::date AS eval_day
          FROM game_evaluations ge
          WHERE ge.imported_at IS NOT NULL AND ge.evaluate_date IS NOT NULL ${catF}
        )
        SELECT date_trunc(${unit}, eval_day)::date::text AS b,
          count(*) FILTER (WHERE eval_day - in_day <= 3)::int AS a0,
          count(*) FILTER (WHERE eval_day - in_day BETWEEN 4 AND 7)::int AS a1,
          count(*) FILTER (WHERE eval_day - in_day BETWEEN 8 AND 14)::int AS a2,
          count(*) FILTER (WHERE eval_day - in_day > 14)::int AS a3,
          round(avg(GREATEST(eval_day - in_day, 0)), 1)::float AS avg_age
        FROM r
        WHERE TRUE
          ${win.from ? sql`AND eval_day >= ${win.from}::date` : sql``}
          ${win.to ? sql`AND eval_day < ${win.to}::date` : sql``}
        GROUP BY 1 ORDER BY 1`,
    ])

    const [perEval, assignedRows, assignedSeries, teamAssignedRows, initConcl, finConcl, series, dayPeople, actSeries, evalSeries, evalAsgSeries, recorders, optRows, videoRows, dailyMixRows, pipelineRaw] = await Promise.all([
      // per-evaluator core + funnel. Shortlist = initial not bypassed (List_Idea);
      // Final Priority = moderator judged 'Priority IV' or 'Insight' (user-defined -
      // Priority V intentionally NOT counted).
      sql`
        SELECT lower(ge.initial_evaluator) AS k,
          mode() WITHIN GROUP (ORDER BY ge.initial_evaluator) AS name,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion <> 'Link_dead')::int AS evaluated,
          count(DISTINCT (ge.evaluate_date AT TIME ZONE ${VN})::date)::int AS active_days,
          COALESCE(SUM(CASE WHEN ge.assigned_date IS NOT NULL THEN GREATEST((ge.evaluate_date AT TIME ZONE ${VN})::date - ge.assigned_date, 0) END), 0)::numeric AS ta_sum,
          count(*) FILTER (WHERE ge.assigned_date IS NOT NULL)::int AS ta_count,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion <> 'Link_dead' AND ge.initial_conclusion NOT ILIKE '%bypass%')::int AS shortlisted,
          count(*) FILTER (WHERE ge.final_conclusion = 'Priority IV')::int AS priority_iv,
          count(*) FILTER (WHERE ge.final_conclusion = 'Insight')::int AS insight,
          count(*) FILTER (WHERE ge.initial_conclusion = 'Link_dead')::int AS link_dead,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion <> 'Link_dead'
                             AND ge.initial_note IS NOT NULL AND btrim(ge.initial_note) <> '')::int AS noted
        ${evalBase}
        GROUP BY lower(ge.initial_evaluator)`,
      // assigned per evaluator - windowed on assigned_date (a DATE, no tz shift).
      // Independent of evaluate_date so unevaluated assignments still count. This
      // is deliberately the CURRENT owner on the CURRENT assign date: a reassign
      // moves the game onto the receiver's plate, so it belongs in their stats.
      // Consequence: SUM(these) != team assigned, which counts first-time intake.
      sql`
        SELECT lower(ge.initial_evaluator) AS k,
          mode() WITHIN GROUP (ORDER BY ge.initial_evaluator) AS name,
          count(*)::int AS assigned
        FROM game_evaluations ge
        WHERE ge.assigned_date IS NOT NULL
          AND ge.initial_evaluator IS NOT NULL AND ge.initial_evaluator <> ''
          ${notSystem} ${catF}
          ${win.batch ? sql`AND ge.batch = ${win.batch}` : sql`
            ${win.from ? sql`AND ge.assigned_date >= ${win.from}::date` : sql``}
            ${win.to ? sql`AND ge.assigned_date < ${win.to}::date` : sql``}`}
        GROUP BY 1`,
      // TEAM assigned per time bucket (denominator for signal/survival trend lines).
      // Axis is first_assigned_date, NOT assigned_date: a reassign/handover restamps
      // assigned_date, which would count the same game as fresh intake again. See
      // migration 033. Per-person series below keep assigned_date on purpose.
      sql`
        SELECT date_trunc(${unit}, ge.first_assigned_date)::date::text AS b, count(*)::int AS n
        FROM game_evaluations ge
        WHERE ge.first_assigned_date IS NOT NULL
          AND ge.initial_evaluator IS NOT NULL AND ge.initial_evaluator <> ''
          ${notSystem} ${catF}
          ${win.batch ? sql`AND ge.batch = ${win.batch}` : sql`
            ${win.from ? sql`AND ge.first_assigned_date >= ${win.from}::date` : sql``}
            ${win.to ? sql`AND ge.first_assigned_date < ${win.to}::date` : sql``}`}
        GROUP BY 1`,
      // TEAM assigned total for the window - same first_assigned_date axis. Computed
      // separately instead of summing the per-evaluator numbers, which are on the
      // assigned_date axis and therefore include games received via reassign.
      sql`
        SELECT count(*)::int AS n
        FROM game_evaluations ge
        WHERE ge.first_assigned_date IS NOT NULL
          AND ge.initial_evaluator IS NOT NULL AND ge.initial_evaluator <> ''
          ${notSystem} ${catF}
          ${win.batch ? sql`AND ge.batch = ${win.batch}` : sql`
            ${win.from ? sql`AND ge.first_assigned_date >= ${win.from}::date` : sql``}
            ${win.to ? sql`AND ge.first_assigned_date < ${win.to}::date` : sql``}`}`,
      // per-evaluator initial conclusion distribution
      sql`SELECT lower(ge.initial_evaluator) AS k, ge.initial_conclusion AS c, count(*)::int AS n
        ${evalBase} AND ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion <> 'Link_dead'
        GROUP BY lower(ge.initial_evaluator), ge.initial_conclusion`,
      // per-evaluator final conclusion distribution
      sql`SELECT lower(ge.initial_evaluator) AS k, ge.final_conclusion AS c, count(*)::int AS n
        ${evalBase} AND ge.final_conclusion IS NOT NULL AND ge.final_conclusion <> ''
        GROUP BY lower(ge.initial_evaluator), ge.final_conclusion`,
      // team time series (bucketed) - volume plus funnel metrics for trend/sparklines
      sql`SELECT date_trunc(${unit}, ge.evaluate_date AT TIME ZONE ${VN})::date::text AS b,
          count(*)::int AS n,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion <> 'Link_dead')::int AS evaluated,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion <> 'Link_dead' AND ge.initial_conclusion NOT ILIKE '%bypass%')::int AS shortlisted,
          count(*) FILTER (WHERE ge.final_conclusion = 'Priority IV')::int AS priority_iv,
          count(*) FILTER (WHERE ge.final_conclusion = 'Insight')::int AS insight
        ${evalBase}
        GROUP BY 1 ORDER BY 1`,
      // DAY-grain active headcount. Kept at day grain even when the buckets are
      // weeks/months so a bucket can report the AVERAGE people working per active
      // day - a week bucket counting distinct people across the whole week would
      // read as "7 people worked" when it was really 2 per day.
      sql`SELECT (ge.evaluate_date AT TIME ZONE ${VN})::date::text AS d,
          count(DISTINCT lower(ge.initial_evaluator))::int AS people
        ${evalBase}
        GROUP BY 1`,
      // per-evaluator ACTIVITY series (heatmap + volume/rank movement) on the finer
      // actUnit grain, with the quality counts the per-period all-rounder needs.
      sql`SELECT lower(ge.initial_evaluator) AS k, date_trunc(${actUnit}, ge.evaluate_date AT TIME ZONE ${VN})::date::text AS b,
          count(*)::int AS n,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion <> 'Link_dead')::int AS evaluated,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion <> 'Link_dead' AND ge.initial_conclusion NOT ILIKE '%bypass%')::int AS shortlisted,
          count(*) FILTER (WHERE ge.final_conclusion IN ('Priority IV', 'Insight'))::int AS final_priority
        ${evalBase}
        GROUP BY 1, 2`,
      // per-evaluator time series (heatmap cells + individual activity chart)
      sql`SELECT lower(ge.initial_evaluator) AS k, date_trunc(${unit}, ge.evaluate_date AT TIME ZONE ${VN})::date::text AS b, count(*)::int AS n,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion <> 'Link_dead')::int AS evaluated,
          count(*) FILTER (WHERE ge.initial_conclusion = 'Link_dead')::int AS link_dead
        ${evalBase}
        GROUP BY 1, 2`,
      // per-evaluator assigned per bucket (assigned_date axis, for the same chart)
      sql`
        SELECT lower(ge.initial_evaluator) AS k, date_trunc(${unit}, ge.assigned_date)::date::text AS b, count(*)::int AS n
        FROM game_evaluations ge
        WHERE ge.assigned_date IS NOT NULL
          AND ge.initial_evaluator IS NOT NULL AND ge.initial_evaluator <> ''
          ${notSystem} ${catF}
          ${win.batch ? sql`AND ge.batch = ${win.batch}` : sql`
            ${win.from ? sql`AND ge.assigned_date >= ${win.from}::date` : sql``}
            ${win.to ? sql`AND ge.assigned_date < ${win.to}::date` : sql``}`}
        GROUP BY 1, 2`,
      // recording per recorder (5min + 20min slots), same window on the completion
      // moment (upload, else manual Confirm) or batch
      sql`
        WITH rec AS (
          SELECT lower(ge.record_5min_assignee) AS k, ge.record_5min_assignee AS name, '5min' AS slot
          FROM game_evaluations ge
          WHERE ${recAt} IS NOT NULL AND ge.record_5min_assignee IS NOT NULL AND ge.record_5min_assignee <> ''
            ${recOk('record_5min_assignee')}
            ${catF}
            ${win.batch ? sql`AND ge.batch = ${win.batch}` : sql`
              ${win.from ? sql`AND ${recAtDate} >= ${win.from}::date` : sql``}
              ${win.to ? sql`AND ${recAtDate} < ${win.to}::date` : sql``}`}
          UNION ALL
          SELECT lower(ge.record_20min_assignee), ge.record_20min_assignee, '20min'
          FROM game_evaluations ge
          WHERE ${recAt} IS NOT NULL AND ge.record_20min_assignee IS NOT NULL AND ge.record_20min_assignee <> ''
            ${recOk('record_20min_assignee')}
            ${catF}
            ${win.batch ? sql`AND ge.batch = ${win.batch}` : sql`
              ${win.from ? sql`AND ${recAtDate} >= ${win.from}::date` : sql``}
              ${win.to ? sql`AND ${recAtDate} < ${win.to}::date` : sql``}`}
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
      // recording queue per assignee: done-in-window rows + still-open rows
      // (an open row has no timestamp to window on; batch view windows on the
      // batch label). `confirmed_on` and the link are carried separately so the
      // client can tell Recorded (video exists) from Recording (Confirm clicked,
      // no video yet) - the same three states the Record tab shows.
      sql`
        WITH rec AS (
          SELECT lower(ge.record_5min_assignee) AS k, '5min' AS slot, ge.game_id, gi.title, gi.os,
                 ge.batch, ge.record_confirmed_at, ge.youtube_link, ${recAt} AS rec_at
          FROM game_evaluations ge LEFT JOIN game_info gi ON gi.game_id = ge.game_id
          WHERE ge.record_5min_assignee IS NOT NULL AND ge.record_5min_assignee <> '' ${recOk('record_5min_assignee')} ${catF}
          UNION ALL
          SELECT lower(ge.record_20min_assignee), '20min', ge.game_id, gi.title, gi.os,
                 ge.batch, ge.record_confirmed_at, ge.youtube_link, ${recAt}
          FROM game_evaluations ge LEFT JOIN game_info gi ON gi.game_id = ge.game_id
          WHERE ge.record_20min_assignee IS NOT NULL AND ge.record_20min_assignee <> '' ${recOk('record_20min_assignee')} ${catF}
        )
        SELECT k, slot, game_id, title, os, batch,
          (rec_at AT TIME ZONE ${VN})::date::text AS recorded_on,
          (record_confirmed_at AT TIME ZONE ${VN})::date::text AS confirmed_on,
          youtube_link
        FROM rec
        WHERE TRUE ${win.batch ? sql`AND batch = ${win.batch}` : sql`
          AND (rec_at IS NULL OR (TRUE
            ${win.from ? sql`AND (rec_at AT TIME ZONE ${VN})::date >= ${win.from}::date` : sql``}
            ${win.to ? sql`AND (rec_at AT TIME ZONE ${VN})::date < ${win.to}::date` : sql``}))`}
        ORDER BY rec_at DESC NULLS FIRST, slot`,
      // per-evaluator per-DAY initial conclusion counts (Individual → Daily breakdown).
      // Always day grain, whatever the view's bucket unit is: the point of the
      // breakdown is "what did they do on each calendar day". Link_dead excluded to
      // match every other conclusion-mix number in this file.
      sql`SELECT lower(ge.initial_evaluator) AS k,
          (ge.evaluate_date AT TIME ZONE ${VN})::date::text AS d,
          ge.initial_conclusion AS c, count(*)::int AS n
        ${evalBase} AND ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion <> 'Link_dead'
        GROUP BY 1, 2, 3`,
      pipelinePromise,
    ])

    // fold conclusion maps
    const initBy = new Map<string, Record<string, number>>()
    for (const r of initConcl) { const m = initBy.get(r.k) || {}; m[r.c] = r.n; initBy.set(r.k, m) }
    const finBy = new Map<string, Record<string, number>>()
    for (const r of finConcl) { const m = finBy.get(r.k) || {}; m[r.c] = r.n; finBy.set(r.k, m) }
    const recBy = new Map<string, { recorded: number; rec5: number; rec20: number }>()
    for (const r of recorders) recBy.set(r.k, { recorded: r.recorded, rec5: r.rec5, rec20: r.rec20 })
    const asgBy = new Map<string, { name: string; assigned: number }>()
    for (const r of assignedRows) asgBy.set(r.k, { name: r.name, assigned: r.assigned })

    // Expected working days in the window: Mon–Fri only (team convention - user
    // rule: everyone is on a 5-day week; weekend work still counts INTO active
    // days as a bonus, so Sat/Sun can make up for a missed weekday).
    const weekdaysBetween = (fromISO: string, toISOExcl: string): number => {
      let n = 0
      const d = new Date(fromISO + 'T00:00:00Z')
      const end = new Date(toISOExcl + 'T00:00:00Z')
      while (d < end) { const dow = d.getUTCDay(); if (dow !== 0 && dow !== 6) n++; d.setUTCDate(d.getUTCDate() + 1) }
      return n
    }
    let expectedDays = win.from && win.to ? weekdaysBetween(win.from, win.to) : 0
    if (!expectedDays && series.length) {
      // batch / all-time: derive the span from the data buckets
      const endD = new Date(series[series.length - 1].b + 'T00:00:00Z')
      endD.setUTCDate(endD.getUTCDate() + (unit === 'day' ? 1 : unit === 'week' ? 7 : 30))
      expectedDays = weekdaysBetween(series[0].b, endD.toISOString().slice(0, 10))
    }
    expectedDays = Math.max(1, expectedDays)

    // Rates are anchored on EVALUATED, not assigned (changed 2026-08-07 - the
    // assigned denominator was comparing two different cohorts: shortlisted and
    // finalPriority only exist on rows with an evaluate_date IN the window, while
    // assigned counts rows stamped by assigned_date, which mostly are NOT the same
    // games. That punished anyone whose queue grew mid-window and flattered anyone
    // clearing an older backlog; on real August data it read mitt at 6.8% survival
    // instead of 11.4%, and a system row with 7 evaluations against 1 assignment
    // came out at 700%. Same rows top and bottom now:
    //   survival = shortlist ÷ evaluated  - how much of what they judged got past bypass
    //   signal   = (Priority IV + Insight) ÷ evaluated - how much became real signal
    // Assigned is still reported as a COUNT (workload) and still drives turnaround.
    const evaluators = perEval.map((e) => {
      const evaluated = e.evaluated
      const rec = recBy.get(e.k) || { recorded: 0, rec5: 0, rec20: 0 }
      const assigned = asgBy.get(e.k)?.assigned || 0
      const finalPriority = e.priority_iv + e.insight
      // active days ÷ expected weekdays; weekend active days count in the
      // numerator (bonus), capped at 100%.
      const consistency = Math.min(1, e.active_days / expectedDays)
      return {
        key: e.k, name: e.name,
        title: titleBy.get(e.k) || null,
        assigned,
        evaluated,
        activeDays: e.active_days,
        throughput: e.active_days > 0 ? evaluated / e.active_days : 0,
        turnaround: e.ta_count > 0 ? Number(e.ta_sum) / e.ta_count : null,
        signalRate: evaluated > 0 ? finalPriority / evaluated : 0,
        consistency,
        shortlisted: e.shortlisted,
        priorityIV: e.priority_iv,
        insight: e.insight,
        finalPriority,
        survivalRate: evaluated > 0 ? e.shortlisted / evaluated : 0,
        linkDead: e.link_dead,
        noted: e.noted,
        noteRate: evaluated > 0 ? e.noted / evaluated : 0,
        recorded: rec.recorded, rec5: rec.rec5, rec20: rec.rec20,
        initialConclusions: initBy.get(e.k) || {},
        finalConclusions: finBy.get(e.k) || {},
      }
    })
    // include recorders / assigned-only people who did no evaluation in this window
    const blank = (key: string, name: string) => ({
      key, name, title: titleBy.get(key) || null, assigned: 0, evaluated: 0, activeDays: 0, throughput: 0, turnaround: null as number | null,
      signalRate: 0, consistency: 0, shortlisted: 0, priorityIV: 0, insight: 0, finalPriority: 0, survivalRate: 0,
      linkDead: 0, noted: 0, noteRate: 0,
      recorded: 0, rec5: 0, rec20: 0, initialConclusions: {}, finalConclusions: {},
    })
    for (const [k, rec] of Array.from(recBy.entries())) {
      if (!evaluators.find((e) => e.key === k)) {
        const r = recorders.find((x) => x.k === k)!
        evaluators.push({ ...blank(k, r.name), recorded: rec.recorded, rec5: rec.rec5, rec20: rec.rec20 })
      }
    }
    for (const [k, a] of Array.from(asgBy.entries())) {
      const ex = evaluators.find((e) => e.key === k)
      if (ex) continue
      evaluators.push({ ...blank(k, a.name), assigned: a.assigned })
    }
    evaluators.sort((a, b) => b.evaluated - a.evaluated)

    // team aggregates
    const sum = (f: (e: typeof evaluators[number]) => number) => evaluators.reduce((s, e) => s + f(e), 0)
    const activeEvals = evaluators.filter((e) => e.evaluated > 0)
    // Team funnel top stage = first-time intake (first_assigned_date), NOT the sum of
    // per-evaluator assigned - that would count a reassigned game twice over the
    // window (once for each owner) and inflate the denominator of every team rate.
    const funnel = {
      assigned: teamAssignedRows[0]?.n || 0,
      evaluated: sum((e) => e.evaluated),
      shortlisted: sum((e) => e.shortlisted),
      priorityIV: sum((e) => e.priorityIV),
      insight: sum((e) => e.insight),
      finalPriority: sum((e) => e.finalPriority),
    }
    const tput = activeEvals.map((e) => e.throughput)
    const tas = evaluators.map((e) => e.turnaround).filter((t): t is number => t != null)
    // Weighted team velocity: total games ÷ total person-active-days. Unlike
    // avgThroughput (unweighted mean of per-person rates), heavy contributors
    // count proportionally here.
    const totalActiveDays = activeEvals.reduce((s, e) => s + e.activeDays, 0)
    const teamTotals = {
      evaluators: activeEvals.length,
      totalAssigned: funnel.assigned,
      totalEvaluated: funnel.evaluated,
      avgThroughput: tput.length ? tput.reduce((a, b) => a + b, 0) / tput.length : 0,
      personDayThroughput: totalActiveDays > 0 ? funnel.evaluated / totalActiveDays : 0,
      avgTurnaround: tas.length ? tas.reduce((a, b) => a + b, 0) / tas.length : null,
      signalRate: funnel.evaluated ? funnel.finalPriority / funnel.evaluated : 0,
      survivalRate: funnel.evaluated ? funnel.shortlisted / funnel.evaluated : 0,
      totalRecorded: sum((e) => e.recorded),
      linkDead: sum((e) => e.linkDead),
      noteRate: funnel.evaluated ? sum((e) => e.noted) / funnel.evaluated : 0,
    }

    // team conclusion distributions
    const mergeMap = (getter: (e: typeof evaluators[number]) => Record<string, number>) => {
      const m: Record<string, number> = {}
      for (const e of evaluators) for (const [c, n] of Object.entries(getter(e))) m[c] = (m[c] || 0) + n
      return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
    }

    // radar - EVERY axis normalized to the team's best (=100) so shapes are
    // comparable even when the raw metric lives in a narrow band (rates ~0–15%).
    const maxOf = (f: (e: typeof evaluators[number]) => number) => Math.max(1e-9, ...evaluators.map(f))
    const mv = maxOf((e) => e.evaluated), mr = maxOf((e) => e.recorded)
    const msg = maxOf((e) => e.signalRate), msv = maxOf((e) => e.survivalRate)
    const mc = maxOf((e) => e.consistency)
    const radar = evaluators.map((e) => ({
      key: e.key,
      name: e.name,
      axes: {
        Volume: Math.round((e.evaluated / mv) * 100),
        Consistency: Math.round((e.consistency / mc) * 100),
        Signal: Math.round((e.signalRate / msg) * 100),
        Survival: Math.round((e.survivalRate / msv) * 100),
        Recording: Math.round((e.recorded / mr) * 100),
      },
    }))

    // labeled time series
    const bucketLabel = (b: string) => {
      const [y, m, d2] = b.split('-').map(Number)
      return unit === 'month' ? `${MONTHS[m - 1]} ${y}`
        : unit === 'week' ? weekLabel(b).replace(/ \d{4}$/, '')
        : `${d2}/${m}`
    }
    // Active headcount per bucket, from the day-grain counts. Day buckets pass the
    // exact number through; week/month buckets report the AVERAGE people per active
    // day, rounded UP (a bucket where anyone worked never reads 0). Mirrors
    // Postgres date_trunc: week starts Monday, month on the 1st.
    const bucketOfDay = (day: string): string => {
      if (unit === 'day') return day
      if (unit === 'month') return `${day.slice(0, 7)}-01`
      const dt = new Date(`${day}T00:00:00Z`)
      dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)) // back to Monday
      return dt.toISOString().slice(0, 10)
    }
    const peopleAcc = new Map<string, { sum: number; days: number }>()
    for (const r of dayPeople) {
      const b = bucketOfDay(r.d)
      const a = peopleAcc.get(b) || { sum: 0, days: 0 }
      a.sum += r.people; a.days += 1
      peopleAcc.set(b, a)
    }
    const peopleOf = (b: string) => {
      const a = peopleAcc.get(b)
      return a && a.days > 0 ? Math.ceil(a.sum / a.days) : 0
    }
    const seriesLabeled = series.map((s) => ({ label: bucketLabel(s.b), value: s.n, people: peopleOf(s.b) }))

    // multi-metric time series (one point per bucket) - powers trend lines & KPI
    // sparklines. Assigned is bucketed on first_assigned_date, the rest on evaluate_date;
    // buckets are the union of both so an assign-only bucket still shows up.
    const asgSeriesBy = new Map<string, number>(assignedSeries.map((r) => [r.b, r.n]))
    const evalSeriesBy = new Map<string, (typeof series)[number]>(series.map((s) => [s.b, s]))
    const allBuckets = Array.from(new Set(Array.from(evalSeriesBy.keys()).concat(Array.from(asgSeriesBy.keys())))).sort()
    const metricSeries = allBuckets.map((b) => {
      const s = evalSeriesBy.get(b)
      const assigned = asgSeriesBy.get(b) || 0
      const evaluated = s?.evaluated || 0
      const shortlisted = s?.shortlisted || 0
      const finalPriority = (s?.priority_iv || 0) + (s?.insight || 0)
      return {
        key: b,
        label: bucketLabel(b),
        volume: s?.n || 0,
        assigned,
        evaluated,
        shortlisted,
        priorityIV: s?.priority_iv || 0,
        insight: s?.insight || 0,
        finalPriority,
        // same-bucket cohort: numerator and denominator both come from the rows
        // evaluated in this bucket (see the note above `evaluators`). Assigned stays
        // as its own line/count - it is intake volume, not a rate denominator.
        signalRate: evaluated > 0 ? finalPriority / evaluated : 0,
        survivalRate: evaluated > 0 ? shortlisted / evaluated : 0,
      }
    })

    // heatmap: person × activity bucket (finer grain than the trend charts)
    const actLabel = (b: string) => {
      const [y, m, d2] = b.split('-').map(Number)
      return actUnit === 'month' ? `${MONTHS[m - 1]} ${y}`
        : actUnit === 'week' ? weekLabel(b).replace(/ \d{4}$/, '')
        : `${d2}/${m}`
    }
    const bucketKeys = Array.from(new Set(actSeries.map((r) => r.b))).sort()
    const heatCells = new Map<string, Record<string, number>>()
    for (const r of actSeries) { const m = heatCells.get(r.k) || {}; m[r.b] = r.n; heatCells.set(r.k, m) }
    const activePeople = evaluators.filter((e) => e.evaluated > 0)
    const periods = bucketKeys.map((b) => ({ key: b, label: actLabel(b) }))
    const heatmap = {
      periods,
      rows: activePeople.map((e) => ({ name: e.name, cells: heatCells.get(e.key) || {} })),
    }

    // Per-period all-rounder score, powering the rank-movement chart. Uses the same
    // configured weights as the window-level score, but only over the axes that mean
    // something inside one bucket: Consistency (active days) is degenerate at day
    // grain and Recording is too sparse to rank on, so both are dropped and the
    // remaining weights re-normalize between themselves.
    // Denominator is the bucket's own evaluated count, matching the window-level
    // rates. Dividing by assigned-in-bucket was badly wrong at day grain: someone who
    // evaluated 200 games on a day they happened to receive no new assignments scored
    // 0 on both quality axes.
    const perPeriodW = { ...rcfg.weights, Consistency: 0, Recording: 0 }
    const scoreCells = new Map<string, Record<string, number>>()
    for (const b of bucketKeys) {
      const rows = actSeries.filter((r) => r.b === b)
      if (!rows.length) continue
      const rate = (num: number, ev: number) => (ev > 0 ? num / ev : 0)
      const maxVol = Math.max(1e-9, ...rows.map((r) => r.n))
      const maxSig = Math.max(1e-9, ...rows.map((r) => rate(r.final_priority, r.evaluated)))
      const maxSur = Math.max(1e-9, ...rows.map((r) => rate(r.shortlisted, r.evaluated)))
      const vols = rows.map((r) => r.n).sort((a, b2) => a - b2)
      const med = vols[Math.floor(vols.length / 2)] || 0
      for (const r of rows) {
        const cred = rcfg.credibility ? (med > 0 ? Math.min(1, r.n / med) : 1) : 1
        const score = allRounderScore({
          Volume: (r.n / maxVol) * 100,
          Signal: (rate(r.final_priority, r.evaluated) / maxSig) * 100,
          Survival: (rate(r.shortlisted, r.evaluated) / maxSur) * 100,
        }, perPeriodW, cred)
        const m = scoreCells.get(r.k) || {}
        m[b] = Math.round(score * 10) / 10
        scoreCells.set(r.k, m)
      }
    }
    const scoreRank = {
      periods,
      rows: activePeople.map((e) => ({ name: e.name, cells: scoreCells.get(e.key) || {} })),
    }

    // per-person activity series: assigned / evaluated / link dead per bucket
    // (assigned is bucketed on assigned_date, the rest on evaluate_date - buckets
    // are the union so an assign-only day still shows)
    type PersonCell = { assigned: number; evaluated: number; linkDead: number }
    const psBy = new Map<string, Map<string, PersonCell>>()
    const psCell = (k: string, b: string): PersonCell => {
      let m = psBy.get(k)
      if (!m) { m = new Map(); psBy.set(k, m) }
      let c = m.get(b)
      if (!c) { c = { assigned: 0, evaluated: 0, linkDead: 0 }; m.set(b, c) }
      return c
    }
    for (const r of evalSeries) { const c = psCell(r.k, r.b); c.evaluated = r.evaluated; c.linkDead = r.link_dead }
    for (const r of evalAsgSeries) { psCell(r.k, r.b).assigned = r.n }
    const personSeries: Record<string, Array<{ key: string; label: string } & PersonCell>> = {}
    for (const [k, m] of Array.from(psBy.entries())) {
      personSeries[k] = Array.from(m.keys()).sort().map((b) => ({ key: b, label: bucketLabel(b), ...m.get(b)! }))
    }

    // options for adaptive dropdown
    const opts: Record<string, string[]> = { week: [], month: [], quarter: [], batch: [] }
    for (const r of optRows) if (opts[r.kind]) opts[r.kind].push(r.v)
    opts.week.sort().reverse()
    opts.month.sort().reverse()
    opts.quarter.sort().reverse()
    opts.batch.sort((a, b) => weekLabelOrder(b) - weekLabelOrder(a))
    // pretty labels for period keys, each with its start–end date range so the
    // picker is unambiguous (e.g. "W1 Aug 2026 · 27/7 – 2/8")
    const dm = (dt: Date) => `${dt.getUTCDate()}/${dt.getUTCMonth() + 1}`
    const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)) // m is 1-based → day 0 of next month
    const weekLabels = opts.week.map((w) => {
      const [y, m, day] = w.split('-').map(Number)
      const start = new Date(Date.UTC(y, m - 1, day))
      const end = new Date(Date.UTC(y, m - 1, day + 6))
      return { key: w, label: `${weekLabel(w)} · ${dm(start)} – ${dm(end)}` }
    })
    const monthLabels = opts.month.map((k) => {
      const [y, m] = k.split('-').map(Number)
      return { key: k, label: `${MONTHS[m - 1]} ${y} · 1/${m} – ${dm(lastDay(y, m))}` }
    })
    const quarterLabels = opts.quarter.map((k) => {
      const [y, q] = k.split('-Q').map(Number)
      const sm = (q - 1) * 3 + 1
      return { key: k, label: `Q${q} ${y} · 1/${sm} – ${dm(lastDay(y, sm + 2))}` }
    })
    const batchLabels = opts.batch.map((k) => ({ key: k, label: k }))

    // recording queue per assignee (only people already in the evaluator list)
    const videos: Record<string, Array<{ gameId: string; title: string | null; os: string | null; slot: string; batch: string | null; recordedOn: string | null; confirmedOn: string | null; youtube: string | null }>> = {}
    for (const v of videoRows) {
      (videos[v.k] ||= []).push({
        gameId: v.game_id, title: v.title, os: v.os, slot: v.slot,
        batch: v.batch, recordedOn: v.recorded_on, confirmedOn: v.confirmed_on, youtube: v.youtube_link,
      })
    }

    // per-person daily conclusion counts, keyed person → day → conclusion → n.
    // Video counts per day are NOT duplicated here - the client derives them from
    // `videos` (recordedOn + slot), which is already the source of truth for the
    // recording queue, so the two panels can never disagree.
    const dailyMix: Record<string, Record<string, Record<string, number>>> = {}
    for (const r of dailyMixRows) {
      const byDay = (dailyMix[r.k] ||= {})
      const day = (byDay[r.d] ||= {})
      day[r.c] = (day[r.c] || 0) + r.n
    }

    // pipeline payload (null on batch view)
    type AgeRow = { key: string; label: string; a0: number; a1: number; a2: number; a3: number }
    let pipeline: null | {
      series: Array<{ key: string; label: string; newGames: number; evaluated: number; backlog: number; people: number }>
      current: { backlog: number; age: { a0: number; a1: number; a2: number; a3: number } }
      window: { newGames: number; evaluated: number }
      aging: AgeRow[]
      cleared: Array<AgeRow & { avgAge: number }>
    } = null
    if (pipelineRaw) {
      const [pipeSeries, backlogNow, agingRows, peopleRows, clearedRows] = pipelineRaw
      const peopleBy = new Map<string, number>(peopleRows.map((r) => [r.b, r.people]))
      const seriesP = pipeSeries.map((r) => ({
        key: r.b, label: bucketLabel(r.b),
        newGames: r.new_games, evaluated: r.evaluated, backlog: r.backlog,
        people: peopleBy.get(r.b) ?? 0,
      }))
      const b0 = backlogNow[0]
      pipeline = {
        series: seriesP,
        current: {
          backlog: b0?.backlog ?? 0,
          age: { a0: b0?.a0 ?? 0, a1: b0?.a1 ?? 0, a2: b0?.a2 ?? 0, a3: b0?.a3 ?? 0 },
        },
        window: {
          newGames: seriesP.reduce((s, r) => s + r.newGames, 0),
          evaluated: seriesP.reduce((s, r) => s + r.evaluated, 0),
        },
        aging: agingRows.map((r) => ({
          key: r.b, label: bucketLabel(r.b), a0: r.a0, a1: r.a1, a2: r.a2, a3: r.a3,
        })),
        cleared: clearedRows.map((r) => ({
          key: r.b, label: bucketLabel(r.b), a0: r.a0, a1: r.a1, a2: r.a2, a3: r.a3,
          avgAge: r.avg_age ?? 0,
        })),
      }
    }

    // Benchmarks are computed here, over the FULL evaluator list, because an
    // evaluator's bundle is stripped of every other row below - the client could not
    // derive them from what it receives.
    const bench = teamBench(evaluators)

    const options = { week: weekLabels, month: monthLabels, quarter: quarterLabels, batch: batchLabels }
    const shell = {
      view, category, title, window: win, bucketUnit: unit, options,
      teamTotals, funnel, bench,
    }

    // An evaluator gets ONLY their own person-level rows. Everything keyed by person
    // is filtered to `selfKey`; the team-wide charts (trend series, heatmap, rank
    // boards, conclusion mixes, pipeline) are emptied rather than filtered, because
    // their tabs are not reachable for this role - see the middleware and the tab
    // gate in ReportView. `config` is replaced with a neutral value: the real one
    // carries the excluded-people list.
    const body = scoped
      ? {
        ...shell,
        empty: !evaluators.some((e) => e.key === selfKey),
        canSeeTeam: false,
        self: selfKey,
        initialConclusions: [], finalConclusions: [],
        series: [], metricSeries: [],
        heatmap: { periods: [], rows: [] },
        scoreRank: { periods: [], rows: [] },
        config: { ...rcfg, excluded: [] },
        personSeries: personSeries[selfKey] ? { [selfKey]: personSeries[selfKey] } : {},
        videos: videos[selfKey] ? { [selfKey]: videos[selfKey] } : {},
        dailyMix: dailyMix[selfKey] ? { [selfKey]: dailyMix[selfKey] } : {},
        evaluators: evaluators.filter((e) => e.key === selfKey),
        radar: radar.filter((r) => r.key === selfKey),
        pipeline: null,
      }
      : {
        ...shell,
        empty: evaluators.length === 0,
        canSeeTeam: true,
        self: null,
        initialConclusions: mergeMap((e) => e.initialConclusions),
        finalConclusions: mergeMap((e) => e.finalConclusions),
        series: seriesLabeled,
        metricSeries,
        heatmap,
        scoreRank,
        config: rcfg,
        personSeries,
        videos,
        dailyMix,
        evaluators, radar,
        pipeline,
      }
    CACHE.set(cacheKey, { at: Date.now(), body })
    return NextResponse.json(body)
  } catch (err) {
    console.error('GET /api/report error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
