import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { isBucket } from '@/lib/buckets'
import { selectPendingGames, loadRoster, commitAssignment, distribute } from '@/lib/reassign-core'
import { writeAssignmentHistory } from '@/lib/assignment-history'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Handover, DB-native (replaces the n8n "Handover" / "handover-puzzle" flows that
// mutated Smartsheet). When an evaluator goes on leave for a date window, their
// still-pending games assigned within that window are redistributed to everyone
// currently available in the bucket. The leave window is recorded in
// handover_requests; the hourly availability cron flips today_available by date.
//
//   dryRun: true  → preview: candidate_count + would-be per-evaluator split.
//   dryRun: false → commit: game_evaluations reassigned, handover_requests row
//                   inserted, one assignment_history row per evaluator (action='handover').

interface Body {
  evaluator_name?: string
  category?: string
  sheet_type?: string // alias for category
  start_date?: string
  end_date?: string
  dryRun?: boolean
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

  const category = String(body.category ?? body.sheet_type ?? '').trim().toLowerCase()
  if (!isBucket(category)) {
    return NextResponse.json({ error: 'category must be puzzle, arcade or simulation' }, { status: 400 })
  }
  const from = String(body.evaluator_name ?? '').trim()
  if (!from) {
    return NextResponse.json({ error: 'evaluator_name is required' }, { status: 400 })
  }
  if (!body.start_date || !body.end_date) {
    return NextResponse.json({ error: 'start_date and end_date are required' }, { status: 400 })
  }
  const dryRun = !!body.dryRun

  try {
    const candidates = await selectPendingGames({
      category, from, startDate: body.start_date, endDate: body.end_date,
    })

    // Everyone currently available in this bucket, minus the person leaving.
    const roster = await loadRoster({ category, onlyAvailable: true })

    if (candidates.length === 0) {
      return NextResponse.json({ ok: true, dryRun, category, from, candidate_count: 0, assigned: 0, per_evaluator: {} })
    }

    const { assignment, perEvaluator } = distribute(candidates, roster, from)

    if (dryRun) {
      return NextResponse.json({
        ok: true, dryRun: true, category, from,
        start_date: body.start_date, end_date: body.end_date,
        candidate_count: candidates.length,
        assignable: assignment.size,
        unassignable: candidates.length - assignment.size,
        per_evaluator: perEvaluator,
      })
    }

    const idToGameId = new Map(candidates.map(c => [c.id, c.game_id]))
    const perEvaluatorGameIds = await commitAssignment(assignment, idToGameId)

    await sql`
      INSERT INTO handover_requests (request_date, evaluator_name, start_date, end_date, sheet_type, status)
      VALUES (NOW(), ${from}, ${body.start_date}, ${body.end_date}, ${category}, 'done')
    `

    const session = await getServerSession(authOptions)
    await writeAssignmentHistory({
      category,
      action: 'handover',
      perEvaluator: perEvaluatorGameIds,
      fromEvaluator: from,
      createdBy: session?.user?.email ?? 'manual',
    })

    return NextResponse.json({
      ok: true, dryRun: false, category, from,
      start_date: body.start_date, end_date: body.end_date,
      candidate_count: candidates.length,
      assigned: assignment.size,
      unassignable: candidates.length - assignment.size,
      per_evaluator: perEvaluator,
    })
  } catch (err) {
    if (err instanceof Error && err.message === 'evaluator list empty') {
      return NextResponse.json({ error: 'no available evaluators to hand over to' }, { status: 409 })
    }
    console.error('POST /api/operations/handover error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
