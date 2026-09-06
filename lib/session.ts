// One session read per request.
//
// `getServerSession` is not a cheap accessor: authOptions.session() runs a
// `SELECT … FROM dashboard_users WHERE email = …` every time it is called. Routes call
// it twice as a matter of course -- once through requireAuth/requireRole to answer "is
// this person allowed in", then again to read session.user.name/role -- so every
// request paid two serialized round-trips to Neon before its real query started,
// across 24 routes.
//
// WHY NOT React's cache(): it does nothing here. cache() memoises within a React
// render, and a Route Handler is not one -- measured in this app on Next 14.2, a
// cache()-wrapped function called three times in one handler ran three times. It only
// works in Server Components, so it would have silently "fixed" nothing.
//
// What does work is keying a WeakMap on the object `headers()` returns: Next gives each
// request its own, and it is stable within that request (both verified against the
// running dev server). Entries die with the request object, so there is nothing to
// evict and nothing leaks between users.
import { headers } from 'next/headers'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import type { Session } from 'next-auth'

const perRequest = new WeakMap<object, Promise<Session | null>>()

/** The request's session, read at most once. Use this everywhere instead of calling
 *  getServerSession(authOptions) directly.
 *
 *  Outside a request scope (unit tests, scripts) `headers()` throws; there is no
 *  request to scope a memo to, so it falls through to an un-memoised read, which is
 *  the correct answer, just not a cached one. */
export async function getSession(): Promise<Session | null> {
  let key: object | null = null
  try {
    key = headers() as unknown as object
  } catch {
    return getServerSession(authOptions)
  }

  const hit = perRequest.get(key)
  if (hit) return hit

  const pending = getServerSession(authOptions)
  perRequest.set(key, pending)
  return pending
}
