import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireManager } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import { applyExistingTagChange, type ExistingTagOutcome } from '@/lib/playtest-tags-existing'

export const dynamic = 'force-dynamic'

// POST /api/playtest-tags/remove — take a confirmed Trends tag back out of
// Signal Sense and record who did it. Called from the Tagging tab, which knows
// tags by their playtest_tags id.
//
// The removal itself is applyExistingTagChange's, shared with the by-pair route
// the evaluation modal uses. This route only resolves the id to the (game,
// value) pair that is the tag's identity in Signal Sense; letting the two
// surfaces carry their own copy of the rule is how they drift apart.
export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  let body: { id?: number }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const id = body.id
  // typeof first: Number.isInteger narrows nothing, so `id` would stay
  // `number | undefined` and cannot be bound into a query.
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }

  const session = process.env.SKIP_AUTH === 'true' ? null : await getServerSession(authOptions)
  const admin = session?.user?.email || 'skip-auth@local'

  // Returned out of the transaction rather than assigned to a closure variable:
  // TypeScript cannot see the callback's writes and narrows such a variable to
  // `null`, so reading a field off it afterwards fails to compile.
  const result = await sql.begin(async txRaw => {
    const tx = txRaw as unknown as typeof sql

    const rows = await tx`
      SELECT id, game_id, field_value FROM playtest_tags
      WHERE id = ${id} AND status = 'synced'
      LIMIT 1
    `
    if (rows.length === 0) {
      return { status: 404, error: 'No synced tag with that id — only a confirmed tag can be removed.' }
    }
    const tag = rows[0] as { id: number; game_id: string; field_value: string }

    return applyExistingTagChange(tx, {
      gameId: tag.game_id, fieldValue: tag.field_value, action: 'remove', admin,
    })
  }) as unknown as { status?: number; error?: string; outcome?: ExistingTagOutcome }

  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true, outcome: result.outcome })
}
