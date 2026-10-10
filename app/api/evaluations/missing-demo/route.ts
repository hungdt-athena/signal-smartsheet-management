import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { getSession } from '@/lib/session'
import { getCurrentBatches, onlyCurrentBatch } from '@/lib/current-batch'
import { weekLabelOrder } from '@/lib/weekly-feedback'

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
}

// `_req` is never read: the scope comes from the session alone.
export async function GET(_req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const session = await getSession()
    const me = session?.user?.name
    if (!me) return NextResponse.json({ items: [] })

    const current = await getCurrentBatches()
    const batches = Array.from(new Set(Object.values(current)))
    if (batches.length === 0) return NextResponse.json({ items: [] })

    const rows = await sql`
      SELECT ge.id, ge.game_id, gi.title, gi.icon_url, ge.genre_1, ge.category_group,
        ge.batch, ge.evaluate_date
      FROM game_evaluations ge
      JOIN game_info gi ON gi.game_id = ge.game_id
      WHERE ge.initial_conclusion = 'List_Idea'
        AND COALESCE(ge.drive_link, '') = ''
        AND lower(ge.initial_evaluator) = lower(${me})
        AND ge.batch = ANY(${batches})
      ORDER BY ge.evaluate_date DESC NULLS LAST, ge.id
    ` as unknown as Row[]

    const items = onlyCurrentBatch(rows, current)
      .sort((a, b) => weekLabelOrder(b.batch ?? '') - weekLabelOrder(a.batch ?? ''))
      .map(r => ({
        id: r.id,
        game_id: r.game_id,
        title: r.title,
        icon_url: r.icon_url,
        category: r.category_group,
        genre: r.genre_1,
        batch: r.batch,
        evaluate_date: r.evaluate_date,
      }))

    return NextResponse.json({ items })
  } catch (err) {
    console.error('GET /api/evaluations/missing-demo error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
