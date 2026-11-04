import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { ensureDemoCode } from '@/lib/file-codes'

export const dynamic = 'force-dynamic'

// POST /api/evaluations/demo-code { gameId } -> { code: string | null }
//
// Returns the game's demo file code, creating it on first ask. This covers games that were
// marked List_Idea before codes existed, or whose code write failed at save time.
// null = no game_info row for that id.
export async function POST(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  let body: { gameId?: unknown } = {}
  try { body = await req.json() } catch { /* handled below */ }
  const gameId = typeof body.gameId === 'string' ? body.gameId.trim() : ''
  if (!gameId) return NextResponse.json({ error: 'gameId is required' }, { status: 400 })

  try {
    const code = await ensureDemoCode(gameId)
    return NextResponse.json({ code }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('POST /api/evaluations/demo-code error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
