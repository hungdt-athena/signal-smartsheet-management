import { NextRequest, NextResponse } from 'next/server'
import { isManagerRole } from '@/lib/roles'
import { getSession } from '@/lib/session'

export async function POST(_req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isManagerRole(session.user.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const webhookUrl = process.env.WEBHOOK_YTB_TRIGGER
  if (webhookUrl) {
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggered_by: session.user.email }),
    }).catch(console.error)
  }

  return NextResponse.json({ triggered_at: new Date().toISOString() })
}
