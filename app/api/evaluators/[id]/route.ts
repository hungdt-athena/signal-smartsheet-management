import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { is_available } = await req.json()
  const webhookUrl = process.env.WEBHOOK_TOGGLE_EVALUATOR
  if (!webhookUrl) return NextResponse.json({ error: 'Toggle webhook not configured' }, { status: 500 })

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: params.id, is_available }),
  })

  if (!res.ok) return NextResponse.json({ error: 'Failed to update availability' }, { status: 502 })
  return NextResponse.json({ ok: true })
}
