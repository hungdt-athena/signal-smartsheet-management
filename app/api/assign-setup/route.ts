// app/api/assign-setup/route.ts — DB-backed evaluator_roster editor (sole writer).
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { requireManager, requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { isBucket, isWeight, normalizeCategory, type Bucket } from '@/lib/buckets'

export const dynamic = 'force-dynamic'

interface RosterRow {
  id: number; name: string; category_group: string; today_available: boolean
  game_platform: string; game_category: string; weight: number; list_type: string
}

const PLATFORMS = ['all', 'ios', 'android']

export async function GET() {
  // Read is open to evaluators too, but scoped to their own Initial-list rows
  // (no Final list). Managers see the full roster. Writes stay manager-only.
  //
  // One request returns every genre: the Assign tab is a single page now, so a
  // per-bucket read would just be three round-trips for one table. Order is by
  // person, then a fixed genre order, because the table groups rows by person.
  const guard = await requireRole(['admin', 'moderator', 'evaluator'])
  if (guard) return guard

  const rows = await sql<RosterRow[]>`
    SELECT id, name, category_group, today_available, game_platform, game_category, weight, list_type
    FROM evaluator_roster
    ORDER BY name ASC,
             array_position(ARRAY['puzzle','arcade','simulation']::text[], category_group)
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

  // Adding a person can create several rows at once, one per genre.
  const groups: Bucket[] = Array.isArray(b.category_groups)
    ? b.category_groups.filter(isBucket)
    : isBucket(b.category_group) ? [b.category_group] : []
  if (groups.length === 0) return NextResponse.json({ error: 'category_groups is required' }, { status: 400 })
  if (b.list_type !== 'initial' && b.list_type !== 'final') return NextResponse.json({ error: 'Invalid list_type' }, { status: 400 })
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const platform = PLATFORMS.includes(b.game_platform) ? b.game_platform : 'all'
  const category = normalizeCategory(b.game_category)
  const weight = isWeight(b.weight) ? b.weight : 100

  try {
    if (b.provision) {
      const email = `${name.toLowerCase().replace(/\s+/g, '')}@athena.studio`
      await sql`
        INSERT INTO dashboard_users (email, name, role)
        VALUES (${email}, ${name}, 'evaluator')
        ON CONFLICT (email) DO NOTHING
      `
    }
    // Availability is inherited from any row this person already has, so adding
    // a genre to someone who is off today does not quietly bring them back.
    const [existing] = await sql<{ today_available: boolean }[]>`
      SELECT today_available FROM evaluator_roster
      WHERE list_type = ${b.list_type} AND name = ${name} LIMIT 1
    `
    const available = existing ? existing.today_available : (b.today_available === false ? false : true)

    const values = groups.map(g => ({
      list_type: b.list_type, category_group: g, name,
      today_available: available, game_platform: platform, game_category: category, weight,
    }))
    await sql`
      INSERT INTO evaluator_roster ${sql(values, 'list_type', 'category_group', 'name', 'today_available', 'game_platform', 'game_category', 'weight')}
      ON CONFLICT (list_type, category_group, name) DO NOTHING
    `
    return NextResponse.json({ ok: true, inserted: groups.length })
  } catch (err) {
    console.error('POST /api/assign-setup error:', err)
    return NextResponse.json({ error: 'Failed to add evaluator' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const { id, field, value, name, list_type: listType } = await req.json()

  try {
    // Availability, platform and weight are facts about the person, so they are
    // written by (list_type, name) — every genre of theirs, in one statement.
    // This is the only place the per-person rule lives, and it lives on the
    // server so no UI can put a person's genres into disagreeing states.
    // Sub-genre stays per row: it is the one thing that varies by genre.
    if (field === 'today_available' || field === 'game_platform' || field === 'weight') {
      const who = typeof name === 'string' ? name.trim() : ''
      if (!who) return NextResponse.json({ error: 'name is required' }, { status: 400 })
      if (listType !== 'initial' && listType !== 'final') {
        return NextResponse.json({ error: 'Invalid list_type' }, { status: 400 })
      }
      if (field === 'today_available') {
        await sql`
          UPDATE evaluator_roster
          SET today_available = ${value === true || value === 'Yes'}, updated_at = NOW()
          WHERE list_type = ${listType} AND name = ${who}
        `
      } else if (field === 'game_platform') {
        if (!PLATFORMS.includes(value)) return NextResponse.json({ error: 'Invalid platform' }, { status: 400 })
        await sql`
          UPDATE evaluator_roster SET game_platform = ${value}, updated_at = NOW()
          WHERE list_type = ${listType} AND name = ${who}
        `
      } else {
        if (!isWeight(value)) return NextResponse.json({ error: 'weight must be 30/50/70/100' }, { status: 400 })
        await sql`
          UPDATE evaluator_roster SET weight = ${value}, updated_at = NOW()
          WHERE list_type = ${listType} AND name = ${who}
        `
      }
      return NextResponse.json({ ok: true })
    }

    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    if (field === 'game_category') {
      await sql`UPDATE evaluator_roster SET game_category = ${normalizeCategory(value)}, updated_at = NOW() WHERE id = ${id}`
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
