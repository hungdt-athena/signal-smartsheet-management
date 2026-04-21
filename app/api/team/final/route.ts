import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'

export const dynamic = 'force-dynamic'

export interface FinalEvaluator {
  name: string
}

export async function GET(_req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const url = process.env.WEBHOOK_TEAM_FINAL_GET
  if (!url) return NextResponse.json({ error: 'WEBHOOK_TEAM_FINAL_GET not configured' }, { status: 500 })

  const res = await fetch(url)
  if (!res.ok) return NextResponse.json({ error: 'Failed to fetch from webhook' }, { status: 502 })
  const data = await res.json()
  return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
}
