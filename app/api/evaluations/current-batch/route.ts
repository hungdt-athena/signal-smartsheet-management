import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireAuth } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

const CATEGORIES = ['puzzle', 'arcade', 'simulation']

// The active weekly batch per category. Managers set it; evaluators marking a
// game List_Idea get this batch forced (see EvalDetailPanel). Stored in
// app_config under key `current_batch:<category>`.

export async function GET(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  const category = req.nextUrl.searchParams.get('category') || 'puzzle'
  const rows = await sql`SELECT value FROM app_config WHERE key = ${`current_batch:${category}`}`
  return NextResponse.json({ current_batch: rows[0]?.value ?? null })
}

export async function POST(req: NextRequest) {
  const guard = await requireAuth()
  if (guard) return guard

  // Manager-only (admin / moderator).
  if (process.env.SKIP_AUTH !== 'true') {
    const session = await getServerSession(authOptions)
    const role = session?.user?.role
    if (role !== 'admin' && role !== 'moderator') {
      return NextResponse.json({ error: 'Forbidden: manager role required' }, { status: 403 })
    }
  }

  try {
    const { category, batch } = await req.json()
    if (!CATEGORIES.includes(category)) {
      return NextResponse.json({ error: 'Invalid category' }, { status: 400 })
    }
    const value = batch ? String(batch) : null
    await sql`
      INSERT INTO app_config (key, value, updated_at)
      VALUES (${`current_batch:${category}`}, ${value}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
    `
    return NextResponse.json({ current_batch: value })
  } catch (err) {
    console.error('POST /api/evaluations/current-batch error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
