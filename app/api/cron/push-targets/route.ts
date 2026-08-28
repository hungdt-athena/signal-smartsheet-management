// app/api/cron/push-targets/route.ts — the daily pipeline's genre list.
//
// n8n used to derive this from the "N8N configs" Google Sheet, which meant the
// pipeline's shape lived outside the repo and could not be tested. Now n8n asks
// the app: GET here, loop `targets`, call push-evaluations + assign-evaluators for
// each. `genres` carries the full picture (on/off, how many people are available)
// so a skipped genre is explainable from the response alone.
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { loadGenreTargets } from '@/lib/genre-config-db'

export const dynamic = 'force-dynamic'

function hasWebhookSecret(req: NextRequest): boolean {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

export async function GET(req: NextRequest) {
  if (!hasWebhookSecret(req)) {
    const guard = await requireAdmin()
    if (guard) return guard
  }

  try {
    const genres = await loadGenreTargets()
    return NextResponse.json(
      { ok: true, targets: genres.filter(g => g.active).map(g => g.bucket), genres },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    console.error('GET /api/cron/push-targets error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
