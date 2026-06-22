import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import version from '@/version.json'

export const dynamic = 'force-dynamic'

// Lightweight poll target for the client's <VersionWatcher>. `buildId` is baked at
// build time (scripts/stamp-version.mjs); the client compares it against the id in
// its own bundle to detect a new deploy. `notice` is an optional broadcast message
// (app_config key `deploy_notice`) admins can set to reach evaluators live — no
// redeploy required. Kept un-authenticated and cheap so it can be polled freely.
export async function GET() {
  let notice: string | null = null
  try {
    const rows = await sql`SELECT value FROM app_config WHERE key = 'deploy_notice'`
    notice = rows[0]?.value ?? null
  } catch {
    // The notice is optional — a DB hiccup must not break version polling.
  }

  return NextResponse.json(
    { buildId: (version as { buildId: string }).buildId, notice },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
