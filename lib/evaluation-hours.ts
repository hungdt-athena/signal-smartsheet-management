// lib/evaluation-hours.ts — panel time per person per VN day, from evaluation_log.
// "Panel time" = the time a game was on screen before each successful save. It is not
// total working time (see the spec). The SQL is mirrored in scripts/sql-verify/checks.sql;
// change both together and run scripts/verify-evaluation-log.sh.
import { sql } from '@/lib/db'

export const PANEL_CAP_S = 1800
export const DEFAULT_TITLES = ['Fulltime', 'Freelancer']

export interface PanelTimeRow { who: string; day: string; hours: number; capped_saves: number; idle_s: number; hidden_s: number }
export interface GamesRow { who: string; day: string; games: number }

export async function loadPanelTime(opts: { from: string; to: string; titles?: string[] }): Promise<{ time: PanelTimeRow[]; games: GamesRow[] }> {
  const titles = opts.titles?.length ? opts.titles : DEFAULT_TITLES
  const [time, games] = await Promise.all([
    sql<PanelTimeRow[]>`
      WITH iv AS (
        SELECT lower(l.actor) AS who,
               l.created_at - make_interval(secs => LEAST(l.view_s, ${PANEL_CAP_S}::int)) AS s,
               l.created_at AS e,
               l.view_s > ${PANEL_CAP_S}::int AS capped,
               l.idle_s, l.hidden_s
        FROM evaluation_log l
        JOIN dashboard_users du ON lower(du.name) = lower(l.actor)
        WHERE l.source = 'panel'
          AND l.view_s IS NOT NULL
          AND du.title = ANY(${titles}::text[])
          AND l.created_at >= (${opts.from}::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
          AND l.created_at <  (${opts.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
      ), ord AS (
        SELECT *, MAX(e) OVER (PARTITION BY who ORDER BY s, e
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_e
        FROM iv
      ), grp AS (
        SELECT *, SUM(CASE WHEN prev_e IS NULL OR s > prev_e THEN 1 ELSE 0 END)
                    OVER (PARTITION BY who ORDER BY s, e) AS g
        FROM ord
      ), blocks AS (
        SELECT who, g, MIN(s) AS block_start, MAX(e) AS block_end,
               COUNT(*) FILTER (WHERE capped) AS n_capped,
               SUM(idle_s) AS idle_s, SUM(hidden_s) AS hidden_s
        FROM grp GROUP BY who, g
      )
      SELECT who, to_char((block_end AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS day,
             round(SUM(EXTRACT(EPOCH FROM (block_end - block_start))) / 3600.0, 4)::float8 AS hours,
             SUM(n_capped)::int AS capped_saves,
             COALESCE(SUM(idle_s), 0)::int AS idle_s, COALESCE(SUM(hidden_s), 0)::int AS hidden_s
      FROM blocks
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
    sql<GamesRow[]>`
      SELECT lower(l.actor) AS who,
             to_char((l.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS day,
             count(DISTINCT l.game_evaluation_id)::int AS games
      FROM evaluation_log l
      JOIN dashboard_users du ON lower(du.name) = lower(l.actor)
      WHERE l.kind = 'first'
        AND du.title = ANY(${titles}::text[])
        AND l.created_at >= (${opts.from}::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
        AND l.created_at <  (${opts.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
  ])
  return { time, games }
}
