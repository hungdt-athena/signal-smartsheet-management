import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { CURRENT_BATCH_KEY, getCurrentBatch } from '@/lib/current-batch'
import { isBatchLabel } from '@/lib/weekly-feedback'

export const dynamic = 'force-dynamic'

// The ONE active weekly batch, shared by every category group. Managers set it;
// evaluators marking a game List_Idea get this batch forced (see EvalDetailPanel).
// Stored in app_config under key `current_batch`.

// `_req` is unused on purpose: the value is global, so a legacy `?category=` is ignored.
export async function GET(_req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  return NextResponse.json({ current_batch: await getCurrentBatch() })
}

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  // Setting this changes the batch for every evaluator, so anything that is not clearly
  // "set this label" or "clear it" is refused instead of being read as "clear".
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !('batch' in body)) {
    return NextResponse.json({ error: 'Body must be a JSON object with a "batch" key' }, { status: 400 })
  }
  const raw = (body as { batch: unknown }).batch
  if (raw !== null && typeof raw !== 'string') {
    return NextResponse.json({ error: 'batch must be a text value or null' }, { status: 400 })
  }
  const trimmed = raw === null ? '' : raw.trim()
  // Empty means "clear". Anything else must be a real label: a free-form value (or one
  // over 40 characters) would later make every List_Idea save fail.
  if (trimmed !== '' && !isBatchLabel(trimmed)) {
    return NextResponse.json({ error: 'batch must look like "W2 Oct, 2026"' }, { status: 400 })
  }
  const value = trimmed || null

  try {
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
