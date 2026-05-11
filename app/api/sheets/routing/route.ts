import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { readRoutingBlocking, updateRoutingBlocking } from '@/lib/google-sheets'

export const dynamic = 'force-dynamic'

function missingConfig() {
  if (!process.env.GOOGLE_SPREADSHEET_ID) return 'GOOGLE_SPREADSHEET_ID'
  if (!process.env.GOOGLE_REFRESH_TOKEN) return 'GOOGLE_REFRESH_TOKEN'
  return null
}

export async function GET() {
  const guard = await requireRole('manager')
  if (guard) return guard

  const missing = missingConfig()
  if (missing) return NextResponse.json({ error: `${missing} not configured` }, { status: 503 })

  try {
    const blocking = await readRoutingBlocking()
    return NextResponse.json({ blocking }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[sheets/routing GET]', e)
    return NextResponse.json({ error: 'Failed to read routing' }, { status: 502 })
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const missing = missingConfig()
  if (missing) return NextResponse.json({ error: `${missing} not configured` }, { status: 503 })

  const { blocking } = await req.json()
  if (blocking !== 'yes' && blocking !== 'no') {
    return NextResponse.json({ error: 'blocking must be "yes" or "no"' }, { status: 400 })
  }

  try {
    await updateRoutingBlocking(blocking)
    return NextResponse.json({ ok: true, blocking })
  } catch (e) {
    console.error('[sheets/routing PATCH]', e)
    return NextResponse.json({ error: 'Failed to update routing' }, { status: 502 })
  }
}
