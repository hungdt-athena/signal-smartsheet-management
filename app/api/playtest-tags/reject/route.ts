import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireManager } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST /api/playtest-tags/reject — drop proposals without touching Signal Sense.
// Rows are kept as `rejected` so the History view still explains what happened.
export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  let body: { ids?: number[] }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const ids = (body.ids || []).filter(n => Number.isInteger(n))
  if (ids.length === 0) return NextResponse.json({ error: 'ids required' }, { status: 400 })

  const session = process.env.SKIP_AUTH === 'true' ? null : await getServerSession(authOptions)
  const admin = session?.user?.email || 'skip-auth@local'

  const rows = await sql`
    UPDATE playtest_tags
    SET status = 'rejected', confirmed_by = ${admin}, confirmed_at = now()
    WHERE status = 'pending' AND id = ANY(${ids})
    RETURNING id
  `
  return NextResponse.json({ ok: true, count: rows.length })
}
