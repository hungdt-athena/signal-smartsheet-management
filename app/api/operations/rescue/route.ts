import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { requireManager } from '@/lib/auth-guard'
import { isBucket } from '@/lib/buckets'
import { commitAssignment, distribute, type Candidate } from '@/lib/reassign-core'
import { scanRoster, selectStaleGames } from '@/lib/rescue-core'
import { classifyRoster, waterfillQuotas, type RescueRow } from '@/lib/rescue-rules'
import { clampRescueConfig, type RescueConfig } from '@/lib/rescue-config'
import { loadRescueConfig, saveRescueConfig } from '@/lib/rescue-config-db'
import { writeAssignmentHistory } from '@/lib/assignment-history'
import { sourceBreakdowns, perEvaluatorPlatform, insertOperationRun } from '@/lib/operation-runs'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Stale-backlog rescue. Where /api/operations/reassign moves ONE hand-picked
// evaluator's games, this scans the whole bucket, decides who is sitting on stale
// games and who has earned the right to take them (rules in lib/rescue-core.ts), and
// then reuses the reassign machinery to move them.
//
// Human in the loop by design: nothing moves without an explicit commit. There is no
// cron entry point — 'scan' and 'preview' are read-only, 'commit' is the approval.
//
//   POST { action: 'scan'    } → per-evaluator numbers + role + reason (persists config)
//   POST { action: 'preview' } → the pooled distribution the commit would produce
//   POST { action: 'commit'  } → moves the games; writes assignment_history
//                                (action='reassign') + one operation_runs row per source
//
// Admin only, read and write: unlike Reassign, evaluators never see this tab, because
// the scan exposes every teammate's backlog side by side.

interface Body {
  action?: string
  category?: string
  config?: Partial<RescueConfig>
  sources?: string[] // subset of the scan's SOURCE rows to pull from
  receivers?: string[] // subset of the scan's RECEIVER rows to hand games to
}

// The scan is always recomputed server-side and the client's picks are intersected
// with it: a stale browser tab must never be able to pull from someone who no longer
// qualifies, or feed games to someone whose own shelf has since gone stale.
function pickRoles(rows: RescueRow[], names: string[] | undefined, role: 'source' | 'receiver'): RescueRow[] {
  const eligible = rows.filter(r => r.role === role)
  if (!names) return eligible
  const wanted = new Set(names.map(n => String(n).trim()).filter(Boolean))
  return eligible.filter(r => wanted.has(r.name))
}

export async function GET(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const category = (req.nextUrl.searchParams.get('category') ?? '').trim().toLowerCase()
  if (!isBucket(category)) {
    return NextResponse.json({ error: 'category must be puzzle, arcade or simulation' }, { status: 400 })
  }

  try {
    const config = await loadRescueConfig()
    const rows = classifyRoster(await scanRoster({ category, config }), config)
    return NextResponse.json(
      { ok: true, category, config, rows },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    console.error('GET /api/operations/rescue error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
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

  const action = String(body.action ?? '').trim().toLowerCase()
  if (action !== 'scan' && action !== 'preview' && action !== 'commit') {
    return NextResponse.json({ error: "action must be 'scan', 'preview' or 'commit'" }, { status: 400 })
  }
  const category = String(body.category ?? '').trim().toLowerCase()
  if (!isBucket(category)) {
    return NextResponse.json({ error: 'category must be puzzle, arcade or simulation' }, { status: 400 })
  }
  const config = clampRescueConfig(body.config)

  try {
    // Scan runs on every action: preview and commit must both be judged against the
    // live state, not against whatever the browser last saw.
    const rows = classifyRoster(await scanRoster({ category, config }), config)

    if (action === 'scan') {
      // The knobs the manager just scanned with become the stored defaults.
      await saveRescueConfig(config)
      return NextResponse.json({ ok: true, action, category, config, rows })
    }

    const sources = pickRoles(rows, body.sources, 'source')
    const receivers = pickRoles(rows, body.receivers, 'receiver')

    if (sources.length === 0) {
      return NextResponse.json({ ok: true, action, category, config, rows, reason: 'no_sources', candidate_count: 0 })
    }
    if (receivers.length === 0) {
      // Deliberately not a fallback to "whoever is left": dumping stale games on
      // someone who is also behind just renames the holder.
      return NextResponse.json({ ok: true, action, category, config, rows, reason: 'no_receivers', candidate_count: 0 })
    }

    // Pull each source's stale games, capped at the pull its role computed.
    const perSource: { name: string; candidates: Candidate[] }[] = []
    for (const s of sources) {
      const candidates = await selectStaleGames({ category, from: s.name, config, limit: s.pull })
      if (candidates.length > 0) perSource.push({ name: s.name, candidates })
    }
    const allCandidates = perSource.flatMap(s => s.candidates)
    const { by_platform: byPlatform, by_date: byDate } = sourceBreakdowns(allCandidates)

    if (allCandidates.length === 0) {
      return NextResponse.json({ ok: true, action, category, config, rows, reason: 'no_stale_games', candidate_count: 0 })
    }

    // Level the receivers' shelves, then let the existing weighted, platform-aware
    // allocator place the individual games — quota becomes its weight, so the split it
    // produces is the water-filled one.
    const quotas = waterfillQuotas(
      receivers.map(r => ({ name: r.name, platform: r.platform, weight: r.weight, pending: r.pending })),
      allCandidates.length,
    )
    const targets = receivers
      .filter(r => (quotas[r.name] ?? 0) > 0)
      .map(r => ({ name: r.name, game_platform: r.platform ?? 'all', weight: quotas[r.name] }))
    const { assignment, perEvaluator } = distribute(allCandidates, targets, null)
    const perEvalPlatform = perEvaluatorPlatform(allCandidates, assignment)

    // Per-source view of the same run: who lost how many, and where those games went.
    // Each source gets its OWN slice of the assignment — passing the whole map to
    // perEvaluatorPlatform() with a filtered candidate list would silently bucket every
    // other source's games as 'other'.
    const perSourceView = perSource.map(s => {
      const ids = new Set(s.candidates.map(c => c.id))
      const sub = new Map<number, string>()
      assignment.forEach((name, id) => { if (ids.has(id)) sub.set(id, name) })
      const split: Record<string, number> = {}
      sub.forEach(name => { split[name] = (split[name] || 0) + 1 })
      return { from: s.name, pulled: s.candidates.length, per_evaluator: split, candidates: s.candidates, sub }
    })
    // Client-facing shape: the internal Maps stay on the server.
    const sourceSplit = perSourceView.map(s => ({ from: s.from, pulled: s.pulled, per_evaluator: s.per_evaluator }))

    const payload = {
      ok: true as const,
      action,
      category,
      config,
      rows,
      candidate_count: allCandidates.length,
      assignable: assignment.size,
      unassignable: allCandidates.length - assignment.size,
      per_evaluator: perEvaluator,
      per_evaluator_platform: perEvalPlatform,
      by_platform: byPlatform,
      by_date: byDate,
      quotas,
      per_source: sourceSplit,
    }

    if (action === 'preview') {
      return NextResponse.json({ ...payload, dryRun: true })
    }

    // --- commit (the approval step) ---
    const idToGameId = new Map(allCandidates.map(c => [c.id, c.game_id]))
    await commitAssignment(assignment, idToGameId)

    const session = await getServerSession(authOptions)
    const createdBy = session?.user?.email ?? 'manual'

    for (const s of perSourceView) {
      // One assignment_history row per (receiver, source) pair, written as 'reassign' so
      // it lands in the Assign tab's history alongside every other movement — a rescue
      // IS a reassign as far as game accounting goes.
      const gameIdsByReceiver = new Map<string, string[]>()
      s.sub.forEach((name, id) => {
        const arr = gameIdsByReceiver.get(name) || []
        arr.push(idToGameId.get(id)!)
        gameIdsByReceiver.set(name, arr)
      })
      await writeAssignmentHistory({
        category,
        action: 'reassign',
        perEvaluator: gameIdsByReceiver,
        fromEvaluator: s.from,
        createdBy,
      })

      // One operation_runs row per source, kind='rescue', so the Rescue tab's history
      // reads like the Reassign one (from → targets → games) and Details re-renders that
      // source's own slice of the run.
      const stats = rows.find(r => r.name === s.from)
      const moved = s.sub.size
      const snapshot = {
        candidate_count: s.pulled,
        assigned: moved,
        unassignable: s.pulled - moved,
        per_evaluator: s.per_evaluator,
        per_evaluator_platform: perEvaluatorPlatform(s.candidates, s.sub),
        ...sourceBreakdowns(s.candidates),
        dryRun: false,
      }
      await insertOperationRun({
        kind: 'rescue',
        category,
        fromEvaluator: s.from,
        status: 'committed',
        params: {
          mode: 'rescue',
          stale_days: config.staleDays,
          cooldown_days: config.cooldownDays,
          source_min_backlog: config.sourceMinBacklog,
          receiver_max_stale: config.receiverMaxStale,
          active_days: config.activeDays,
          // Snapshot of why this person qualified, so a later review does not have to
          // reconstruct the backlog they had at the time.
          source_pending: stats?.pending ?? null,
          source_stale: stats?.stale ?? null,
          selected_evaluators: Object.keys(s.per_evaluator),
        },
        snapshot,
        gameCount: moved,
        submittedBy: createdBy,
      })
    }

    return NextResponse.json({ ...payload, dryRun: false, assigned: assignment.size })
  } catch (err) {
    if (err instanceof Error && err.message === 'evaluator list empty') {
      return NextResponse.json({ error: 'no valid target evaluators' }, { status: 409 })
    }
    console.error('POST /api/operations/rescue error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
