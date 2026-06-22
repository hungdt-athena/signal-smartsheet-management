import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { parseStoreLink } from '@/lib/game-link'

export const dynamic = 'force-dynamic'

interface GameRow {
  game_id: string
  title: string
  app_link: string | null
  icon_url: string | null
}

export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const { searchParams } = req.nextUrl
  const link = (searchParams.get('link') || '').trim()
  const q = (searchParams.get('q') || '').trim()

  // Link wins: paste a store URL → exact game.
  if (link) {
    const parsed = parseStoreLink(link)
    if (!parsed) return NextResponse.json({ results: [] })
    const rows = await sql<GameRow[]>`
      SELECT game_id, title, app_link, icon_url
      FROM game_info
      WHERE (game_id = ${parsed.storeId} OR app_link ILIKE ${'%' + parsed.storeId + '%'}) AND is_active = true
      LIMIT 1
    `
    return NextResponse.json({ results: rows })
  }

  if (q) {
    const rows = await sql<GameRow[]>`
      SELECT game_id, title, app_link, icon_url
      FROM game_info
      WHERE title ILIKE ${'%' + q + '%'} AND is_active = true
      ORDER BY (title ILIKE ${q + '%'}) DESC, length(title) ASC
      LIMIT 10
    `
    return NextResponse.json({ results: rows })
  }

  return NextResponse.json({ results: [] })
}
