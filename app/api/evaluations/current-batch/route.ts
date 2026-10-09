import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { CURRENT_BATCH_KEY, getCurrentBatch } from '@/lib/current-batch'

export const dynamic = 'force-dynamic'

// The ONE active weekly batch, shared by every category group. Managers set it;
// evaluators marking a game List_Idea get this batch forced (see EvalDetailPanel).
// Stored in app_config under key `current_batch`.

// `_req` is unused on purpose: the value is global, so a legacy `?category=` is ignored.
export async function GET(_req?: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  return NextResponse.json({ current_batch: await getCurrentBatch() })
}

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  try {
    const { batch } = await req.json()
    const value = batch ? String(batch) : null
    await sql`
      INSERT INTO app_config (key, value, updated_at)
      VALUES (${CURRENT_BATCH_KEY}, ${value}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
    `
    return NextResponse.json({ current_batch: value })
  } catch (err) {
    console.error('POST /api/evaluations/current-batch error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
