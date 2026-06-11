import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST /api/admin/sync-evaluators — import evaluators from initial+final sheets
export async function POST() {
  const guard = await requireRole(['admin', 'moderator'])
  if (guard) return guard

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

  // Deduplicate (case-insensitive)
  const seen = new Set<string>()
  const unique: string[] = []
  for (const n of names) {
    const key = n.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(n)
    }
  }

  let added = 0
  for (const name of unique) {
    const email = `${name.toLowerCase()}@athena.studio`
    const result = await sql`
      INSERT INTO dashboard_users (email, name, role)
      VALUES (${email}, ${name}, 'evaluator')
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    `
    if (result.length > 0) added++
  }

  return NextResponse.json({ ok: true, total: unique.length, added })
}
