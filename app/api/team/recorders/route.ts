import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/team/recorders — candidate recorders for assignment.
// Any dashboard user can be a recorder, ordered evaluators → moderators → admins.
export async function GET(_req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const rows = await sql`
    SELECT name FROM dashboard_users
    WHERE name IS NOT NULL AND name <> ''
    ORDER BY
      CASE role
        WHEN 'evaluator' THEN 0
        WHEN 'moderator' THEN 1
        WHEN 'admin' THEN 2
        ELSE 3
      END,
      name
  `

  const names = rows.map(r => r.name)
  return NextResponse.json(names, { headers: { 'Cache-Control': 'no-store' } })
}
