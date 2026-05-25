import GoogleProvider from 'next-auth/providers/google'
import type { NextAuthOptions } from 'next-auth'
import { sql } from '@/lib/db'

const ALLOWED_DOMAIN = 'athena.studio'
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 // 30 days

async function fetchEvaluatorNames(): Promise<string[]> {
  const names: string[] = []
  const urls = [process.env.WEBHOOK_TEAM_INITIAL_GET, process.env.WEBHOOK_TEAM_FINAL_GET]
  for (const url of urls) {
    if (!url) continue
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) continue
      const data = await res.json()
      for (const row of data) {
        const name = (row['Evaluator Name'] || '').trim()
        if (name) names.push(name)
      }
    } catch { /* skip */ }
  }
  // deduplicate
  return Array.from(new Set(names))
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
      if (!user.email) return false

      // Domain restriction
      if (!user.email.endsWith(`@${ALLOWED_DOMAIN}`)) {
        return '/login?error=domain'
      }

      // Already in DB → allow
      const existing = await sql`SELECT id FROM dashboard_users WHERE email = ${user.email}`
      if (existing.length > 0) return true

      // Extract prefix (e.g. "nhilv" from "nhilv@athena.studio")
      const prefix = user.email.split('@')[0].toLowerCase()

      // Check if prefix matches any evaluator name (case-insensitive)
      const evaluatorNames = await fetchEvaluatorNames()
      const matched = evaluatorNames.find(n => n.toLowerCase() === prefix)

      if (matched) {
        // Auto-create as evaluator
        await sql`
          INSERT INTO dashboard_users (email, name, role)
          VALUES (${user.email}, ${matched}, 'evaluator')
          ON CONFLICT (email) DO NOTHING
        `
        return true
      }

      // Not in DB, not in evaluator lists → reject
      return '/login?error=unauthorized'
    },
    async session({ session }) {
      if (!session.user?.email) return session
      const email = session.user.email
      const rows = await sql`SELECT id, name, role FROM dashboard_users WHERE email = ${email}`
      if (rows.length > 0) {
        session.user.id = rows[0].id
        session.user.role = rows[0].role
        session.user.name = rows[0].name
      }
      return session
    },
    async jwt({ token, user }) {
      if (user?.email) {
        const rows = await sql`SELECT role FROM dashboard_users WHERE email = ${user.email}`
        if (rows.length > 0) token.role = rows[0].role
      }
      return token
    },
    async redirect({ url, baseUrl }) {
      return url.startsWith(baseUrl) ? url : baseUrl
    },
  },
  pages: { signIn: '/login', error: '/login' },
}
