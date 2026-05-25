import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

const SUPER_ADMIN_EMAIL = 'hungdt@athena.studio'

// GET /api/admin/users — list all users
export async function GET() {
  const guard = await requireRole('admin')
  if (guard) return guard

  const users = await sql`
    SELECT id, email, name, role, created_at
    FROM dashboard_users
    ORDER BY created_at ASC
  `
  return NextResponse.json(users, { headers: { 'Cache-Control': 'no-store' } })
}

// POST /api/admin/users — add a new user
export async function POST(req: NextRequest) {
  const guard = await requireRole('admin')
  if (guard) return guard

  const { email, name, role } = await req.json()
  if (!email || !role) {
    return NextResponse.json({ error: 'email and role are required' }, { status: 400 })
  }
  if (!email.endsWith('@athena.studio')) {
    return NextResponse.json({ error: 'Only @athena.studio emails allowed' }, { status: 400 })
  }
  if (!['admin', 'evaluator'].includes(role)) {
    return NextResponse.json({ error: 'role must be admin or evaluator' }, { status: 400 })
  }

  const displayName = name || email.split('@')[0]

  try {
    await sql`
      INSERT INTO dashboard_users (email, name, role)
      VALUES (${email.toLowerCase()}, ${displayName}, ${role})
      ON CONFLICT (email) DO NOTHING
    `
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Failed to add user:', err)
    return NextResponse.json({ error: 'Failed to add user' }, { status: 500 })
  }
}

// PUT /api/admin/users — update user role
export async function PUT(req: NextRequest) {
  const guard = await requireRole('admin')
  if (guard) return guard

  const { id, role } = await req.json()
  if (!id || !role) {
    return NextResponse.json({ error: 'id and role are required' }, { status: 400 })
  }
  if (!['admin', 'evaluator'].includes(role)) {
    return NextResponse.json({ error: 'role must be admin or evaluator' }, { status: 400 })
  }

  // Prevent demoting super admin
  const user = await sql`SELECT email FROM dashboard_users WHERE id = ${id}`
  if (user.length > 0 && user[0].email === SUPER_ADMIN_EMAIL && role !== 'admin') {
    return NextResponse.json({ error: 'Cannot demote super admin' }, { status: 403 })
  }

  await sql`UPDATE dashboard_users SET role = ${role} WHERE id = ${id}`
  return NextResponse.json({ ok: true })
}

// DELETE /api/admin/users — remove a user
export async function DELETE(req: NextRequest) {
  const guard = await requireRole('admin')
  if (guard) return guard

  const { id } = await req.json()
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  // Prevent deleting super admin
  const user = await sql`SELECT email FROM dashboard_users WHERE id = ${id}`
  if (user.length > 0 && user[0].email === SUPER_ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Cannot delete super admin' }, { status: 403 })
  }

  await sql`DELETE FROM dashboard_users WHERE id = ${id}`
  return NextResponse.json({ ok: true })
}
