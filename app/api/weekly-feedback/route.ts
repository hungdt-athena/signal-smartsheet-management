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
  // gameMention is a node (not a mark) with an href attribute — sanitize it too.
  const typed = n as { type?: string; attrs?: { href?: unknown } }
  if (typed.type === 'gameMention') {
    const attrs = (typed.attrs ?? {}) as Record<string, unknown>
    out.attrs = { ...attrs, href: isSafeHref(attrs.href) ? attrs.href : null }
  }
  if (Array.isArray(n.content)) {
    out.content = (n.content as unknown[]).map(sanitizeNode)
  }
  return out
}

// A section's feedback is a Tiptap document; sanitize its link marks the same way.
function sanitizeDoc(doc: unknown): unknown {
  if (!doc || typeof doc !== 'object') return doc
  return sanitizeNode(doc)
}

interface GameAlikeGame { game_id: string | null; title: string; app_link: string | null; icon_url: string | null; manual: boolean }
interface Section { id: string; feedback: unknown; alike: { name: string; games: GameAlikeGame[] } }

function sanitizeGame(g: unknown): GameAlikeGame {
  const x = (g ?? {}) as Record<string, unknown>
  return {
    game_id: typeof x.game_id === 'string' ? x.game_id : null,
    title: typeof x.title === 'string' ? x.title : '',
    // app_link is rendered as <a href> in the read-only view — same XSS surface.
    app_link: isSafeHref(x.app_link) ? (x.app_link as string) : null,
    icon_url: isSafeHref(x.icon_url) ? (x.icon_url as string) : null,
    manual: !!x.manual,
  }
}

function sanitizeSections(input: unknown): Section[] {
  if (!Array.isArray(input)) return []
  return input.map((s, i) => {
    const x = (s ?? {}) as Record<string, unknown>
    const alike = (x.alike ?? {}) as Record<string, unknown>
    return {
      id: typeof x.id === 'string' && x.id ? x.id : `s_${i}`,
      feedback: sanitizeDoc(x.feedback ?? null),
      alike: {
        name: typeof alike.name === 'string' ? alike.name : '',
        games: Array.isArray(alike.games) ? alike.games.map(sanitizeGame) : [],
      },
    }
  })
}

// Pre-018 rows store `feedback` (Tiptap doc) + `game_alike` (either an old
// structured [{name,games}] array or a Tiptap doc) in separate columns. Fold
// them into a single section so old records keep rendering after the migration.
function legacyToSections(feedback: unknown, gameAlike: unknown): Section[] {
  const games: GameAlikeGame[] = []
  if (Array.isArray(gameAlike)) {
    for (const sec of gameAlike) {
      const gs = (sec as { games?: unknown })?.games
      if (Array.isArray(gs)) for (const g of gs) games.push(sanitizeGame(g))
    }
  }
  // If game_alike was free-text (a Tiptap doc), surface it as feedback rather
  // than dropping it; structured games above take priority for the games list.
  const fb = feedback ?? (!Array.isArray(gameAlike) ? (gameAlike ?? null) : null)
  if (!fb && !games.length) return []
  return [{ id: 'legacy', feedback: fb ?? null, alike: { name: '', games } }]
}

function rowToSections(row: { sections?: unknown; feedback?: unknown; game_alike?: unknown }): Section[] {
  if (Array.isArray(row.sections)) return row.sections as Section[]
  return legacyToSections(row.feedback, row.game_alike)
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
