// app/api/assign-setup/recommend/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  if (!q) return NextResponse.json({ users: [] })
  const like = `%${q}%`
  const users = await sql<{ name: string; email: string }[]>`
    SELECT name, email FROM dashboard_users
    WHERE name ILIKE ${like} OR email ILIKE ${like}
    ORDER BY name ASC
    LIMIT 10
  `
  return NextResponse.json({ users }, { headers: { 'Cache-Control': 'no-store' } })
}
