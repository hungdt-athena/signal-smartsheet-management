import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import { getConfigValues } from '@/lib/config'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const { searchParams } = req.nextUrl
    const category = searchParams.get('category') || 'puzzle'
    const evaluator = searchParams.get('evaluator') || ''
    const conclusion = searchParams.get('conclusion') || ''
    const conclusions = searchParams.get('conclusions') || ''
    const batch = searchParams.get('batch') || ''
    const status = searchParams.get('status') || ''
    const assignmentStatus = searchParams.get('assignment_status') || ''
    const hasRecording = searchParams.get('has_recording') || ''
    const recorder = searchParams.get('recorder') || ''
    const monthParam = searchParams.get('month') || ''
    const autoMonth = monthParam === 'auto'
    const year = parseInt(searchParams.get('year') || '0')
    const month = autoMonth ? 0 : parseInt(monthParam || '0')
    const day = parseInt(searchParams.get('day') || '0')
    // New canonical date params (YYYY-MM-DD, inclusive). year/month/day kept as a
    // fallback so any caller not yet migrated to from/to keeps working.
    const from = searchParams.get('from') || ''
    const to = searchParams.get('to') || ''
    const sortParam = searchParams.get('sort') === 'asc' ? 'asc' : 'desc'
    const page = Math.max(1, parseInt(searchParams.get('page') || '1') || 1)
    const limit = Math.min(500, Math.max(10, parseInt(searchParams.get('limit') || '200') || 200))
    const offset = (page - 1) * limit
    const wantMeta = page === 1

    // The month picker filters on different dates per view: the standard
    // evaluators tab tracks when work was assigned (assigned_date); Short List
    // tracks when games were evaluated/decided (evaluate_date), falling back to
    // updated_at for rows synced without an eval date. Short List sends
    // date_basis=evaluated. Columns are synced from Smartsheet.
    const dateBasis = searchParams.get('date_basis') === 'evaluated' ? 'evaluated' : 'assigned'
    const pickerDate = dateBasis === 'evaluated'
      ? sql`COALESCE(ge.evaluate_date, ge.updated_at)`
      : sql`ge.assigned_date`

    const statusFilter = status === 'pending'
      ? sql`AND ge.initial_conclusion IS NULL`
      : status === 'done'
        ? sql`AND ge.initial_conclusion IS NOT NULL`
        : sql``

    // Case-insensitive: sheet data has casing drift (Huydd vs HuyDD) — match all variants.
    const evaluatorFilter = evaluator ? sql`AND lower(ge.initial_evaluator) = lower(${evaluator})` : sql``

    const conclusionList = conclusions.split(',').map(c => c.trim()).filter(Boolean)
    const conclusionFilter = conclusionList.length > 0
      ? sql`AND ge.initial_conclusion IN ${sql(conclusionList)}`
      : conclusion
        ? sql`AND ge.initial_conclusion = ${conclusion}`
        : sql``

    const batchFilter = batch ? sql`AND ge.batch = ${batch}` : sql``

    const assignmentFilter = assignmentStatus === 'unassigned'
      ? sql`AND ge.record_5min_assignee IS NULL AND ge.record_20min_assignee IS NULL`
      : assignmentStatus === 'assigned'
        ? sql`AND (ge.record_5min_assignee IS NOT NULL OR ge.record_20min_assignee IS NOT NULL)`
        : sql``

    const recordingFilter = hasRecording === 'true'
      ? sql`AND (ge.record_5min_assignee IS NOT NULL OR ge.record_20min_assignee IS NOT NULL)`
      : sql``

    const recorderFilter = recorder
      ? sql`AND (ge.record_5min_assignee = ${recorder} OR ge.record_20min_assignee = ${recorder})`
      : sql``

    // Months with data — needed for the picker (page 1) and to resolve month=auto.
    const availableMonths = (wantMeta || autoMonth)
      ? await sql`
          SELECT DISTINCT
            EXTRACT(YEAR FROM ${pickerDate})::int AS year,
            EXTRACT(MONTH FROM ${pickerDate})::int AS month
          FROM game_evaluations ge
          WHERE ge.category_group = ${category}
            AND ${pickerDate} IS NOT NULL
            ${evaluatorFilter}
          ORDER BY year DESC, month DESC
        `
      : []

    // Resolve the active inclusive date range [rangeFrom, rangeTo] (YYYY-MM-DD).
    // Priority: explicit from/to → year/month(/day) → month=auto. appliedMonth is
    // echoed back (applied_month) so the client can lock in the auto-resolved month.
    const pad = (n: number) => String(n).padStart(2, '0')
    const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
    const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate()

    let rangeFrom: string | null = null
    let rangeTo: string | null = null
    let appliedMonth: { year: number; month: number } | null = null

    if (from && to) {
      rangeFrom = from
      rangeTo = to
    } else if (year > 0 && month > 0 && day > 0) {
      rangeFrom = rangeTo = isoDate(year, month, day)
    } else if (year > 0 && month > 0) {
      appliedMonth = { year, month }
      rangeFrom = isoDate(year, month, 1)
      rangeTo = isoDate(year, month, lastDay(year, month))
    } else if (autoMonth) {
      const nowVN = new Date(Date.now() + 7 * 3600 * 1000)
      const curY = nowVN.getUTCFullYear()
      const curM = nowVN.getUTCMonth() + 1
      if (availableMonths.some(m => m.year === curY && m.month === curM)) {
        appliedMonth = { year: curY, month: curM }
      } else if (availableMonths.length > 0) {
        appliedMonth = { year: availableMonths[0].year, month: availableMonths[0].month }
      }
      if (appliedMonth) {
        rangeFrom = isoDate(appliedMonth.year, appliedMonth.month, 1)
        rangeTo = isoDate(appliedMonth.year, appliedMonth.month, lastDay(appliedMonth.year, appliedMonth.month))
      }
    }

    // One range filter on pickerDate covers day / month / custom-range alike.
    const rangeFilter = rangeFrom && rangeTo
      ? sql`AND ${pickerDate} >= ${rangeFrom}::date
            AND ${pickerDate} < ${rangeTo}::date + interval '1 day'`
      : sql``

    // Shared by the list and stats queries — they must stay in lockstep.
    const listFilters = sql`
      ${evaluatorFilter}
      ${conclusionFilter}
      ${statusFilter}
      ${rangeFilter}
      ${batchFilter}
      ${assignmentFilter}
      ${recordingFilter}
      ${recorderFilter}
    `

    const [rows, statsRows, distinctConclusions, distinctEvaluators] = await Promise.all([
      sql`
        SELECT ge.id, ge.game_id, ge.category_group, ge.genre_1, ge.genre_2,
          ge.initial_evaluator, ge.final_evaluator, ge.assigned_date,
          ge.evaluate_date, ge.initial_note, ge.initial_conclusion, ge.final_conclusion, ge.batch,
          ge.record_assignee, ge.record_assign_date,
          ge.record_5min_assignee, ge.record_5min_date,
          ge.record_5min_drive, ge.record_5min_drive_date,
          ge.record_20min_assignee, ge.record_20min_date,
          ge.record_20min_drive, ge.record_20min_drive_date,
          ge.drive_link, ge.drive_date, ge.youtube_link,
          ge.imported_at, ge.updated_at,
          gi.title, gi.os, gi.app_link, gi.icon_url,
          COALESCE(gi.initial_release, gi.temp_release)::text AS release_date,
          COALESCE(dev.developer_name, dev.dev_company) AS publisher_name
        FROM game_evaluations ge
        JOIN game_info gi ON ge.game_id = gi.game_id
        LEFT JOIN developer dev ON gi.publisher_id = dev.id
        WHERE ge.category_group = ${category}
          ${listFilters}
        ${sortParam === 'asc'
          ? sql`ORDER BY ${pickerDate} ASC, ge.imported_at ASC`
          : sql`ORDER BY ${pickerDate} DESC, ge.imported_at DESC`}
        LIMIT ${limit} OFFSET ${offset}
      `,
      wantMeta
        ? sql`
            SELECT count(*)::int AS total,
              count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL)::int AS evaluated
            FROM game_evaluations ge
            WHERE ge.category_group = ${category}
              ${listFilters}
          `
        : Promise.resolve([]),
      wantMeta
        ? sql`
            SELECT DISTINCT ge.initial_conclusion AS c
            FROM game_evaluations ge
            WHERE ge.category_group = ${category}
              AND ge.initial_conclusion IS NOT NULL
              ${evaluatorFilter}
              ${rangeFilter}
          `
        : Promise.resolve([]),
      // Full evaluator list for the category — deliberately ignores month and
      // pagination so the filter dropdown shows everyone, not just whoever
      // happens to be in the currently loaded rows. Grouped case-insensitively
      // (sheet data has Huydd vs HuyDD drift); the dominant casing wins.
      wantMeta
        ? sql`
            SELECT mode() WITHIN GROUP (ORDER BY ge.initial_evaluator) AS e
            FROM game_evaluations ge
            WHERE ge.category_group = ${category}
              AND ge.initial_evaluator IS NOT NULL
            GROUP BY lower(ge.initial_evaluator)
            ORDER BY 1
          `
        : Promise.resolve([]),
    ])

    const body: Record<string, unknown> = { data: rows, page, limit }

    if (wantMeta) {
      const s = statsRows[0] || { total: 0, evaluated: 0 }
      body.total = s.total
      body.stats = {
        total: s.total,
        evaluated: s.evaluated,
        pending: s.total - s.evaluated,
      }
      body.applied_month = appliedMonth
      body.available_months = availableMonths
      const conclusionOptions = await getConfigValues('conclusion')
      body.conclusion_options = conclusionOptions
      body.available_evaluators = distinctEvaluators.map(r => r.e)
      const present: string[] = distinctConclusions.map(r => r.c)
      body.available_conclusions = conclusionOptions.filter(c => present.includes(c))
        .concat(present.filter(c => !conclusionOptions.includes(c)).sort())
      const cfg = await sql`SELECT value FROM app_config WHERE key = ${`current_batch:${category}`}`
      body.current_batch = cfg[0]?.value ?? null
    }

    return NextResponse.json(body)
  } catch (err) {
    console.error('GET /api/evaluations error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const body = await req.json()
    const {
      id, initial_note, initial_conclusion, final_conclusion, batch, drive_link, youtube_link,
      record_5min_assignee, record_20min_assignee,
      record_5min_drive, record_20min_drive,
    } = body

    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    if (initial_conclusion) {
      const opts = await getConfigValues('conclusion')
      if (!opts.includes(initial_conclusion)) {
        return NextResponse.json({ error: 'Invalid conclusion' }, { status: 400 })
      }
    }
    if (final_conclusion) {
      const opts = await getConfigValues('final_conclusion')
      if (!opts.includes(final_conclusion)) {
        return NextResponse.json({ error: 'Invalid final conclusion' }, { status: 400 })
      }
    }

    // Ownership enforcement: non-admins may only edit content/recordings of games
    // assigned to them. Admins have full access.
    if (process.env.SKIP_AUTH !== 'true') {
      const session = await getServerSession(authOptions)
      const role = session?.user?.role
      const me = session?.user?.name
      const isManager = role === 'admin' || role === 'moderator'
      if (!isManager) {
        const owned = await sql`
          SELECT initial_evaluator, record_5min_assignee, record_20min_assignee
          FROM game_evaluations WHERE id = ${id}
        `
        if (owned.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
        const row = owned[0]
        // drive_link (demo video) is intentionally NOT ownership-gated: the Short
        // List view is only delivered to the right people, so anyone who can see a
        // row may attach/import its demo video. Note/conclusion/batch stay gated.
        const editsContent = initial_note !== undefined || initial_conclusion !== undefined
          || youtube_link !== undefined || batch !== undefined
        // Case-insensitive: imported sheet names have casing drift (Huydd vs HuyDD).
        const same = (a: string | null, b: string | null | undefined) =>
          !!a && !!b && a.toLowerCase() === b.toLowerCase()
        if (editsContent && !same(row.initial_evaluator, me)) {
          return NextResponse.json({ error: 'Forbidden: not your evaluation' }, { status: 403 })
        }
        if (record_5min_drive !== undefined && !same(row.record_5min_assignee, me)) {
          return NextResponse.json({ error: 'Forbidden: not your recording' }, { status: 403 })
        }
        if (record_20min_drive !== undefined && !same(row.record_20min_assignee, me)) {
          return NextResponse.json({ error: 'Forbidden: not your recording' }, { status: 403 })
        }
        // Reassigning recorders is a manager action — use /api/evaluations/assign-records.
        if (record_5min_assignee !== undefined || record_20min_assignee !== undefined) {
          return NextResponse.json({ error: 'Forbidden: cannot reassign here' }, { status: 403 })
        }
        if (final_conclusion !== undefined) {
          return NextResponse.json({ error: 'Forbidden: final conclusion requires manager role' }, { status: 403 })
        }
      }
    }

    // Clearable eval fields use a "provided-flag" pattern instead of COALESCE so
    // an explicit empty value clears the column to NULL (COALESCE can only keep or
    // set non-null). A field absent from the body is left untouched; a field sent
    // as '' / null is cleared. Date stamps only advance for real (non-null) values.
    const provided = (k: string) => Object.prototype.hasOwnProperty.call(body, k)
    const clean = (v: unknown): string | null => (v === '' || v === null || v === undefined ? null : String(v))
    const noteProvided = provided('initial_note'), noteVal = clean(initial_note)
    const concProvided = provided('initial_conclusion'), concVal = clean(initial_conclusion)
    const dlProvided = provided('drive_link'), dlVal = clean(drive_link)

    const result = await sql`
      UPDATE game_evaluations SET
        initial_note = CASE WHEN ${noteProvided} THEN ${noteVal} ELSE initial_note END,
        initial_conclusion = CASE WHEN ${concProvided} THEN ${concVal} ELSE initial_conclusion END,
        evaluate_date = CASE
          WHEN ${concProvided} AND ${concVal}::text IS NOT NULL THEN NOW()
          WHEN ${concProvided} AND ${concVal}::text IS NULL THEN NULL
          ELSE evaluate_date END,
        final_conclusion = COALESCE(${final_conclusion ?? null}, final_conclusion),
        batch = COALESCE(${batch ?? null}, batch),
        drive_link = CASE WHEN ${dlProvided} THEN ${dlVal} ELSE drive_link END,
        drive_date = CASE
          WHEN ${dlProvided} AND ${dlVal}::text IS NOT NULL THEN NOW()
          WHEN ${dlProvided} AND ${dlVal}::text IS NULL THEN NULL
          ELSE drive_date END,
        youtube_link = COALESCE(${youtube_link ?? null}, youtube_link),
        record_5min_assignee = COALESCE(${record_5min_assignee ?? null}, record_5min_assignee),
        record_5min_date = CASE WHEN ${record_5min_assignee ?? null}::text IS NOT NULL AND record_5min_assignee IS NULL THEN NOW() ELSE record_5min_date END,
        record_5min_drive = COALESCE(${record_5min_drive ?? null}, record_5min_drive),
        record_5min_drive_date = CASE WHEN ${record_5min_drive ?? null}::text IS NOT NULL THEN NOW() ELSE record_5min_drive_date END,
        record_20min_assignee = COALESCE(${record_20min_assignee ?? null}, record_20min_assignee),
        record_20min_date = CASE WHEN ${record_20min_assignee ?? null}::text IS NOT NULL AND record_20min_assignee IS NULL THEN NOW() ELSE record_20min_date END,
        record_20min_drive = COALESCE(${record_20min_drive ?? null}, record_20min_drive),
        record_20min_drive_date = CASE WHEN ${record_20min_drive ?? null}::text IS NOT NULL THEN NOW() ELSE record_20min_drive_date END
      WHERE id = ${id}
      RETURNING *
    `

    if (result.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json({ data: result[0] })
  } catch (err) {
    console.error('PATCH /api/evaluations error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
