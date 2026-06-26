import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'moderator'])
  if (guard) return guard
  try {
    const { ids } = await req.json()
    const list = Array.isArray(ids) ? ids.map(Number).filter(Boolean) : []
    if (list.length === 0) {
      return NextResponse.json({ error: 'ids array is required' }, { status: 400 })
    }
    const result = await sql`
      UPDATE game_evaluations
      SET record_confirmed_at = NOW()
      WHERE id IN ${sql(list)} AND record_confirmed_at IS NULL
    `
    return NextResponse.json({ confirmed: result.count })
  } catch (err) {
    console.error('POST /api/evaluations/confirm-records error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
