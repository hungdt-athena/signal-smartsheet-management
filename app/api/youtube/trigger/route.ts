import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export async function POST(_req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const triggeredAt = new Date().toISOString()
  await sql`
    INSERT INTO ops_logs (workflow_name, triggered_by, status, created_at)
    VALUES ('upload_ytb', ${session.user.email}, 'running', ${triggeredAt}::timestamptz)
  `

  const webhookUrl = process.env.WEBHOOK_YTB_TRIGGER
  if (webhookUrl) {
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggered_by: session.user.email }),
    }).catch(console.error)
  }

  return NextResponse.json({ triggered_at: triggeredAt })
}
