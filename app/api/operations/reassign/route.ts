import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { requireManager } from '@/lib/auth-guard'
import { isBucket } from '@/lib/buckets'
import { selectPendingGames, loadRoster, commitAssignment, distribute } from '@/lib/reassign-core'
import { writeAssignmentHistory } from '@/lib/assignment-history'
import { sourceBreakdowns, perEvaluatorPlatform, insertOperationRun } from '@/lib/operation-runs'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Manual re-assign, DB-native (replaces the n8n "Handover-ReAssign-ByDateRange"
// flow that mutated Smartsheet). Move a source evaluator's still-pending games to a
// chosen set of evaluators. The manager narrows the set by a date range and/or a
// max count, and previews the resulting distribution (dryRun) before committing.
//
//   dryRun: true  → preview only. Returns candidate_count; if selected_evaluators
//                   is provided, also returns the would-be per-evaluator split.
//   dryRun: false → commit. selected_evaluators required. Writes game_evaluations
//                   + one assignment_history row per evaluator (action='reassign').

interface Body {
  evaluator_name?: string
  category?: string
  sheet_type?: string // alias for category, kept for the existing UI
  selected_evaluators?: string[]
  evaluator_weights?: Record<string, number> // per-run weight override (does NOT touch the roster)
  start_date?: string
  end_date?: string
  count?: number
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

  const hasRange = !!(body.start_date && body.end_date)
  const count = Number(body.count) > 0 ? Math.floor(Number(body.count)) : null
  if (!hasRange && !count) {
    return NextResponse.json({ error: 'provide a date range (start_date + end_date) and/or count' }, { status: 400 })
  }

  const selected = (body.selected_evaluators || [])
    .map(n => String(n).trim())
    .filter(Boolean)
    .filter(n => n !== from)
  const dryRun = !!body.dryRun

  if (!dryRun && selected.length === 0) {
    return NextResponse.json({ error: 'selected_evaluators must be a non-empty array to commit' }, { status: 400 })
  }

  try {
    const candidates = await selectPendingGames({
      category,
      from,
      startDate: hasRange ? body.start_date : null,
      endDate: hasRange ? body.end_date : null,
      count,
    })

    // Breakdowns of the candidate pool (the games that would move), for the live
    // preview: split by platform and by the day each game was originally assigned.
    const { by_platform: byPlatform, by_date: byDate } = sourceBreakdowns(candidates)

    // Preview with no targets chosen yet: report the candidate pool + breakdowns.
    if (dryRun && selected.length === 0) {
      return NextResponse.json({ ok: true, dryRun: true, category, from, candidate_count: candidates.length, per_evaluator: {}, by_platform: byPlatform, by_date: byDate })
    }

    if (candidates.length === 0) {
      return NextResponse.json({ ok: true, dryRun, category, from, candidate_count: 0, assigned: 0, per_evaluator: {}, by_platform: byPlatform, by_date: byDate })
    }

    // Enrich chosen targets with roster platform/weight (default all/100 if a picked
    // name isn't registered in this bucket's roster).
    const roster = await loadRoster({ category, names: selected })
    const rosterByName = new Map(roster.map(r => [r.name, r]))
    const weightOverride = body.evaluator_weights ?? {}
    const targets = selected.map(name => ({
      name,
      game_platform: rosterByName.get(name)?.game_platform ?? 'all',
      // UI weight override wins over the roster weight for this run only.
      weight: Number(weightOverride[name]) > 0 ? Number(weightOverride[name]) : (rosterByName.get(name)?.weight ?? 100),
    }))

    const { assignment, perEvaluator } = distribute(candidates, targets, from)

    // Per-evaluator platform split of the resulting distribution.
    const perEvalPlatform = perEvaluatorPlatform(candidates, assignment)

    if (dryRun) {
      return NextResponse.json({
        ok: true, dryRun: true, category, from,
        candidate_count: candidates.length,
        assignable: assignment.size,
        unassignable: candidates.length - assignment.size,
        per_evaluator: perEvaluator,
        per_evaluator_platform: perEvalPlatform,
        by_platform: byPlatform, by_date: byDate,
      })
    }

    const idToGameId = new Map(candidates.map(c => [c.id, c.game_id]))
    const perEvaluatorGameIds = await commitAssignment(assignment, idToGameId)

    const session = await getServerSession(authOptions)
    const createdBy = session?.user?.email ?? 'manual'
    await writeAssignmentHistory({
      category,
      action: 'reassign',
      perEvaluator: perEvaluatorGameIds,
      fromEvaluator: from,
      createdBy,
    })

    // Record the operation as one committed run (with its full snapshot for Details).
    const snapshot = {
      candidate_count: candidates.length,
      assigned: assignment.size,
      unassignable: candidates.length - assignment.size,
      per_evaluator: perEvaluator,
      per_evaluator_platform: perEvalPlatform,
      by_platform: byPlatform, by_date: byDate,
      dryRun: false,
    }
    await insertOperationRun({
      kind: 'reassign', category, fromEvaluator: from, status: 'committed',
      params: {
        mode: hasRange && count ? 'range+quantity' : hasRange ? 'range' : 'quantity',
        start_date: hasRange ? body.start_date : null,
        end_date: hasRange ? body.end_date : null,
        count: count ?? null,
        selected_evaluators: selected,
        evaluator_weights: body.evaluator_weights ?? {},
      },
      snapshot, gameCount: assignment.size, submittedBy: createdBy,
    })

    return NextResponse.json({
      ok: true, dryRun: false, category, from,
      candidate_count: candidates.length,
      assigned: assignment.size,
      unassignable: candidates.length - assignment.size,
      per_evaluator: perEvaluator,
      per_evaluator_platform: perEvalPlatform,
      by_platform: byPlatform, by_date: byDate,
    })
  } catch (err) {
    if (err instanceof Error && err.message === 'evaluator list empty') {
      return NextResponse.json({ error: 'no valid target evaluators' }, { status: 409 })
    }
    console.error('POST /api/operations/reassign error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
