// app/api/operations/pending-holders/route.ts — who actually holds pending games
// in a bucket, and how many.
//
// The Re-assign and Handover source dropdowns used to be the bucket roster, which
// answers a different question: who is *configured* to receive this genre. Those
// two sets drift. In arcade the roster and the holders happen to agree today, but
// a person can sit in the roster holding zero pending games (nothing to move), and
// a person dropped from the roster can still be holding games that must be moved
// off them. Driving the dropdown off game_evaluations makes the list say what the
// manager needs: these are the people you can move work away from, right now.
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { isBucket } from '@/lib/buckets'
import { getSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

interface Holder { name: string; pending: number }

export async function GET(req: NextRequest) {
  const guard = await requireRole(['admin', 'moderator', 'evaluator'])
  if (guard) return guard

  const category = req.nextUrl.searchParams.get('category')
  if (!isBucket(category)) {
    return NextResponse.json({ error: 'category must be puzzle, arcade or simulation' }, { status: 400 })
  }

  const rows = await sql<Holder[]>`
    SELECT initial_evaluator AS name, COUNT(*)::int AS pending
    FROM game_evaluations
    WHERE category_group = ${category}
      AND initial_conclusion IS NULL
      AND initial_evaluator IS NOT NULL
      AND initial_evaluator <> ''
    GROUP BY initial_evaluator
    ORDER BY pending DESC, initial_evaluator ASC
  `

  // Evaluators only ever act on their own backlog (Handover locks the source to
  // them), so they see their own row and nobody else's.
  const session = await getSession()
  let holders: Holder[] = rows
  if (session?.user?.role === 'evaluator') {
    const me = (session.user.name || '').toLowerCase()
    holders = rows.filter(r => r.name.toLowerCase() === me)
  }

  return NextResponse.json({ category, holders }, { headers: { 'Cache-Control': 'no-store' } })
}
