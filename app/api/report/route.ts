import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { loadBatchSpans } from '@/lib/report-batches'
import { weekLabelOrder } from '@/lib/weekly-feedback'
import { teamBench, weekLabel } from '@/lib/report'
import { SYSTEM_EVALUATOR_KEY_LIST } from '@/lib/system-accounts'
// allRounderScore left the server with the rank-movement bump chart: the only score
// the client still needs is the window-level one, and it computes that itself from
// the radar axes so a weights change re-ranks without a refetch.
import { loadReportConfig } from '@/lib/report-config-db'
import { isManagerRole } from '@/lib/roles'
import { getSession } from '@/lib/session'
import { loadRescueConfig } from '@/lib/rescue-config-db'
import { scanRoster } from '@/lib/rescue-core'
import { classifyRoster } from '@/lib/rescue-rules'

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
type View = 'week' | 'month' | 'quarter' | 'year' | 'batch' | 'custom'

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
  if (view === 'year' && /^\d{4}$/.test(key)) {
    const y = Number(key)
    return { label: `${y}`, from: d(y, 1, 1), to: d(y + 1, 1, 1) }
  }
  if (view === 'quarter' && /^\d{4}-Q[1-4]$/.test(key)) {
    const [y, q] = key.split('-Q').map(Number)
    const sm = (q - 1) * 3 + 1
    const to = q === 4 ? d(y + 1, 1, 1) : d(y, sm + 3, 1)
    return { label: `Q${q} ${y}`, from: d(y, sm, 1), to }
  }
  return { label: 'All time' } // no key → all
}

// The window immediately before this one, on the SAME calendar grain the filter bar
// is set to: the previous week for a week, the previous month for a month. A KPI
// badge that says "vs last month" is answering the question the reader asked; a fixed
// 90-day trailing average answers a different one, and there is no way to tell them
// apart once the number is on screen. The trailing baseline keeps its job on the Team
// health gauges, where it is a threshold rather than a comparison.
//
// Full calendar periods on both sides, deliberately: comparing a part-finished
// September against the last 16 days of August would be "like with like" only in
// length, and nobody reads it that way. Everything read against this is a RATE, so
// the two sides being different lengths costs nothing - and a count never is.
// Null where "the one before" has no meaning: all-time and batch.
function prevWindow(view: View, win: { from?: string; to?: string; batch?: string }, prevBatch?: { from: string; to: string } | null): { from: string; to: string } | null {
  // A batch is a week the team named, and batches tile the calendar, so "the one
  // before" is simply the previous batch - already resolved from the same list.
  if (win.batch) return prevBatch ?? null
  if (!win.from) return null
  const iso = (dt: Date) => dt.toISOString().slice(0, 10)
  const [y, m, day] = win.from.split('-').map(Number)
  // Date.UTC normalises the rollover, so month index -1 is December of the year before
  if (view === 'week') return { from: iso(new Date(Date.UTC(y, m - 1, day - 7))), to: win.from }
  if (view === 'month') return { from: iso(new Date(Date.UTC(y, m - 2, 1))), to: win.from }
  if (view === 'quarter') return { from: iso(new Date(Date.UTC(y, m - 4, 1))), to: win.from }
  if (view === 'year') return { from: iso(new Date(Date.UTC(y - 1, 0, 1))), to: win.from }
  // custom has no grain to step back by, so it uses its own length
  if (!win.to) return null
  const span = Math.max(1, Math.round((Date.parse(win.to) - Date.parse(win.from)) / 864e5))
  return { from: iso(new Date(Date.parse(win.from) - span * 864e5)), to: win.from }
}

export async function GET(req: NextRequest) {
  const guard = await requireRole(['admin', 'moderator', 'evaluator'])
  if (guard) return guard

  try {
    // Evaluators may read this endpoint, but only their OWN performance: the response
    // is rebuilt below with every other person's row removed. Team AGGREGATES stay
    // (the "vs team" benchmark lines and the funnel counts) - user's call: an
    // evaluator should know where they sit against the team, without seeing who is
    // who. Their key is their display name, lowercased, exactly like every other
    // self-scoped route (see quick-stats).
    const session = process.env.SKIP_AUTH === 'true' ? null : await getSession()
    // SKIP_AUTH local dev has no session and gets the full admin view on purpose.
    const scoped = !!session && !isManagerRole(session.user?.role)
    const selfKey = (session?.user?.name || '').toLowerCase()
    if (scoped && !selfKey) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { searchParams } = req.nextUrl
    const view = (['week', 'month', 'quarter', 'year', 'batch', 'custom'].includes(searchParams.get('view') || '')
      ? searchParams.get('view') : 'batch') as View
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

    // Batch is the landing view, and landing on "all batches" would make the first
    // screen anyone sees an all-time scan. Resolving the newest batch HERE rather than
    // letting the client pick one after it has seen the options costs a single cheap
    // lookup instead of a second round-trip for the whole (heavy) bundle - and the app
    // is a continent away from the database, so a round-trip is the expensive unit.
    // `key=all` is the explicit way to ask for every batch.
    let batchKey = key
    if (view === 'batch' && !key) {
      const latest = await sql`
        SELECT batch FROM game_evaluations
        WHERE batch IS NOT NULL AND batch <> ''
          ${category !== 'all' ? sql`AND category_group = ${category}` : sql``}
        GROUP BY batch`
      // The team's batch labels are manual strings ("W2 Jun, 2026"), so "newest" is the
      // label order the rest of the app already sorts them by, never a max() on text.
      batchKey = latest.map((r) => r.batch as string)
        .sort((a, b) => weekLabelOrder(b) - weekLabelOrder(a) || b.localeCompare(a))[0] || ''
    }
    const winBase = resolveWindow(view, view === 'batch' && key === 'all' ? '' : batchKey, from, to)

    /* Resolve the batch label to the days it covers. This rides along with the roster
       query that was already being awaited in this function, so it costs no extra
       round-trip - and after the first request it costs no query at all, see
       `loadBatchSpans`. Once resolved, a batch is an ordinary date window: every query
       below, the charts, the previous period and the baseline all work on it without
       knowing it came from a label. `win.batch` survives only as the thing to print. */
    const rosterPromise = sql`SELECT lower(name) AS k FROM evaluator_roster WHERE list_type = 'initial'`
    // Loaded on every view, not just batch: the dropdown has to list them whatever the
    // reader is currently looking at. Cached, so this is a query once every 5 minutes.
    const batchSpans = await loadBatchSpans()
    const batchAt = batchSpans.findIndex((b) => b.batch === winBase.batch)
    const batchSpan = batchAt >= 0 ? batchSpans[batchAt] : null
    // the list is newest-first, so the batch before this one is the NEXT entry
    const prevBatch = batchAt >= 0 ? batchSpans[batchAt + 1] ?? null : null
    const win = batchSpan ? { ...winBase, from: batchSpan.from, to: batchSpan.to } : winBase

    // WHERE fragments shared by evaluation queries.
    const catF = category !== 'all' ? sql`AND ge.category_group = ${category}` : sql``
    // A VN-local calendar date as a timestamptz boundary.
    //
    // Window predicates used to read `(ge.evaluate_date AT TIME ZONE VN)::date >= X`,
    // which wraps the COLUMN in an expression. That costs two things: no plain index on
    // evaluate_date can ever be used, and -- worse -- the planner loses its statistics
    // and falls back to a guess. Measured on prod: it estimated 282 rows for a month
    // that actually holds 15384, a 55x miss, which is exactly the kind of error that
    // makes it pick a nested loop into game_info (4.8 GB, 19.7% cache hit) and turn a
    // 40 ms query into seconds.
    //
    // Converting the CONSTANT instead of the column is algebraically identical --
    // verified against prod, both forms return the same 15384 rows -- and the estimate
    // lands at 15506. Keep new window predicates in this shape.
    const vnBound = (d: string) => sql`(${d}::timestamp AT TIME ZONE ${VN})`

    // Window: batch view filters by label; date views filter evaluate_date.
    /* One shape for every view: a batch reaches here already carrying the days it
       covers, so nothing filters on the label any anymore - which is what made batch
       view a ~5% cohort instead of a week.

       The fallback matters. A batch from before `BATCH_ERA_START` has no resolvable
       span, and without this branch its window would carry neither dates nor a label:
       an empty predicate, which does not fail - it silently widens to ALL TIME and
       renders a perfectly healthy-looking page of the wrong numbers. Falling back to
       the label keeps those old batches behaving exactly as they did before. */
    /* Every other window predicate in this file runs on a different date column
       (assign date, recording date) but needs the same fallback: an unresolvable batch
       must narrow to its label, never to nothing. `legacyBatch` is that one condition,
       named once so a new query cannot quietly forget it. */
    const legacyBatch: string | null = win.batch && !batchSpan ? win.batch : null
    const winOn = (frag: ReturnType<typeof sql>) => legacyBatch ? sql`AND ge.batch = ${legacyBatch}` : frag

    const winF = legacyBatch
      ? sql`AND ge.batch = ${legacyBatch}`
      : sql`
        ${win.from ? sql`AND ge.evaluate_date >= ${vnBound(win.from)}` : sql``}
        ${win.to ? sql`AND ge.evaluate_date < ${vnBound(win.to)}` : sql``}`

    // Bucket unit for the time series, from the window span.
    const spanDays = win.from && win.to
      ? Math.round((Date.parse(win.to) - Date.parse(win.from)) / 864e5)
      : 400
    const unit = spanDays <= 16 ? 'day' : spanDays <= 130 ? 'week' : 'month'
    // Activity views (heatmap + movement charts) read cadence, so they stay finer
    // than the trend buckets: a week/month/batch window breaks down by DAY, a
    // quarter by WEEK, and only all-time falls back to months.
    const actUnit = spanDays <= 62 ? 'day' : spanDays <= 200 ? 'week' : 'month'

    // Only people currently declared on the Assign roster count in the report -
    // historical/one-off names (tiennh, quangnm…) and system accounts are noise.
    // Falls back to the system-account exclusion if the roster table is empty.
    // Rescue's threshold, fetched alongside the roster because that await already
    // exists. Everything on the Report that says "stale" reads this number, so the
    // tab and the Rescue panel can never point at different games.
    const [rosterRows, rescueCfg] = await Promise.all([
      rosterPromise,
      loadRescueConfig(),
    ])
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
    // Only ever used as a FILTER, so it compares the raw column against VN-local
    // boundaries rather than casting the column to a VN date -- same reason as vnBound
    // above, plus it makes idx_game_evaluations_recorded_at (which indexes exactly this
    // COALESCE) usable instead of dead weight.
    const recAtFrom = (d: string) => sql`AND ${recAt} >= ${vnBound(d)}`
    const recAtTo   = (d: string) => sql`AND ${recAt} < ${vnBound(d)}`

    // "Judged" as every other number on the report counts it. Link_dead and
    // Stale_release are housekeeping, not decisions, and leaving them in made the
    // judged-vs-aged card say 1,845 three tiles from an Evaluated KPI reading 1,842.
    const judged = sql`ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> ''
      AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release')`

    const evalBase = sql`
      FROM game_evaluations ge
      WHERE ge.evaluate_date IS NOT NULL
        AND ge.initial_evaluator IS NOT NULL AND ge.initial_evaluator <> ''
        ${notSystem}
        ${catF} ${winF}`

    /* The waiting stock, right now. Deliberately OUTSIDE `pipelinePromise`: it has no
       window in it at all - no date bound, no batch - so it is the one number on this
       tab that is true whatever the filter bar says. It used to travel inside the
       pipeline bundle, which is null on batch view, so picking a batch (the DEFAULT
       view) made the Backlog KPI and the age bar vanish and took the tab's three
       summary chips with them. Cost of splitting it out: nothing - it is the same
       single count it always was, just not conditioned on a window it never used. */
    const stockPromise = sql`
      SELECT count(*)::int AS backlog,
        count(*) FILTER (WHERE CURRENT_DATE - (ge.imported_at AT TIME ZONE ${VN})::date <= 3)::int AS a0,
        count(*) FILTER (WHERE CURRENT_DATE - (ge.imported_at AT TIME ZONE ${VN})::date BETWEEN 4 AND 7)::int AS a1,
        count(*) FILTER (WHERE CURRENT_DATE - (ge.imported_at AT TIME ZONE ${VN})::date BETWEEN 8 AND 14)::int AS a2,
        count(*) FILTER (WHERE CURRENT_DATE - (ge.imported_at AT TIME ZONE ${VN})::date > 14)::int AS a3
      FROM game_evaluations ge
      WHERE ge.evaluate_date IS NULL AND ge.initial_conclusion IS NULL ${catF}`


    // Pipeline flow (game-level, NOT person-level): games entering the pipeline
    // (imported_at) vs games evaluated (evaluate_date) vs end-of-bucket backlog
    // (pushed but not yet evaluated). System accounts are NOT excluded - their rows
    // are real games flowing through. Backlog is cumulative over ALL history (so it
    // shows true absolute stock), then sliced to the window. Batch view has no time
    // axis → pipeline is null there.
    const pipelinePromise = !win.from ? Promise.resolve(null) : Promise.all([
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
      stockPromise,
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
          count(*) FILTER (WHERE s.snap - r.in_day > 14)::int AS a3,
          -- how long the queue has actually been waiting, in days. The four bands say
          -- how the stock is shaped; these say how long a game sits there, which is the
          -- thing a reader wants and could not get by eyeballing band heights.
          count(*)::int AS waiting,
          percentile_disc(0.5) WITHIN GROUP (ORDER BY (s.snap - r.in_day))::int AS med_age,
          percentile_disc(0.9) WITHIN GROUP (ORDER BY (s.snap - r.in_day))::int AS p90_age,
          max(s.snap - r.in_day)::int AS max_age
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
      // Where the intake came from. `game_info.type` is the scraper/importer that
      // found the game (apkcombo-scraper, appagg-scraper, top-pub-scraper,
      // appranking-scraper - shown as insight-track - sync, manual). Volume alone says nothing, so each source carries its own outcome
      // counts: a source that is 30% of intake and has produced no pick is a push
      // filter to turn off, and no other chart can show that.
      sql`
        SELECT date_trunc(${unit}, (ge.imported_at AT TIME ZONE ${VN}))::date::text AS b,
          COALESCE(NULLIF(btrim(gi.type), ''), 'unknown') AS src,
          count(*)::int AS n,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> ''
                             AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release'))::int AS evaluated,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> ''
                             AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release')
                             AND ge.initial_conclusion NOT ILIKE '%bypass%')::int AS shortlisted,
          count(*) FILTER (WHERE ge.final_conclusion IN ('Priority IV', 'Insight'))::int AS final_priority
        FROM game_evaluations ge
        JOIN game_info gi ON gi.game_id = ge.game_id
        WHERE ge.imported_at IS NOT NULL ${catF}
          ${win.from ? sql`AND ge.imported_at >= ${vnBound(win.from)}` : sql``}
          ${win.to ? sql`AND ge.imported_at < ${vnBound(win.to)}` : sql``}
        GROUP BY 1, 2 ORDER BY 1, 2`,
      // Games that crossed an age boundary during each bucket. The mirror image of
      // `cleared` above: that one counts work finished, this one counts work that only
      // got older, and together they say whether a bucket gained or lost ground.
      //
      // Counting CROSSINGS, not states, is what makes this safe per bucket. A game is
      // judged at most once ever and passes each boundary at most once ever, so no
      // game is counted twice no matter how long it sits - which is exactly the trap in
      // summing per-bucket snapshots, where a game that never moves is counted once a
      // day for a week. The crossing day is knowable from the import date alone:
      // in_day + 4 / + 8 / + 15, and it happened only if the game was still unjudged
      // then. No snapshot join needed, so this is a plain scan.
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
        ), x AS (
          SELECT r.in_day + v.off AS cross_day, v.band
          FROM r, (VALUES (4, 'a1'), (8, 'a2'), (15, 'a3')) AS v(off, band)
          WHERE (r.out_day IS NULL OR r.out_day > r.in_day + v.off)
        )
        SELECT date_trunc(${unit}, cross_day)::date::text AS b, band, count(*)::int AS n
        FROM x
        -- a boundary in the future has not been crossed yet; the current bucket would
        -- otherwise book every game that is merely scheduled to age this week
        WHERE cross_day <= CURRENT_DATE
          ${win.from ? sql`AND cross_day >= ${win.from}::date` : sql``}
          ${win.to ? sql`AND cross_day < ${win.to}::date` : sql``}
        GROUP BY 1, 2 ORDER BY 1, 2`,
    ])

    // What the team normally does, measured on the period immediately BEFORE this
    // window (up to 90 days of it). The health gauges are read against this instead
    // of hardcoded targets: 8% shortlist and 100 games/day were numbers somebody
    // picked once, and a bar can only say "good" or "bad" against a real reference.
    // Needs a window start to have a "before" - all-time and batch views get null.
    const baselineFrom = win.from ? new Date(new Date(`${win.from}T00:00:00Z`).getTime() - 90 * 86400_000).toISOString().slice(0, 10) : null
    // Same shape of aggregate over an arbitrary date range, so the trailing baseline
    // and the previous window are computed by one definition instead of two that can
    // drift apart. Rates only on the reading side - see `baseline` / `prev` below.
    //
    // `self_active_days` reuses the SAME active-day expression as the per-evaluator
    // `active_days` column below (`(ge.evaluate_date AT TIME ZONE VN)::date`, counted
    // DISTINCT) - it is not a second definition, just this one filtered down to a
    // single person. `selfMatchKey` is only ever `selfKey` on a scoped request; on an
    // unscoped one it is a sentinel no lowercase name can equal, so the column comes
    // back 0 for a manager rather than quietly picking their own name.
    //
    // The sentinel has to be a value Postgres will actually ACCEPT as a text
    // parameter: it was briefly `'\u0000'`, which is a valid JS string but not valid
    // Postgres text (NUL is not a legal byte in a Postgres string literal) - every
    // request that reached `refQuery` (any real window: a real batch, a real week or
    // month key) 500'd with "invalid byte sequence for encoding UTF8: 0x00", caught
    // here by Task 11 trying to capture a real payload for anything other than the
    // degenerate all-time/no-key case. `''` is safe: `initial_evaluator <> ''` is
    // already part of every one of these queries' WHERE clause, so the lowercased key
    // this compares against can never legitimately be empty.
    const selfMatchKey = scoped ? selfKey : ''
    const refQuery = (f: string, t: string) => sql`
      SELECT
        count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> ''
                           AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release'))::int AS evaluated,
        count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> ''
                           AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release')
                           AND ge.initial_conclusion NOT ILIKE '%bypass%')::int AS shortlisted,
        count(*) FILTER (WHERE ge.final_conclusion IN ('Priority IV', 'Insight'))::int AS final_priority,
        count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> ''
                           AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release')
                           AND ge.initial_note IS NOT NULL AND btrim(ge.initial_note) <> '')::int AS noted,
        count(DISTINCT (lower(ge.initial_evaluator), (ge.evaluate_date AT TIME ZONE ${VN})::date))::int AS person_days,
        count(DISTINCT CASE WHEN lower(ge.initial_evaluator) = ${selfMatchKey}
                THEN (ge.evaluate_date AT TIME ZONE ${VN})::date END)::int AS self_active_days
      FROM game_evaluations ge
      WHERE ge.evaluate_date IS NOT NULL
        AND ge.initial_evaluator IS NOT NULL AND ge.initial_evaluator <> ''
        ${notSystem} ${catF}
        AND ge.evaluate_date >= ${vnBound(f)}
        AND ge.evaluate_date < ${vnBound(t)}`

    const baselinePromise = win.from ? refQuery(baselineFrom!, win.from) : Promise.resolve(null)
    // The previous week/month/quarter, for the KPI row's comparison badges.
    const prevWin = prevWindow(view, win, prevBatch)
    const prevPromise = prevWin ? refQuery(prevWin.from, prevWin.to) : Promise.resolve(null)

    const [perEval, assignedRows, assignedSeries, teamAssignedRows, initConcl, finConcl, series, dayPeople, actSeries, evalSeries, evalAsgSeries, recorders, optRows, videoRows, dailyMixRows, pipelineRaw, baselineRaw, prevRaw, personClearedRaw, personAgedRaw, backlogByRaw, stockRaw, rescueStats] = await Promise.all([
      // per-evaluator core + funnel. Shortlist = initial not bypassed (List_Idea);
      // Final Priority = moderator judged 'Priority IV' or 'Insight' (user-defined -
      // Priority V intentionally NOT counted).
      sql`
        SELECT lower(ge.initial_evaluator) AS k,
          mode() WITHIN GROUP (ORDER BY ge.initial_evaluator) AS name,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release'))::int AS evaluated,
          count(DISTINCT (ge.evaluate_date AT TIME ZONE ${VN})::date)::int AS active_days,
          COALESCE(SUM(CASE WHEN ge.assigned_date IS NOT NULL THEN GREATEST((ge.evaluate_date AT TIME ZONE ${VN})::date - ge.assigned_date, 0) END), 0)::numeric AS ta_sum,
          count(*) FILTER (WHERE ge.assigned_date IS NOT NULL)::int AS ta_count,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release') AND ge.initial_conclusion NOT ILIKE '%bypass%')::int AS shortlisted,
          count(*) FILTER (WHERE ge.final_conclusion = 'Priority IV')::int AS priority_iv,
          count(*) FILTER (WHERE ge.final_conclusion = 'Insight')::int AS insight,
          count(*) FILTER (WHERE ge.initial_conclusion = 'Link_dead')::int AS link_dead,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release')
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
          ${winOn(sql`
            ${win.from ? sql`AND ge.assigned_date >= ${win.from}::date` : sql``}
            ${win.to ? sql`AND ge.assigned_date < ${win.to}::date` : sql``}`)}
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
          ${winOn(sql`
            ${win.from ? sql`AND ge.first_assigned_date >= ${win.from}::date` : sql``}
            ${win.to ? sql`AND ge.first_assigned_date < ${win.to}::date` : sql``}`)}
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
          ${winOn(sql`
            ${win.from ? sql`AND ge.first_assigned_date >= ${win.from}::date` : sql``}
            ${win.to ? sql`AND ge.first_assigned_date < ${win.to}::date` : sql``}`)}`,
      // per-evaluator initial conclusion distribution
      sql`SELECT lower(ge.initial_evaluator) AS k, ge.initial_conclusion AS c, count(*)::int AS n
        ${evalBase} AND ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release')
        GROUP BY lower(ge.initial_evaluator), ge.initial_conclusion`,
      // per-evaluator final conclusion distribution
      sql`SELECT lower(ge.initial_evaluator) AS k, ge.final_conclusion AS c, count(*)::int AS n
        ${evalBase} AND ge.final_conclusion IS NOT NULL AND ge.final_conclusion <> ''
        GROUP BY lower(ge.initial_evaluator), ge.final_conclusion`,
      // team time series (bucketed) - volume plus funnel metrics for trend/sparklines
      sql`SELECT date_trunc(${unit}, ge.evaluate_date AT TIME ZONE ${VN})::date::text AS b,
          count(*)::int AS n,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release'))::int AS evaluated,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release') AND ge.initial_conclusion NOT ILIKE '%bypass%')::int AS shortlisted,
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
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release'))::int AS evaluated,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release') AND ge.initial_conclusion NOT ILIKE '%bypass%')::int AS shortlisted,
          count(*) FILTER (WHERE ge.final_conclusion IN ('Priority IV', 'Insight'))::int AS final_priority
        ${evalBase}
        GROUP BY 1, 2`,
      // per-evaluator time series (heatmap cells + individual activity chart). The
      // shortlist count rides along for free in a FILTER on a query that already runs:
      // it is what lets Individual draw this person's shortlist rate BUCKET BY BUCKET
      // against the team's, which is the one thing the tab could not say before -
      // every chart on it showed volume over time, so nobody's pick quality had a
      // direction, only a level.
      sql`SELECT lower(ge.initial_evaluator) AS k, date_trunc(${unit}, ge.evaluate_date AT TIME ZONE ${VN})::date::text AS b, count(*)::int AS n,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release'))::int AS evaluated,
          count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release') AND ge.initial_conclusion NOT ILIKE '%bypass%')::int AS shortlisted,
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
          ${winOn(sql`
            ${win.from ? sql`AND ge.assigned_date >= ${win.from}::date` : sql``}
            ${win.to ? sql`AND ge.assigned_date < ${win.to}::date` : sql``}`)}
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
            ${winOn(sql`
              ${win.from ? recAtFrom(win.from) : sql``}
              ${win.to ? recAtTo(win.to) : sql``}`)}
          UNION ALL
          SELECT lower(ge.record_20min_assignee), ge.record_20min_assignee, '20min'
          FROM game_evaluations ge
          WHERE ${recAt} IS NOT NULL AND ge.record_20min_assignee IS NOT NULL AND ge.record_20min_assignee <> ''
            ${recOk('record_20min_assignee')}
            ${catF}
            ${winOn(sql`
              ${win.from ? recAtFrom(win.from) : sql``}
              ${win.to ? recAtTo(win.to) : sql``}`)}
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
        SELECT 'year', to_char(evaluate_date AT TIME ZONE ${VN}, 'YYYY')
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
        WHERE TRUE ${legacyBatch ? sql`AND batch = ${legacyBatch}` : sql`
          AND (rec_at IS NULL OR (TRUE
            ${win.from ? sql`AND rec_at >= ${vnBound(win.from)}` : sql``}
            ${win.to ? sql`AND rec_at < ${vnBound(win.to)}` : sql``}))`}
        ORDER BY rec_at DESC NULLS FIRST, slot`,
      // per-evaluator per-DAY initial conclusion counts (Individual → Daily breakdown).
      // Always day grain, whatever the view's bucket unit is: the point of the
      // breakdown is "what did they do on each calendar day". Link_dead and
      // Stale_release excluded to
      // match every other conclusion-mix number in this file.
      sql`SELECT lower(ge.initial_evaluator) AS k,
          (ge.evaluate_date AT TIME ZONE ${VN})::date::text AS d,
          ge.initial_conclusion AS c, count(*)::int AS n
        ${evalBase} AND ge.initial_conclusion IS NOT NULL AND ge.initial_conclusion <> '' AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release')
        GROUP BY 1, 2, 3`,
      pipelinePromise,
      baselinePromise,
      prevPromise,
      // ---- per-person "judged vs aged", the two halves of one bucket's movement ----
      // The same pair of EVENT counts Overview draws for the team, grouped by the
      // person holding the game. Events, not states: a game is judged at most once and
      // crosses each boundary at most once, so both sides stay addable across buckets -
      // which a snapshot never is, because a game that sits still all week appears in
      // every one of its buckets.
      //
      // The clock is `assigned_date`, NOT `imported_at` the way Overview's version
      // counts. On a per-person chart the question is how long the game sat on THIS
      // desk, and a reassign restamps that date - so the crossings follow the game to
      // its new owner and start again, which is the same rule the backlog card and
      // "Days waiting" already use.
      sql`
        SELECT lower(ge.initial_evaluator) AS k,
          date_trunc(${unit}, (ge.evaluate_date AT TIME ZONE ${VN}))::date::text AS b,
          count(*) FILTER (WHERE ${judged} AND (ge.evaluate_date AT TIME ZONE ${VN})::date - ge.assigned_date <= 3)::int AS a0,
          count(*) FILTER (WHERE ${judged} AND (ge.evaluate_date AT TIME ZONE ${VN})::date - ge.assigned_date BETWEEN 4 AND 7)::int AS a1,
          count(*) FILTER (WHERE ${judged} AND (ge.evaluate_date AT TIME ZONE ${VN})::date - ge.assigned_date BETWEEN 8 AND 14)::int AS a2,
          count(*) FILTER (WHERE ${judged} AND (ge.evaluate_date AT TIME ZONE ${VN})::date - ge.assigned_date > 14)::int AS a3
        ${evalBase} AND ge.assigned_date IS NOT NULL
        GROUP BY 1, 2 ORDER BY 1, 2`,
      // The mirror: games that only got older on this person's desk. A crossing day is
      // knowable from the assign date alone (+4 / +8 / +15) and happened only if the
      // game was still unjudged then, so this needs no snapshot join.
      sql`
        WITH r AS (
          SELECT lower(ge.initial_evaluator) AS k, ge.assigned_date AS in_day,
                 -- Exactly the exit rule the team-level pipeline query uses, and for the
                 -- same two irregular shapes in the data. Reading evaluate_date alone
                 -- left 111 of one evaluator's games ageing forever in September while
                 -- their backlog card correctly showed nothing older than 3 days:
                 --   * the Jun-2026 bulk import carries initial_conclusion and NO
                 --     evaluate_date, so it arrived already judged and exits on arrival;
                 --   * backfilled rows can carry an evaluate_date before the assign
                 --     date, so GREATEST keeps a game from exiting before it arrived.
                 CASE
                   WHEN ge.evaluate_date IS NOT NULL
                     THEN GREATEST(ge.assigned_date, (ge.evaluate_date AT TIME ZONE ${VN})::date)
                   WHEN ge.initial_conclusion IS NOT NULL THEN ge.assigned_date
                   ELSE NULL
                 END AS out_day
          FROM game_evaluations ge
          WHERE ge.assigned_date IS NOT NULL
            AND ge.initial_evaluator IS NOT NULL AND ge.initial_evaluator <> ''
            ${notSystem} ${catF}
        ), x AS (
          SELECT r.k, r.in_day + v.off AS cross_day, v.band
          FROM r, (VALUES (4, 'a1'), (8, 'a2'), (15, 'a3')) AS v(off, band)
          WHERE (r.out_day IS NULL OR r.out_day > r.in_day + v.off)
        )
        SELECT k, date_trunc(${unit}, cross_day)::date::text AS b, band, count(*)::int AS n
        FROM x
        -- a boundary in the future has not been crossed yet, or the open bucket books
        -- every game merely scheduled to age this week
        WHERE cross_day <= CURRENT_DATE
          ${win.from ? sql`AND cross_day >= ${win.from}::date` : sql``}
          ${win.to ? sql`AND cross_day < ${win.to}::date` : sql``}
        GROUP BY 1, 2, 3 ORDER BY 1, 2`,
      // Who the unevaluated queue is currently sitting with. This is a STOCK, not a
      // flow: it is read as of NOW and is never sliced by the window, exactly like
      // Overview's Backlog KPI - and it sums to the same number, because every
      // unevaluated row carries an evaluator and an assigned_date.
      //
      // Age is measured from `assigned_date`, NOT `imported_at` the way Overview's
      // "Backlog by age" is. On a per-person card the question is how long THIS
      // person has been sitting on the game, and a reassign or handover restamps
      // assigned_date, which is the behaviour we want: the new owner's clock starts
      // when they received it. It is also the same clock as the "Days waiting"
      // metric already on this tab. The two tabs therefore agree on the total and
      // can disagree on the band split; the card's tooltip says so.
      sql`
        SELECT lower(ge.initial_evaluator) AS k,
          mode() WITHIN GROUP (ORDER BY ge.initial_evaluator) AS name,
          count(*)::int AS n,
          count(*) FILTER (WHERE CURRENT_DATE - ge.assigned_date <= 3)::int AS a0,
          count(*) FILTER (WHERE CURRENT_DATE - ge.assigned_date BETWEEN 4 AND 7)::int AS a1,
          count(*) FILTER (WHERE CURRENT_DATE - ge.assigned_date BETWEEN 8 AND 14)::int AS a2,
          count(*) FILTER (WHERE CURRENT_DATE - ge.assigned_date > 14)::int AS a3,
          max(CURRENT_DATE - ge.assigned_date)::int AS oldest,
          -- Rescue's own threshold, not the fixed 14-day band above: this is what
          -- selfStale reads, so a contractor's own count matches the Rescue panel.
          count(*) FILTER (WHERE CURRENT_DATE - ge.assigned_date > ${rescueCfg.staleDays})::int AS stale
        FROM game_evaluations ge
        WHERE ge.evaluate_date IS NULL AND ge.initial_conclusion IS NULL
          AND ge.assigned_date IS NOT NULL
          AND ge.initial_evaluator IS NOT NULL AND ge.initial_evaluator <> ''
          ${notSystem} ${catF}
        GROUP BY 1 ORDER BY 3 DESC`,
      stockPromise,
      // The Rescue scan itself. Guarded so an evaluator never pays for a query whose
      // result is thrown away below (rescue is manager-only).
      !scoped ? scanRoster({ category, config: rescueCfg }) : Promise.resolve([]),
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
    // Mirrors `date_trunc(${unit}, day)::date::text` in SQL, so a generated bucket key
    // collides with the one a row produced instead of sitting beside it.
    const bucketStart = (d: Date, u: string): string => {
      const x = new Date(d.getTime())
      if (u === 'month') x.setUTCDate(1)
      else if (u === 'week') {
        // Postgres weeks are ISO: Monday is day 1
        const dow = (x.getUTCDay() + 6) % 7
        x.setUTCDate(x.getUTCDate() - dow)
      }
      return x.toISOString().slice(0, 10)
    }

    const seriesLabeled = series.map((s) => ({ label: bucketLabel(s.b), value: s.n, people: peopleOf(s.b) }))

    // multi-metric time series (one point per bucket) - powers trend lines & KPI
    // sparklines. Assigned is bucketed on first_assigned_date, the rest on evaluate_date;
    // buckets are the union of both so an assign-only bucket still shows up.
    const asgSeriesBy = new Map<string, number>(assignedSeries.map((r) => [r.b, r.n]))
    const evalSeriesBy = new Map<string, (typeof series)[number]>(series.map((s) => [s.b, s]))
    /* Every bucket in the window, not just the ones with rows in them. The union of
       "buckets that have data" skipped any quiet day entirely, so a line drawn from it
       jumped 30/8 -> 7/9 -> 8/9 with equal spacing between unequal gaps: a weekend of
       no work read as a day of no work, and the slope of everything around it was
       wrong. A day nobody judged anything is a real zero and has to occupy its own
       step. Falls back to the old union when the window has no dates (all-time). */
    const bucketsInWindow = (): string[] => {
      if (!win.from || !win.to) return []
      const out: string[] = []
      const end = Date.parse(win.to)
      const d = new Date(win.from + 'T00:00:00Z')
      while (d.getTime() < end) {
        out.push(bucketStart(d, unit))
        // step a whole bucket, then snap: months are not a fixed number of days
        if (unit === 'day') d.setUTCDate(d.getUTCDate() + 1)
        else if (unit === 'week') d.setUTCDate(d.getUTCDate() + 7)
        else d.setUTCMonth(d.getUTCMonth() + 1)
      }
      return Array.from(new Set(out))
    }
    const allBuckets = Array.from(new Set(
      bucketsInWindow()
        .concat(Array.from(evalSeriesBy.keys()))
        .concat(Array.from(asgSeriesBy.keys())),
    )).sort()
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
        // person-days worked in this bucket (Σ over its days of "people active that
        // day"). Lets the client read velocity per bucket - evaluated ÷ personDays -
        // and average it, which is what the Team health benchmarks compare against.
        personDays: peopleAcc.get(b)?.sum || 0,
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

    // A per-period Overall score used to be computed here, one value per person per
    // bucket, to drive a rank-movement bump chart. It was dropped with the chart: two
    // of the five axes had to be zeroed because they are meaningless inside a single
    // day, and ranking a composite score that has lost 40% of its definition, at day
    // grain, across seven crossing lines, was noise with a shape. Biggest movers on
    // the Leaderboard now reads first bucket against last off the heatmap the client
    // already has.

    // per-person activity series: assigned / evaluated / link dead per bucket
    // (assigned is bucketed on assigned_date, the rest on evaluate_date - buckets
    // are the union so an assign-only day still shows)
    type PersonCell = { assigned: number; evaluated: number; shortlisted: number; linkDead: number }
    const psBy = new Map<string, Map<string, PersonCell>>()
    const psCell = (k: string, b: string): PersonCell => {
      let m = psBy.get(k)
      if (!m) { m = new Map(); psBy.set(k, m) }
      let c = m.get(b)
      if (!c) { c = { assigned: 0, evaluated: 0, shortlisted: 0, linkDead: 0 }; m.set(b, c) }
      return c
    }
    for (const r of evalSeries) { const c = psCell(r.k, r.b); c.evaluated = r.evaluated; c.shortlisted = r.shortlisted; c.linkDead = r.link_dead }
    for (const r of evalAsgSeries) { psCell(r.k, r.b).assigned = r.n }
    const personSeries: Record<string, Array<{ key: string; label: string } & PersonCell>> = {}
    for (const [k, m] of Array.from(psBy.entries())) {
      personSeries[k] = Array.from(m.keys()).sort().map((b) => ({ key: b, label: bucketLabel(b), ...m.get(b)! }))
    }

    // options for adaptive dropdown
    const opts: Record<string, string[]> = { week: [], month: [], quarter: [], year: [], batch: [] }
    for (const r of optRows) if (opts[r.kind]) opts[r.kind].push(r.v)
    opts.week.sort().reverse()
    opts.month.sort().reverse()
    opts.quarter.sort().reverse()
    opts.year.sort().reverse()
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
    /* Only batches whose label resolves to a week are offered. The pre-cutoff ones fall
       back to the label predicate and still WORK, but they are the migration leftovers
       whose spans overlap and run backwards - putting them in the dropdown invites a
       reader to compare a 26-day cohort against a 7-day week and call it a trend. The
       Week view covers those dates without the label. */
    const batchSpanBy = new Map(batchSpans.map((b) => [b.batch, b]))
    const batchLabels = opts.batch
      .filter((k) => batchSpanBy.has(k))
      .map((k) => {
        const b = batchSpanBy.get(k)!
        // `to` is exclusive, so the last day shown is the day before it - same as the
        // week labels right above, which the batch names are meant to line up with.
        const last = new Date(Date.parse(b.to) - 864e5)
        return { key: k, label: `${k} · ${dm(new Date(b.from + 'T00:00:00Z'))} – ${dm(last)}` }
      })

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
      // per bucket: the stock's age bands, plus how long that stock had been waiting
      aging: Array<AgeRow & { waiting: number; medAge: number; p90Age: number; maxAge: number }>
      cleared: Array<AgeRow & { avgAge: number }>
      // intake split by importer, per bucket, plus each source's outcome so far
      sources: Array<{ key: string; label: string; parts: Record<string, number> }>
      sourceYield: Array<{ src: string; n: number; evaluated: number; shortlisted: number; finalPriority: number }>
      // games that crossed into an older band during each bucket, by the band they
      // crossed INTO - the mirror of `cleared`, which counts what was finished
      aged: Array<{ key: string; label: string; parts: Record<string, number> }>
    } = null
    if (pipelineRaw) {
      const [pipeSeries, backlogNow, agingRows, peopleRows, clearedRows, sourceRows, agedRows] = pipelineRaw
      const peopleBy = new Map<string, number>(peopleRows.map((r) => [r.b, r.people]))
      const seriesP = pipeSeries.map((r) => ({
        key: r.b, label: bucketLabel(r.b),
        newGames: r.new_games, evaluated: r.evaluated, backlog: r.backlog,
        people: peopleBy.get(r.b) ?? 0,
      }))
      const b0 = backlogNow[0]
      // pivot the source rows two ways: bucket → {source: count} for the stack, and
      // source → window totals for the yield read underneath it
      const srcByBucket = new Map<string, Record<string, number>>()
      const srcTot = new Map<string, { src: string; n: number; evaluated: number; shortlisted: number; finalPriority: number }>()
      for (const r of sourceRows) {
        const parts = srcByBucket.get(r.b) || {}
        parts[r.src] = (parts[r.src] || 0) + r.n
        srcByBucket.set(r.b, parts)
        const t = srcTot.get(r.src) || { src: r.src, n: 0, evaluated: 0, shortlisted: 0, finalPriority: 0 }
        t.n += r.n; t.evaluated += r.evaluated; t.shortlisted += r.shortlisted; t.finalPriority += r.final_priority
        srcTot.set(r.src, t)
      }
      const srcBuckets = Array.from(srcByBucket.keys()).sort()
        .map((b) => ({ key: b, label: bucketLabel(b), parts: srcByBucket.get(b)! }))
      const srcYield = Array.from(srcTot.values()).sort((a, b) => b.n - a.n)
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
          waiting: r.waiting, medAge: r.med_age ?? 0, p90Age: r.p90_age ?? 0, maxAge: r.max_age ?? 0,
        })),
        cleared: clearedRows.map((r) => ({
          key: r.b, label: bucketLabel(r.b), a0: r.a0, a1: r.a1, a2: r.a2, a3: r.a3,
          avgAge: r.avg_age ?? 0,
        })),
        sources: srcBuckets,
        sourceYield: srcYield,
        aged: (() => {
          const by = new Map<string, Record<string, number>>()
          for (const r of agedRows as unknown as Array<{ b: string; band: string; n: number }>) {
            const parts = by.get(r.b) || {}
            parts[r.band] = (parts[r.band] || 0) + r.n
            by.set(r.b, parts)
          }
          return Array.from(by.keys()).sort().map((b) => ({ key: b, label: bucketLabel(b), parts: by.get(b)! }))
        })(),
      }
    }

    // Trailing reference for the health gauges. Rates only - a count would compare a
    // 7-day window against 90 days and read as a collapse every time.
    const b0r = baselineRaw?.[0]
    const baseline = b0r && b0r.evaluated > 0 && baselineFrom
      ? {
        from: baselineFrom, to: win.from!, days: 90,
        evaluated: b0r.evaluated,
        survivalRate: b0r.shortlisted / b0r.evaluated,
        signalRate: b0r.final_priority / b0r.evaluated,
        noteRate: b0r.noted / b0r.evaluated,
        personDayThroughput: b0r.person_days > 0 ? b0r.evaluated / b0r.person_days : 0,
      }
      : null

    // The previous week/month/quarter on the same grain as the filter bar. Rates
    // only, for the same reason as the baseline: the previous period is a different
    // number of days whenever the current one is still running, so a count would be
    // comparing a Tuesday against a full month.
    const p0r = prevRaw?.[0]
    const prev = p0r && p0r.evaluated > 0 && prevWin
      ? {
        from: prevWin.from, to: prevWin.to,
        // what to call it on screen - "last week", "last month", …
        label: view === 'week' ? 'last week' : view === 'month' ? 'last month'
          : view === 'quarter' ? 'last quarter' : view === 'year' ? 'last year' : 'the period before',
        evaluated: p0r.evaluated,
        survivalRate: p0r.shortlisted / p0r.evaluated,
        signalRate: p0r.final_priority / p0r.evaluated,
        personDayThroughput: p0r.person_days > 0 ? p0r.evaluated / p0r.person_days : 0,
        // Only meaningful for one person, so only a scoped (evaluator) request gets it -
        // an admin's `prev` stays exactly the shape it was, per the Bundle type in
        // ReportView.tsx. This is what lets Individual's `rhythm` act fire for a
        // contractor reading their own page.
        ...(scoped ? { activeDays: p0r.self_active_days } : {}),
      }
      : null

    // Per-person "judged vs aged": one row per person per bucket, carrying both halves
    // of that bucket's movement. Buckets are the UNION of the two axes, because a
    // bucket where somebody judged nothing but their queue aged is exactly the bucket
    // the chart exists to show - dropping it would hide the only bad weeks.
    type MoveCell = { cleared: [number, number, number, number]; aged: [number, number, number] }
    const moveBy = new Map<string, Map<string, MoveCell>>()
    const moveCell = (k: string, b: string): MoveCell => {
      let m = moveBy.get(k)
      if (!m) { m = new Map(); moveBy.set(k, m) }
      let c = m.get(b)
      if (!c) { c = { cleared: [0, 0, 0, 0], aged: [0, 0, 0] }; m.set(b, c) }
      return c
    }
    for (const r of personClearedRaw || []) {
      moveCell(r.k, r.b).cleared = [r.a0, r.a1, r.a2, r.a3]
    }
    const AGED_IDX: Record<string, number> = { a1: 0, a2: 1, a3: 2 }
    for (const r of personAgedRaw || []) {
      const i = AGED_IDX[r.band as string]
      if (i != null) moveCell(r.k, r.b).aged[i] = r.n
    }
    const personMoves: Record<string, Array<{ key: string; label: string } & MoveCell>> = {}
    for (const [k, m] of Array.from(moveBy.entries())) {
      personMoves[k] = Array.from(m.keys()).sort().map((b) => ({ key: b, label: bucketLabel(b), ...m.get(b)! }))
    }

    // Per-person backlog stock, largest holder first. Names come from the same
    // `mode()` trick the evaluator rows use, so casing matches the rest of the tab.
    const backlogBy = (backlogByRaw || [])
      .filter((r) => r.n > 0)
      .map((r) => ({
        key: r.k as string, name: (r.name || r.k) as string, n: r.n as number,
        a0: r.a0 as number, a1: r.a1 as number, a2: r.a2 as number, a3: r.a3 as number,
        oldest: (r.oldest ?? 0) as number,
        stale: (r.stale ?? 0) as number,
      }))

    // Benchmarks are computed here, over the FULL evaluator list, because an
    // evaluator's bundle is stripped of every other row below - the client could not
    // derive them from what it receives.
    const bench = teamBench(evaluators)

    // The waiting pile as it stands right now. Always present, on every view: it is the
    // one figure on this tab the window does not reach.
    const s0 = stockRaw?.[0]
    const stock = {
      backlog: s0?.backlog ?? 0,
      age: { a0: s0?.a0 ?? 0, a1: s0?.a1 ?? 0, a2: s0?.a2 ?? 0, a3: s0?.a3 ?? 0 },
    }

    // Top level, NOT inside `pipeline`: the scan reads "right now" and has no window
    // in it at all. `stock` was hoisted out of `pipeline` for exactly this reason on
    // 2026-09-21, and the batch view lost three chips the day it was not.
    const rescueRows = !scoped ? classifyRoster(rescueStats, rescueCfg) : []
    const rescue = !scoped ? {
      staleDays: rescueCfg.staleDays,
      sources: rescueRows.filter((r) => r.role === 'source')
        .map((r) => ({ name: r.name, stale: r.stale, movable: r.movable }))
        .sort((a, b) => b.movable - a.movable),
      receivers: rescueRows.filter((r) => r.role === 'receiver')
        .map((r) => ({ name: r.name, pending: r.pending, evaluatedRecent: r.evaluatedRecent })),
      movableTotal: rescueRows.reduce((s, r) => s + (r.role === 'source' ? r.movable : 0), 0),
    } : null
    // The same number Rescue would show for this person, so a contractor never sees
    // "Backlog" and "Stale" disagree between the Report and the Rescue panel.
    const selfStale = scoped ? (backlogBy.find((b) => b.key === selfKey)?.stale ?? 0) : null

    const yearLabels = opts.year.map((k) => ({ key: k, label: `${k} · 1/1 – 31/12` }))
    const options = { week: weekLabels, month: monthLabels, quarter: quarterLabels, year: yearLabels, batch: batchLabels }
    const shell = {
      // Two grains, and the client needs both by name. `bucketUnit` is the trend
      // charts' x axis; `activityUnit` is the heatmap's, which is deliberately finer.
      // Until now only the first was sent, so the Leaderboard described the heatmap's
      // cells with the trend chart's noun and printed "13 of 13 weeks with nothing
      // evaluated" over a grid of days.
      view, category, title, window: win, bucketUnit: unit, activityUnit: actUnit, options,
      teamTotals, funnel, bench, baseline, prev, stock,
      staleDays: rescueCfg.staleDays,
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
        config: { ...rcfg, excluded: [] },
        personSeries: personSeries[selfKey] ? { [selfKey]: personSeries[selfKey] } : {},
        videos: videos[selfKey] ? { [selfKey]: videos[selfKey] } : {},
        dailyMix: dailyMix[selfKey] ? { [selfKey]: dailyMix[selfKey] } : {},
        evaluators: evaluators.filter((e) => e.key === selfKey),
        radar: radar.filter((r) => r.key === selfKey),
        // their own queue only - Individual shows it, Leaderboard is not reachable
        backlogBy: backlogBy.filter((b) => b.key === selfKey),
        personMoves: personMoves[selfKey] ? { [selfKey]: personMoves[selfKey] } : {},
        pipeline: null,
        rescue: null,
        selfStale,
      }
      : {
        ...shell,
        empty: evaluators.length === 0,
        canSeeTeam: true,
        self: null,
        rescue,
        selfStale: null,
        initialConclusions: mergeMap((e) => e.initialConclusions),
        finalConclusions: mergeMap((e) => e.finalConclusions),
        series: seriesLabeled,
        metricSeries,
        heatmap,
        config: rcfg,
        personSeries,
        videos,
        dailyMix,
        evaluators, radar, backlogBy, personMoves,
        pipeline,
      }
    CACHE.set(cacheKey, { at: Date.now(), body })
    return NextResponse.json(body)
  } catch (err) {
    console.error('GET /api/report error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
