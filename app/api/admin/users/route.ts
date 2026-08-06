import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

const SUPER_ADMIN_EMAIL = 'hungdt@athena.studio'
const VALID_ROLES = ['admin', 'evaluator']
// Job classification, independent of the access role. Set manually per user;
// the Report tab groups performance by it (Fulltime vs Freelancer).
const VALID_TITLES = ['Admin', 'Fulltime', 'Freelancer', 'Recorder']

// GET /api/admin/users — list all users
export async function GET() {
  const guard = await requireRole('admin')
  if (guard) return guard

  const users = await sql`
    SELECT id, email, name, role, title, created_at
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
  if (!VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` }, { status: 400 })
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

// PUT /api/admin/users — update role / display name / title (any subset)
export async function PUT(req: NextRequest) {
  const guard = await requireRole('admin')
  if (guard) return guard

  const body = await req.json()
  const { id, role, name, title } = body
  if (!id || (role === undefined && name === undefined && title === undefined)) {
    return NextResponse.json({ error: 'id and at least one of role, name, title are required' }, { status: 400 })
  }
  if (role !== undefined && !VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` }, { status: 400 })
  }
  // title: '' / null clears it, otherwise must be a known value
  if (title !== undefined && title !== null && title !== '' && !VALID_TITLES.includes(title)) {
    return NextResponse.json({ error: `title must be one of: ${VALID_TITLES.join(', ')}` }, { status: 400 })
  }
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
  }

  const user = await sql`SELECT email, role FROM dashboard_users WHERE id = ${id}`
  if (user.length === 0) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Prevent demoting super admin
  if (role !== undefined && user[0].email === SUPER_ADMIN_EMAIL && role !== 'admin') {
    return NextResponse.json({ error: 'Cannot demote super admin' }, { status: 403 })
  }

  await sql`
    UPDATE dashboard_users SET
      role = ${role !== undefined ? role : sql`role`},
      name = ${name !== undefined ? name.trim() : sql`name`},
      title = ${title !== undefined ? (title || null) : sql`title`}
    WHERE id = ${id}
  `
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

  const user = await sql`SELECT email, role FROM dashboard_users WHERE id = ${id}`
  if (user.length === 0) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Prevent deleting super admin
  if (user[0].email === SUPER_ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Cannot delete super admin' }, { status: 403 })
  }

  await sql`DELETE FROM dashboard_users WHERE id = ${id}`
  return NextResponse.json({ ok: true })
}
