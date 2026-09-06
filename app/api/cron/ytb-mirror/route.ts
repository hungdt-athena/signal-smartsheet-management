import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { mirrorYtbUploads } from '@/lib/ytb-mirror'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST /api/cron/ytb-mirror — pull sheet `ytb_uploaded` into the ytb_uploads table.
//
// Wire this into n8n on a schedule (every 10-15 min is plenty; recording happens
// after final conclusion, so nothing downstream needs the minute). Keeping it warm
// means GET /api/ytb-uploads almost never has to re-pull the sheet itself.
//
// It is an optimisation, not a dependency: the read path self-heals when the
// mirror goes stale. If this cron is never wired, reads stay correct and merely
// pay the sheet latency once every 15 minutes.
//
// Auth: x-webhook-secret (n8n cron) OR admin session — same idiom as report-rollup.

function hasWebhookSecret(req: NextRequest): boolean {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

export async function POST(req: NextRequest) {
  if (!hasWebhookSecret(req)) {
    const guard = await requireAdmin()
    if (guard) return guard
  }

  try {
    const result = await mirrorYtbUploads()
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    console.error('[cron/ytb-mirror]', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 502 })
  }
}
