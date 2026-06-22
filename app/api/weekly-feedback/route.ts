import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

interface SessionInfo { isManager: boolean; name: string }

async function resolveSession(): Promise<SessionInfo> {
  if (process.env.SKIP_AUTH === 'true') return { isManager: true, name: '' }
  const session = await getServerSession(authOptions)
  const role = session?.user?.role
  return {
    isManager: role === 'admin' || role === 'moderator',
    name: session?.user?.name || '',
  }
}

export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const { isManager, name } = await resolveSession()
  const { searchParams } = req.nextUrl
  const batch = (searchParams.get('batch') || '').trim()

  // Managers may read any evaluator; everyone else is locked to themselves.
  const evaluator = isManager
    ? (searchParams.get('evaluator') || name || '')
    : (name || ' __no_evaluator__')

  if (batch) {
    const rows = await sql`
      SELECT batch, evaluator, feedback, game_alike, updated_at
      FROM weekly_feedback
      WHERE batch = ${batch} AND lower(evaluator) = lower(${evaluator})
      LIMIT 1
    `
    return NextResponse.json({ record: rows[0] ?? null })
  }

  const rows = await sql`
    SELECT batch, evaluator, feedback, game_alike, updated_at
    FROM weekly_feedback
    WHERE lower(evaluator) = lower(${evaluator})
    ORDER BY updated_at DESC
  `
  return NextResponse.json({ records: rows })
}

export async function PUT(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const { name } = await resolveSession()
  let body: { batch?: string; evaluator?: string; feedback?: unknown; game_alike?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }) }

  const batch = (body.batch || '').trim()
  if (!batch) return NextResponse.json({ error: 'batch is required' }, { status: 400 })

  // Write is own-only for everyone (admins included). A client that names a
  // different evaluator is rejected rather than silently rewritten.
  if (process.env.SKIP_AUTH !== 'true' && body.evaluator && body.evaluator.toLowerCase() !== name.toLowerCase()) {
    return NextResponse.json({ error: 'Forbidden: can only edit your own feedback' }, { status: 403 })
  }
  const evaluator = process.env.SKIP_AUTH === 'true' ? (body.evaluator || name || 'dev') : name
  if (!evaluator) return NextResponse.json({ error: 'No evaluator identity' }, { status: 400 })

  const feedback = body.feedback ?? null
  const gameAlike = Array.isArray(body.game_alike) ? body.game_alike : []

  const rows = await sql`
    INSERT INTO weekly_feedback (batch, evaluator, feedback, game_alike, updated_at)
    VALUES (${batch}, ${evaluator}, ${sql.json(feedback as object)}, ${sql.json(gameAlike)}, NOW())
    ON CONFLICT (batch, evaluator)
    DO UPDATE SET feedback = EXCLUDED.feedback, game_alike = EXCLUDED.game_alike, updated_at = NOW()
    RETURNING batch, evaluator, feedback, game_alike, updated_at
  `
  return NextResponse.json({ record: rows[0] })
}
