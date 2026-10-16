import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { CURRENT_BATCH_KEY, getCurrentBatch } from '@/lib/current-batch'
import { isBatchLabel } from '@/lib/weekly-feedback'
import { clearBatchSpanCache } from '@/lib/report-batches'
import { getSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

// The ONE active weekly batch, shared by every category group. Managers set it;
// evaluators marking a game List_Idea get this batch forced (see EvalDetailPanel).
// Stored in app_config under key `current_batch`. The day it starts lives in `batches`
// (migrations 049/050): the Report places games that carry no label by that moment, and a
// batch ends the moment the next one starts. It is a time, not a day, because batches are
// switched in the middle of a day. Entered and shown in Vietnam time, "YYYY-MM-DDTHH:mm".

// `_req` is unused on purpose: the value is global, so a legacy `?category=` is ignored.
export async function GET(_req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const current = await getCurrentBatch()
  let starts_at: string | null = null
  if (current) {
    // The start is optional context for the picker: a missing `batches` table (migration
    // not applied yet) or row must not stop the batch itself from being read.
    try {
      const rows = await sql`SELECT to_char(starts_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI') AS starts_at FROM batches WHERE label = ${current}`
      starts_at = (rows[0] as { starts_at?: string } | undefined)?.starts_at ?? null
    } catch (err) {
      console.error('GET /api/evaluations/current-batch starts_at error:', err)
    }
  }
  return NextResponse.json({ current_batch: current, starts_at })
}

// "2026-10-14T09:30" read as Vietnam time. The regex alone would let 2026-02-31 or 25:99 through.
function isLocalMinute(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return false
  const d = new Date(`${v}:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 16) === v
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

  // The moment the batch starts, in Vietnam time. Optional: a batch that already has a start
  // keeps it, a new one starts NOW (the switch happens in the middle of a day, and games
  // judged before it stay in the old batch).
  const rawStart = (body as { starts_at?: unknown }).starts_at
  if (rawStart !== undefined && rawStart !== null && (typeof rawStart !== 'string' || !isLocalMinute(rawStart))) {
    return NextResponse.json({ error: 'starts_at must look like 2026-10-14T09:30' }, { status: 400 })
  }
  const startsAt = typeof rawStart === 'string' ? rawStart : null

  try {
    let startsAtSaved: string | null = null
    if (value) {
      const actor = process.env.SKIP_AUTH === 'true' ? null : (await getSession())?.user?.name ?? null
      try {
        // starts_on is kept in step (the VN day of starts_at) for a build that still reads it.
        const rows = await sql`
          INSERT INTO batches (label, starts_at, starts_on, set_by)
          VALUES (${value},
                  COALESCE(${startsAt}::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh', NOW()),
                  COALESCE(${startsAt}::timestamp, NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
                  ${actor})
          ON CONFLICT (label) DO UPDATE
            SET starts_at = COALESCE(${startsAt}::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh', batches.starts_at),
                starts_on = (COALESCE(${startsAt}::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh', batches.starts_at)
                             AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
                set_by = ${actor}, updated_at = NOW()
          RETURNING to_char(starts_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI') AS starts_at`
        startsAtSaved = (rows[0] as { starts_at?: string } | undefined)?.starts_at ?? null
      } catch (err) {
        // One batch per start instant (batches_starts_at_key): two at the same moment would
        // give one of them an empty window.
        if ((err as { code?: string }).code === '23505') {
          return NextResponse.json({ error: 'Another batch already starts at that time' }, { status: 409 })
        }
        throw err
      }
      clearBatchSpanCache()
    }
    await sql`
      INSERT INTO app_config (key, value, updated_at)
      VALUES (${CURRENT_BATCH_KEY}, ${value}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
    `
    return NextResponse.json({ current_batch: value, starts_at: startsAtSaved })
  } catch (err) {
    console.error('POST /api/evaluations/current-batch error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
