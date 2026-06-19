// app/api/team/initial/weight/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { isWeight } from '@/lib/buckets'

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const url = process.env.WEBHOOK_TEAM_INITIAL_WEIGHT
  if (!url) return NextResponse.json({ error: 'WEBHOOK_TEAM_INITIAL_WEIGHT not configured' }, { status: 500 })

  const body = await req.json()
  if (!isWeight(body?.weight)) return NextResponse.json({ error: 'weight must be 30/50/70/100' }, { status: 400 })

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) return NextResponse.json({ error: 'Webhook failed' }, { status: 502 })
  return NextResponse.json({ ok: true })
}
