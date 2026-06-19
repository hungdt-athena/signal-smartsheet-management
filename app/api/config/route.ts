import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'
import { CONFIG_FIELDS, CONFIG_DEFAULTS, isConfigField } from '@/lib/config'

export const dynamic = 'force-dynamic'

interface OptionRow { id: number; field: string; value: string; sort_order: number; active: boolean }

/**
 * GET /api/config            — active option values per field (any authed user).
 *                              Shape: { conclusion: string[], final_conclusion: string[], genre: string[] }
 * GET /api/config?manage=1   — full rows incl. inactive (admin + moderator).
 *                              Shape: { conclusion: OptionRow[], ... }
 */
export async function GET(req: NextRequest) {
  const manage = req.nextUrl.searchParams.get('manage') === '1'

  if (manage) {
    const guard = await requireManager()
    if (guard) return guard
    const rows = await sql<OptionRow[]>`
      SELECT id, field, value, sort_order, active
      FROM config_options
      ORDER BY field ASC, sort_order ASC, id ASC
    `
    const grouped: Record<string, OptionRow[]> = {}
    for (const f of CONFIG_FIELDS) grouped[f] = []
    for (const r of rows) (grouped[r.field] ??= []).push(r)
    return NextResponse.json(grouped, { headers: { 'Cache-Control': 'no-store' } })
  }

  const guard = await requireAuth()
  if (guard) return guard

  const out: Record<string, string[]> = {}
  try {
    const rows = await sql<{ field: string; value: string }[]>`
      SELECT field, value FROM config_options
      WHERE active = true
      ORDER BY field ASC, sort_order ASC, id ASC
    `
    for (const f of CONFIG_FIELDS) out[f] = []
    for (const r of rows) (out[r.field] ??= []).push(r.value)
    // Fall back to defaults for any field the table doesn't populate.
    for (const f of CONFIG_FIELDS) if (out[f].length === 0) out[f] = CONFIG_DEFAULTS[f]
  } catch {
    for (const f of CONFIG_FIELDS) out[f] = CONFIG_DEFAULTS[f]
  }
  return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } })
}

// POST /api/config — add an option { field, value }
export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const { field, value } = await req.json()
  if (!isConfigField(field)) return NextResponse.json({ error: 'Invalid field' }, { status: 400 })
  const val = typeof value === 'string' ? value.trim() : ''
  if (!val) return NextResponse.json({ error: 'value is required' }, { status: 400 })

  try {
    const next = await sql<{ n: number }[]>`
      SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM config_options WHERE field = ${field}
    `
    await sql`
      INSERT INTO config_options (field, value, sort_order)
      VALUES (${field}, ${val}, ${next[0].n})
      ON CONFLICT (field, value) DO NOTHING
    `
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('POST /api/config error:', err)
    return NextResponse.json({ error: 'Failed to add option' }, { status: 500 })
  }
}

/**
 * PATCH /api/config — one of:
 *   { id, value }            rename an option
 *   { id, active }           toggle active
 *   { field, ids: number[] } reorder (sort_order = index)
 */
export async function PATCH(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const body = await req.json()

  try {
    if (Array.isArray(body.ids)) {
      if (!isConfigField(body.field)) return NextResponse.json({ error: 'Invalid field' }, { status: 400 })
      const ids: number[] = body.ids
      await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as typeof sql
        for (let i = 0; i < ids.length; i++) {
          await tx`UPDATE config_options SET sort_order = ${i} WHERE id = ${ids[i]} AND field = ${body.field}`
        }
      })
      return NextResponse.json({ ok: true })
    }

    if (!body.id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    if (typeof body.value === 'string') {
      const val = body.value.trim()
      if (!val) return NextResponse.json({ error: 'value cannot be empty' }, { status: 400 })
      await sql`UPDATE config_options SET value = ${val} WHERE id = ${body.id}`
      return NextResponse.json({ ok: true })
    }

    if (typeof body.active === 'boolean') {
      await sql`UPDATE config_options SET active = ${body.active} WHERE id = ${body.id}`
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  } catch (err) {
    // Unique violation on rename to an existing value.
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
      return NextResponse.json({ error: 'That value already exists' }, { status: 409 })
    }
    console.error('PATCH /api/config error:', err)
    return NextResponse.json({ error: 'Failed to update option' }, { status: 500 })
  }
}

// DELETE /api/config — remove an option { id }
export async function DELETE(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  try {
    await sql`DELETE FROM config_options WHERE id = ${id}`
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('DELETE /api/config error:', err)
    return NextResponse.json({ error: 'Failed to delete option' }, { status: 500 })
  }
}
