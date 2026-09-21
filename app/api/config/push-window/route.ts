// app/api/config/push-window/route.ts — how many days back the push step looks,
// per genre.
//
// Modelled on /api/genre-config, and split from it for the same reason that one
// is split from /api/assign-setup: this is a pipeline knob only an admin may
// turn, while everyone who can see the Assign panel needs to read it.
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, requireAuth } from '@/lib/auth-guard'
import { isBucket } from '@/lib/buckets'
import { loadPushWindowConfig, savePushWindowConfig } from '@/lib/push-window-db'
import { isPushWindow, PUSH_WINDOWS } from '@/lib/push-window'
import { getSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

async function canEdit(): Promise<boolean> {
  if (process.env.SKIP_AUTH === 'true') return true
  const session = await getSession()
  return session?.user?.role === 'admin'
}

export async function GET() {
  const guard = await requireAuth()
  if (guard) return guard
  try {
    const [windows, editable] = await Promise.all([loadPushWindowConfig(), canEdit()])
    return NextResponse.json(
      { windows, options: PUSH_WINDOWS, canEdit: editable },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    console.error('GET /api/config/push-window error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin()
  if (guard) return guard

  let body: { bucket?: unknown; days?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  if (!isBucket(body.bucket)) return NextResponse.json({ error: 'unknown genre' }, { status: 400 })
  if (!isPushWindow(body.days)) {
    return NextResponse.json({ error: `days must be one of ${PUSH_WINDOWS.join(', ')}` }, { status: 400 })
  }

  try {
    // Read-modify-write the whole blob: one genre's window must not drop the others.
    const config = await loadPushWindowConfig()
    const next = { ...config, [body.bucket]: body.days }
    await savePushWindowConfig(next)
    return NextResponse.json({ ok: true, windows: next })
  } catch (err) {
    console.error('PUT /api/config/push-window error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
