import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { ensureRecordCode } from '@/lib/file-codes'

export const dynamic = 'force-dynamic'

// POST /api/evaluations/record-code { gameId } -> { code: string | null }
//
// Returns the game's record file code, creating it on first ask. This covers games whose
// bucket was Confirmed before codes existed, or whose code write failed at confirm time.
// A code is only made for a game with at least one Confirmed bucket; otherwise (or for an
// unknown game) the answer is null and nothing is written.
export async function POST(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  let body: { gameId?: unknown } = {}
  try { body = await req.json() } catch { /* handled below */ }
  const gameId = typeof body.gameId === 'string' ? body.gameId.trim() : ''
  if (!gameId) return NextResponse.json({ error: 'gameId is required' }, { status: 400 })

  const noStore = { headers: { 'Cache-Control': 'no-store' } }
  try {
    const confirmed = await sql`
      SELECT 1 AS ok FROM game_evaluations
      WHERE game_id = ${gameId}
        AND (record_5min_confirmed_at IS NOT NULL OR record_20min_confirmed_at IS NOT NULL)
      LIMIT 1`
    if (confirmed.length === 0) return NextResponse.json({ code: null }, noStore)
    const code = await ensureRecordCode(gameId)
    return NextResponse.json({ code }, noStore)
  } catch (err) {
    console.error('POST /api/evaluations/record-code error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
