// app/api/admin/users/audit-evaluators/route.ts — names that evaluate games but
// have no user account.
//
// Every evaluator dropdown is built from names in game_evaluations, so a name
// with no dashboard_users row could never be managed: an admin had nothing to
// deactivate. This finds those names and gives them a row — deactivated, because
// a name that has been working without an account is almost always someone who
// left. An admin reactivates the ones that turn out to be current staff.
//
// System labels (`Shortcut`) are skipped: there is nobody behind them, so an
// account would be a fiction — they are filtered out of Config > People and the
// dropdowns by name instead.
//
// GET previews (nothing is written), POST applies.
import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { SYSTEM_LABEL_KEY_LIST } from '@/lib/system-accounts'

export const dynamic = 'force-dynamic'

interface Orphan { key: string; name: string; total: number; last_eval: string | null }

// A name in game_evaluations with no dashboard_users row of the same name.
// Matching is on lower(name), never on email — an existing user's address does
// not have to follow the name@athena.studio shape.
async function findOrphans(): Promise<Orphan[]> {
  return sql<Orphan[]>`
    SELECT lower(ge.initial_evaluator) AS key,
           mode() WITHIN GROUP (ORDER BY ge.initial_evaluator) AS name,
           COUNT(*)::int AS total,
           MAX(ge.evaluate_date) AS last_eval
    FROM game_evaluations ge
    WHERE ge.initial_evaluator IS NOT NULL AND ge.initial_evaluator <> ''
      AND lower(ge.initial_evaluator) <> ALL(${SYSTEM_LABEL_KEY_LIST})
      AND NOT EXISTS (
        SELECT 1 FROM dashboard_users du
        WHERE lower(du.name) = lower(ge.initial_evaluator)
      )
    GROUP BY lower(ge.initial_evaluator)
    ORDER BY 3 DESC
  `
}

export async function GET() {
  const guard = await requireAdmin()
  if (guard) return guard
  try {
    return NextResponse.json({ orphans: await findOrphans() }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('GET /api/admin/users/audit-evaluators error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

export async function POST() {
  const guard = await requireAdmin()
  if (guard) return guard
  try {
    const orphans = await findOrphans()
    const created: string[] = []
    const skipped: string[] = []

    for (const o of orphans) {
      // Same synthetic address the evaluator sheet sync has always used. It is
      // never a working login here — the row is created deactivated.
      const email = `${o.key.replace(/\s+/g, '')}@athena.studio`
      const rows = await sql`
        INSERT INTO dashboard_users (email, name, role, active)
        VALUES (${email}, ${o.name}, 'evaluator', false)
        ON CONFLICT (email) DO NOTHING
        RETURNING id
      `
      // A conflict means the address is taken by a user under a different display
      // name — renaming someone else's account is not this route's business.
      if (rows.length > 0) created.push(o.name)
      else skipped.push(o.name)
    }

    return NextResponse.json({ ok: true, created, skipped })
  } catch (err) {
    console.error('POST /api/admin/users/audit-evaluators error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
