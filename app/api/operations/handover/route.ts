import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { requireRole } from '@/lib/auth-guard'
import { isBucket } from '@/lib/buckets'
import { selectPendingGames, loadRoster, distribute } from '@/lib/reassign-core'
import { sourceBreakdowns, perEvaluatorPlatform, insertOperationRun, type DistSnapshot } from '@/lib/operation-runs'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Handover, DB-native (replaces the n8n "Handover" / "handover-puzzle" flows that
// mutated Smartsheet). When an evaluator goes on leave for a date window, their
// still-pending games assigned within that window are redistributed to everyone
// currently available in the bucket.
//
// This route no longer commits. It is now the SUBMIT step of an approval workflow:
//   dryRun: true  → live preview (candidate pool + would-be distribution). No writes.
//   dryRun: false → create a PENDING operation_runs request + snapshot. Still NO game
//                   changes — a manager approves it via /api/operations/handover/resolve,
//                   which recomputes and actually redistributes.

interface Body {
  evaluator_name?: string
  category?: string
  sheet_type?: string // alias for category
  start_date?: string
  end_date?: string
  dryRun?: boolean
}

export async function POST(req: NextRequest) {
  // Managers submit for anyone; evaluators may only submit their OWN handover.
  const guard = await requireRole(['admin', 'moderator', 'evaluator'])
  if (guard) return guard

  const session = await getServerSession(authOptions)
  const isEvaluator = session?.user?.role === 'evaluator'

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
  // An evaluator can only hand over their own games — ignore any body-supplied name.
  const from = isEvaluator
    ? (session?.user?.name || '').trim()
    : String(body.evaluator_name ?? '').trim()
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
    const { by_platform, by_date } = sourceBreakdowns(candidates)

    // Everyone currently available in this bucket, minus the person leaving.
    const roster = await loadRoster({ category, onlyAvailable: true })
    const { assignment, perEvaluator } = candidates.length
      ? distribute(candidates, roster, from)
      : { assignment: new Map<number, string>(), perEvaluator: {} as Record<string, number> }
    const per_evaluator_platform = perEvaluatorPlatform(candidates, assignment)

    const snapshot: DistSnapshot = {
      candidate_count: candidates.length,
      assignable: assignment.size,
      unassignable: candidates.length - assignment.size,
      per_evaluator: perEvaluator,
      per_evaluator_platform,
      by_platform, by_date,
      dryRun: true,
    }

    if (dryRun) {
      return NextResponse.json({ ok: true, category, from, start_date: body.start_date, end_date: body.end_date, ...snapshot })
    }

    // Submit: persist a pending request. No game_evaluations / handover_requests /
    // assignment_history writes here — those happen on approve.
    const session = await getServerSession(authOptions)
    const runId = await insertOperationRun({
      kind: 'handover', category, fromEvaluator: from, status: 'pending',
      params: { start_date: body.start_date, end_date: body.end_date },
      snapshot, gameCount: assignment.size,
      submittedBy: session?.user?.email ?? 'manual',
    })

    return NextResponse.json({
      ok: true, submitted: true, run_id: runId, status: 'pending',
      category, from, start_date: body.start_date, end_date: body.end_date, ...snapshot,
    })
  } catch (err) {
    if (err instanceof Error && err.message === 'evaluator list empty') {
      return NextResponse.json({ error: 'no available evaluators to hand over to' }, { status: 409 })
    }
    console.error('POST /api/operations/handover error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
