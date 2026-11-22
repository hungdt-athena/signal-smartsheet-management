-- Phase 2 (migration 055) stats snapshot: every per-person count the counting routes show,
-- per person x month x category, from the view they read (eval_stats_rows: eval_row for
-- evaluation counts, media_row for recordings), plus the panel time (category = statsCategory).
-- Read-only. Spec: docs/superpowers/specs/2026-11-23-unified-playtest-phase2-design.md 6.1.
--
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/phase2-stats-snapshot.sql > stats-A.csv
--
-- Take one before the phase 2 runs (A) and one after (B), then
--   python3 -I scripts/phase2-stats-diff.py stats-A.csv stats-B.csv expected.csv
-- (expected.csv: scripts/phase2-expected-diff.sql). The only differences allowed are its three
-- reasons: assigned of the A / B stores that left their holder (user ruling 23/11), the os split
-- of B pairs and the demo-link attribution of pairs whose drive_link moved or was shared (R11).
--
-- CSV columns: metric, person, month, category, key, n
--   person   lower(name); month YYYY-MM in Asia/Ho_Chi_Minh; category = category_group
--   evaluations   rows judged in the month (evaluate_date), by initial_evaluator
--   active_days   distinct days with an evaluation (Report person_days)
--   conclusion    same rows, key = initial_conclusion ('(none)' when empty)
--   final         same rows with a final, key = final_conclusion (Report counts finals this way)
--   final_by      finals by final_evaluator and final_conclusion_date, key = final_conclusion
--   noted         same rows as evaluations with a non-blank initial_note
--   drive_link    same rows with a demo link (Quick stats)
--   os            same rows, key = game_info.os (Quick stats platforms)
--   rec_done      recordings per recorder (Report): key 5min / 20min, month of the done moment
--                 (Confirm, else upload), counted when the bucket is the game's own or has a video
--   rec_confirmed Confirmed recordings per recorder (Effort sessions / game-time): key 5 / 20,
--                 month of record_<slot>_date, else the Confirm
--   assigned      first_assigned_date month, by the current holder (Report team intake axis)
--   assigned_cur  assigned_date month, by the current holder (Report per-person assigned)
--   panel_s       evaluation_log panel seconds per actor (Effort game-time), n = sum(view_s);
--                 category = the eval row's statsCategory (credit's category when credited)
-- COPY (...) TO STDOUT is what psql's \copy runs; written as COPY so the query can span lines.
COPY (
WITH ev AS (
  SELECT ge.*, lower(ge.initial_evaluator) AS who,
         to_char(ge.evaluate_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') AS mon,
         COALESCE(ge.category_group, '') AS cat
    FROM eval_stats_rows ge
   WHERE ge.eval_row AND ge.evaluate_date IS NOT NULL
     AND NULLIF(btrim(ge.initial_evaluator), '') IS NOT NULL
),
rec AS (
  SELECT lower(s.assignee) AS who, s.slot, s.done, s.own, s.uploaded, s.dated, s.confirmed,
         COALESCE(ge.category_group, '') AS cat
    FROM eval_stats_rows ge
   CROSS JOIN LATERAL (VALUES
     ('5min', ge.record_5min_assignee, COALESCE(ge.record_5min_confirmed_at, ge.youtube_5min_uploaded_at),
      ge.youtube_5min_uploaded_at, ge.record_5min_date, ge.record_5min_confirmed_at),
     ('20min', ge.record_20min_assignee, COALESCE(ge.record_20min_confirmed_at, ge.youtube_20min_uploaded_at),
      ge.youtube_20min_uploaded_at, ge.record_20min_date, ge.record_20min_confirmed_at)
   ) AS s0(slot, assignee, done, uploaded, dated, confirmed)
   CROSS JOIN LATERAL (SELECT s0.*,
       (CASE WHEN ge.record_bucket IN ('5min', '20min') THEN ge.record_bucket
             WHEN ge.final_conclusion = 'Priority IV' THEN '20min' ELSE '5min' END) = s0.slot AS own) s
   WHERE ge.media_row AND NULLIF(btrim(s.assignee), '') IS NOT NULL
),
m AS (
  SELECT 'evaluations' AS metric, who AS person, mon AS month, cat AS category, '' AS key, count(*) AS n
    FROM ev GROUP BY 2, 3, 4
  UNION ALL
  SELECT 'active_days', who, mon, cat, '', count(DISTINCT (evaluate_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
    FROM ev GROUP BY 2, 3, 4
  UNION ALL
  SELECT 'conclusion', who, mon, cat, COALESCE(NULLIF(initial_conclusion, ''), '(none)'), count(*)
    FROM ev GROUP BY 2, 3, 4, 5
  UNION ALL
  SELECT 'final', who, mon, cat, final_conclusion, count(*)
    FROM ev WHERE NULLIF(final_conclusion, '') IS NOT NULL GROUP BY 2, 3, 4, 5
  UNION ALL
  SELECT 'noted', who, mon, cat, '', count(*)
    FROM ev WHERE NULLIF(btrim(initial_note), '') IS NOT NULL GROUP BY 2, 3, 4
  UNION ALL
  SELECT 'drive_link', who, mon, cat, '', count(*)
    FROM ev WHERE NULLIF(drive_link, '') IS NOT NULL GROUP BY 2, 3, 4
  UNION ALL
  SELECT 'os', ev.who, ev.mon, ev.cat, COALESCE(lower(gi.os), 'unknown'), count(*)
    FROM ev LEFT JOIN game_info gi ON gi.game_id = ev.game_id GROUP BY 2, 3, 4, 5
  UNION ALL
  SELECT 'final_by', lower(ge.final_evaluator),
         COALESCE(to_char(ge.final_conclusion_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM'), '(no date)'),
         COALESCE(ge.category_group, ''), ge.final_conclusion, count(*)
    FROM eval_stats_rows ge
   WHERE ge.eval_row AND NULLIF(ge.final_conclusion, '') IS NOT NULL
     AND NULLIF(btrim(ge.final_evaluator), '') IS NOT NULL
   GROUP BY 2, 3, 4, 5
  UNION ALL
  SELECT 'rec_done', who, to_char(done AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM'), cat, slot, count(*)
    FROM rec WHERE done IS NOT NULL AND (own OR uploaded IS NOT NULL) GROUP BY 2, 3, 4, 5
  UNION ALL
  SELECT 'rec_confirmed', who, to_char(COALESCE(dated, confirmed) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM'), cat,
         replace(slot, 'min', ''), count(*)
    FROM rec WHERE confirmed IS NOT NULL GROUP BY 2, 3, 4, 5
  UNION ALL
  SELECT 'assigned', lower(ge.initial_evaluator), to_char(ge.first_assigned_date, 'YYYY-MM'),
         COALESCE(ge.category_group, ''), '', count(*)
    FROM eval_stats_rows ge
   WHERE ge.eval_row AND ge.first_assigned_date IS NOT NULL
     AND NULLIF(btrim(ge.initial_evaluator), '') IS NOT NULL
   GROUP BY 2, 3, 4
  UNION ALL
  SELECT 'assigned_cur', lower(ge.initial_evaluator), to_char(ge.assigned_date, 'YYYY-MM'),
         COALESCE(ge.category_group, ''), '', count(*)
    FROM eval_stats_rows ge
   WHERE ge.eval_row AND ge.assigned_date IS NOT NULL
     AND NULLIF(btrim(ge.initial_evaluator), '') IS NOT NULL
   GROUP BY 2, 3, 4
  UNION ALL
  SELECT 'panel_s', lower(l.actor), to_char(l.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM'),
         COALESCE(COALESCE(ge.credit ->> 'category_group', ge.category_group), ''), '', sum(l.view_s)
    FROM evaluation_log l LEFT JOIN game_evaluations ge ON ge.id = l.game_evaluation_id
   WHERE l.source = 'panel' AND l.view_s IS NOT NULL
   GROUP BY 2, 3, 4
)
SELECT metric, person, month, category, key, n FROM m
 ORDER BY metric, person, month, category, key
) TO STDOUT WITH (FORMAT csv, HEADER);
