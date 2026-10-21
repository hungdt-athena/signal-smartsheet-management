import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { getSession } from '@/lib/session'
import { getYtbUploaded } from '@/lib/ytb-cache'
import { recordingQueue } from '@/lib/record-queue'

export const dynamic = 'force-dynamic'

// GET /api/record/my-queue -> { count, games }
//
// The games the signed-in person has to record: Recording status on the Record tab, in the
// current batch and the one before it. Feeds the badge next to Record in the sidebar. The
// YouTube sheet read is cached for 60s, so polling this is cheap.
export async function GET() {
  const guard = await requireAuth()
  if (guard) return guard

  const session = await getSession()
  const name = session?.user?.name
  if (!name) return NextResponse.json({ count: 0, games: [] }, { headers: { 'Cache-Control': 'no-store' } })

  try {
    const games = await recordingQueue(name, await getYtbUploaded())
    return NextResponse.json({ count: games.length, games }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    // No count beats a wrong one: without the sheet every confirmed game would look unrecorded.
    console.error('GET /api/record/my-queue error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
