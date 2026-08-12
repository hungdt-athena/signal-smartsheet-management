import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import { TRENDS_FIELD } from '@/lib/playtest-tags'

export const dynamic = 'force-dynamic'

interface SessionInfo { isManager: boolean; name: string; email: string }

async function resolveSession(): Promise<SessionInfo> {
  if (process.env.SKIP_AUTH === 'true') {
    return { isManager: true, name: '', email: 'skip-auth@local' }
  }
  const session = await getServerSession(authOptions)
  return {
    isManager: session?.user?.role === 'admin',
    name: session?.user?.name || '',
    email: session?.user?.email || '',
  }
}

// GET /api/playtest-tags?gameId=<id> — this game's pending proposals plus the
// Trends tags it already carries in Signal Sense (shown read-only in the modal
// so nobody re-tags what is there).
export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const gameId = (req.nextUrl.searchParams.get('gameId') || '').trim()
  if (!gameId) return NextResponse.json({ error: 'gameId required' }, { status: 400 })

  const [pending, existing] = await Promise.all([
    sql`
      SELECT pt.id, pt.field_value, pt.sub_value_id, pt.tagged_by, du.name AS tagged_by_name
      FROM playtest_tags pt
      LEFT JOIN dashboard_users du ON du.email = pt.tagged_by
      WHERE pt.game_id = ${gameId} AND pt.status = 'pending'
      ORDER BY pt.field_value
    `,
    sql`
      SELECT cfv.field_value, cfv.sub_value_id, sv.name AS sub_value_name
      FROM custom_field_values cfv
      LEFT JOIN sub_value_definitions sv ON sv.id = cfv.sub_value_id
      WHERE cfv.game_id = ${gameId} AND cfv.field_name = ${TRENDS_FIELD}
      ORDER BY cfv.field_value
    `,
  ])

  return NextResponse.json({ pending, existing }, { headers: { 'Cache-Control': 'no-store' } })
}

// PUT /api/playtest-tags — replace the whole pending set for one game. Called
// from the evaluation modal's save(), so the payload is the full list the user
// sees: anything missing from it is dropped.
export async function PUT(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  let body: { game_id?: string; tags?: { field_value?: string; sub_value_id?: number | null }[] }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const gameId = (body.game_id || '').trim()
  if (!gameId) return NextResponse.json({ error: 'game_id required' }, { status: 400 })

  const tags = (body.tags || [])
    .map(t => ({ field_value: (t.field_value || '').trim(), sub_value_id: t.sub_value_id ?? null }))
    .filter(t => t.field_value)
  // The pending set is keyed on (game, value); collapse a repeated value rather
  // than tripping the partial unique index.
  const unique = Array.from(new Map(tags.map(t => [t.field_value, t])).values())

  const { isManager, name, email } = await resolveSession()

  // Own-only: an evaluator may tag their own game, an admin any game.
  const evRows = await sql`
    SELECT initial_evaluator FROM game_evaluations WHERE game_id = ${gameId} LIMIT 1
  `
  if (evRows.length === 0) return NextResponse.json({ error: 'Game not found' }, { status: 404 })
  const owner = (evRows[0].initial_evaluator as string | null) || ''
  if (!isManager && owner.toLowerCase() !== name.toLowerCase()) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Values must exist as active Trends definitions — this app never creates them.
  if (unique.length > 0) {
    const wanted = unique.map(t => t.field_value)
    const ok = await sql`
      SELECT DISTINCT field_value FROM custom_field_definitions
      WHERE field_name = ${TRENDS_FIELD} AND is_active AND field_value = ANY(${wanted})
    `
    const allowed = new Set(ok.map(r => r.field_value as string))
    const bad = wanted.filter(v => !allowed.has(v))
    if (bad.length > 0) {
      return NextResponse.json({ error: `Unknown Trends value: ${bad.join(', ')}` }, { status: 400 })
    }
  }

  // Replace: only pending rows are touched, so confirmed/rejected history stays.
  await sql`DELETE FROM playtest_tags WHERE game_id = ${gameId} AND status = 'pending'`
  for (const t of unique) {
    await sql`
      INSERT INTO playtest_tags (game_id, field_value, sub_value_id, tagged_by)
      VALUES (${gameId}, ${t.field_value}, ${t.sub_value_id}, ${email})
    `
  }

  return NextResponse.json({ ok: true, count: unique.length })
}
