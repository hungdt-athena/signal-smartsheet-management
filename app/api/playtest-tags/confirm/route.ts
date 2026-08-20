import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireManager } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import { readNotes, type PendingTag } from '@/lib/playtest-tags'
import { syncTags, type SyncOutput } from '@/lib/playtest-tags-sync'

export const dynamic = 'force-dynamic'

// POST /api/playtest-tags/confirm — sync pending Trends tags of one game into
// Signal Sense. Runs in a transaction so a failure leaves every tag it touched
// pending rather than half-applied. `overwrite` carries the conflict ids whose
// playtest sub-value should replace Signal Sense's.
//
// `ids` narrows the run to the tags the admin ticked. Omitting it confirms every
// pending tag of the game, which is what the earlier per-game button did.
//
// `notes` is an optional `{ id: text }` map of the admin's per-tag reasoning.
// It is stored, never acted on: History shows it to the evaluator beside the
// diff between what they proposed and what was confirmed.
//
// The rules themselves live in lib/playtest-tags-sync.ts, shared with the admin
// tagging path in PUT /api/playtest-tags.
export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  let body: { game_id?: string; overwrite?: number[]; ids?: number[]; notes?: Record<string, string> }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const gameId = (body.game_id || '').trim()
  if (!gameId) return NextResponse.json({ error: 'game_id required' }, { status: 400 })
  const overwrite = new Set((body.overwrite || []).filter(n => Number.isInteger(n)))
  // An `ids` array that survives the filter empty asked for nothing, which is
  // not the same as asking for everything — refuse rather than confirm the lot.
  const only = body.ids === undefined ? null : body.ids.filter(n => Number.isInteger(n))
  if (only !== null && only.length === 0) {
    return NextResponse.json({ error: 'ids was empty' }, { status: 400 })
  }

  const notes = readNotes(body.notes)

  const session = process.env.SKIP_AUTH === 'true' ? null : await getServerSession(authOptions)
  const admin = session?.user?.email || 'skip-auth@local'

  let out: SyncOutput = { results: [], skipped: [] }

  await sql.begin(async txRaw => {
    // postgres.js types a transaction handle as TransactionSql, which is not
    // callable as a tagged template. Every other transaction in this repo casts
    // it the same way.
    const tx = txRaw as unknown as typeof sql

    const pending = await tx`
      SELECT id, field_value, sub_value_id
      FROM playtest_tags
      WHERE game_id = ${gameId} AND status = 'pending'
        ${only === null ? tx`` : tx`AND id = ANY(${only})`}
      ORDER BY id
    ` as unknown as PendingTag[]

    out = await syncTags(tx, { gameId, pending, actor: admin, overwrite, notes })
  })

  return NextResponse.json({ ok: true, results: out.results, skipped: out.skipped })
}
