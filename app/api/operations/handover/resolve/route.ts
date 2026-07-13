import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { selectPendingGames, loadRoster, commitAssignment, distribute } from '@/lib/reassign-core'
import { writeAssignmentHistory } from '@/lib/assignment-history'
import { sourceBreakdowns, perEvaluatorPlatform, type DistSnapshot } from '@/lib/operation-runs'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Approve or reject a PENDING handover request (operation_runs, migration 028).
//
//   approve → recompute the distribution against the CURRENT pending games +
//             currently-available roster (the submit-time snapshot is reference
//             only), commit game_evaluations, insert handover_requests (status
//             'done', drives the availability cron), write assignment_history
//             (action='handover'), and mark the run 'approved' with the committed
//             result stored.
//   reject  → mark the run 'rejected'. No game changes.
//
// Any manager (admin/moderator) may resolve, EXCEPT the person who submitted it.

interface Body {
  id?: number
  action?: 'approve' | 'reject'
  note?: string
}

interface RunRow {
  id: number
  category_group: string
  from_evaluator: string
  status: string
  submitted_by: string | null
  params: { start_date?: string; end_date?: string }
}

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  let body: Body
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const id = Number(body.id)
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }
  if (body.action !== 'approve' && body.action !== 'reject') {
    return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 })
  }

  const session = await getServerSession(authOptions)
  const reviewer = session?.user?.email ?? 'manual'

  try {
    const found = (await sql`
      SELECT id, category_group, from_evaluator, status, submitted_by, params
      FROM operation_runs
      WHERE id = ${id} AND kind = 'handover'
    `) as unknown as RunRow[]
    if (found.length === 0) {
      return NextResponse.json({ error: 'handover request not found' }, { status: 404 })
    }
    const run = found[0]
    if (run.status !== 'pending') {
      return NextResponse.json({ error: `already ${run.status}` }, { status: 409 })
    }
    // A manager cannot approve/reject their own submitted request.
    if (run.submitted_by && run.submitted_by === reviewer) {
      return NextResponse.json({ error: 'cannot resolve your own handover request' }, { status: 403 })
    }

    if (body.action === 'reject') {
      await sql`
        UPDATE operation_runs
        SET status = 'rejected', reviewed_by = ${reviewer}, reviewed_at = NOW(), review_note = ${body.note ?? null}
        WHERE id = ${id}
      `
      return NextResponse.json({ ok: true, id, status: 'rejected' })
    }

    // Approve — recompute fresh against current state.
    const category = run.category_group
    const from = run.from_evaluator
    const startDate = run.params?.start_date ?? null
    const endDate = run.params?.end_date ?? null

    const candidates = await selectPendingGames({ category, from, startDate, endDate })
    const { by_platform, by_date } = sourceBreakdowns(candidates)
    const roster = await loadRoster({ category, onlyAvailable: true })
    const { assignment, perEvaluator } = candidates.length
      ? distribute(candidates, roster, from)
      : { assignment: new Map<number, string>(), perEvaluator: {} as Record<string, number> }
    const per_evaluator_platform = perEvaluatorPlatform(candidates, assignment)

    if (assignment.size > 0) {
      const idToGameId = new Map(candidates.map(c => [c.id, c.game_id]))
      const perEvaluatorGameIds = await commitAssignment(assignment, idToGameId)
      await writeAssignmentHistory({
        category, action: 'handover', perEvaluator: perEvaluatorGameIds,
        fromEvaluator: from, createdBy: reviewer,
      })
    }

    // Record the leave window (drives the hourly availability cron), as the old
    // direct-commit path did — now stamped at approval time.
    await sql`
      INSERT INTO handover_requests (request_date, evaluator_name, start_date, end_date, sheet_type, status)
      VALUES (NOW(), ${from}, ${startDate}, ${endDate}, ${category}, 'done')
    `

    const result: DistSnapshot = {
      candidate_count: candidates.length,
      assigned: assignment.size,
      unassignable: candidates.length - assignment.size,
      per_evaluator: perEvaluator,
      per_evaluator_platform,
      by_platform, by_date,
      dryRun: false,
    }
    await sql`
      UPDATE operation_runs
      SET status = 'approved', result = ${sql.json(result as unknown as import('postgres').JSONValue)},
          game_count = ${assignment.size}, reviewed_by = ${reviewer}, reviewed_at = NOW(),
          review_note = ${body.note ?? null}
      WHERE id = ${id}
    `

    return NextResponse.json({ ok: true, id, status: 'approved', category, from, ...result })
  } catch (err) {
    if (err instanceof Error && err.message === 'evaluator list empty') {
      return NextResponse.json({ error: 'no available evaluators to hand over to' }, { status: 409 })
    }
    console.error('POST /api/operations/handover/resolve error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
