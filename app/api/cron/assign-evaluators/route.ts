import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { assignGames } from '@/lib/assign-evaluators'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// DB replacement for the "auto-assign-game-evaluator" n8n flow: distribute
// unassigned game_evaluations rows among today's available evaluators
// (evaluator_roster, list_type 'initial') by weight, platform-aware.
// Run AFTER /api/cron/push-evaluations and /api/admin/sync-roster.

const CATEGORIES = ['puzzle', 'arcade', 'simulation']

function hasWebhookSecret(req: NextRequest): boolean {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

export async function POST(req: NextRequest) {
  if (!hasWebhookSecret(req)) {
    const guard = await requireRole(['admin'])
    if (guard) return guard
  }

  let body: { category?: string; dryRun?: boolean } | null
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  const category = body.category || ''
  if (!CATEGORIES.includes(category)) {
    return NextResponse.json({ error: `category must be one of ${CATEGORIES.join(', ')}` }, { status: 400 })
  }

  try {
    // Roster: available initial evaluators whose category matches (blank = any).
    // Unassigned rows of this category, with the game's platform.
    const [roster, games] = await Promise.all([
      sql`
      SELECT name, game_platform, weight
      FROM evaluator_roster
      WHERE list_type = 'initial'
        AND today_available = TRUE
        AND (game_category IS NULL OR game_category = '' OR lower(game_category) = ${category})
      ORDER BY sort_order NULLS LAST, name
    `,
      sql`
      SELECT ge.id, gi.os
      FROM game_evaluations ge
      JOIN game_info gi ON ge.game_id = gi.game_id
      WHERE ge.category_group = ${category}
        AND ge.initial_evaluator IS NULL
      ORDER BY ge.imported_at
    `,
    ])

    if (games.length === 0) {
      return NextResponse.json({ ok: true, dryRun: !!body.dryRun, category, assigned: 0, per_evaluator: {} })
    }
    if (roster.length === 0) {
      return NextResponse.json({ error: 'no available evaluators in roster' }, { status: 409 })
    }

    let assignment: Map<number, string>
    try {
      assignment = assignGames(
        games.map(g => ({ id: g.id, os: g.os })),
        roster.map(r => ({ name: r.name, platform: r.game_platform, weight: r.weight })),
      )
    } catch (e) {
      if (e instanceof Error && e.message === 'evaluator list empty') {
        return NextResponse.json({ error: 'no available evaluators in roster' }, { status: 409 })
      }
      throw e
    }

    if (!body.dryRun) {
      // One UPDATE per evaluator (grouped), assigned_date = today VN.
      const byEvaluator = new Map<string, number[]>()
      assignment.forEach((name, id) => {
        const ids = byEvaluator.get(name) || []
        ids.push(id)
        byEvaluator.set(name, ids)
      })
      for (const [name, ids] of Array.from(byEvaluator.entries())) {
        await sql`
          UPDATE game_evaluations
          SET initial_evaluator = ${name},
              assigned_date = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
          WHERE id IN ${sql(ids)}
        `
      }
    }

    const perEvaluator: Record<string, number> = {}
    assignment.forEach((name) => { perEvaluator[name] = (perEvaluator[name] || 0) + 1 })

    return NextResponse.json({
      ok: true,
      dryRun: !!body.dryRun,
      category,
      assigned: assignment.size,
      unassigned: games.length - assignment.size,
      per_evaluator: perEvaluator,
    })
  } catch (err) {
    console.error('POST /api/cron/assign-evaluators error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
