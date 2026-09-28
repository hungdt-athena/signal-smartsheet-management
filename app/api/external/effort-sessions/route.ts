import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { SYSTEM_LABEL_KEY_LIST } from '@/lib/system-accounts'
import {
  parseParams, hasValidApiKey, groupByPerson,
  type Person, type EventRow, type RecordRow,
} from '@/lib/effort-sessions'

export const dynamic = 'force-dynamic'

const VN = 'Asia/Ho_Chi_Minh'

// GET /api/external/effort-sessions?from=YYYY-MM-DD&to=YYYY-MM-DD[&employee_id=abc]
// Header: x-api-key: <EFFORT_TRACKER_API_KEY>
//
// Read-only feed for the Effort Tracker: every time a person set an initial
// conclusion (with the game and their note) and every game they were assigned to
// record, so a PM can put it beside the effort they declared. Nothing here writes,
// and nothing here sums hours.
//
// - from/to are days in VN time, both ends included, at most 62 days.
// - No employee_id → every Freelancer (dashboard_users.title).
//   With employee_id → that one person, whatever their title.
// - employee_id is the part of the company email before '@'. The person is joined
//   to their evaluations by display name, same convention as the Report.
// - sessions: evaluate_date, the last time the initial conclusion CHANGED. It is
//   not moved by a final conclusion, nor by re-saving an unchanged verdict.
// - records: Record tab assignments, dated by when the game was assigned
//   (record_<n>min_date). Only confirmed ones (record_confirmed_at): a draft is
//   still the admin arranging, the recorder has not been handed it. A change of
//   recorder clears the confirmation, so it drops out until re-confirmed.
//   duration_min is the bucket (5 or 20), not the real video length.
export async function GET(req: NextRequest) {
  if (!hasValidApiKey(req.headers.get('x-api-key'), process.env.EFFORT_TRACKER_API_KEY)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const p = parseParams(req.nextUrl.searchParams)
  if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 })

  try {
    const people = await sql<Person[]>`
      SELECT lower(split_part(email, '@', 1)) AS employee_id, name
      FROM dashboard_users
      WHERE name IS NOT NULL AND name <> ''
        AND lower(name) <> ALL(${SYSTEM_LABEL_KEY_LIST})
        AND ${p.employeeId
          ? sql`lower(split_part(email, '@', 1)) = ${p.employeeId}`
          : sql`lower(title) = 'freelancer'`}
      ORDER BY name
    `
    if (p.employeeId && people.length === 0) {
      return NextResponse.json({ error: `employee_id ${p.employeeId} not found` }, { status: 404 })
    }

    const keys = people.map(x => x.name.toLowerCase())
    const eventsQ = keys.length === 0 ? Promise.resolve([]) : sql<EventRow[]>`
      SELECT lower(ge.initial_evaluator) AS evaluator_key,
             to_char(ge.evaluate_date AT TIME ZONE ${VN}, 'YYYY-MM-DD') AS date,
             to_char(ge.evaluate_date AT TIME ZONE ${VN}, 'HH24:MI:SS') AS time,
             ge.game_id, gi.title AS game, ge.category_group AS genre,
             ge.initial_conclusion AS status, ge.initial_note AS comment
      FROM game_evaluations ge
      LEFT JOIN game_info gi ON gi.game_id = ge.game_id
      WHERE lower(ge.initial_evaluator) = ANY(${keys})
        AND ge.evaluate_date >= (${p.from}::date)::timestamp AT TIME ZONE ${VN}
        AND ge.evaluate_date <  (${p.to}::date + 1)::timestamp AT TIME ZONE ${VN}
      ORDER BY ge.evaluate_date, ge.game_id
    `

    // One row per assigned duration: a game can hold both a 5- and a 20-min slot.
    // A bucket move carries the recorder but not the date, so fall back to the
    // confirmation time rather than dropping the row.
    const recordsQ = keys.length === 0 ? Promise.resolve([]) : sql<RecordRow[]>`
      WITH slot AS (
        SELECT ge.game_id, ge.category_group, ge.record_confirmed_at,
               s.assignee, s.duration_min,
               COALESCE(s.assigned_at, ge.record_confirmed_at) AS assigned_at
        FROM game_evaluations ge
        CROSS JOIN LATERAL (VALUES
          (ge.record_5min_assignee, ge.record_5min_date, 5),
          (ge.record_20min_assignee, ge.record_20min_date, 20)
        ) AS s(assignee, assigned_at, duration_min)
        WHERE ge.record_confirmed_at IS NOT NULL
          AND s.assignee IS NOT NULL
          AND lower(s.assignee) = ANY(${keys})
      )
      SELECT lower(slot.assignee) AS assignee_key,
             to_char(slot.assigned_at AT TIME ZONE ${VN}, 'YYYY-MM-DD') AS date,
             to_char(slot.assigned_at AT TIME ZONE ${VN}, 'HH24:MI:SS') AS time,
             slot.game_id, gi.title AS game, slot.category_group AS genre,
             slot.duration_min
      FROM slot
      LEFT JOIN game_info gi ON gi.game_id = slot.game_id
      WHERE slot.assigned_at >= (${p.from}::date)::timestamp AT TIME ZONE ${VN}
        AND slot.assigned_at <  (${p.to}::date + 1)::timestamp AT TIME ZONE ${VN}
      ORDER BY slot.assigned_at, slot.game_id, slot.duration_min
    `
    const [rows, records] = await Promise.all([eventsQ, recordsQ])

    return NextResponse.json({
      from: p.from, to: p.to, timezone: VN,
      people: groupByPerson(people, rows, records),
    })
  } catch (err) {
    console.error('[effort-sessions]', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
