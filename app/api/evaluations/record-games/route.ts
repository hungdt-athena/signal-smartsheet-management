import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { recordViewRows, toYtGame } from '@/lib/record-view-games'

export const dynamic = 'force-dynamic'

// GET /api/evaluations/record-games
//
// Every game in the Record view as the YouTube matcher needs it (title, bucket,
// recorder, first-assigned day), whatever batch or recorder the page shows. The
// Record tab resolves uploads over this list, not over its own filtered rows:
// matched against one batch, the uploads of other batches' games look unclaimed
// and a game in the batch takes them.
export async function GET() {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const rows = await recordViewRows()
    return NextResponse.json(rows.map(toYtGame), { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('GET /api/evaluations/record-games error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
