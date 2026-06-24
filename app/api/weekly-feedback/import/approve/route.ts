// THROWAWAY: approve staged import rows → copy into the live weekly_feedback
// table and mark the staging row approved. Body: { ids: number[] } or { all: true }.
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import { sanitizeSections } from '@/lib/weekly-feedback'

export const dynamic = 'force-dynamic'

async function requireManager(): Promise<NextResponse | null> {
  if (process.env.SKIP_AUTH === 'true') return null
  const session = await getServerSession(authOptions)
  const role = session?.user?.role
  if (role !== 'admin' && role !== 'moderator') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return null
}

export async function POST(req: NextRequest) {
  const guard = await requireAuth(); if (guard) return guard
  const m = await requireManager(); if (m) return m
  let body: { ids?: unknown; all?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }) }

  const all = body.all === true
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : []
  if (!all && !ids.length) return NextResponse.json({ error: 'ids or all required' }, { status: 400 })

  const rows = all
    ? await sql`SELECT id, batch, evaluator, sections FROM weekly_feedback_import WHERE status = 'pending'`
    : await sql`SELECT id, batch, evaluator, sections FROM weekly_feedback_import WHERE id = ANY(${ids})`

  let approved = 0
  for (const r of rows) {
    const sections = sanitizeSections(r.sections)
    await sql`
      INSERT INTO weekly_feedback (batch, evaluator, sections, updated_at)
      VALUES (${r.batch}, ${r.evaluator}, ${sql.json(sections as unknown as Parameters<typeof sql.json>[0])}, NOW())
      ON CONFLICT (batch, evaluator)
      DO UPDATE SET sections = EXCLUDED.sections, updated_at = NOW()
    `
    await sql`UPDATE weekly_feedback_import SET status = 'approved', updated_at = NOW() WHERE id = ${r.id}`
    approved++
  }
  return NextResponse.json({ approved })
}
