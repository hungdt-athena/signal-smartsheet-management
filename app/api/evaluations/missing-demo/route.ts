import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { getSession } from '@/lib/session'
import { getCurrentBatch } from '@/lib/current-batch'

export const dynamic = 'force-dynamic'

// The signed-in user's own List_Idea games that still have no demo link, limited to the
// current batch. Feeds the "missing demo link" prompt.
//
// Scope is the caller's own name for EVERYONE, managers included -- the prompt nags a
// person about games they evaluated. There is deliberately no ?evaluator= override.

interface Row {
  id: number
  game_id: string
  title: string
  icon_url: string | null
  genre_1: string | null
  category_group: string
  batch: string | null
  evaluate_date: string | null
  // From drive_link_suggestions (migration 048); all null when the auto-sync left nothing
  suggested_link?: string | null
  suggested_name?: string | null
  shared_with?: number | null
}

/** Postgres 42P01 (undefined_table) on drive_link_suggestions: migration 048 was not applied. */
function isMissingSuggestionTable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null
  return !!e && e.code === '42P01' && /drive_link_suggestions/.test(String(e.message ?? ''))
}

// `_req` is never read: the scope comes from the session alone.
export async function GET(_req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const session = await getSession()
    const me = session?.user?.name
    if (!me) return NextResponse.json({ items: [] })

    const current = await getCurrentBatch()
    if (!current) return NextResponse.json({ items: [] })

    // Same scope either way; the first query also carries the auto-sync suggestion for titles
    // shared by different games. Without migration 048 the suggestion table does not exist, and
    // losing the whole prompt over that would be worse than losing the suggestions.
    let rows: Row[]
    try {
      rows = await sql`
        SELECT ge.id, ge.game_id, gi.title, gi.icon_url, ge.genre_1, ge.category_group,
          ge.batch, ge.evaluate_date,
          s.link AS suggested_link, s.file_name AS suggested_name, s.shared_with
        FROM game_evaluations ge
        JOIN game_info gi ON gi.game_id = ge.game_id
        LEFT JOIN drive_link_suggestions s ON s.game_evaluation_id = ge.id
        WHERE ge.initial_conclusion = 'List_Idea'
          AND COALESCE(ge.drive_link, '') = ''
          AND lower(ge.initial_evaluator) = lower(${me})
          AND ge.batch = ${current}
        ORDER BY ge.evaluate_date DESC NULLS LAST, ge.id
      ` as unknown as Row[]
    } catch (err) {
      if (!isMissingSuggestionTable(err)) throw err
      console.error('GET /api/evaluations/missing-demo: drive_link_suggestions missing, apply migration 048')
      rows = await sql`
        SELECT ge.id, ge.game_id, gi.title, gi.icon_url, ge.genre_1, ge.category_group,
          ge.batch, ge.evaluate_date
        FROM game_evaluations ge
        JOIN game_info gi ON gi.game_id = ge.game_id
        WHERE ge.initial_conclusion = 'List_Idea'
          AND COALESCE(ge.drive_link, '') = ''
          AND lower(ge.initial_evaluator) = lower(${me})
          AND ge.batch = ${current}
        ORDER BY ge.evaluate_date DESC NULLS LAST, ge.id
      ` as unknown as Row[]
    }

    const items = rows.map(r => ({
      id: r.id,
      game_id: r.game_id,
      title: r.title,
      icon_url: r.icon_url,
      category: r.category_group,
      genre: r.genre_1,
      batch: r.batch,
      evaluate_date: r.evaluate_date,
      suggested_link: r.suggested_link ?? null,
      suggested_name: r.suggested_name ?? null,
      shared_with: r.shared_with ?? null,
    }))

    return NextResponse.json({ items })
  } catch (err) {
    console.error('GET /api/evaluations/missing-demo error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
