// app/api/genre-config/route.ts — the Assign Setup genre toggles.
//
// Deliberately NOT part of /api/assign-setup: that route is the sole writer of
// evaluator_roster and runs at requireManager, while this is a pipeline switch that
// only an admin may flip. Keeping them apart keeps both rules easy to state.
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { requireAdmin, requireAuth } from '@/lib/auth-guard'
import { isBucket } from '@/lib/buckets'
import { loadGenreConfig, loadGenreTargets, saveGenreConfig } from '@/lib/genre-config-db'

export const dynamic = 'force-dynamic'

async function canEdit(): Promise<boolean> {
  if (process.env.SKIP_AUTH === 'true') return true
  const session = await getServerSession(authOptions)
  return session?.user?.role === 'admin'
}

export async function GET() {
  // Anyone logged in may see which genres are running; only admin may change it.
  const guard = await requireAuth()
  if (guard) return guard

  try {
    const [genres, editable] = await Promise.all([loadGenreTargets(), canEdit()])
    return NextResponse.json({ genres, canEdit: editable }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('GET /api/genre-config error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin()
  if (guard) return guard

  let body: { bucket?: unknown; enabled?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  if (!isBucket(body.bucket)) return NextResponse.json({ error: 'unknown genre' }, { status: 400 })
  if (typeof body.enabled !== 'boolean') return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })

  try {
    // Read-modify-write the whole blob: one genre's toggle must not drop the others.
    const config = await loadGenreConfig()
    await saveGenreConfig({ ...config, [body.bucket]: body.enabled })
    return NextResponse.json({ ok: true, genres: await loadGenreTargets() })
  } catch (err) {
    console.error('PUT /api/genre-config error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
