import GoogleProvider from 'next-auth/providers/google'
import type { NextAuthOptions } from 'next-auth'
import { sql } from '@/lib/db'

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      const rows = await sql`SELECT id, role FROM users WHERE email = ${user.email}`
      return rows.length > 0  // block if not in whitelist
    },
    async session({ session }) {
      if (!session.user?.email) return session
      const rows = await sql`SELECT id, name, role FROM users WHERE email = ${session.user.email}`
      if (rows.length > 0) {
        session.user.id = rows[0].id
        session.user.role = rows[0].role
        session.user.name = rows[0].name
      }
      return session
    },
    async redirect({ url, baseUrl }) {
      return url.startsWith(baseUrl) ? url : baseUrl
    },
  },
  pages: { signIn: '/login', error: '/login' },
}
