import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-guard'
import { checkStorage } from '@/lib/screenshot-store'

export const dynamic = 'force-dynamic'

// Proves screenshot storage works from wherever the app is actually running,
// rather than from what the config appears to say. Open it once after a deploy:
// it uploads a probe object, reads the same bytes back and deletes it, then
// reports the backend and bucket it used.
//
// The previous storage outage looked exactly like a working config -- both env
// vars set, pointing at a Supabase project that no longer existed -- and nothing
// in the app noticed until an evaluator lost work. This is the check that would
// have caught it in one request.

export async function GET() {
  const guard = await requireAdmin()
  if (guard) return guard

  const result = await checkStorage()
  return NextResponse.json(result, { status: result.ok ? 200 : 503 })
}
