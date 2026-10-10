// app/api/assign-setup/run/route.ts — the manual "Push & assign now" button
// behind the Assign tab's breakdown panel.
//
// It runs the daily pipeline by hand, for the genres asked for, in the cron's
// own order: push first (new game_evaluations rows), then assign (hand them
// out). It does NOT reimplement either step — it calls the two cron route
// handlers directly, so a manual run and the 09:00 run cannot drift apart.
//
// Admin-only, like the cron routes it calls: this writes thousands of rows and
// puts games on real people's plates.
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { BUCKETS, isBucket, type Bucket } from '@/lib/buckets'
import { POST as pushEvaluations } from '@/app/api/cron/push-evaluations/route'
import { POST as assignEvaluators } from '@/app/api/cron/assign-evaluators/route'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

interface StepResult { ok: boolean; skipped?: string; [k: string]: unknown }

/** Call a cron handler in-process with a body, and read its JSON back. */
async function call(
  handler: (req: NextRequest) => Promise<Response>,
  url: string,
  body: unknown,
): Promise<StepResult> {
  const res = await handler(new NextRequest(new URL(url, 'http://internal'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
  const json = await res.json().catch(() => ({}))
  return { ok: res.ok, ...json }
}

export async function POST(req: NextRequest) {
  // The session guard runs here and the handlers below re-run their own, so a
  // non-admin cannot reach the writes even if this check were removed.
  const guard = await requireAdmin()
  if (guard) return guard

  let body: { genres?: unknown; exclude?: unknown; dryRun?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  // Walked in BUCKETS order whatever order they were sent in: a game goes to the
  // first genre that pushes it (see push-evaluations), so the order is the split.
  const asked: Bucket[] = Array.isArray(body.genres) ? body.genres.filter(isBucket) : []
  const genres: Bucket[] = BUCKETS.filter(b => asked.includes(b))
  if (genres.length === 0) {
    return NextResponse.json({ error: 'genres is required' }, { status: 400 })
  }
  // Names the operator unticked in the preview, PER GENRE — being off for
  // Puzzle says nothing about Arcade, and the preview's tabs are per genre too.
  // This is a parameter of THIS run only: it never touches evaluator_roster, so
  // tonight's cron still uses the roster as written.
  const rawExclude = (body.exclude && typeof body.exclude === 'object' && !Array.isArray(body.exclude))
    ? body.exclude as Record<string, unknown>
    : {}
  const exclude: Partial<Record<Bucket, string[]>> = {}
  for (const [k, v] of Object.entries(rawExclude)) {
    if (!isBucket(k) || !Array.isArray(v)) continue
    exclude[k] = v.map(x => String(x).trim()).filter(Boolean)
  }
  const dryRun = body.dryRun === true

  const results: Record<string, { pushed: number; assigned: number; skipped?: string; perEvaluator?: Record<string, number> }> = {}

  try {
    for (const category of genres) {
      const push = await call(pushEvaluations, '/api/cron/push-evaluations', { category, dryRun })
      if (!push.ok) {
        return NextResponse.json({ error: `push failed for ${category}`, detail: push }, { status: 502 })
      }
      // A gated genre stops here: assigning into a genre the push just skipped
      // would hand out yesterday's leftovers under the banner of a manual push.
      if (push.skipped) {
        results[category] = { pushed: 0, assigned: 0, skipped: String(push.skipped) }
        continue
      }

      const assign = await call(assignEvaluators, '/api/cron/assign-evaluators',
        { category, dryRun, exclude: exclude[category] ?? [] })
      if (!assign.ok) {
        return NextResponse.json({ error: `assign failed for ${category}`, detail: assign }, { status: 502 })
      }

      results[category] = {
        pushed: Number(push.pushed) || 0,
        assigned: Number(assign.assigned) || 0,
        ...(assign.skipped ? { skipped: String(assign.skipped) } : {}),
        perEvaluator: (assign.per_evaluator as Record<string, number>) ?? {},
      }
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      genres,
      exclude,
      pushed: Object.values(results).reduce((n, r) => n + r.pushed, 0),
      assigned: Object.values(results).reduce((n, r) => n + r.assigned, 0),
      results,
    })
  } catch (err) {
    console.error('POST /api/assign-setup/run error:', err)
    return NextResponse.json({ error: 'Run failed' }, { status: 500 })
  }
}
