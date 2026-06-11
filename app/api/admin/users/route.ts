import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireRole } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

const SUPER_ADMIN_EMAIL = 'hungdt@athena.studio'
const VALID_ROLES = ['admin', 'moderator', 'evaluator']

/** Role of the requester ('admin' when SKIP_AUTH is on for local dev). */
async function callerRole(): Promise<string> {
  if (process.env.SKIP_AUTH === 'true') return 'admin'
  const session = await getServerSession(authOptions)
  return session?.user?.role ?? ''
}

// GET /api/admin/users — list all users
export async function GET() {
  const guard = await requireRole(['admin', 'moderator'])
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
  const guard = await requireRole(['admin', 'moderator'])
  if (guard) return guard

  const { email, name, role } = await req.json()
  if (!email || !role) {
    return NextResponse.json({ error: 'email and role are required' }, { status: 400 })
  }
  if (!email.endsWith('@athena.studio')) {
    return NextResponse.json({ error: 'Only @athena.studio emails allowed' }, { status: 400 })
  }
  if (!VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` }, { status: 400 })
  }
  // Only admins may create admins.
  if (role === 'admin' && (await callerRole()) !== 'admin') {
    return NextResponse.json({ error: 'Only admins can grant the admin role' }, { status: 403 })
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
  const guard = await requireRole(['admin', 'moderator'])
  if (guard) return guard

  const { id, role } = await req.json()
  if (!id || !role) {
    return NextResponse.json({ error: 'id and role are required' }, { status: 400 })
  }
  if (!VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` }, { status: 400 })
  }

  const user = await sql`SELECT email, role FROM dashboard_users WHERE id = ${id}`
  if (user.length === 0) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Moderators cannot grant the admin role or modify existing admins.
  const caller = await callerRole()
  if (caller !== 'admin' && (role === 'admin' || user[0].role === 'admin')) {
    return NextResponse.json({ error: 'Only admins can manage admin accounts' }, { status: 403 })
  }

  // Prevent demoting super admin
  if (user[0].email === SUPER_ADMIN_EMAIL && role !== 'admin') {
    return NextResponse.json({ error: 'Cannot demote super admin' }, { status: 403 })
  }

  await sql`UPDATE dashboard_users SET role = ${role} WHERE id = ${id}`
  return NextResponse.json({ ok: true })
}

// DELETE /api/admin/users — remove a user
export async function DELETE(req: NextRequest) {
  const guard = await requireRole(['admin', 'moderator'])
  if (guard) return guard

  const { id } = await req.json()
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const user = await sql`SELECT email, role FROM dashboard_users WHERE id = ${id}`
  if (user.length === 0) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Prevent deleting super admin
  if (user[0].email === SUPER_ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Cannot delete super admin' }, { status: 403 })
  }

  // Moderators cannot delete admins.
  if ((await callerRole()) !== 'admin' && user[0].role === 'admin') {
    return NextResponse.json({ error: 'Only admins can delete admin accounts' }, { status: 403 })
  }

  await sql`DELETE FROM dashboard_users WHERE id = ${id}`
  return NextResponse.json({ ok: true })
}
