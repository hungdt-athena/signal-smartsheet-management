import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireRole } from '@/lib/auth-guard'

// GET /api/smartsheet-sheets — read cached stats
export async function GET() {
  const guard = await requireRole('manager')
  if (guard) return guard

  const rows = await sql`
    SELECT sheet_name, sheet_id, row_count, col_count, max_rows, remaining, updated_at
    FROM smartsheet_sheets
    ORDER BY id
  `
  return NextResponse.json(rows)
}

// PATCH /api/smartsheet-sheets — update sheet_id in DB and sync to Google Sheets via n8n
export async function PATCH(req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const { sheet_name, sheet_id } = await req.json()
  if (!sheet_name || !sheet_id) {
    return NextResponse.json({ error: 'sheet_name and sheet_id required' }, { status: 400 })
  }

  // 1. Save to DB
  await sql`UPDATE smartsheet_sheets SET sheet_id = ${sheet_id} WHERE sheet_name = ${sheet_name}`

  // 2. Sync to Google Sheets via n8n webhook (non-blocking — fire and forget)
  const webhookUrl = process.env.WEBHOOK_UPDATE_SHEET_CONFIG
  if (webhookUrl) {
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet_name, sheet_id }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {}) // silent fail — DB is source of truth
  }

  // 3. Trigger capacity refresh so the new sheet_id is immediately reflected
  const refreshUrl = process.env.WEBHOOK_SMARTSHEET_REFRESH
  if (refreshUrl) {
    fetch(refreshUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    }).catch(() => {})
  }

  return NextResponse.json({ ok: true })
}
