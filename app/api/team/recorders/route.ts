import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/team/recorders — candidate recorders for assignment.
// Any ACTIVE dashboard user can be a recorder, ordered evaluators, then admins.
//
// Deactivating a user in Users Management is the strong form of hiding: no
// sign-in, gone from Config › People, gone from every evaluator dropdown. This
// list has to obey it too, or someone who left the team keeps being offered as
// the person to record a video.
export async function GET(_req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const rows = await sql`
    SELECT name FROM dashboard_users
    WHERE active = TRUE AND name IS NOT NULL AND name <> ''
    ORDER BY
      CASE role
        WHEN 'evaluator' THEN 0
                WHEN 'admin' THEN 2
        ELSE 3
      END,
      name
  `

  const names = rows.map(r => r.name)
  return NextResponse.json(names, { headers: { 'Cache-Control': 'no-store' } })
}
