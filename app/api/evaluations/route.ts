import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

const CONCLUSION_OPTIONS = [
  'Bypass', 'Conclusion', 'Good', 'Link_dead', 'M_ByPass', 'Need deeper testing', 'Skip',
  'Wait for PlayTest', 'Priority IV: Idea', 'Priority III: Watchlist for next phase',
  'Check Market Data', 'Watchlist for next milestone', 'Priority II', 'Priority I',
  'Need Direction', 'List_Idea',
]

export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const { searchParams } = req.nextUrl
    const category = searchParams.get('category') || 'puzzle'
    const evaluator = searchParams.get('evaluator') || ''
    const conclusion = searchParams.get('conclusion') || ''
    const conclusions = searchParams.get('conclusions') || ''
    const status = searchParams.get('status') || ''
    const assignmentStatus = searchParams.get('assignment_status') || ''
    const hasRecording = searchParams.get('has_recording') || ''
    const recorder = searchParams.get('recorder') || ''
    const monthParam = searchParams.get('month') || ''
    const autoMonth = monthParam === 'auto'
    const year = parseInt(searchParams.get('year') || '0')
    const month = autoMonth ? 0 : parseInt(monthParam || '0')
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
    const limit = Math.min(500, Math.max(10, parseInt(searchParams.get('limit') || '200')))
    const offset = (page - 1) * limit
    const wantMeta = page === 1

    const statusFilter = status === 'pending'
      ? sql`AND ge.initial_conclusion IS NULL`
      : status === 'done'
        ? sql`AND ge.initial_conclusion IS NOT NULL`
        : sql``

    const evaluatorFilter = evaluator ? sql`AND ge.initial_evaluator = ${evaluator}` : sql``

    const conclusionFilter = conclusions
      ? sql`AND ge.initial_conclusion IN ${sql(conclusions.split(',').map(c => c.trim()).filter(Boolean))}`
      : conclusion
        ? sql`AND ge.initial_conclusion = ${conclusion}`
        : sql``

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
            EXTRACT(YEAR FROM ge.assigned_date)::int AS year,
            EXTRACT(MONTH FROM ge.assigned_date)::int AS month
          FROM game_evaluations ge
          WHERE ge.category_group = ${category}
            AND ge.assigned_date IS NOT NULL
            ${evaluatorFilter}
          ORDER BY year DESC, month DESC
        `
      : []

    // month=auto → current month (Asia/Ho_Chi_Minh) if it has data, else latest with data.
    let applied: { year: number; month: number } | null = null
    if (autoMonth) {
      const nowVN = new Date(Date.now() + 7 * 3600 * 1000)
      const curY = nowVN.getUTCFullYear()
      const curM = nowVN.getUTCMonth() + 1
      if (availableMonths.some(m => m.year === curY && m.month === curM)) {
        applied = { year: curY, month: curM }
      } else if (availableMonths.length > 0) {
        applied = { year: availableMonths[0].year, month: availableMonths[0].month }
      }
    } else if (year > 0 && month > 0) {
      applied = { year, month }
    }

    const monthFilter = applied
      ? sql`AND ge.assigned_date >= make_date(${applied.year}, ${applied.month}, 1)
            AND ge.assigned_date < make_date(${applied.year}, ${applied.month}, 1) + interval '1 month'`
      : sql``

    const [rows, statsRows, distinctConclusions] = await Promise.all([
      sql`
        SELECT ge.id, ge.game_id, ge.category_group, ge.genre_1, ge.genre_2,
          ge.initial_evaluator, ge.final_evaluator, ge.assigned_date,
          ge.evaluate_date, ge.initial_note, ge.initial_conclusion,
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
          ${evaluatorFilter}
          ${conclusionFilter}
          ${statusFilter}
          ${monthFilter}
          ${assignmentFilter}
          ${recordingFilter}
          ${recorderFilter}
        ORDER BY ge.assigned_date DESC, ge.imported_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      wantMeta
        ? sql`
            SELECT count(*)::int AS total,
              count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL)::int AS evaluated,
              count(*) FILTER (WHERE ge.initial_conclusion = 'Link_dead')::int AS dead_links
            FROM game_evaluations ge
            WHERE ge.category_group = ${category}
              ${evaluatorFilter}
              ${conclusionFilter}
              ${statusFilter}
              ${monthFilter}
              ${assignmentFilter}
              ${recordingFilter}
              ${recorderFilter}
          `
        : Promise.resolve([]),
      wantMeta
        ? sql`
            SELECT DISTINCT ge.initial_conclusion AS c
            FROM game_evaluations ge
            WHERE ge.category_group = ${category}
              AND ge.initial_conclusion IS NOT NULL
              ${evaluatorFilter}
              ${monthFilter}
          `
        : Promise.resolve([]),
    ])

    const body: Record<string, unknown> = { data: rows, page, limit }

    if (wantMeta) {
      const s = statsRows[0] || { total: 0, evaluated: 0, dead_links: 0 }
      body.total = s.total
      body.stats = {
        total: s.total,
        evaluated: s.evaluated,
        pending: s.total - s.evaluated,
        dead_links: s.dead_links,
      }
      body.applied_month = applied
      body.available_months = availableMonths
      body.conclusion_options = CONCLUSION_OPTIONS
      const present: string[] = distinctConclusions.map(r => r.c)
      body.available_conclusions = CONCLUSION_OPTIONS.filter(c => present.includes(c))
        .concat(present.filter(c => !CONCLUSION_OPTIONS.includes(c)).sort())
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
      id, initial_note, initial_conclusion, drive_link, youtube_link,
      record_5min_assignee, record_20min_assignee,
      record_5min_drive, record_20min_drive,
    } = body

    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    if (initial_conclusion && !CONCLUSION_OPTIONS.includes(initial_conclusion)) {
      return NextResponse.json({ error: 'Invalid conclusion' }, { status: 400 })
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
        const editsContent = initial_note !== undefined || initial_conclusion !== undefined
          || drive_link !== undefined || youtube_link !== undefined
        if (editsContent && row.initial_evaluator !== me) {
          return NextResponse.json({ error: 'Forbidden: not your evaluation' }, { status: 403 })
        }
        if (record_5min_drive !== undefined && row.record_5min_assignee !== me) {
          return NextResponse.json({ error: 'Forbidden: not your recording' }, { status: 403 })
        }
        if (record_20min_drive !== undefined && row.record_20min_assignee !== me) {
          return NextResponse.json({ error: 'Forbidden: not your recording' }, { status: 403 })
        }
        // Reassigning recorders is a manager action — use /api/evaluations/assign-records.
        if (record_5min_assignee !== undefined || record_20min_assignee !== undefined) {
          return NextResponse.json({ error: 'Forbidden: cannot reassign here' }, { status: 403 })
        }
      }
    }

    const result = await sql`
      UPDATE game_evaluations SET
        initial_note = COALESCE(${initial_note ?? null}, initial_note),
        initial_conclusion = COALESCE(${initial_conclusion ?? null}, initial_conclusion),
        evaluate_date = ${initial_conclusion ? new Date().toISOString() : null}::timestamptz,
        drive_link = COALESCE(${drive_link ?? null}, drive_link),
        drive_date = CASE WHEN ${drive_link ?? null}::text IS NOT NULL THEN NOW() ELSE drive_date END,
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
