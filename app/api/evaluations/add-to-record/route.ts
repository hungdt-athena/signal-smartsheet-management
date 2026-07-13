import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

const BUCKETS = ['5min', '20min'] as const
const CATEGORIES = ['puzzle', 'arcade', 'simulation'] as const

// Pull a game into a record bucket by game_id — even if it has no evaluation
// row yet (a catalog game never evaluated, or evaluated in another batch).
// The eval row is created lazily (mirroring cron/push-evaluations) so the
// record flow can operate on it. Returns the eval `id`.
export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'moderator'])
  if (guard) return guard
  try {
    const { game_id, category_group, bucket } = await req.json()
    if (!game_id) {
      return NextResponse.json({ error: 'game_id is required' }, { status: 400 })
    }
    if (!CATEGORIES.includes(category_group)) {
      return NextResponse.json({ error: 'invalid category_group' }, { status: 400 })
    }
    if (!BUCKETS.includes(bucket)) {
      return NextResponse.json({ error: 'bucket must be 5min or 20min' }, { status: 400 })
    }

    // Game must exist in the catalog. (Search already enforces this, but guard
    // against a stale/forged game_id.)
    const game = await sql`SELECT game_id FROM game_info WHERE game_id = ${game_id} LIMIT 1`
    if (game.length === 0) {
      return NextResponse.json({ error: 'Game not found in catalog' }, { status: 404 })
    }

    // Create the eval row if this game has never been evaluated in this category.
    await sql`
      INSERT INTO game_evaluations (game_id, category_group)
      VALUES (${game_id}, ${category_group})
      ON CONFLICT (game_id, category_group) DO NOTHING
    `

    const result = await sql`
      UPDATE game_evaluations
      SET record_bucket = ${bucket}
      WHERE game_id = ${game_id} AND category_group = ${category_group}
      RETURNING id
    `
    return NextResponse.json({ ok: true, id: result[0]?.id })
  } catch (err) {
    console.error('POST /api/evaluations/add-to-record error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
