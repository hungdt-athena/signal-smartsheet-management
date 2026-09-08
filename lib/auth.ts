import GoogleProvider from 'next-auth/providers/google'
import type { NextAuthOptions } from 'next-auth'
import { sql } from '@/lib/db'

const ALLOWED_DOMAIN = 'athena.studio'
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 // 30 days

async function fetchNamesFromWebhook(url: string | undefined): Promise<string[]> {
  if (!url) return []
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return []
    const data = await res.json()
    return (data as { 'Evaluator Name'?: string }[])
      .map(r => (r['Evaluator Name'] || '').trim())
      .filter(Boolean)
  } catch { return [] }
}

async function fetchEvaluatorNames(): Promise<string[]> {
  const [initial, final] = await Promise.all([
    fetchNamesFromWebhook(process.env.WEBHOOK_TEAM_INITIAL_GET),
    fetchNamesFromWebhook(process.env.WEBHOOK_TEAM_FINAL_GET),
  ])
  return Array.from(new Set([...initial, ...final]))
}

async function fetchRecorderNames(): Promise<string[]> {
  return fetchNamesFromWebhook(process.env.WEBHOOK_TEAM_RECORDERS_GET)
}

// --- the signed-in user's row, cached for a few seconds -------------------------
//
// `session()` below runs on EVERY authenticated request, and it used to read
// dashboard_users from the database every single time -- one serialized round-trip
// before the request's own query had even started. With the app in Asia and the
// database in us-east-2 that is ~225ms of pure waiting added to every API call, paid
// to re-read a role that changes maybe twice a month.
//
// It is cached rather than moved into the JWT because the read is what makes
// deactivation and role changes take effect on the next request instead of whenever
// the 30-day token expires. A short TTL keeps that property to within
// USER_CACHE_TTL_MS; `invalidateUserCache` closes even that window for changes this
// app makes itself (Users Management), so the TTL only ever covers a row edited
// directly in the database or by another instance.
const USER_CACHE_TTL_MS = 30_000

interface CachedUser { id: number; name: string; role: string; active: boolean }
const userCache = new Map<string, { at: number; row: CachedUser | null }>()

/** Drop a user's cached row so the next request re-reads it. Call after any write
 *  that changes their role, name or active flag. */
export function invalidateUserCache(email?: string | null) {
  if (email) userCache.delete(email.toLowerCase())
  else userCache.clear()
}

async function readUser(email: string): Promise<CachedUser | null> {
  const key = email.toLowerCase()
  const hit = userCache.get(key)
  if (hit && Date.now() - hit.at < USER_CACHE_TTL_MS) return hit.row

  const rows = await sql<CachedUser[]>`
    SELECT id, name, role, active FROM dashboard_users WHERE email = ${email}
  `
  const row = rows[0] ?? null
  userCache.set(key, { at: Date.now(), row })
  return row
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  session: { maxAge: SESSION_MAX_AGE },
  jwt: { maxAge: SESSION_MAX_AGE },
  callbacks: {
    async signIn({ user }) {
      try {
        if (!user.email) return false

        if (!user.email.endsWith(`@${ALLOWED_DOMAIN}`)) {
          return '/login?error=domain'
        }

        const existing = await sql`SELECT id, active FROM dashboard_users WHERE email = ${user.email}`
        // A deactivated account keeps its row (and all its history) but must not
        // get back in — this is what Users Management' Deactivate now means.
        if (existing.length > 0) return existing[0].active === false ? '/login?error=inactive' : true

        const prefix = user.email.split('@')[0].toLowerCase()

        const evaluatorNames = await fetchEvaluatorNames()
        const matched = evaluatorNames.find(n => n.toLowerCase() === prefix)

        if (matched) {
          await sql`
            INSERT INTO dashboard_users (email, name, role)
            VALUES (${user.email}, ${matched}, 'evaluator')
            ON CONFLICT (email) DO NOTHING
          `
          return true
        }

        // Recorders (in the recorder sheet but not an evaluator sheet) sign in as
        // evaluators — the dedicated 'others' role was removed.
        const recorderNames = await fetchRecorderNames()
        const matchedRecorder = recorderNames.find(n => n.toLowerCase() === prefix)
        if (matchedRecorder) {
          await sql`
            INSERT INTO dashboard_users (email, name, role)
            VALUES (${user.email}, ${matchedRecorder}, 'evaluator')
            ON CONFLICT (email) DO NOTHING
          `
          return true
        }

        return '/login?error=unauthorized'
      } catch (e) {
        console.error('[auth] signIn DB error:', (e as Error).message)
        return '/login?error=server'
      }
    },
    async session({ session }) {
      if (!session.user?.email) return session
      try {
        const row = await readUser(session.user.email)
        // Deactivating someone must take effect on their next request, not when
        // their JWT happens to expire, so a live session loses its role here and
        // every requireRole guard then turns it away.
        if (row && row.active !== false) {
          session.user.id = row.id
          session.user.role = row.role as typeof session.user.role
          session.user.name = row.name
        }
      } catch (e) {
        console.error('[auth] session DB error:', (e as Error).message)
      }
      return session
    },
    async jwt({ token, user }) {
      if (user?.email) {
        try {
          const rows = await sql`SELECT role, active FROM dashboard_users WHERE email = ${user.email}`
          if (rows.length > 0 && rows[0].active !== false) token.role = rows[0].role
        } catch (e) {
          console.error('[auth] jwt DB error:', (e as Error).message)
        }
      }
      return token
    },
    async redirect({ url, baseUrl }) {
      return url.startsWith(baseUrl) ? url : baseUrl
    },
  },
  pages: { signIn: '/login', error: '/login' },
}
