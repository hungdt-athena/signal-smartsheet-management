-- 031: retire VinhTD as the auto-attribution name for record shortcuts.
--
-- When a game is pulled straight into Record without a real evaluation (see POST
-- /api/evaluations/add-to-record) the row used to be stamped VinhTD as BOTH the
-- initial and the final evaluator, which credited a real person with work nobody
-- did. Those rows now carry the `Shortcut` system account instead — a label only,
-- deliberately WITHOUT a dashboard_users row so it never lands in the roster,
-- assignment cron, or Users Management.
--
-- Scope: only rows carrying the full auto-fill signature (initial AND final both
-- VinhTD, initial_conclusion = 'List_Idea'). VinhTD remains the final_evaluator on
-- ~1k genuinely-moderated rows where someone else did the initial evaluation —
-- those are untouched. Idempotent.
UPDATE game_evaluations
   SET initial_evaluator = 'Shortcut',
       final_evaluator   = 'Shortcut'
 WHERE initial_evaluator ILIKE 'vinhtd'
   AND final_evaluator   ILIKE 'vinhtd'
   AND initial_conclusion = 'List_Idea';
