// THROWAWAY: admin review surface for the legacy-sheet import staging table.
// Lists / edits weekly_feedback_import rows. Approval lives in ./approve.
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import { sanitizeSections } from '@/lib/weekly-feedback'

export const dynamic = 'force-dynamic'

// Import review is admin/moderator-only — it edits everyone's feedback, which the
// normal own-only API forbids. This is a deliberate, separate manager-gated path.
async function requireManager(): Promise<NextResponse | null> {
  if (process.env.SKIP_AUTH === 'true') return null
  const session = await getServerSession(authOptions)
  const role = session?.user?.role
  if (role !== 'admin' && role !== 'moderator') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return null
}

export async function GET() {
  const guard = await requireAuth(); if (guard) return guard
  const m = await requireManager(); if (m) return m
  const rows = await sql`
    SELECT id, batch, evaluator, sections, status, source_tab, updated_at
    FROM weekly_feedback_import
    ORDER BY evaluator, batch
  `
  const records = rows.map(r => ({
    id: r.id, batch: r.batch, evaluator: r.evaluator, status: r.status,
    source_tab: r.source_tab, updated_at: r.updated_at,
    sections: sanitizeSections(r.sections),
  }))
  return NextResponse.json({ records })
}

export async function PUT(req: NextRequest) {
  const guard = await requireAuth(); if (guard) return guard
  const m = await requireManager(); if (m) return m
  let body: { id?: number; sections?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }) }
  const id = Number(body.id)
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const sections = sanitizeSections(body.sections)
  const rows = await sql`
    UPDATE weekly_feedback_import
    SET sections = ${sql.json(sections as unknown as Parameters<typeof sql.json>[0])}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING id
  `
  if (!rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
