import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireManager } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import {
  classifyTag, resolveConfirm, TRENDS_FIELD, SYNC_USER,
  type ExistingTag, type PendingTag, type SyncResult,
} from '@/lib/playtest-tags'

export const dynamic = 'force-dynamic'

// POST /api/playtest-tags/confirm — sync one game's pending Trends tags into
// Signal Sense. Runs in a transaction so a failure leaves every tag of the game
// pending rather than half-applied. `overwrite` carries the conflict ids whose
// playtest sub-value should replace Signal Sense's.
export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  let body: { game_id?: string; overwrite?: number[] }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const gameId = (body.game_id || '').trim()
  if (!gameId) return NextResponse.json({ error: 'game_id required' }, { status: 400 })
  const overwrite = new Set((body.overwrite || []).filter(n => Number.isInteger(n)))

  const session = process.env.SKIP_AUTH === 'true' ? null : await getServerSession(authOptions)
  const admin = session?.user?.email || 'skip-auth@local'

  const results: { id: number; result: SyncResult }[] = []

  await sql.begin(async tx => {
    const pending = await tx`
      SELECT id, field_value, sub_value_id
      FROM playtest_tags
      WHERE game_id = ${gameId} AND status = 'pending'
      ORDER BY id
    ` as unknown as PendingTag[]
    if (pending.length === 0) return

    const theirs = await tx`
      SELECT field_value, sub_value_id
      FROM custom_field_values
      WHERE game_id = ${gameId} AND field_name = ${TRENDS_FIELD}
    ` as unknown as ExistingTag[]
    const byValue = new Map(theirs.map(t => [t.field_value, t]))

    for (const p of pending) {
      const action = classifyTag(p, byValue.get(p.field_value))
      const outcome = resolveConfirm(action, overwrite.has(p.id))

      if (outcome.write === 'insert') {
        await tx`
          INSERT INTO custom_field_values
            (game_id, field_name, field_value, sub_value_id, created_by, updated_by)
          VALUES (${gameId}, ${TRENDS_FIELD}, ${p.field_value}, ${p.sub_value_id}, ${SYNC_USER}, ${SYNC_USER})
          ON CONFLICT (game_id, field_name, field_value) DO NOTHING
        `
      } else if (outcome.write === 'update') {
        await tx`
          UPDATE custom_field_values
          SET sub_value_id = ${p.sub_value_id}, updated_by = ${SYNC_USER}, updated_at = now()
          WHERE game_id = ${gameId} AND field_name = ${TRENDS_FIELD} AND field_value = ${p.field_value}
        `
      }

      await tx`
        UPDATE playtest_tags
        SET status = ${outcome.status}, sync_result = ${outcome.result},
            confirmed_by = ${admin}, confirmed_at = now()
        WHERE id = ${p.id}
      `
      results.push({ id: p.id, result: outcome.result })
    }
  })

  return NextResponse.json({ ok: true, results })
}
