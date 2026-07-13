// app/api/assign-setup/route.ts — DB-backed evaluator_roster editor (sole writer).
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { requireManager, requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { isBucket, isWeight, normalizeCategory } from '@/lib/buckets'

export const dynamic = 'force-dynamic'

interface RosterRow {
  id: number; name: string; today_available: boolean
  game_platform: string; game_category: string; weight: number; list_type: string
}

const PLATFORMS = ['all', 'ios', 'android']

export async function GET(req: NextRequest) {
  // Read is open to evaluators too, but scoped to their own Initial-list row
  // (no Final list). Managers see the full roster. Writes stay manager-only.
  const guard = await requireRole(['admin', 'moderator', 'evaluator'])
  if (guard) return guard
  const group = req.nextUrl.searchParams.get('group') ?? ''
  if (!isBucket(group)) return NextResponse.json({ error: 'Invalid group' }, { status: 400 })

  const rows = await sql<RosterRow[]>`
    SELECT id, name, today_available, game_platform, game_category, weight, list_type
    FROM evaluator_roster
    WHERE category_group = ${group}
    ORDER BY sort_order NULLS LAST, name ASC
  `
  let initial = rows.filter(r => r.list_type === 'initial')
  let final = rows.filter(r => r.list_type === 'final')

  const session = await getServerSession(authOptions)
  if (session?.user?.role === 'evaluator') {
    const me = (session.user.name || '').toLowerCase()
    initial = initial.filter(r => r.name.toLowerCase() === me)
    final = []
  }
  return NextResponse.json({ initial, final }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const b = await req.json()

  if (!isBucket(b.category_group)) return NextResponse.json({ error: 'Invalid bucket' }, { status: 400 })
  if (b.list_type !== 'initial' && b.list_type !== 'final') return NextResponse.json({ error: 'Invalid list_type' }, { status: 400 })
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const platform = PLATFORMS.includes(b.game_platform) ? b.game_platform : 'all'
  const category = normalizeCategory(b.game_category)
  const weight = isWeight(b.weight) ? b.weight : 100
  const available = b.today_available === false ? false : true

  try {
    if (b.provision) {
      const email = `${name.toLowerCase().replace(/\s+/g, '')}@athena.studio`
      await sql`
        INSERT INTO dashboard_users (email, name, role)
        VALUES (${email}, ${name}, 'evaluator')
        ON CONFLICT (email) DO NOTHING
      `
    }
    await sql`
      INSERT INTO evaluator_roster (list_type, category_group, name, today_available, game_platform, game_category, weight)
      VALUES (${b.list_type}, ${b.category_group}, ${name}, ${available}, ${platform}, ${category}, ${weight})
      ON CONFLICT (list_type, category_group, name) DO NOTHING
    `
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('POST /api/assign-setup error:', err)
    return NextResponse.json({ error: 'Failed to add evaluator' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const { id, field, value } = await req.json()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  try {
    if (field === 'today_available') {
      await sql`UPDATE evaluator_roster SET today_available = ${value === true || value === 'Yes'}, updated_at = NOW() WHERE id = ${id}`
    } else if (field === 'game_platform') {
      if (!PLATFORMS.includes(value)) return NextResponse.json({ error: 'Invalid platform' }, { status: 400 })
      await sql`UPDATE evaluator_roster SET game_platform = ${value}, updated_at = NOW() WHERE id = ${id}`
    } else if (field === 'game_category') {
      await sql`UPDATE evaluator_roster SET game_category = ${normalizeCategory(value)}, updated_at = NOW() WHERE id = ${id}`
    } else if (field === 'weight') {
      if (!isWeight(value)) return NextResponse.json({ error: 'weight must be 30/50/70/100' }, { status: 400 })
      await sql`UPDATE evaluator_roster SET weight = ${value}, updated_at = NOW() WHERE id = ${id}`
    } else {
      return NextResponse.json({ error: 'Unknown field' }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PATCH /api/assign-setup error:', err)
    return NextResponse.json({ error: 'Failed to update' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  try {
    await sql`DELETE FROM evaluator_roster WHERE id = ${id}`
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('DELETE /api/assign-setup error:', err)
    return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })
  }
}
