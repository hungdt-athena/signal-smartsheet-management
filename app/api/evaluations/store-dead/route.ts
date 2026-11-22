import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { getSession } from '@/lib/session'
import { isManagerRole } from '@/lib/roles'
import {
  readTiming, logKindSql, isMissingLogTable, EVALUATION_LOG_MISSING,
} from '@/lib/evaluation-log'

export const dynamic = 'force-dynamic'

// Mark one store of a linked pair Link_dead (or reopen it). Link_dead is the one result that
// stays with its store, so it has its own route: a plain PATCH of initial_conclusion would
// log as a pair save. Reopening clears the conclusion and the date; the sync trigger then
// copies the pair's result onto the row.
// Who may: a manager, or the initial_evaluator of this row OR of its twin (the holder of the
// pair can toggle the other store).
export async function POST(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const body = await req.json()
    const id = Number(body?.id)
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'id is required' }, { status: 400 })
    if (typeof body?.dead !== 'boolean') return NextResponse.json({ error: 'dead must be a boolean' }, { status: 400 })
    const dead: boolean = body.dead

    let isManager = true
    let actor: string | null = null
    let role: string | null = null
    if (process.env.SKIP_AUTH !== 'true') {
      const session = await getSession()
      role = session?.user?.role ?? null
      actor = session?.user?.name ?? null
      isManager = isManagerRole(role)
    }

    const timing = readTiming(body)
    const same = (a: string | null | undefined, b: string | null | undefined) =>
      !!a && !!b && a.toLowerCase() === b.toLowerCase()

    type Outcome = { status: number; error: string } | { rows: Record<string, unknown>[] }
    const out: Outcome = await sql.begin(async (txRaw): Promise<Outcome> => {
      const tx = txRaw as unknown as typeof sql
      // Both rows of the pair, in id order, before anything is written: two people saving
      // the two stores at once would otherwise deadlock on the sync triggers.
      const locked = await tx`
        SELECT id, game_id, initial_evaluator, initial_conclusion, final_conclusion, evaluate_date, batch, pair_eval_id
        FROM game_evaluations
        WHERE id IN (${id}, (SELECT pair_eval_id FROM game_evaluations WHERE id = ${id}))
        ORDER BY id FOR UPDATE
      `
      const row = locked.find((r) => Number(r.id) === id)
      if (!row) return { status: 404, error: 'Not found' }
      if (!isManager && !locked.some((r) => same(r.initial_evaluator as string | null, actor))) {
        return { status: 403, error: 'Forbidden: not your evaluation' }
      }
      if (!dead && row.initial_conclusion !== 'Link_dead') {
        return { status: 400, error: 'This store is not marked Link_dead' }
      }

      // 1. The write. The sync trigger runs inside it: on a reopen it copies the pair's
      //    result onto this row. Marking dead is a new result, so the date moves to now
      //    (same rule as PATCH: evaluate_date follows a change of the conclusion). Keeping the
      //    old date would backdate a counted row; a row already Link_dead keeps its date.
      //    The row is locked above, so its conclusion cannot change in between.
      const newDate = !dead ? sql`NULL`
        : row.initial_conclusion === 'Link_dead' ? sql`COALESCE(ge.evaluate_date, NOW())`
        : sql`NOW()`
      await tx`
        UPDATE game_evaluations ge SET
          initial_conclusion = ${dead ? 'Link_dead' : null}::text,
          evaluate_date = ${newDate},
          updated_by = ${actor}
        WHERE ge.id = ${id}
      `
      // 2. Re-read the row after the triggers, and 3. log from that state, so
      //    conclusion_after is what the row really holds (the pair's result after a reopen).
      const rows = await tx`
        WITH old AS (
          SELECT ${id}::int AS id, ${(row.game_id as string) ?? null}::text AS game_id,
            ${(row.initial_conclusion as string | null) ?? null}::text AS initial_conclusion,
            ${(row.initial_evaluator as string | null) ?? null}::text AS initial_evaluator,
            ${(row.final_conclusion as string | null) ?? null}::text AS final_conclusion,
            ${row.evaluate_date ? new Date(row.evaluate_date as string).toISOString() : null}::timestamptz AS evaluate_date,
            ${(row.batch as string | null) ?? null}::text AS batch
        ), upd AS (
          SELECT * FROM game_evaluations WHERE id = ${id}
        ), logged AS (
          INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, actor_role, owner, source,
            context, kind, conclusion_before, conclusion_after, final_before, final_after, changed,
            view_s, hidden_s, idle_s, batch_before, batch_after, pair_scope)
          SELECT old.id, old.game_id, ${actor}::text, ${role}::text, old.initial_evaluator, ${timing.source}::text, ${timing.context}::text,
            ${logKindSql(sql, { initialTouched: true, finalTouched: false })},
            old.initial_conclusion, upd.initial_conclusion,
            old.final_conclusion, upd.final_conclusion,
            old.initial_conclusion IS DISTINCT FROM upd.initial_conclusion,
            ${timing.viewS}::int, ${timing.hiddenS}::int, ${timing.idleS}::int,
            old.batch, upd.batch, 'store'
          FROM old JOIN upd ON upd.id = old.id
        )
        SELECT * FROM upd
      `
      return { rows }
    })

    if ('error' in out) return NextResponse.json({ error: out.error }, { status: out.status })
    if (out.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ data: out.rows[0] })
  } catch (err) {
    if (isMissingLogTable(err)) {
      return NextResponse.json({ error: EVALUATION_LOG_MISSING }, { status: 500 })
    }
    console.error('POST /api/evaluations/store-dead error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
