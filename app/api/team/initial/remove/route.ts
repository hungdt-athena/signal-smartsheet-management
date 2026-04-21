import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth-guard'

export async function POST(req: NextRequest) {
  const guard = await requireRole('manager')
  if (guard) return guard

  const url = process.env.WEBHOOK_TEAM_INITIAL_REMOVE
  if (!url) return NextResponse.json({ error: 'WEBHOOK_TEAM_INITIAL_REMOVE not configured' }, { status: 500 })

  const body = await req.json()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) return NextResponse.json({ error: 'Webhook failed' }, { status: 502 })
  return NextResponse.json({ ok: true })
}
