import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireRole } from '@/lib/auth-guard'

function verifyWebhookSecret(req: NextRequest) {
  const secret = process.env.WEBHOOK_SECRET
  return !!secret && req.headers.get('x-webhook-secret') === secret
}

// POST /api/smartsheet-sheets/refresh
//
// Two modes:
//
// 1. Called by DASHBOARD (manager session) → forwards to n8n webhook to trigger refresh
//    Body: {} (empty — just triggers n8n)
//    Returns: { triggered: true }
//
// 2. Called by N8N after fetching Smartsheet data → updates cache
//    Headers: x-webhook-secret
//    Body: [{ sheet_name, row_count, col_count }, ...]
//    Returns: { ok: true }

export async function POST(req: NextRequest) {
  // n8n callback: update cache
  if (verifyWebhookSecret(req)) {
    const sheets: Array<{ sheet_name: string; row_count: number; col_count: number }> = await req.json()

    for (const s of sheets) {
      await sql`
        UPDATE smartsheet_sheets
        SET row_count = ${s.row_count}, col_count = ${s.col_count}, updated_at = NOW()
        WHERE sheet_name = ${s.sheet_name}
      `
    }
    return NextResponse.json({ ok: true, updated: sheets.map(s => s.sheet_name) })
  }

  // Dashboard trigger: forward to n8n
  const guard = await requireRole('manager')
  if (guard) return guard

  const webhookUrl = process.env.WEBHOOK_SMARTSHEET_REFRESH
  if (!webhookUrl) {
    return NextResponse.json({ error: 'WEBHOOK_SMARTSHEET_REFRESH not configured' }, { status: 503 })
  }

  // Read current sheet_ids to pass to n8n
  const sheets = await sql`SELECT sheet_name, sheet_id FROM smartsheet_sheets`

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sheets }),
    signal: AbortSignal.timeout(5000),
  })

  if (!res.ok) return NextResponse.json({ error: 'n8n webhook failed' }, { status: 502 })
  return NextResponse.json({ triggered: true })
}
