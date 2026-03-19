import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { sql } from '@/lib/db'

export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (session.user.role !== 'evaluator') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const rows = await sql`
    SELECT id, status, summary, error_message, created_at
    FROM ops_logs
    WHERE workflow_name = 'handover' AND triggered_by = ${session.user.email}
    ORDER BY created_at DESC LIMIT 20
  `
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (session.user.role !== 'evaluator') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { start_date, end_date } = await req.json()
  if (!start_date || !end_date) {
    return NextResponse.json({ error: 'start_date and end_date are required' }, { status: 400 })
  }

  const triggeredAt = new Date().toISOString()

  await sql`
    INSERT INTO ops_logs (workflow_name, triggered_by, status, created_at)
    VALUES ('handover', ${session.user.email}, 'running', ${triggeredAt}::timestamptz)
  `

  const webhookUrl = process.env.WEBHOOK_HANDOVER
  if (webhookUrl) {
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evaluator_name: session.user.name,
        start_date,
        end_date,
        triggered_by: session.user.email,
      }),
    }).catch(console.error)
  }

  return NextResponse.json({ triggered_at: triggeredAt })
}
