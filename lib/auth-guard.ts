import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

type Role = 'admin' | 'moderator' | 'evaluator'

/** Returns null if allowed, or a 401/403 NextResponse if blocked.
 *  Accepts a single role or a list of allowed roles.
 *  Skips all checks when SKIP_AUTH=true (local dev). */
export async function requireRole(role: Role | Role[]): Promise<NextResponse | null> {
  if (process.env.SKIP_AUTH === 'true') return null
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const allowed = Array.isArray(role) ? role : [role]
  if (!allowed.includes(session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

/** Allows admin or moderator (the "manager" tier). */
export function requireManager(): Promise<NextResponse | null> {
  return requireRole(['admin', 'moderator'])
}

/** Returns null if the user is logged in (any role), or 401 if not.
 *  Skips all checks when SKIP_AUTH=true (local dev). */
export async function requireAuth(): Promise<NextResponse | null> {
  if (process.env.SKIP_AUTH === 'true') return null
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return null
}
