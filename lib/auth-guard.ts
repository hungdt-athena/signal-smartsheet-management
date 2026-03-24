import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

type Role = 'manager' | 'evaluator'

/** Returns null if allowed, or a 401/403 NextResponse if blocked.
 *  Skips all checks when SKIP_AUTH=true (local dev). */
export async function requireRole(role: Role): Promise<NextResponse | null> {
  if (process.env.SKIP_AUTH === 'true') return null
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (session.user.role !== role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return null
}
