import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'
import { sanitizeSections, rowToSections } from '@/lib/weekly-feedback'
import type { Section } from '@/components/weekly-feedback/types'

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

  // List view: many rows, filtered by batch (optional) + evaluator. Managers may
  // read any/all evaluators; everyone else is locked to themselves (own-only).
  if (searchParams.get('list') === '1') {
    const evalParam = (searchParams.get('evaluator') || '').trim()
    const evalFilter = !isManager
      ? sql`lower(evaluator) = lower(${name || ' __no_evaluator__'})`
      : (evalParam ? sql`lower(evaluator) = lower(${evalParam})` : sql`TRUE`)
    const batchFilter = batch ? sql`batch = ${batch}` : sql`TRUE`
    const rows = await sql`
      SELECT batch, evaluator, sections, feedback, game_alike, updated_at
      FROM weekly_feedback
      WHERE ${evalFilter} AND ${batchFilter}
      ORDER BY updated_at DESC
    `
    const records = rows.map(row => ({ batch: row.batch, evaluator: row.evaluator, sections: rowToSections(row), updated_at: row.updated_at }))
    return NextResponse.json({ records })
  }

  // Managers may read any evaluator; everyone else is locked to themselves.
  const evaluator = isManager
    ? (searchParams.get('evaluator') || name || '')
    : (name || ' __no_evaluator__')

  if (batch) {
    const rows = await sql`
      SELECT batch, evaluator, sections, feedback, game_alike, updated_at
      FROM weekly_feedback
      WHERE batch = ${batch} AND lower(evaluator) = lower(${evaluator})
      LIMIT 1
    `
    const row = rows[0]
    return NextResponse.json({ record: row ? { batch: row.batch, evaluator: row.evaluator, sections: rowToSections(row), updated_at: row.updated_at } : null })
  }

  const rows = await sql`
    SELECT batch, evaluator, sections, feedback, game_alike, updated_at
    FROM weekly_feedback
    WHERE lower(evaluator) = lower(${evaluator})
    ORDER BY updated_at DESC
  `
  const records = rows.map(row => ({ batch: row.batch, evaluator: row.evaluator, sections: rowToSections(row), updated_at: row.updated_at }))
  return NextResponse.json({ records })
}

export async function PUT(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  // 403 check below is role-blind by design: admins cannot write others' feedback either.
  const { name } = await resolveSession()
  let body: { batch?: string; evaluator?: string; sections?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }) }

  const batch = (body.batch || '').trim()
  if (!batch) return NextResponse.json({ error: 'batch is required' }, { status: 400 })

  // Write is own-only for everyone (admins included). A client that names a
  // different evaluator is rejected rather than silently rewritten.
  if (process.env.SKIP_AUTH !== 'true' && body.evaluator && body.evaluator.toLowerCase() !== name.toLowerCase()) {
    return NextResponse.json({ error: 'Forbidden: can only edit your own feedback' }, { status: 403 })
  }
  // Empty or absent evaluator is treated as "use session name" — safe fallback.
  const evaluator = process.env.SKIP_AUTH === 'true' ? (body.evaluator || name || 'dev') : name
  if (!evaluator) return NextResponse.json({ error: 'No evaluator identity' }, { status: 400 })

  const sections = sanitizeSections(body.sections)

  // History safety net: if a row already exists and hasn't been touched for a
  // while (a new editing "session"), snapshot its PREVIOUS sections before the
  // overwrite — so an accidental autosave that wipes content stays recoverable.
  // Within an active session (rapid autosaves <60s apart) we skip snapshotting
  // to avoid one row per keystroke-pause. Keep only the latest 30 per key.
  // Wrapped so a not-yet-applied migration 019 (missing history table) degrades
  // to "no history" instead of breaking saves entirely.
  try {
    const existing = await sql`
      SELECT sections, feedback, game_alike
      FROM weekly_feedback
      WHERE batch = ${batch} AND lower(evaluator) = lower(${evaluator})
        AND updated_at < NOW() - INTERVAL '60 seconds'
      LIMIT 1
    `
    if (existing[0]) {
      const prev = rowToSections(existing[0])
      if (prev.length) {
        await sql`
          INSERT INTO weekly_feedback_history (batch, evaluator, sections)
          VALUES (${batch}, ${evaluator}, ${sql.json(prev as unknown as Parameters<typeof sql.json>[0])})
        `
        await sql`
          DELETE FROM weekly_feedback_history
          WHERE batch = ${batch} AND lower(evaluator) = lower(${evaluator})
            AND id NOT IN (
              SELECT id FROM weekly_feedback_history
              WHERE batch = ${batch} AND lower(evaluator) = lower(${evaluator})
              ORDER BY saved_at DESC LIMIT 30
            )
        `
      }
    }
  } catch (e) {
    console.error('weekly_feedback history snapshot skipped:', e)
  }

  const rows = await sql`
    INSERT INTO weekly_feedback (batch, evaluator, sections, updated_at)
    VALUES (${batch}, ${evaluator}, ${sql.json(sections as unknown as Parameters<typeof sql.json>[0])}, NOW())
    ON CONFLICT (batch, evaluator)
    DO UPDATE SET sections = EXCLUDED.sections, updated_at = NOW()
    RETURNING batch, evaluator, sections, updated_at
  `
  return NextResponse.json({ record: rows[0] })
}
