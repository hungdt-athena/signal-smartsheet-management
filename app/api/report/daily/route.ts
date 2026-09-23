import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { getSession } from '@/lib/session'
import { isManagerRole } from '@/lib/roles'
import { loadReportConfig } from '@/lib/report-config-db'
import { SYSTEM_EVALUATOR_KEY_LIST } from '@/lib/system-accounts'
import { BUCKETS } from '@/lib/buckets'

export const dynamic = 'force-dynamic'

// GET /api/report/daily - ONE day's evaluation work per person per bucket, plus the
// index of which days in the range have any work at all.
//
// This is the table the 18:00 Google Chat card prints (workflows/daily-eval-noti.json),
// brought into the Report as a block at the top of the Leaderboard. It answers a
// question the rest of that tab does not:
//
//   Leaderboard - where do people differ from each other? Rates, ranks, calibration,
//                 over a window long enough for those to mean anything.
//   Daily       - did yesterday's work happen? Raw counts, no rate, no rank, no score.
//
// One day is far too noisy to judge calibration on, which is why this prints counts
// and the Leaderboard prints percentages. If this route ever starts returning a rate
// or an ordering-by-quality, it has taken the Leaderboard's job.
//
// Two answers in one round trip, because they are independent:
//   `index` - every day in the range that has work, with its total. Drives the strip
//             of day buttons, and is skipped with index=0 when only the day changed.
//   `day`   - the tables for one day: the day asked for, or the most recent one with
//             work when none is (rank 1 over the range), so the first paint never
//             costs a second request to find out which day to show.
//
// Two things it does NOT inherit from the chat card, both on purpose:
//   - `total` counts JUDGED rows only. The card counts Link_dead into its total and
//     says so in a footnote; every other number in this Report excludes Link_dead and
//     Stale_release as housekeeping rather than decisions (see `judged` in
//     app/api/report/route.ts). Two different totals for one person on one screen is
//     the exact class of bug the Report's redesign was written to stop, so the Report's
//     rule wins here and the housekeeping counts are returned separately, to be printed
//     as "not counted".
//   - People excluded in Config, and the system accounts, are left out - the same
//     roster every other Report number is built from.
//
// Params: from,to=YYYY-MM-DD (inclusive, the page's own period), day=YYYY-MM-DD,
//         category=all|puzzle|arcade|simulation (the page's own Category filter -
//         the block sits on the Leaderboard and must not contradict the filter bar
//         above it), index=0 to skip the day list.
// Manager-only: it is a whole-team table, like the Leaderboard.

const VN = 'Asia/Ho_Chi_Minh'
// What to look back over when the caller has no period at all (the "All batches"
// view). Unbounded would be a full scan of evaluate_date for a block that only ever
// shows one day.
const DEFAULT_SPAN_DAYS = 30

export interface DailyRow {
  name: string
  total: number
  idea: number
  pbp: number
  bypass: number
  other: number
  tagRows: number
  tagged: number
}
export interface DailyBucket {
  bucket: string
  evaluators: number
  total: number
  linkDead: number
  staleRelease: number
  rows: DailyRow[]
}
export interface DailyDay {
  date: string
  total: number
  buckets: DailyBucket[]
}
export interface DailyIndexEntry { date: string; total: number }

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export async function GET(req: NextRequest) {
  try {
    const session = process.env.SKIP_AUTH === 'true' ? null : await getSession()
    if (session && !isManagerRole(session.user?.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { searchParams } = req.nextUrl
    const rawFrom = (searchParams.get('from') || '').trim()
    const rawTo = (searchParams.get('to') || '').trim()
    const rawDay = (searchParams.get('day') || '').trim()
    const wantIndex = searchParams.get('index') !== '0'
    // The block lives on the Leaderboard, under a filter bar that is showing one
    // Category. Ignoring it would put three genres under a page that says Puzzle.
    const cat = (searchParams.get('category') || 'all').toLowerCase()
    const category = (BUCKETS as readonly string[]).includes(cat) ? cat : 'all'
    const catFilter = category === 'all' ? sql`` : sql`AND ge.category_group = ${category}`

    const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)
    const today = new Date()
    const to = isDay(rawTo) ? rawTo : isoDay(today)
    const from = isDay(rawFrom)
      ? rawFrom
      : isoDay(new Date(today.getTime() - DEFAULT_SPAN_DAYS * 86400_000))
    const day = isDay(rawDay) ? rawDay : ''

    const { config: rcfg } = await loadReportConfig()
    const excluded = Array.from(new Set([...SYSTEM_EVALUATOR_KEY_LIST, ...rcfg.excluded]))

    // Day boundaries are built as timestamptz BEFORE the comparison, so the index on
    // evaluate_date / tagged_at is still usable. Writing
    // `(col AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= x` wraps the column in an
    // expression and throws the index (and the planner's statistics) away - the same
    // trap app/api/report/route.ts documents at length. Grouping BY that expression
    // is fine; filtering by it is not.
    const lo = sql`(${day || from}::timestamp AT TIME ZONE ${VN})`
    const hi = day
      ? sql`((${day}::timestamp AT TIME ZONE ${VN}) + INTERVAL '1 day')`
      : sql`((${to}::timestamp AT TIME ZONE ${VN}) + INTERVAL '1 day')`
    // WHICH DAY, resolved once and applied to BOTH sides.
    //
    // This block shipped with the tagging side bounded by the whole PERIOD while only
    // the evaluations were narrowed to the day. Every tag anybody made on any other
    // day in the period then arrived as its own row -- a person with 0 judged and a
    // tag count, once per day they had tagged. On screen that was DuyenLP three times
    // and an evaluator count of 15 for a day with 8 people in it.
    //
    // Without an explicit day it is the most recent one with work, picked inside SQL:
    // asking the index first and then the day would be two serialized round trips to a
    // database on another continent, on every first paint, and the two queries are
    // otherwise independent and share one.
    //
    // This is the one place a date column is compared through an expression, and it is
    // deliberate: the range predicate on the bare column stays in every query, so the
    // index still does the narrowing and the expression only picks a day out of what is
    // left. That is the opposite of the trap described above, where the expression
    // REPLACES the range predicate and leaves an index nothing to do.
    const targetDay = day
      ? sql`${day}::date`
      : sql`(
          SELECT max((g2.evaluate_date AT TIME ZONE ${VN})::date)
          FROM game_evaluations g2
          WHERE g2.evaluate_date >= ${lo} AND g2.evaluate_date < ${hi}
            AND g2.initial_evaluator IS NOT NULL
            AND g2.initial_conclusion IS NOT NULL AND g2.initial_conclusion <> ''
            AND g2.initial_conclusion NOT IN ('Link_dead', 'Stale_release')
            AND lower(g2.initial_evaluator) <> ALL(${excluded})
            ${category === 'all' ? sql`` : sql`AND g2.category_group = ${category}`}
        )`

    const dayRowsQ = sql<Array<{
      day_vn: string; bucket: string; evaluator: string
      total: number; idea: number; pbp: number; bypass: number
      link_dead: number; stale_release: number
      tag_rows: number; tagged: number
    }>>`
      WITH ev AS (
        SELECT (ge.evaluate_date AT TIME ZONE ${VN})::date AS day_vn,
               ge.category_group AS bucket,
               ge.initial_evaluator AS evaluator,
               lower(ge.initial_evaluator) AS k,
               count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL
                                  AND ge.initial_conclusion <> ''
                                  AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release'))::int AS total,
               count(*) FILTER (WHERE ge.initial_conclusion = 'List_Idea')::int AS idea,
               count(*) FILTER (WHERE ge.initial_conclusion = 'Playtest & Bypass')::int AS pbp,
               count(*) FILTER (WHERE ge.initial_conclusion = 'Bypass')::int AS bypass,
               count(*) FILTER (WHERE ge.initial_conclusion = 'Link_dead')::int AS link_dead,
               count(*) FILTER (WHERE ge.initial_conclusion = 'Stale_release')::int AS stale_release
        FROM game_evaluations ge
        WHERE ge.evaluate_date >= ${lo} AND ge.evaluate_date < ${hi}
          AND ge.initial_evaluator IS NOT NULL
          AND lower(ge.initial_evaluator) <> ALL(${excluded})
          ${catFilter}
          AND (ge.evaluate_date AT TIME ZONE ${VN})::date = ${targetDay}
        GROUP BY 1, 2, 3, 4
      ),
      -- Tagging is credited to the same person on the same day. playtest_tags.tagged_by
      -- is an email and initial_evaluator is a display name, so the two sides only meet
      -- through dashboard_users. Two numbers, not one: a game can carry several tags, so
      -- "11 tags across 6 games" is the only way to read tag density.
      tg AS (
        SELECT (pt.tagged_at AT TIME ZONE ${VN})::date AS day_vn,
               ge.category_group AS bucket, du.name AS evaluator,
               lower(du.name) AS k,
               count(*)::int AS tag_rows,
               count(DISTINCT pt.game_id)::int AS tagged
        FROM playtest_tags pt
        JOIN dashboard_users du ON lower(du.email) = lower(pt.tagged_by)
        JOIN game_evaluations ge ON ge.game_id = pt.game_id
        WHERE pt.tagged_at >= ${lo} AND pt.tagged_at < ${hi}
          AND pt.status <> 'removed'
          AND lower(du.name) <> ALL(${excluded})
          ${catFilter}
          AND (pt.tagged_at AT TIME ZONE ${VN})::date = ${targetDay}
        GROUP BY 1, 2, 3, 4
      )
      -- FULL OUTER: somebody who spent the day tagging and judged nothing still has a
      -- row. An inner join would report them as absent.
      --
      -- Joined on the LOWERED name. ge.initial_evaluator is sheet data with known
      -- casing drift (HuyDD vs Huydd) and du.name is the account's display name;
      -- matching them raw puts one person on two rows, one carrying their judgements
      -- and one carrying only their tags. The evaluation spelling is the one displayed,
      -- because it is what every other number in this Report is labelled with.
      SELECT COALESCE(e.day_vn, t.day_vn)::text AS day_vn,
             COALESCE(e.bucket, t.bucket) AS bucket,
             COALESCE(e.evaluator, t.evaluator) AS evaluator,
             COALESCE(e.total, 0) AS total, COALESCE(e.idea, 0) AS idea,
             COALESCE(e.pbp, 0) AS pbp, COALESCE(e.bypass, 0) AS bypass,
             COALESCE(e.link_dead, 0) AS link_dead,
             COALESCE(e.stale_release, 0) AS stale_release,
             COALESCE(t.tag_rows, 0) AS tag_rows, COALESCE(t.tagged, 0) AS tagged
      FROM ev e
      FULL OUTER JOIN tg t
        ON t.day_vn = e.day_vn AND t.bucket = e.bucket AND t.k = e.k
      ORDER BY bucket, total DESC, evaluator
    `

    // Which days in the PERIOD have work, for the strip of day buttons. A plain
    // aggregate over the same predicate as the day query, so a day is listed exactly
    // when the table for it would have rows -- a strip offering a day the table cannot
    // fill is worse than a strip one button short.
    //
    // "A day with work" has ONE definition, shared by the newest-day pick above, this
    // index and the totals below: at least one judged row, housekeeping excluded. Left
    // as a plain row count, a day whose only activity was clearing dead links would sit
    // on the strip offering a table of zeroes. It also means a day on which somebody
    // only tagged is not on the strip - the day picker and the table have to agree, and
    // the table is keyed on the day's judgements. Independent of the day query, so the two ride the same
    // Promise.all rather than costing two latencies.
    const indexQ = wantIndex
      ? sql<Array<{ date: string; total: number }>>`
          SELECT (ge.evaluate_date AT TIME ZONE ${VN})::date::text AS date,
                 count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL
                                    AND ge.initial_conclusion <> ''
                                    AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release'))::int AS total
          FROM game_evaluations ge
          WHERE ge.evaluate_date >= (${from}::timestamp AT TIME ZONE ${VN})
            AND ge.evaluate_date < ((${to}::timestamp AT TIME ZONE ${VN}) + INTERVAL '1 day')
            AND ge.initial_evaluator IS NOT NULL
            AND lower(ge.initial_evaluator) <> ALL(${excluded})
            ${catFilter}
          GROUP BY 1
          HAVING count(*) FILTER (WHERE ge.initial_conclusion IS NOT NULL
                                    AND ge.initial_conclusion <> ''
                                    AND ge.initial_conclusion NOT IN ('Link_dead', 'Stale_release')) > 0
          ORDER BY 1 DESC
        `
      : Promise.resolve([] as Array<{ date: string; total: number }>)

    const [dayRows, indexRows] = await Promise.all([dayRowsQ, indexQ])

    // Belt and braces for the bug above: the SQL now narrows both sides to one day, and
    // the assembly folds in only rows carrying that date. Rows from two days quietly
    // summed under one heading is a wrong table; rows dropped here would at worst be a
    // short one, and the test that pins the SQL is what keeps this from hiding anything.
    const targetDate = dayRows.length > 0
      ? dayRows.map((r) => r.day_vn).sort().slice(-1)[0]
      : ''
    let dayOut: DailyDay | null = null
    for (const r of dayRows) {
      if (r.day_vn !== targetDate) continue
      if (!dayOut) dayOut = { date: r.day_vn, total: 0, buckets: [] }
      let bucket = dayOut.buckets.find((b) => b.bucket === r.bucket)
      if (!bucket) {
        bucket = { bucket: r.bucket, evaluators: 0, total: 0, linkDead: 0, staleRelease: 0, rows: [] }
        dayOut.buckets.push(bucket)
      }
      const other = Math.max(0, r.total - r.idea - r.pbp - r.bypass)
      bucket.rows.push({
        name: r.evaluator, total: r.total, idea: r.idea, pbp: r.pbp,
        bypass: r.bypass, other, tagRows: r.tag_rows, tagged: r.tagged,
      })
      bucket.evaluators += 1
      bucket.total += r.total
      bucket.linkDead += r.link_dead
      bucket.staleRelease += r.stale_release
      dayOut.total += r.total
    }
    // An explicit day with nothing in it is still that day, not "no day" - the strip
    // has to keep its selection and the block has to say the day was quiet.
    if (!dayOut && day) dayOut = { date: day, total: 0, buckets: [] }

    return NextResponse.json({ day: dayOut, index: indexRows, from, to, category })
  } catch (e) {
    console.error('[report/daily]', e)
    return NextResponse.json({ error: 'Failed to load daily report' }, { status: 500 })
  }
}
