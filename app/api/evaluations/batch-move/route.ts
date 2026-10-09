import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { getSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

/** Same as the Short List page size, so "select all shown" always fits. */
export const MAX_MOVE = 500

// Move many games to another batch in one statement (manager tier only).
//
// There is deliberately NO filter on initial/final conclusion: ticking a game that
// already has a final conclusion means the manager wants it moved, and PATCH's
// lock on a finished game does not apply to this explicit bulk action. Only the
// listed ids can change; ids that do not exist simply do not count in `moved`.

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  let body: { ids?: unknown; batch?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  if (body === null || typeof body !== 'object') {
    return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 })
  }

  const batch = typeof body.batch === 'string' ? body.batch.trim() : ''
  if (!batch) return NextResponse.json({ error: 'batch is required' }, { status: 400 })

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return NextResponse.json({ error: 'ids must be a non-empty array' }, { status: 400 })
  }
  if (!body.ids.every(n => Number.isInteger(n) && (n as number) > 0)) {
    return NextResponse.json({ error: 'ids must be positive integers' }, { status: 400 })
  }
  const ids = Array.from(new Set(body.ids as number[]))
  if (ids.length > MAX_MOVE) {
    return NextResponse.json({ error: `Move at most ${MAX_MOVE} games at a time` }, { status: 400 })
  }

  try {
    const actor = process.env.SKIP_AUTH === 'true' ? null : (await getSession())?.user?.name ?? null
    const rows = await sql`
      UPDATE game_evaluations
      SET batch = ${batch}, updated_by = ${actor}, updated_at = NOW()
      WHERE id = ANY(${ids})
      RETURNING id
    `
    return NextResponse.json({ moved: rows.length })
  } catch (err) {
    console.error('POST /api/evaluations/batch-move error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
