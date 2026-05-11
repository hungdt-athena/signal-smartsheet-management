import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'
import { readFlowLog } from '@/lib/google-sheets'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const limit = Number(new URL(req.url).searchParams.get('limit') ?? '50')

  try {
    const rows = await readFlowLog(limit)
    return NextResponse.json(rows)
  } catch (err) {
    console.error('[operations/history]', err)
    return NextResponse.json({ error: 'Failed to read flow_log sheet' }, { status: 500 })
  }
}
