import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { readRealtimeStatus } from '@/lib/google-sheets'

export const dynamic = 'force-dynamic'

export async function GET() {
  const guard = await requireRole('manager')
  if (guard) return guard

  try {
    const rows = await readRealtimeStatus()
    return NextResponse.json(rows)
  } catch (err) {
    console.error('[operations/realtime]', err)
    return NextResponse.json({ error: 'Failed to read realtime sheet' }, { status: 500 })
  }
}
