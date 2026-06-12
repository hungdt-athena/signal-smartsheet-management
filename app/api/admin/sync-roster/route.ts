import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Mirror the "Evaluator List" Google Sheet into evaluator_roster (list_type
// 'initial'). n8n POSTs the sheet rows (keyed by column title) before each
// assign run, so the DB roster always matches what managers edit in the sheet.

function hasWebhookSecret(req: NextRequest): boolean {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

export async function POST(req: NextRequest) {
  if (!hasWebhookSecret(req)) {
    const guard = await requireRole(['admin'])
    if (guard) return guard
  }

  let body: { rows?: Record<string, unknown>[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  if (!Array.isArray(body.rows)) {
    return NextResponse.json({ error: 'rows array required' }, { status: 400 })
  }

  let synced = 0
  try {
    for (let i = 0; i < body.rows.length; i++) {
      const row = body.rows[i]
      const name = String(row['Evaluator Name'] ?? '').trim()
      if (!name) continue
      const available = String(row['Today Available'] ?? '').trim().toLowerCase() === 'yes'
      const platform = String(row['Game Platform'] ?? 'all').trim().toLowerCase() || 'all'
      const weight = Number(row['Weight']) || 100
      const category = String(row['Game Category'] ?? '').trim().toLowerCase() || null
      await sql`
        INSERT INTO evaluator_roster (list_type, name, today_available, game_platform, game_category, weight, sort_order, updated_at)
        VALUES ('initial', ${name}, ${available}, ${platform}, ${category}, ${weight}, ${i}, NOW())
        ON CONFLICT (list_type, name) DO UPDATE SET
          today_available = EXCLUDED.today_available,
          game_platform   = EXCLUDED.game_platform,
          game_category   = EXCLUDED.game_category,
          weight          = EXCLUDED.weight,
          sort_order      = EXCLUDED.sort_order,
          updated_at      = NOW()
      `
      synced++
    }

    return NextResponse.json({ ok: true, synced })
  } catch (e) {
    console.error('sync-roster DB error:', e)
    return NextResponse.json({ error: 'DB write failed', detail: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
