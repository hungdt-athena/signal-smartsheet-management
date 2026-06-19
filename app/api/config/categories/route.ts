// app/api/config/categories/route.ts — genre→bucket mappings (category_mappings table).
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { BUCKETS, isBucket } from '@/lib/buckets'

export const dynamic = 'force-dynamic'

interface MappingRow { id: number; genre: string; category_group: string; active: boolean }

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams
  const check = params.get('check')
  const manage = params.get('manage') === '1'

  // Genre-existence probe against game_info.metadata.categories (advisory only).
  if (check !== null) {
    const guard = await requireManager()
    if (guard) return guard
    const g = check.trim()
    if (!g) return NextResponse.json({ exists: false })
    const rows = await sql<{ one: number }[]>`
      SELECT 1 AS one FROM game_info
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(metadata->'categories') c
        WHERE lower(c) = lower(${g})
      )
      LIMIT 1
    `
    return NextResponse.json({ exists: rows.length > 0 }, { headers: { 'Cache-Control': 'no-store' } })
  }

  if (manage) {
    const guard = await requireManager()
    if (guard) return guard
    const rows = await sql<MappingRow[]>`
      SELECT id, genre, category_group, active
      FROM category_mappings
      ORDER BY category_group ASC, id ASC
    `
    const grouped: Record<string, MappingRow[]> = {}
    for (const b of BUCKETS) grouped[b] = []
    for (const r of rows) (grouped[r.category_group] ??= []).push(r)
    return NextResponse.json(grouped, { headers: { 'Cache-Control': 'no-store' } })
  }

  const guard = await requireAuth()
  if (guard) return guard
  const rows = await sql<{ genre: string; category_group: string }[]>`
    SELECT genre, category_group FROM category_mappings
    WHERE active = true
    ORDER BY category_group ASC, id ASC
  `
  const grouped: Record<string, string[]> = {}
  for (const b of BUCKETS) grouped[b] = []
  for (const r of rows) (grouped[r.category_group] ??= []).push(r.genre)
  return NextResponse.json(grouped, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const { genre, category_group } = await req.json()
  const g = typeof genre === 'string' ? genre.trim() : ''
  if (!g) return NextResponse.json({ error: 'genre is required' }, { status: 400 })
  if (!isBucket(category_group)) return NextResponse.json({ error: 'Invalid bucket' }, { status: 400 })
  try {
    await sql`
      INSERT INTO category_mappings (genre, category_group)
      VALUES (${g}, ${category_group})
      ON CONFLICT (genre, category_group) DO NOTHING
    `
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('POST /api/config/categories error:', err)
    return NextResponse.json({ error: 'Failed to add mapping' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const { id, active } = await req.json()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  if (typeof active !== 'boolean') return NextResponse.json({ error: 'active must be boolean' }, { status: 400 })
  try {
    await sql`UPDATE category_mappings SET active = ${active} WHERE id = ${id}`
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PATCH /api/config/categories error:', err)
    return NextResponse.json({ error: 'Failed to update mapping' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  try {
    await sql`DELETE FROM category_mappings WHERE id = ${id}`
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('DELETE /api/config/categories error:', err)
    return NextResponse.json({ error: 'Failed to delete mapping' }, { status: 500 })
  }
}
