-- Phase 2 (migration 055): the stats changes the runs are EXPECTED to make, computed from their
-- snapshots alone, one row per (reason, metric, person, month, category, key). Read-only.
-- scripts/phase2-stats-diff.py takes it as the third file: the gate passes only when the stats diff
-- before/after is exactly the sum of these rows, and nothing else.
--
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -v run_like='prod-p2-%' \
--          -f scripts/phase2-expected-diff.sql > expected.csv
--
-- Run it BEFORE any rollback of those runs (it reads their snapshots, which a rollback deletes).
-- For each reason, delta = (the family's rows as they count now, from eval_stats_rows) minus (the
-- same rows as they counted before the run, from row_before: unlinked then, no credit), over the
-- families the reason covers, for the metrics it covers (same definitions as
-- scripts/phase2-stats-snapshot.sql). The three reasons (user ruling 23/11, controller ruling R11):
--   assigned_ab     metrics assigned / assigned_cur, families of group A and B: A and B do not freeze
--                   the assignment, so the store that left its holder drops out of that holder's count
--                   (only the front row of a pair counts). Both rows with the same holder and month
--                   still lose one: two rows were one game.
--   platform_b      metric os, families of group B: the front is the store released first, so when
--                   the judged store becomes the back row the verdict counts on the other store's os
--                   (same person, month, category, conclusion).
--   demo_link       metric drive_link, families where the run wrote drive_link on either row: a demo
--                   moved onto the front (D/E/F credit '_moved', or A/B fill), or the shared link
--                   copied onto a Link_dead / Stale_release back row (C, phase 1 media sharing).
-- CSV columns: reason, metric, person, month, category, key, delta (only non-zero rows).
COPY (
WITH snap AS (
  SELECT ms.family_id, ms.pair_group, ms.game_evaluation_id AS id, ms.row_before AS r, ms.written AS w
    FROM eval_pair_merge_snapshots ms
   WHERE ms.run_id LIKE :'run_like'
),
fam AS (
  SELECT family_id,
         bool_or(pair_group IN ('A', 'B')) AS ab,
         bool_or(pair_group = 'B') AS b,
         bool_or(w ? 'drive_link') AS link
    FROM snap GROUP BY 1
),
rows_in AS (
  SELECT s.*, f.ab, f.b, f.link FROM snap s JOIN fam f USING (family_id)
   WHERE f.ab OR f.b OR f.link
),
-- each row before the run, read like eval_stats_rows reads an unlinked row without credit
bf AS (
  SELECT ri.ab, ri.b, ri.link,
         lower(ri.r ->> 'initial_evaluator') AS who,
         NULLIF(btrim(ri.r ->> 'initial_evaluator'), '') IS NOT NULL AS has_who,
         to_char((ri.r ->> 'evaluate_date')::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') AS mon,
         (ri.r ->> 'first_assigned_date')::date AS fad, (ri.r ->> 'assigned_date')::date AS ad,
         COALESCE(ri.r ->> 'category_group', '') AS cat,
         COALESCE(lower(gi.os), 'unknown') AS os,
         NULLIF(ri.r ->> 'drive_link', '') IS NOT NULL AS has_link
    FROM rows_in ri LEFT JOIN game_info gi ON gi.game_id = ri.r ->> 'game_id'
),
af AS (
  SELECT ri.ab, ri.b, ri.link,
         lower(ge.initial_evaluator) AS who,
         NULLIF(btrim(ge.initial_evaluator), '') IS NOT NULL AS has_who,
         to_char(ge.evaluate_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') AS mon,
         ge.first_assigned_date AS fad, ge.assigned_date AS ad,
         COALESCE(ge.category_group, '') AS cat,
         COALESCE(lower(gi.os), 'unknown') AS os,
         NULLIF(ge.drive_link, '') IS NOT NULL AS has_link
    FROM rows_in ri JOIN eval_stats_rows ge ON ge.id = ri.id
    LEFT JOIN game_info gi ON gi.game_id = ge.game_id
   WHERE ge.eval_row
),
x AS (
  SELECT -1 AS d, bf.* FROM bf
  UNION ALL
  SELECT 1, af.* FROM af
),
e AS (
  SELECT 'assigned_ab' AS reason, 'assigned' AS metric, who AS person, to_char(fad, 'YYYY-MM') AS month,
         cat AS category, '' AS key, d
    FROM x WHERE ab AND has_who AND fad IS NOT NULL
  UNION ALL
  SELECT 'assigned_ab', 'assigned_cur', who, to_char(ad, 'YYYY-MM'), cat, '', d
    FROM x WHERE ab AND has_who AND ad IS NOT NULL
  UNION ALL
  SELECT 'platform_b', 'os', who, mon, cat, os, d
    FROM x WHERE b AND has_who AND mon IS NOT NULL
  UNION ALL
  SELECT 'demo_link', 'drive_link', who, mon, cat, '', d
    FROM x WHERE link AND has_who AND mon IS NOT NULL AND has_link
)
SELECT reason, metric, person, month, category, key, sum(d) AS delta
  FROM e
 GROUP BY 1, 2, 3, 4, 5, 6
HAVING sum(d) <> 0
 ORDER BY 1, 2, 3, 4, 5, 6
) TO STDOUT WITH (FORMAT csv, HEADER);
