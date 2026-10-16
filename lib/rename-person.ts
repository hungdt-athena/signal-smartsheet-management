import { sql } from '@/lib/db'

// A person is identified across the app by their name string, not by dashboard_users.id:
// the filters, the roster, the Report and the hours all join on it. Renaming someone in
// Users Management therefore has to carry the new name to every place that names them,
// or their old name lingers in dropdowns and their history splits in two.
//
// Left alone on purpose: audit columns (updated_by, created_by, submitted_by,
// reviewed_by), the sheet mirror ytb_uploads.pic (re-synced from the sheet), and the
// weekly_feedback_history snapshots. Those record what was written at the time.
//
// One statement, so it is one transaction and one round-trip -- the database is far from
// the app and a statement per table would cost ~225ms each.

export interface RenameCounts { [table: string]: number }

export async function renamePerson(oldName: string, newName: string): Promise<RenameCounts> {
  const from = oldName.trim()
  const to = newName.trim()
  if (!from || !to || from === to) return {}

  const [r] = await sql<{ roster: number; games: number; log: number; feedback: number; history: number; runs: number }[]>`
    WITH
    roster AS (
      UPDATE evaluator_roster SET name = ${to}
      WHERE lower(trim(name)) = lower(${from}) RETURNING 1
    ),
    games AS (
      UPDATE game_evaluations SET
        initial_evaluator    = CASE WHEN lower(trim(initial_evaluator))    = lower(${from}) THEN ${to} ELSE initial_evaluator END,
        final_evaluator      = CASE WHEN lower(trim(final_evaluator))      = lower(${from}) THEN ${to} ELSE final_evaluator END,
        record_assignee      = CASE WHEN lower(trim(record_assignee))      = lower(${from}) THEN ${to} ELSE record_assignee END,
        record_5min_assignee = CASE WHEN lower(trim(record_5min_assignee)) = lower(${from}) THEN ${to} ELSE record_5min_assignee END,
        record_20min_assignee= CASE WHEN lower(trim(record_20min_assignee))= lower(${from}) THEN ${to} ELSE record_20min_assignee END
      WHERE lower(trim(initial_evaluator))    = lower(${from})
         OR lower(trim(final_evaluator))      = lower(${from})
         OR lower(trim(record_assignee))      = lower(${from})
         OR lower(trim(record_5min_assignee)) = lower(${from})
         OR lower(trim(record_20min_assignee))= lower(${from})
      RETURNING 1
    ),
    log AS (
      UPDATE evaluation_log SET
        actor           = CASE WHEN lower(trim(actor))           = lower(${from}) THEN ${to} ELSE actor END,
        owner           = CASE WHEN lower(trim(owner))           = lower(${from}) THEN ${to} ELSE owner END,
        owner_after     = CASE WHEN lower(trim(owner_after))     = lower(${from}) THEN ${to} ELSE owner_after END,
        recorder_before = CASE WHEN lower(trim(recorder_before)) = lower(${from}) THEN ${to} ELSE recorder_before END,
        recorder_after  = CASE WHEN lower(trim(recorder_after))  = lower(${from}) THEN ${to} ELSE recorder_after END
      WHERE lower(trim(actor))           = lower(${from})
         OR lower(trim(owner))           = lower(${from})
         OR lower(trim(owner_after))     = lower(${from})
         OR lower(trim(recorder_before)) = lower(${from})
         OR lower(trim(recorder_after))  = lower(${from})
      RETURNING 1
    ),
    feedback AS (
      UPDATE weekly_feedback SET evaluator = ${to}
      WHERE lower(trim(evaluator)) = lower(${from}) RETURNING 1
    ),
    history AS (
      UPDATE assignment_history SET
        evaluator_name = CASE WHEN lower(trim(evaluator_name)) = lower(${from}) THEN ${to} ELSE evaluator_name END,
        from_evaluator = CASE WHEN lower(trim(from_evaluator)) = lower(${from}) THEN ${to} ELSE from_evaluator END
      WHERE lower(trim(evaluator_name)) = lower(${from})
         OR lower(trim(from_evaluator)) = lower(${from})
      RETURNING 1
    ),
    runs AS (
      UPDATE operation_runs SET from_evaluator = ${to}
      WHERE lower(trim(from_evaluator)) = lower(${from}) RETURNING 1
    )
    SELECT (SELECT count(*) FROM roster)::int   AS roster,
           (SELECT count(*) FROM games)::int    AS games,
           (SELECT count(*) FROM log)::int      AS log,
           (SELECT count(*) FROM feedback)::int AS feedback,
           (SELECT count(*) FROM history)::int  AS history,
           (SELECT count(*) FROM runs)::int     AS runs
  `
  return { ...r }
}
