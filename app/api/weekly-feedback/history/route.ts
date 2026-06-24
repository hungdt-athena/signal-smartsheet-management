import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Recent snapshots of a week's sections, newest first. Read access mirrors the
// main GET: managers may inspect any evaluator; everyone else is own-only.
export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  let isManager = true
  let name = ''
  if (process.env.SKIP_AUTH !== 'true') {
    const session = await getServerSession(authOptions)
    const role = session?.user?.role
    isManager = role === 'admin' || role === 'moderator'
    name = session?.user?.name || ''
  }

  const { searchParams } = req.nextUrl
  const batch = (searchParams.get('batch') || '').trim()
  if (!batch) return NextResponse.json({ error: 'batch is required' }, { status: 400 })
  const evaluator = isManager
    ? (searchParams.get('evaluator') || name || '')
    : (name || ' __no_evaluator__')

  try {
    const rows = await sql`
      SELECT id, sections, saved_at
      FROM weekly_feedback_history
      WHERE batch = ${batch} AND lower(evaluator) = lower(${evaluator})
      ORDER BY saved_at DESC
      LIMIT 30
    `
    return NextResponse.json({ snapshots: rows })
  } catch (e) {
    // Migration 019 not applied yet → no history table. Degrade to empty.
    console.error('weekly_feedback history read skipped:', e)
    return NextResponse.json({ snapshots: [] })
  }
}
