import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { requireManager } from '@/lib/auth-guard'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

const SUPER_ADMIN_EMAIL = 'hungdt@athena.studio'
const VALID_ROLES = ['admin', 'moderator', 'evaluator']

/** True when the caller is an admin.
 *
 *  Moderators share this route -- they invite people and fix display names --
 *  but must not touch a role or delete anyone. If they could, a moderator would
 *  simply make themselves an admin, and the other two limits on the tier (no
 *  auto-synced tags, no Final Conclusion) would mean nothing. */
async function callerIsAdmin(): Promise<boolean> {
  if (process.env.SKIP_AUTH === 'true') return true
  const session = await getServerSession(authOptions)
  return session?.user?.role === 'admin'
}
// Job classification, independent of the access role. Set manually per user;
// the Report tab groups performance by it (Fulltime vs Freelancer).
const VALID_TITLES = ['Admin', 'Fulltime', 'Freelancer', 'Recorder']

// GET /api/admin/users — list all users
export async function GET() {
  const guard = await requireManager()
  if (guard) return guard

  // Active first, so the working roster is what you see and the deactivated tail
  // sits at the bottom instead of being interleaved with it.
  const users = await sql`
    SELECT id, email, name, role, title, active, created_at
    FROM dashboard_users
    ORDER BY active DESC, created_at ASC
  `
  return NextResponse.json(users, { headers: { 'Cache-Control': 'no-store' } })
}

// POST /api/admin/users — add a new user
export async function POST(req: NextRequest) {
  const guard = await requireManager()
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
  // Otherwise "a moderator cannot change a role" is answered by inviting a
  // fresh admin account instead.
  if (role === 'admin' && !(await callerIsAdmin())) {
    return NextResponse.json({ error: 'Only an admin can invite an admin' }, { status: 403 })
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

// PUT /api/admin/users — update role / display name / title / active (any subset)
export async function PUT(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const body = await req.json()
  const { id, role, name, title, active } = body
  if (!id || (role === undefined && name === undefined && title === undefined && active === undefined)) {
    return NextResponse.json({ error: 'id and at least one of role, name, title, active are required' }, { status: 400 })
  }
  if (active !== undefined && typeof active !== 'boolean') {
    return NextResponse.json({ error: 'active must be boolean' }, { status: 400 })
  }
  // Same tier as changing a role: deactivating someone locks them out of the
  // whole dashboard, which is not a moderator's call to make.
  if (active !== undefined && !(await callerIsAdmin())) {
    return NextResponse.json({ error: 'Only an admin can deactivate a user' }, { status: 403 })
  }
  if (role !== undefined && !VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` }, { status: 400 })
  }
  // Checked before any read: a refused role change must not even look the user
  // up, and a moderator sending name + role in one request changes neither.
  if (role !== undefined && !(await callerIsAdmin())) {
    return NextResponse.json({ error: 'Only an admin can change a role' }, { status: 403 })
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
  if (active === false && user[0].email === SUPER_ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Cannot deactivate super admin' }, { status: 403 })
  }

  await sql`
    UPDATE dashboard_users SET
      role = ${role !== undefined ? role : sql`role`},
      name = ${name !== undefined ? name.trim() : sql`name`},
      title = ${title !== undefined ? (title || null) : sql`title`},
      active = ${active !== undefined ? active : sql`active`}
    WHERE id = ${id}
  `
  return NextResponse.json({ ok: true })
}

// Deleting a user is gone on purpose. It removed the only row saying a name
// belonged to a real person while every game they evaluated kept that name, so
// the roster and the history disagreed for good. PUT { id, active: false } is
// the replacement: no sign-in, out of every dropdown, row and history intact.
