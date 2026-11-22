-- Phase 2 (migration 055) preview for the review sheet: one CSV line per old pair that
-- eval_pair_phase2_plan() finds (groups A..F are what apply links; G is listed, never linked).
-- Read-only. Spec: docs/superpowers/specs/2026-11-23-unified-playtest-phase2-design.md 6.3.
--
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/phase2-preview.sql > phase2-preview.csv
--
-- Then import the CSV into a NEW tab of the review sheet. Per group totals: the runbook's R2 query.
-- front_* = the row the list will show (pair_back = false), back_* = the other store. For a G family
-- (no front / back) front_* is the iOS store and back_* the Android store, and a store with several
-- evaluation rows shows them joined with " | ".
-- *_now = the row today; *_after = the pair after the link:
--   result_after   the pair's result (C: the front's own; the back keeps its own Link_dead /
--                  Stale_release or verdict)
--   holder_after   who holds the pair (A: the chosen holder; B: the judged row's; D/E/F: the front's)
--   final_after    the final the pair keeps (the plan's final_from row; C: the front's own)
--   group_after    category_group of both rows (C: each keeps its own)
--   back_note_now  the back row's initial_note (D/E/F: hidden behind the front's after the link;
--                  kept in its credit, the snapshot and History)
-- COPY (...) TO STDOUT is what psql's \copy runs; written as COPY so the query can span lines.
COPY (
WITH p AS (SELECT * FROM eval_pair_phase2_plan()),
side AS (
  SELECT p.family_id, g.game_id, g.os, g.title,
         COALESCE(g.initial_release, g.temp_release)::date AS rel,
         CASE WHEN p.front_id IS NOT NULL
              THEN CASE WHEN EXISTS (SELECT 1 FROM game_evaluations e WHERE e.id = p.front_id AND e.game_id = g.game_id)
                        THEN 'front' ELSE 'back' END
              ELSE CASE WHEN g.os = 'ios' THEN 'front' ELSE 'back' END END AS side
    FROM p JOIN game_info g ON g.family_id = p.family_id
),
s AS (
  SELECT side.family_id, side.side, side.game_id, side.os, side.title, side.rel,
         string_agg(e.id::text, ' | ' ORDER BY e.id) AS eval_ids,
         string_agg(COALESCE(e.initial_evaluator, ''), ' | ' ORDER BY e.id) AS holder,
         string_agg(COALESCE(e.initial_conclusion, ''), ' | ' ORDER BY e.id) AS conclusion,
         string_agg(COALESCE(e.final_conclusion, ''), ' | ' ORDER BY e.id) AS final,
         string_agg(COALESCE(e.category_group, ''), ' | ' ORDER BY e.id) AS grp,
         string_agg(COALESCE(to_char(e.evaluate_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD'), ''), ' | ' ORDER BY e.id) AS evaluated,
         string_agg(COALESCE(e.assigned_date::text, ''), ' | ' ORDER BY e.id) AS assigned,
         string_agg(COALESCE(left(regexp_replace(e.initial_note, '\s+', ' ', 'g'), 300), ''), ' | ' ORDER BY e.id) AS note
    FROM side JOIN game_evaluations e ON e.game_id = side.game_id
   GROUP BY 1, 2, 3, 4, 5, 6
)
SELECT p.grp AS "group", p.family_id, array_to_string(p.flags, ' ') AS flags,
       f.os AS front_os, f.game_id AS front_game_id, f.title AS front_title, f.rel AS front_release,
       b.os AS back_os, b.game_id AS back_game_id, b.title AS back_title, b.rel AS back_release,
       f.eval_ids AS front_eval_id, f.holder AS front_holder_now, f.conclusion AS front_result_now,
       f.final AS front_final_now, f.grp AS front_group_now, f.evaluated AS front_evaluated, f.assigned AS front_assigned,
       b.eval_ids AS back_eval_id, b.holder AS back_holder_now, b.conclusion AS back_result_now,
       b.final AS back_final_now, b.grp AS back_group_now, b.evaluated AS back_evaluated, b.assigned AS back_assigned,
       p.result_conclusion AS result_after, p.holder AS holder_after,
       CASE WHEN p.grp = 'C' THEN NULLIF(f.final, '')
            ELSE (SELECT e.final_conclusion FROM game_evaluations e WHERE e.id = p.final_from) END AS final_after,
       CASE p.grp WHEN 'G' THEN NULL WHEN 'C' THEN NULL
            ELSE (SELECT e.category_group FROM game_evaluations e
                   WHERE e.id = CASE WHEN p.grp IN ('A', 'B') THEN p.holder_row ELSE p.front_id END) END AS group_after,
       NULLIF(b.note, '') AS back_note_now
  FROM p
  LEFT JOIN s f ON f.family_id = p.family_id AND f.side = 'front'
  LEFT JOIN s b ON b.family_id = p.family_id AND b.side = 'back'
 ORDER BY p.grp, p.family_id
) TO STDOUT WITH (FORMAT csv, HEADER);
