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
// (migration 049): the Report places games that carry no label by those dates, and a
// batch ends the day the next one starts.

// `_req` is unused on purpose: the value is global, so a legacy `?category=` is ignored.
export async function GET(_req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const current = await getCurrentBatch()
  let starts_on: string | null = null
  if (current) {
    // The start is optional context for the picker: a missing `batches` table (migration
    // not applied yet) or row must not stop the batch itself from being read.
    try {
      const rows = await sql`SELECT starts_on::text AS starts_on FROM batches WHERE label = ${current}`
      starts_on = (rows[0] as { starts_on?: string } | undefined)?.starts_on ?? null
    } catch (err) {
      console.error('GET /api/evaluations/current-batch starts_on error:', err)
    }
  }
  return NextResponse.json({ current_batch: current, starts_on })
}

// A real calendar day, "YYYY-MM-DD": the regex alone would let 2026-02-31 through.
function isIsoDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
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

  // The day the batch starts. Optional: a batch that already has a start keeps it, a new
  // one starts TOMORROW (the day it is closed belongs to the old batch).
  const rawStart = (body as { starts_on?: unknown }).starts_on
  if (rawStart !== undefined && rawStart !== null && (typeof rawStart !== 'string' || !isIsoDay(rawStart))) {
    return NextResponse.json({ error: 'starts_on must be a date like 2026-10-14' }, { status: 400 })
  }
  const startsOn = typeof rawStart === 'string' ? rawStart : null

  try {
    let startsOnSaved: string | null = null
    if (value) {
      const actor = process.env.SKIP_AUTH === 'true' ? null : (await getSession())?.user?.name ?? null
      try {
        const rows = await sql`
          INSERT INTO batches (label, starts_on, set_by)
          VALUES (${value}, COALESCE(${startsOn}::date, (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 1), ${actor})
          ON CONFLICT (label) DO UPDATE
            SET starts_on = COALESCE(${startsOn}::date, batches.starts_on), set_by = ${actor}, updated_at = NOW()
          RETURNING starts_on::text AS starts_on`
        startsOnSaved = (rows[0] as { starts_on?: string } | undefined)?.starts_on ?? null
      } catch (err) {
        // One batch per start day (batches_starts_on_key): two on the same day would give
        // one of them an empty window.
        if ((err as { code?: string }).code === '23505') {
          return NextResponse.json({ error: 'Another batch already starts that day' }, { status: 409 })
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
    return NextResponse.json({ current_batch: value, starts_on: startsOnSaved })
  } catch (err) {
    console.error('POST /api/evaluations/current-batch error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
