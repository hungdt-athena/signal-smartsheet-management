import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Tiptap's Link extension only sanitizes hrefs at editor-input time, not when
// generateHTML serializes stored JSON. Feedback can be written via the API
// directly, so strip link marks with unsafe href protocols before persisting —
// otherwise a crafted javascript:/data: href would XSS an admin viewing it.
const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|\/|#)/i

function isSafeHref(href: unknown): boolean {
  return typeof href === 'string' && SAFE_HREF.test(href.trim())
}

function sanitizeNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  const n = node as { marks?: unknown; content?: unknown; [k: string]: unknown }
  const out: Record<string, unknown> = { ...n }
  if (Array.isArray(n.marks)) {
    out.marks = (n.marks as unknown[]).filter((m) => {
      const mark = m as { type?: string; attrs?: { href?: unknown } }
      if (mark?.type !== 'link') return true
      return isSafeHref(mark?.attrs?.href)
    })
  }
  if (Array.isArray(n.content)) {
    out.content = (n.content as unknown[]).map(sanitizeNode)
  }
  return out
}

function sanitizeGameAlike(sections: unknown[]): unknown[] {
  return sections.map((s) => {
    const sec = (s ?? {}) as { games?: unknown; [k: string]: unknown }
    const games = Array.isArray(sec.games) ? sec.games : []
    return {
      ...sec,
      games: games.map((g) => {
        const game = (g ?? {}) as { app_link?: unknown; icon_url?: unknown; [k: string]: unknown }
        return {
          ...game,
          app_link: isSafeHref(game.app_link) ? game.app_link : null,
          icon_url: isSafeHref(game.icon_url) ? game.icon_url : null,
        }
      }),
    }
  })
}

function sanitizeFeedback(feedback: unknown): unknown {
  if (!feedback || typeof feedback !== 'object') return feedback
  return sanitizeNode(feedback)
}

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

  // 403 check below is role-blind by design: admins cannot write others' feedback either.
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
  // Empty or absent evaluator is treated as "use session name" — safe fallback.
  const evaluator = process.env.SKIP_AUTH === 'true' ? (body.evaluator || name || 'dev') : name
  if (!evaluator) return NextResponse.json({ error: 'No evaluator identity' }, { status: 400 })

  const feedback = sanitizeFeedback(body.feedback ?? null)
  const gameAlike = sanitizeGameAlike(Array.isArray(body.game_alike) ? body.game_alike : [])

  const rows = await sql`
    INSERT INTO weekly_feedback (batch, evaluator, feedback, game_alike, updated_at)
    VALUES (${batch}, ${evaluator}, ${sql.json(feedback as Parameters<typeof sql.json>[0])}, ${sql.json(gameAlike as Parameters<typeof sql.json>[0])}, NOW())
    ON CONFLICT (batch, evaluator)
    DO UPDATE SET feedback = EXCLUDED.feedback, game_alike = EXCLUDED.game_alike, updated_at = NOW()
    RETURNING batch, evaluator, feedback, game_alike, updated_at
  `
  return NextResponse.json({ record: rows[0] })
}
