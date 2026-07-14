import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// NOTE: The Report tab now reads live from game_evaluations via GET /api/report
// (with an in-memory cache) — that endpoint is the source of truth. This rollup
// route + the report_rollup table remain as an OPTIONAL pre-aggregation for scale
// (wire into cron only if live aggregation ever gets slow); they are not required
// by the current read path.
//
// POST /api/cron/report-rollup — (re)compute the report_rollup table. Weeks are anchored on real timestamps (evaluate_date for the
// evaluation domain, record_confirmed_at for recording), truncated to the Monday
// of the ISO week in Asia/Ho_Chi_Minh.
//
// Freeze model: past weeks are immutable once computed; only the current run's
// target weeks are rebuilt (DELETE + INSERT), so a normal daily/weekly run touches
// just one or two weeks.
//   mode 'current' (default) — rebuild the current + previous ISO week
//   mode 'all'               — full rebuild (admin "Rebuild report" button, run once)
//   week 'YYYY-MM-DD'        — rebuild one specific week (its Monday)
//
// Auth: x-webhook-secret (n8n cron) OR admin session — same idiom as push-evaluations.

const VN = 'Asia/Ho_Chi_Minh'

function hasWebhookSecret(req: NextRequest): boolean {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

export async function POST(req: NextRequest) {
  if (!hasWebhookSecret(req)) {
    const guard = await requireRole(['admin'])
    if (guard) return guard
  }

  let body: { mode?: string; week?: string } = {}
  try { body = await req.json() } catch { /* empty body → defaults */ }

  const mode = body.mode === 'all' || body.mode === 'week' ? body.mode : 'current'
  const week = (body.week || '').trim()
  if (mode === 'week' && !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
    return NextResponse.json({ error: 'week must be YYYY-MM-DD' }, { status: 400 })
  }

  // A predicate over the week-start derived from the given timestamp column.
  const weekOf = (col: ReturnType<typeof sql>) =>
    sql`date_trunc('week', ${col} AT TIME ZONE ${VN})::date`

  const sourcePred = (col: ReturnType<typeof sql>) => {
    if (mode === 'all') return sql`TRUE`
    if (mode === 'week') return sql`${weekOf(col)} = ${week}::date`
    // current: this week + last week
    return sql`${weekOf(col)} >= date_trunc('week', (now() AT TIME ZONE ${VN}) - interval '7 days')::date`
  }

  // Matching DELETE predicate on the already-stored period_week.
  const rowPred = () => {
    if (mode === 'all') return sql`TRUE`
    if (mode === 'week') return sql`period_week = ${week}::date`
    return sql`period_week >= date_trunc('week', (now() AT TIME ZONE ${VN}) - interval '7 days')::date`
  }

  // 'YYYY-Qn' from a DATE column.
  const quarterExpr = (col: ReturnType<typeof sql>) =>
    sql`to_char(${col}, 'YYYY') || '-Q' || EXTRACT(QUARTER FROM ${col})::int`

  try {
    const counts = await sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as typeof sql
      // ---- EVALUATION domain ----
      await tx`DELETE FROM report_rollup WHERE domain = 'evaluation' AND ${rowPred()}`
      const evRows = await tx`
        WITH base AS (
          SELECT
            (ge.evaluate_date AT TIME ZONE ${VN})::date AS ev_date,
            ${weekOf(sql`ge.evaluate_date`)} AS wk,
            lower(ge.initial_evaluator) AS ekey,
            ge.initial_evaluator AS ename,
            ge.category_group AS cat,
            ge.assigned_date AS adate,
            ge.initial_conclusion AS concl
          FROM game_evaluations ge
          WHERE ge.evaluate_date IS NOT NULL
            AND ge.initial_evaluator IS NOT NULL AND ge.initial_evaluator <> ''
            AND ${sourcePred(sql`ge.evaluate_date`)}
        ),
        concl AS (
          SELECT wk, cat, ekey, concl, count(*)::int AS n
          FROM base
          WHERE concl IS NOT NULL AND concl <> '' AND concl <> 'Link_dead'
          GROUP BY wk, cat, ekey, concl
        ),
        concl_agg AS (
          SELECT wk, cat, ekey, jsonb_object_agg(concl, n) AS conclusions
          FROM concl GROUP BY wk, cat, ekey
        ),
        agg AS (
          SELECT wk, cat, ekey,
            mode() WITHIN GROUP (ORDER BY ename) AS ename,
            count(*)::int AS games,
            count(DISTINCT ev_date)::int AS active_days,
            COALESCE(SUM(CASE WHEN adate IS NOT NULL THEN GREATEST(ev_date - adate, 0) END), 0)::numeric AS turnaround_sum,
            count(*) FILTER (WHERE adate IS NOT NULL)::int AS turnaround_count,
            -- "signal_count": games the evaluator escalated rather than bypassed
            -- (List_Idea, Priority*, etc.). Initial evaluators rarely use "Priority"
            -- labels — the real positive signal is anything that isn't a bypass.
            count(*) FILTER (WHERE concl IS NOT NULL AND concl <> '' AND concl <> 'Link_dead' AND concl NOT ILIKE '%bypass%')::int AS priority_count
          FROM base GROUP BY wk, cat, ekey
        )
        INSERT INTO report_rollup
          (period_week, period_month, period_quarter, category_group, domain,
           evaluator, evaluator_key, games, active_days, turnaround_sum,
           turnaround_count, priority_count, conclusions, computed_at)
        SELECT a.wk, to_char(a.wk, 'YYYY-MM'), ${quarterExpr(sql`a.wk`)},
          a.cat, 'evaluation', a.ename, a.ekey, a.games, a.active_days,
          a.turnaround_sum, a.turnaround_count, a.priority_count,
          COALESCE(ca.conclusions, '{}'::jsonb), now()
        FROM agg a LEFT JOIN concl_agg ca USING (wk, cat, ekey)
        RETURNING 1
      `

      // ---- RECORDING domain ----
      // Recorders live in record_5min_assignee / record_20min_assignee (the flat
      // record_assignee column is unused in prod). A game can in principle be
      // recorded in both slots, so we UNION the two — each filled slot is one
      // credited record. Completion is record_confirmed_at; there is no assign-date
      // for recording, so turnaround is left null (0/0). bucket = the slot.
      await tx`DELETE FROM report_rollup WHERE domain = 'recording' AND ${rowPred()}`
      const recRows = await tx`
        WITH base AS (
          SELECT (ge.record_confirmed_at AT TIME ZONE ${VN})::date AS ev_date,
            ${weekOf(sql`ge.record_confirmed_at`)} AS wk,
            lower(ge.record_5min_assignee) AS ekey, ge.record_5min_assignee AS ename,
            ge.category_group AS cat, '5min' AS bucket
          FROM game_evaluations ge
          WHERE ge.record_confirmed_at IS NOT NULL
            AND ge.record_5min_assignee IS NOT NULL AND ge.record_5min_assignee <> ''
            AND ${sourcePred(sql`ge.record_confirmed_at`)}
          UNION ALL
          SELECT (ge.record_confirmed_at AT TIME ZONE ${VN})::date AS ev_date,
            ${weekOf(sql`ge.record_confirmed_at`)} AS wk,
            lower(ge.record_20min_assignee) AS ekey, ge.record_20min_assignee AS ename,
            ge.category_group AS cat, '20min' AS bucket
          FROM game_evaluations ge
          WHERE ge.record_confirmed_at IS NOT NULL
            AND ge.record_20min_assignee IS NOT NULL AND ge.record_20min_assignee <> ''
            AND ${sourcePred(sql`ge.record_confirmed_at`)}
        ),
        buck AS (
          SELECT wk, cat, ekey, bucket, count(*)::int AS n
          FROM base GROUP BY wk, cat, ekey, bucket
        ),
        buck_agg AS (
          SELECT wk, cat, ekey, jsonb_object_agg(bucket, n) AS conclusions
          FROM buck GROUP BY wk, cat, ekey
        ),
        agg AS (
          SELECT wk, cat, ekey,
            mode() WITHIN GROUP (ORDER BY ename) AS ename,
            count(*)::int AS games,
            count(DISTINCT ev_date)::int AS active_days
          FROM base GROUP BY wk, cat, ekey
        )
        INSERT INTO report_rollup
          (period_week, period_month, period_quarter, category_group, domain,
           evaluator, evaluator_key, games, active_days, turnaround_sum,
           turnaround_count, priority_count, conclusions, computed_at)
        SELECT a.wk, to_char(a.wk, 'YYYY-MM'), ${quarterExpr(sql`a.wk`)},
          a.cat, 'recording', a.ename, a.ekey, a.games, a.active_days,
          0, 0, 0, COALESCE(ba.conclusions, '{}'::jsonb), now()
        FROM agg a LEFT JOIN buck_agg ba USING (wk, cat, ekey)
        RETURNING 1
      `

      return { evaluation: evRows.length, recording: recRows.length }
    })

    return NextResponse.json({ ok: true, mode, week: mode === 'week' ? week : undefined, rows: counts })
  } catch (err) {
    console.error('POST /api/cron/report-rollup error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
