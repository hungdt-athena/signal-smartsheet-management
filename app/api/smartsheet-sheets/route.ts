import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireRole } from '@/lib/auth-guard'

// GET /api/smartsheet-sheets — read cached stats
export async function GET() {
  const guard = await requireRole('manager')
  if (guard) return guard

  const rows = await sql`
    SELECT sheet_name, sheet_id, categories_list, row_count, col_count, max_rows, remaining, updated_at
    FROM smartsheet_sheets
    ORDER BY id
  `
  return NextResponse.json(rows)
}

// PATCH /api/smartsheet-sheets — update sheet_id for a sheet
export async function PATCH(req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const { sheet_name, sheet_id } = await req.json()
  if (!sheet_name || !sheet_id) {
    return NextResponse.json({ error: 'sheet_name and sheet_id required' }, { status: 400 })
  }

  await sql`
    UPDATE smartsheet_sheets SET sheet_id = ${sheet_id}
    WHERE sheet_name = ${sheet_name}
  `
  return NextResponse.json({ ok: true })
}
