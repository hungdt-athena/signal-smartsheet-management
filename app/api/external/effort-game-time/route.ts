import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { SYSTEM_LABEL_KEY_LIST } from '@/lib/system-accounts'
import { PANEL_CAP_S } from '@/lib/evaluation-hours'
import { parseParams, hasValidApiKey, type Person, type RecordRow } from '@/lib/effort-sessions'
import { groupGameTime, type GameTimeRow } from '@/lib/effort-game-time'

export const dynamic = 'force-dynamic'

const VN = 'Asia/Ho_Chi_Minh'

// GET /api/external/effort-game-time?from=YYYY-MM-DD&to=YYYY-MM-DD[&employee_id=abc]
// Header: x-api-key: <EFFORT_TRACKER_API_KEY>
//
// The Effort Tracker's second feed, next to /api/external/effort-sessions (which is
// untouched): for each person and VN day, how many seconds each game was open in the
// Evaluate panel. Same key, same from/to rules (VN days, both ends included, at most 62),
// same scope (every Freelancer, or one person by employee_id) and the same `records`.
//
// - duration_s is "panel time" from evaluation_log (view_s of each panel save, capped at
//   PANEL_CAP_S like the Hours tab), summed per game and day. It is not working time:
//   a game played on a phone while the panel sat idle is not in it, and neither is the
//   5-minute demo credit the Hours tab gives a link added outside the panel.
// - null, not 0, when the only trace of that game that day is a seed row: games judged
//   before 2026-10-11 have one timestamp and no measured seconds.
// - A save is dated by when it happened, so a game revisited on another day is its own
//   entry that day.
// - records: confirmed Record-tab assignments dated by assignment, with how many of each
//   bucket. duration_min is the bucket (5 or 20), not the real video length.
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

    // The game row is joined by evaluation id, not game_id: a game with a row in two genres
    // would otherwise be counted once per row. The id is NULL if the row was deleted
    // (FK ON DELETE SET NULL); the time stays, only the genre is lost.
    const gamesQ = keys.length === 0 ? Promise.resolve([]) : sql<GameTimeRow[]>`
      WITH ev AS (
        SELECT lower(l.actor) AS who, l.created_at, l.game_id, l.game_evaluation_id AS ge_id,
               LEAST(l.view_s, ${PANEL_CAP_S}::int) AS s
        FROM evaluation_log l
        WHERE l.source = 'panel'
          AND l.view_s IS NOT NULL
          AND lower(l.actor) = ANY(${keys})
          AND l.created_at >= (${p.from}::date)::timestamp AT TIME ZONE ${VN}
          AND l.created_at <  (${p.to}::date + 1)::timestamp AT TIME ZONE ${VN}
        UNION ALL
        -- the one trace a game judged before the log has: its verdict time, no seconds
        SELECT lower(l.owner), l.created_at, l.game_id, l.game_evaluation_id, NULL
        FROM evaluation_log l
        WHERE l.source = 'seed'
          AND l.kind = 'first'
          AND lower(l.owner) = ANY(${keys})
          AND l.created_at >= (${p.from}::date)::timestamp AT TIME ZONE ${VN}
          AND l.created_at <  (${p.to}::date + 1)::timestamp AT TIME ZONE ${VN}
      )
      SELECT ev.who AS person_key,
             to_char(ev.created_at AT TIME ZONE ${VN}, 'YYYY-MM-DD') AS date,
             ev.game_id, gi.title AS game, ge.category_group AS genre,
             CASE WHEN count(ev.s) = 0 THEN NULL ELSE sum(ev.s)::int END AS duration_s
      FROM ev
      LEFT JOIN game_info gi ON gi.game_id = ev.game_id
      LEFT JOIN game_evaluations ge ON ge.id = ev.ge_id
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY min(ev.created_at), ev.game_id
    `

    // Same query as effort-sessions' `records`, copied: change both together.
    const recordsQ = keys.length === 0 ? Promise.resolve([]) : sql<RecordRow[]>`
      WITH slot AS (
        SELECT ge.game_id, ge.category_group,
               s.assignee, s.duration_min,
               COALESCE(s.assigned_at, s.confirmed_at) AS assigned_at
        FROM game_evaluations ge
        CROSS JOIN LATERAL (VALUES
          (ge.record_5min_assignee, ge.record_5min_date, 5, ge.record_5min_confirmed_at),
          (ge.record_20min_assignee, ge.record_20min_date, 20, ge.record_20min_confirmed_at)
        ) AS s(assignee, assigned_at, duration_min, confirmed_at)
        WHERE s.confirmed_at IS NOT NULL
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
    const [rows, records] = await Promise.all([gamesQ, recordsQ])

    return NextResponse.json({
      from: p.from, to: p.to, timezone: VN,
      people: groupGameTime(people, rows, records),
    })
  } catch (err) {
    console.error('[effort-game-time]', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
