import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireManager } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import { applyExistingTagChange, type ExistingTagAction, type ExistingTagOutcome } from '@/lib/playtest-tags-existing'

export const dynamic = 'force-dynamic'

// Trends tags that are already in Signal Sense, edited from this app.
//
// Keyed by (game, value) rather than by a playtest_tags id: most of these tags
// were made in Signal Sense and have no row here at all. That pair is the tag's
// identity over there — `unique_game_field_value` — so it is enough.
//
//   PATCH  { gameId, fieldValue, subValueId }  → move or clear the sub-value
//   DELETE { gameId, fieldValue }              → take the tag out

interface Body { gameId?: unknown; fieldValue?: unknown; subValueId?: unknown }

async function handle(req: NextRequest, action: ExistingTagAction) {
  const guard = await requireManager()
  if (guard) return guard

  let body: Body
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const gameId = typeof body.gameId === 'string' ? body.gameId.trim() : ''
  const fieldValue = typeof body.fieldValue === 'string' ? body.fieldValue.trim() : ''
  if (!gameId || !fieldValue) {
    return NextResponse.json({ error: 'gameId and fieldValue required' }, { status: 400 })
  }

  const raw = body.subValueId
  if (action === 'set_sub_value' && raw != null && !Number.isInteger(raw)) {
    return NextResponse.json({ error: 'subValueId must be an integer or null' }, { status: 400 })
  }
  const subValueId = typeof raw === 'number' ? raw : null

  const session = process.env.SKIP_AUTH === 'true' ? null : await getServerSession(authOptions)
  const admin = session?.user?.email || 'skip-auth@local'

  // Returned out of the transaction rather than assigned to a closure variable:
  // TypeScript cannot see the callback's writes and would narrow such a variable
  // to `null`, so reading a field off it afterwards fails to compile.
  const result = await sql.begin(async txRaw =>
    applyExistingTagChange(txRaw as unknown as typeof sql, {
      gameId, fieldValue, action, subValueId, admin,
    })) as unknown as { status?: number; error?: string; outcome?: ExistingTagOutcome }

  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true, outcome: result.outcome })
}

export const PATCH = (req: NextRequest) => handle(req, 'set_sub_value')
export const DELETE = (req: NextRequest) => handle(req, 'remove')
