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

        const existing = await sql`SELECT id FROM dashboard_users WHERE email = ${user.email}`
        if (existing.length > 0) return true

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
        const email = session.user.email
        const rows = await sql`SELECT id, name, role FROM dashboard_users WHERE email = ${email}`
        if (rows.length > 0) {
          session.user.id = rows[0].id
          session.user.role = rows[0].role
          session.user.name = rows[0].name
        }
      } catch (e) {
        console.error('[auth] session DB error:', (e as Error).message)
      }
      return session
    },
    async jwt({ token, user }) {
      if (user?.email) {
        try {
          const rows = await sql`SELECT role FROM dashboard_users WHERE email = ${user.email}`
          if (rows.length > 0) token.role = rows[0].role
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
