import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireManager } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import { readNotes } from '@/lib/playtest-tags'

export const dynamic = 'force-dynamic'

// POST /api/playtest-tags/reject — drop proposals without touching Signal Sense.
// Rows are kept as `rejected` so the History view still explains what happened,
// and `notes` carries the admin's optional per-tag reason for the evaluator.
export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  let body: { ids?: number[]; notes?: Record<string, string> }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const ids = (body.ids || []).filter(n => Number.isInteger(n))
  if (ids.length === 0) return NextResponse.json({ error: 'ids required' }, { status: 400 })

  const session = process.env.SKIP_AUTH === 'true' ? null : await getServerSession(authOptions)
  const admin = session?.user?.email || 'skip-auth@local'

  const notes = readNotes(body.notes)

  const rows = await sql`
    UPDATE playtest_tags
    SET status = 'rejected', confirmed_by = ${admin}, confirmed_at = now()
    WHERE status = 'pending' AND id = ANY(${ids})
    RETURNING id
  `

  // Notes are per tag and most rejects carry none, so they go on afterwards,
  // one statement per note rather than a join over the whole batch. Only rows
  // the UPDATE above actually moved are stamped: a note must not attach itself
  // to a tag someone else had already reviewed.
  const rejected = new Set(rows.map(r => r.id as number))
  for (const [id, note] of Array.from(notes)) {
    if (!rejected.has(id)) continue
    await sql`UPDATE playtest_tags SET review_note = ${note} WHERE id = ${id}`
  }
  return NextResponse.json({ ok: true, count: rows.length })
}
